"""Temporal replay at one decision cutoff (BUILD_SPEC 8.2).

Order of operations is enforced by structure:
  1. snapshot_as_of(...) builds AvailableViews (rows with availableAt <= cutoff, revisions resolved).
  2. Labels, features, climatology and calibration are built only from those views.
  3. Models predict; predictions are frozen (canonical JSON hashed).
  4. RealizedVault.realize(frozen) re-verifies the hash and only then computes realized targets from
     the full table. Models never receive the vault.
"""

from __future__ import annotations

import copy
import hashlib
import json
from typing import Any

import numpy as np
import pandas as pd

from .availability import AvailableView, ExclusionLog, snapshot_as_of, to_utc
from .contracts import validate
from .errors import ContractError, FreezeViolation, LeakageError
from .features import weekly_input_series
from .metrics import mase_scale, score_record, summarize
from .models import MarketContext, abstain, baseline_a, baseline_b, candidate_c
from .weekly import STATISTICS, daily_values, week_start, weekly_series

DEFAULT_MODEL_CONFIG: dict[str, Any] = {
    "targetStatistic": "weekly_median_modal",
    "maxStaleWeeks": 3,
    "strictVintage": True,
    "baselineA": {"enabled": True, "minResidualPairs": 12},
    "baselineB": {"enabled": True, "minSeasonYears": 2, "minResidualPairs": 12, "isoWeekWindow": 0},
    "candidate": {
        "ridgeAlpha": 1.0, "fourierOrder": 2, "anchorYears": 5, "calibrationWeeks": 52, "minFitPairs": 26,
        "minCalibrationPairs": 12, "weatherWindowWeeks": 8, "weatherLagWeeks": 2,
        "weatherVariable": "precipitation_sum", "weatherRegionByMarket": {},
        "satelliteVariable": "vegetation_index_anomaly",
    },
    "candidates": [{"id": "C_base", "featureGroups": {}}],
}
FEATURE_GROUPS = ("arrivals_lag", "weather_climatology", "satellite_anomaly")


def resolve_config(cfg: dict[str, Any] | None) -> dict[str, Any]:
    out = copy.deepcopy(DEFAULT_MODEL_CONFIG)
    for k, v in (cfg or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = {**out[k], **v}
        else:
            out[k] = copy.deepcopy(v)
    for c in out["candidates"]:
        c["featureGroups"] = {g: bool(c["featureGroups"].get(g, False)) for g in FEATURE_GROUPS}
        c.setdefault("anchor", "seasonal_reference")
    ids = [c["id"] for c in out["candidates"]]
    if len(set(ids)) != len(ids):
        raise ContractError("candidate ids must be unique")
    return out


def canonical_hash(obj: Any) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


class FrozenPredictions:
    """Holds a reference to the prediction list and the hash taken at freeze time."""

    def __init__(self, predictions: list[dict[str, Any]]):
        self.predictions = predictions
        self.hash = canonical_hash(predictions)

    def verify(self) -> None:
        current = canonical_hash(self.predictions)
        if current != self.hash:
            raise FreezeViolation(f"predictions changed after freeze: {self.hash[:12]} -> {current[:12]}")


def freeze(predictions: list[dict[str, Any]]) -> FrozenPredictions:
    return FrozenPredictions(predictions)


class RealizedVault:
    """Full (post-cutoff) observation table. The only accessor demands verified frozen predictions."""

    def __init__(self, frame: pd.DataFrame, statistic: str, strict_vintage: bool):
        self.__frame = frame
        self.__statistic = statistic
        self.__strict = strict_vintage
        self.reads = 0

    def realize(self, frozen: FrozenPredictions) -> dict[tuple[str, str], dict[str, Any]]:
        if not isinstance(frozen, FrozenPredictions):
            raise FreezeViolation("realized targets can only be joined to frozen predictions")
        frozen.verify()
        self.reads += 1
        latest = snapshot_as_of(self.__frame, None, kind="realized", date_col="observedOn", strict_vintage=self.__strict)
        weekly = weekly_series(daily_values(latest.frame), self.__statistic)
        out: dict[tuple[str, str], dict[str, Any]] = {}
        for p in frozen.predictions:
            key = (p["marketId"], p["targetWeek"])
            if key in out:
                continue
            w = weekly.get(p["marketId"])
            ts = pd.Timestamp(p["targetWeek"])
            if w is None or ts not in w.index or not np.isfinite(w.at[ts, "value"]):
                out[key] = {"marketId": key[0], "targetWeek": key[1], "value": None, "nDays": 0, "labelAvailableAt": None}
            else:
                row = w.loc[ts]
                out[key] = {"marketId": key[0], "targetWeek": key[1], "value": round(float(row["value"]), 6),
                            "nDays": int(row["nDays"]), "labelAvailableAt": row["labelAvailableAt"].isoformat()}
        return out


def _iso(ts: pd.Timestamp | None) -> str | None:
    return None if ts is None or pd.isna(ts) else ts.isoformat()


def _view_hash(df: pd.DataFrame) -> str:
    cols = ["rowId", "availableAt", "modalInrPerKg", "minInrPerKg", "maxInrPerKg", "arrivalsTonnes"]
    rows = sorted([str(v) for v in r] for r in df[cols].itertuples(index=False))
    return canonical_hash(rows)[:16]


def run_replay(request: dict[str, Any], observations: pd.DataFrame, weather: pd.DataFrame | None = None,
               satellite: pd.DataFrame | None = None, *, mode: str = "replay") -> dict[str, Any]:
    validate(request, "replay_request", what="replay request")
    if mode not in ("replay", "synthetic"):
        raise ContractError("mode must be replay or synthetic")
    cfg = resolve_config(request.get("modelConfig"))
    if cfg["targetStatistic"] not in STATISTICS:
        raise ContractError("unknown targetStatistic")
    tz = request.get("regionTimezone", "Asia/Kolkata")
    cutoff = to_utc(request["decisionCutoff"])
    cutoff_day = cutoff.tz_convert(tz).tz_localize(None).normalize()
    policy = {"labelSettleDays": 0, "rollingWeeks": None, **request["trainingPolicy"]}
    if policy["kind"] == "rolling" and not policy["rollingWeeks"]:
        raise ContractError("rolling training policy requires rollingWeeks")
    stale = cfg["maxStaleWeeks"]
    notes: list[str] = []

    # Complete weeks only: the origin week ended before the cutoff date (minus settle days).
    origin = week_start(pd.Series([cutoff_day - pd.Timedelta(days=policy["labelSettleDays"])])).iloc[0] - pd.Timedelta(weeks=1)
    hw_start, hw_end = pd.Timestamp(request["harvestWindow"]["start"]), pd.Timestamp(request["harvestWindow"]["end"])
    pw_end = pd.Timestamp(request["plantingWindow"]["end"])
    if hw_end < hw_start:
        raise ContractError("harvestWindow.end before start")
    if cutoff_day > pw_end:
        notes.append("decisionCutoff is after plantingWindow.end: this is not a planting-time decision")
    first_monday = week_start(pd.Series([hw_start])).iloc[0]
    if first_monday < hw_start:
        first_monday += pd.Timedelta(weeks=1)
    target_weeks = list(pd.date_range(first_monday, hw_end, freq="7D"))
    if not target_weeks:
        raise ContractError("harvestWindow contains no ISO week start (Monday)")
    if target_weeks[0] <= cutoff_day:
        raise ContractError("target weeks must start after the decision cutoff date")
    targets, beyond = [], []
    for w in target_weeks:
        h = int((w - origin).days // 7)
        (targets if h <= request["horizonWeeks"] else beyond).append((w, h))

    product, markets = request["productId"], list(request["marketIds"])
    in_scope = (observations["productId"] == product) & observations["marketId"].isin(markets)
    obs = observations[in_scope].reset_index(drop=True)
    view = snapshot_as_of(obs, cutoff, kind="price_observation", date_col="observedOn", strict_vintage=cfg["strictVintage"])
    vault = RealizedVault(obs, cfg["targetStatistic"], cfg["strictVintage"])

    wants_weather = any(c["featureGroups"]["weather_climatology"] for c in cfg["candidates"])
    wants_sat = any(c["featureGroups"]["satellite_anomaly"] for c in cfg["candidates"])
    wview: AvailableView | None = None
    if wants_weather and weather is not None and len(weather):
        wview = snapshot_as_of(weather, cutoff, kind="weather_input", date_col="periodEnd", strict_vintage=cfg["strictVintage"])
    sview: AvailableView | None = None
    if wants_sat and satellite is not None and len(satellite):
        sview = snapshot_as_of(satellite, cutoff, kind="satellite_input", date_col="periodEnd", strict_vintage=cfg["strictVintage"])

    price_log = ExclusionLog()
    price_log.merge(view.exclusions)
    daily_all = daily_values(view.frame, price_log)
    label_days = daily_all[daily_all["observedOn"] <= origin + pd.Timedelta(days=6)]
    weekly_by_market = weekly_series(label_days, cfg["targetStatistic"], end=origin, log=price_log)

    predictions: list[dict[str, Any]] = []
    fitted: list[dict[str, Any]] = []
    label_audit, group_audit, scales = [], [], {}
    model_ids = (["A_last_value"] if cfg["baselineA"]["enabled"] else []) + \
                (["B_seasonal_reference"] if cfg["baselineB"]["enabled"] else []) + [c["id"] for c in cfg["candidates"]]

    for market in markets:
        wk = weekly_by_market.get(market)
        mdaily = daily_all[daily_all["marketId"] == market]
        if wk is None or wk.empty:
            for mid in model_ids:
                predictions += [abstain(mid, market, w, h, "no_training_data") for w, h in targets]
            label_audit.append({"marketId": market, "nWeeks": 0, "nValidWeeks": 0, "passed": True, "status": "no_training_data"})
            continue
        o = len(wk) - 1
        s = 0 if policy["kind"] == "expanding" else max(0, o - policy["rollingWeeks"] + 1)
        vals = wk["value"].to_numpy(float)
        valid = int(np.isfinite(vals[s:o + 1]).sum())
        max_label = wk["labelAvailableAt"].iloc[s:o + 1].max()
        if pd.notna(max_label) and max_label > cutoff:
            bad = wk[wk["labelAvailableAt"] > cutoff]
            raise LeakageError("training label available after cutoff", [{"week": str(i.date()), "labelAvailableAt": _iso(r)} for i, r in bad["labelAvailableAt"].items()])
        last_label_end = wk.index[o] + pd.Timedelta(days=6)
        label_ok = bool(last_label_end < cutoff_day and wk.index[o] == origin)
        label_audit.append({
            "marketId": market, "trainingPolicy": policy["kind"], "firstWeek": str(wk.index[s].date()),
            "lastWeek": str(wk.index[o].date()), "lastWeekEnd": str(last_label_end.date()), "nWeeks": int(o - s + 1),
            "nValidWeeks": valid, "nMissingWeeks": int(o - s + 1 - valid),
            "missingFraction": round(1 - valid / (o - s + 1), 4), "maxLabelAvailableAt": _iso(max_label),
            "passed": label_ok,
        })
        scales[market] = mase_scale(vals[s:o + 1])
        last = mdaily.sort_values("observedOn").iloc[-1] if len(mdaily) else None
        ctx = MarketContext(
            market_id=market, product_id=product, weekly=wk, train_start_pos=s,
            last_quote=None if last is None else float(last["modal"]),
            last_quote_date=None if last is None else str(last["observedOn"].date()),
            data_hash=_view_hash(view.frame[view.frame["marketId"] == market]),
        )
        if wants_weather:
            region = cfg["candidate"]["weatherRegionByMarket"].get(market)
            if wview is None:
                ctx.weather_status = "no_rows"
            elif region is None:
                ctx.weather_status = "no_region_mapping"
            else:
                ws = weekly_input_series(wview, region, cfg["candidate"]["weatherVariable"], wk.index)
                if ws.notna().sum() == 0:
                    ctx.weather_status = "no_rows"
                else:
                    ctx.weather_weekly, ctx.weather_status = ws, "used"
            rows = wview.frame if wview is not None else pd.DataFrame(columns=["availableAt"])
            group_audit.append({"marketId": market, "group": "weather_climatology", "status": ctx.weather_status,
                                "regionId": region, "rowsAvailable": int(len(rows)),
                                "maxAvailableAt": _iso(rows["availableAt"].max()) if len(rows) else None,
                                "passed": bool(len(rows) == 0 or rows["availableAt"].max() <= cutoff),
                                "note": "observed anomaly vs training-window climatology; no weather forecast used"})
        if wants_sat:
            ctx.satellite_status = "no_rows" if sview is None else "rows_present_but_no_validated_transform"
            group_audit.append({"marketId": market, "group": "satellite_anomaly", "status": ctx.satellite_status,
                                "rowsAvailable": 0 if sview is None else int(len(sview.frame)), "passed": True,
                                "note": "placeholder group: abstains; values are never fabricated"})
        if valid < policy["minTrainWeeks"]:
            for mid in model_ids:
                predictions += [abstain(mid, market, w, h, "insufficient_training_weeks") for w, h in targets]
            continue
        if cfg["baselineA"]["enabled"]:
            p, info = baseline_a(ctx, targets, cfg["baselineA"], stale)
            predictions += p
            fitted.append(info)
        if cfg["baselineB"]["enabled"]:
            p, info = baseline_b(ctx, targets, cfg["baselineB"])
            predictions += p
            fitted.append(info)
        for cand in cfg["candidates"]:
            p, info = candidate_c(ctx, targets, cfg["candidate"], cand["featureGroups"], cand["id"], stale, cand["anchor"])
            predictions += p
            fitted.append(info)

    for p in predictions:
        p["productId"] = product
        p["seasonId"] = request.get("seasonId")

    # ---- freeze, then (and only then) read realized values
    frozen = freeze(predictions)
    realized = vault.realize(frozen)
    records = [score_record(p, realized[(p["marketId"], p["targetWeek"])]["value"], scales.get(p["marketId"])) for p in predictions]
    per_model = {m: summarize([r for r in records if r["modelId"] == m]) for m in model_ids}

    first_target = targets[0][0] if targets else None
    leakage_checks = [
        {"name": "feature_rows_available_by_cutoff", "passed": bool(view.max_available_at is None or view.max_available_at <= cutoff),
         "detail": f"maxAvailableAt={_iso(view.max_available_at)} cutoff={cutoff.isoformat()}"},
        {"name": "training_labels_complete_before_cutoff", "passed": all(a["passed"] for a in label_audit)},
        {"name": "targets_after_training_labels",
         "passed": bool(first_target is None or (first_target > cutoff_day and first_target > origin))},
        {"name": "exogenous_rows_available_by_cutoff", "passed": all(g["passed"] for g in group_audit)},
        {"name": "predictions_frozen_before_realized_join", "passed": vault.reads == 1, "detail": f"predictionsHash={frozen.hash}"},
    ]
    for chk in leakage_checks:
        if not chk["passed"]:
            raise LeakageError(f"leakage check failed: {chk['name']}", [chk])

    return {
        "schemaVersion": "1.0",
        "mode": mode,
        "synthetic": mode == "synthetic",
        "request": request,
        "resolvedModelConfig": cfg,
        "seasonId": request.get("seasonId"),
        "decisionCutoff": cutoff.isoformat(),
        "decisionCutoffLocalDate": str(cutoff_day.date()),
        "regionTimezone": tz,
        "originWeek": str(origin.date()),
        "target": {"statistic": cfg["targetStatistic"], "definition": STATISTICS[cfg["targetStatistic"]], "unit": "INR/kg",
                   "weeks": [{"targetWeek": str(w.date()), "horizonWeeks": h} for w, h in targets]},
        "featureAudit": {
            "cutoff": cutoff.isoformat(),
            "priceObservations": {"rowsInScope": int(len(obs)), "rowsAvailable": int(len(view.frame)),
                                  "maxAvailableAt": _iso(view.max_available_at),
                                  "passed": leakage_checks[0]["passed"]},
            "trainingLabels": label_audit,
            "featureGroups": group_audit,
            "notes": notes,
        },
        "fittedModels": fitted,
        "predictions": predictions,
        "predictionsHash": frozen.hash,
        "realizedTarget": sorted(realized.values(), key=lambda r: (r["marketId"], r["targetWeek"])),
        "scores": {"records": records, "perModel": per_model},
        "exclusionReport": {
            "priceObservations": price_log.to_dict(),
            "weatherInputs": wview.exclusions.to_dict() if wview is not None else None,
            "targetsBeyondHorizon": [{"targetWeek": str(w.date()), "horizonWeeks": h} for w, h in beyond],
            "rowsOutOfScope": int((~in_scope).sum()),
        },
        "leakageChecks": leakage_checks,
    }
