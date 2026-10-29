"""Baseline A, baseline B and candidate C.

Conventions shared by all models:
- Work on the weekly target series built from an AvailableView (pre-cutoff rows only).
- Positions are integer week offsets on a complete Monday grid; `origin` is the last complete week
  before the cutoff. Training labels are positions in [train_start, origin].
- A and B: q50 is the baseline's defined point (last quote; seasonal median); q10/q90 add empirical
  log-residual quantiles measured only on training data. C: q50 is the point forecast of the ridge
  model refit on all training pairs (its intercept carries the bias estimate from all training data);
  q10/q90 add the inner-calibration log-residual quantiles centred on their median, so the interval
  measures dispersion from the calibration split without re-importing one calibration year's bias.
  Centring makes C quantiles ordered by construction. Residuals are on the log scale, so
  quantiles are positive by construction; a crossing quantile set is reported as a defect and the
  model abstains for that target instead of re-sorting.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd

from .features import iso_week_bucket, weekly_climatology, window_anomaly

QUANTILE_LEVELS = (0.1, 0.5, 0.9)
QKEYS = ("q10", "q50", "q90")
WEEKS_PER_YEAR = 52
FOURIER_PERIOD = 52.1775  # mean ISO weeks per year


@dataclass
class MarketContext:
    market_id: str
    product_id: str
    weekly: pd.DataFrame            # indexed by weekStart, complete weeks only, last row = origin
    train_start_pos: int
    last_quote: float | None
    last_quote_date: str | None
    weather_weekly: pd.Series | None = None   # aligned to weekly.index, or None if unavailable
    weather_status: str = "disabled"
    satellite_status: str = "disabled"
    data_hash: str = ""
    notes: list[str] = field(default_factory=list)

    @property
    def origin_pos(self) -> int:
        return len(self.weekly) - 1

    @property
    def L(self) -> np.ndarray:
        v = self.weekly["value"].to_numpy(dtype=float)
        with np.errstate(divide="ignore", invalid="ignore"):
            return np.where(v > 0, np.log(v), np.nan)

    def week_at(self, pos: int) -> pd.Timestamp:
        return self.weekly.index[0] + pd.Timedelta(weeks=pos)


def _get(a: np.ndarray, idx: np.ndarray | int) -> np.ndarray:
    idx = np.asarray(idx)
    out = np.full(idx.shape, np.nan)
    ok = (idx >= 0) & (idx < len(a))
    out[ok] = a[idx[ok]]
    return out


def _ffill(a: np.ndarray, limit: int) -> np.ndarray:
    return pd.Series(a).ffill(limit=limit if limit > 0 else None).to_numpy() if limit > 0 else a.copy()


def _quantiles(resid: np.ndarray) -> tuple[float, float]:
    return float(np.quantile(resid, 0.1)), float(np.quantile(resid, 0.9))


def _model_hash(payload: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()[:12]


def abstain(model_id: str, ctx_market: str, week: pd.Timestamp, h: int, reason: str) -> dict[str, Any]:
    return {"modelId": model_id, "marketId": ctx_market, "targetWeek": week.date().isoformat(), "horizonWeeks": int(h),
            "abstained": True, "abstainReason": reason, "quantiles": None, "negativeQuantilesReported": False}


def finalize(model_id: str, market: str, week: pd.Timestamp, h: int, q10: float, q50: float, q90: float) -> dict[str, Any]:
    """Validate quantiles. Non-finite or crossing -> abstain with a defect reason. Negative -> clip to 0 and flag."""
    qs = np.array([q10, q50, q90], dtype=float)
    if not np.all(np.isfinite(qs)):
        return abstain(model_id, market, week, h, "defect:non_finite_quantile")
    if not (qs[0] <= qs[1] <= qs[2]):
        return abstain(model_id, market, week, h, "defect:quantile_crossing")
    negative = bool(np.any(qs < 0))
    qs = np.maximum(qs, 0.0)
    return {"modelId": model_id, "marketId": market, "targetWeek": week.date().isoformat(), "horizonWeeks": int(h),
            "abstained": False, "abstainReason": None,
            "quantiles": {k: round(float(v), 6) for k, v in zip(QKEYS, qs)},
            "negativeQuantilesReported": negative}


# --------------------------------------------------------------------------------------------- A
def baseline_a(ctx: MarketContext, targets: list[tuple[pd.Timestamp, int]], cfg: dict[str, Any], stale: int) -> tuple[list[dict], dict]:
    mid = "A_last_value"
    info = {"modelId": mid, "marketId": ctx.market_id, "kind": "baseline_last_value",
            "point": "last valid daily modal quote with availableAt <= cutoff",
            "lastQuote": ctx.last_quote, "lastQuoteDate": ctx.last_quote_date}
    if ctx.last_quote is None:
        return [abstain(mid, ctx.market_id, w, h, "no_valid_quote_before_cutoff") for w, h in targets], info
    L, o, s = ctx.L, ctx.origin_pos, ctx.train_start_pos
    lv = _ffill(L, stale)
    preds, npairs = [], {}
    for w, h in targets:
        p = np.arange(max(0, s - h), o - h + 1)
        p = p[p + h >= s]
        r = _get(L, p + h) - _get(lv, p)
        r = r[np.isfinite(r)]
        npairs[int(h)] = int(r.size)
        if r.size < cfg["minResidualPairs"]:
            preds.append(abstain(mid, ctx.market_id, w, h, "insufficient_residual_pairs"))
            continue
        lo, hi = _quantiles(r)
        q50 = ctx.last_quote
        preds.append(finalize(mid, ctx.market_id, w, h, q50 * np.exp(lo), q50, q50 * np.exp(hi)))
    info["residualPairsByHorizon"] = npairs
    info["fittedModelId"] = f"{mid}@{_model_hash({'m': mid, 'd': ctx.data_hash, 'cfg': cfg})}"
    return preds, info


# --------------------------------------------------------------------------------------------- B
def baseline_b(ctx: MarketContext, targets: list[tuple[pd.Timestamp, int]], cfg: dict[str, Any]) -> tuple[list[dict], dict]:
    mid = "B_seasonal_reference"
    info = {"modelId": mid, "marketId": ctx.market_id, "kind": "baseline_seasonal",
            "point": "median of training-year values in the same ISO week (+/- isoWeekWindow)"}
    o, s = ctx.origin_pos, ctx.train_start_pos
    weeks = ctx.weekly.index[s:o + 1]
    vals = ctx.weekly["value"].to_numpy(dtype=float)[s:o + 1]
    ok = np.isfinite(vals) & (vals > 0)
    hist = pd.DataFrame({"bucket": iso_week_bucket(weeks)[ok], "year": weeks.isocalendar().year.to_numpy()[ok], "v": vals[ok]})
    win = cfg["isoWeekWindow"]

    def near(bucket: int) -> np.ndarray:
        d = np.abs(hist["bucket"].to_numpy() - bucket)
        d = np.minimum(d, WEEKS_PER_YEAR - d)
        return d <= win

    # Leave-one-year-out residuals within the training window only.
    resid = []
    for b in range(1, WEEKS_PER_YEAR + 1):
        m = near(b) & (hist["bucket"].to_numpy() == b)
        if not m.any():
            continue
        pool = hist[near(b)]
        for _, row in hist[m].iterrows():
            others = pool[pool["year"] != row["year"]]["v"]
            if len(others):
                resid.append(np.log(row["v"]) - np.log(np.median(others)))
    resid = np.array(resid)
    info["looResiduals"] = int(resid.size)
    preds = []
    for w, h in targets:
        b = int(iso_week_bucket(pd.DatetimeIndex([w]))[0])
        pool = hist[near(b)]
        if pool["year"].nunique() < cfg["minSeasonYears"]:
            preds.append(abstain(mid, ctx.market_id, w, h, "insufficient_season_years"))
            continue
        if resid.size < cfg["minResidualPairs"]:
            preds.append(abstain(mid, ctx.market_id, w, h, "insufficient_residual_pairs"))
            continue
        ref = float(np.median(pool["v"]))
        lo, hi = _quantiles(resid)
        preds.append(finalize(mid, ctx.market_id, w, h, ref * np.exp(lo), ref, ref * np.exp(hi)))
    info["fittedModelId"] = f"{mid}@{_model_hash({'m': mid, 'd': ctx.data_hash, 'cfg': cfg})}"
    return preds, info


# --------------------------------------------------------------------------------------------- C
def _ridge_fit(X: np.ndarray, z: np.ndarray, alpha: float) -> dict[str, np.ndarray]:
    mu = X.mean(axis=0) if X.shape[1] else np.zeros(0)
    sd = X.std(axis=0) if X.shape[1] else np.zeros(0)
    sd = np.where(sd > 0, sd, 1.0)
    Xs = (X - mu) / sd
    zbar = float(z.mean())
    k = Xs.shape[1]
    beta = np.linalg.solve(Xs.T @ Xs + alpha * np.eye(k), Xs.T @ (z - zbar)) if k else np.zeros(0)
    return {"mu": mu, "sd": sd, "beta": beta, "intercept": np.array(zbar)}


def _ridge_predict(m: dict[str, np.ndarray], X: np.ndarray) -> np.ndarray:
    if X.shape[1] == 0:
        return np.full(X.shape[0], float(m["intercept"]))
    return float(m["intercept"]) + ((X - m["mu"]) / m["sd"]) @ m["beta"]


def _seasonal_anchor(a: np.ndarray, t: np.ndarray, kind: str, years: int) -> np.ndarray:
    """Log anchor for week t built only from weeks t-52k (k >= 1), fallback t-52k-1 when missing.

    seasonal_naive: k = 1 only. seasonal_reference: median over k = 1..years of available values.
    For horizons <= 52 every referenced week is at or before the origin.
    """
    ks = [1] if kind == "seasonal_naive" else list(range(1, years + 1))
    stack = []
    for k in ks:
        v = _get(a, t - WEEKS_PER_YEAR * k)
        stack.append(np.where(np.isfinite(v), v, _get(a, t - WEEKS_PER_YEAR * k - 1)))
    st = np.vstack(stack)
    with np.errstate(all="ignore"):
        cnt = np.isfinite(st).sum(axis=0)
        med = np.nanmedian(np.where(cnt > 0, st, 0.0), axis=0) if st.size else np.full(t.shape, np.nan)
    return np.where(cnt > 0, med, np.nan)


def candidate_c(ctx: MarketContext, targets: list[tuple[pd.Timestamp, int]], cfg: dict[str, Any], groups: dict[str, bool],
                model_id: str, stale: int, anchor: str = "seasonal_reference") -> tuple[list[dict], dict]:
    """Direct per-horizon model: log y[t] = anchor(t) + ridge(features at origin) + residual.

    anchor: seasonal_naive = log y[t-52] (fallback t-53); seasonal_reference = median of log y at
    t-52k, k = 1..anchorYears (each with a one-week-older fallback). All anchor weeks are at or before
    the origin for horizons <= 52 weeks; longer horizons abstain.
    Features at origin p: level anomaly lv[p] - anchor(p) (same anchor kind); Fourier terms of the
    target ISO week; optional arrivals YoY log anomaly; optional weather window anomaly vs training
    climatology.
    Quantiles: empirical residual quantiles from an inner temporal split (fit on training targets
    before the last `calibrationWeeks`, score on the last `calibrationWeeks`), then the point model is
    refit on all training pairs. No hyperparameters are tuned (ridgeAlpha is fixed by config).
    """
    info: dict[str, Any] = {"modelId": model_id, "marketId": ctx.market_id, "kind": "statistical_candidate",
                            "anchor": anchor, "featureGroups": groups, "perHorizon": {}}
    if groups.get("satellite_anomaly"):
        reason = f"feature_group_unavailable:satellite_anomaly:{ctx.satellite_status}"
        info["status"] = reason
        return [abstain(model_id, ctx.market_id, w, h, reason) for w, h in targets], info
    if groups.get("weather_climatology") and ctx.weather_weekly is None:
        reason = f"feature_group_unavailable:weather_climatology:{ctx.weather_status}"
        info["status"] = reason
        return [abstain(model_id, ctx.market_id, w, h, reason) for w, h in targets], info

    L, o, s = ctx.L, ctx.origin_pos, ctx.train_start_pos
    lv = _ffill(L, stale)
    idx = ctx.weekly.index
    buckets_all = np.concatenate([iso_week_bucket(idx), iso_week_bucket(pd.date_range(idx[-1] + pd.Timedelta(weeks=1), periods=105, freq="7D"))])
    arr = ctx.weekly["arrivalsTonnes"].to_numpy(dtype=float)
    with np.errstate(divide="ignore", invalid="ignore"):
        la = _ffill(np.where(arr > 0, np.log(arr), np.nan), stale)
    cal_weeks = cfg["calibrationWeeks"]
    cal_start = o - cal_weeks + 1  # first calibration target position

    def weather_anom(last_clim_pos: int) -> np.ndarray:
        clim = weekly_climatology(ctx.weather_weekly, first_week=idx[s], last_week=idx[last_clim_pos])
        return window_anomaly(ctx.weather_weekly, clim, cfg["weatherWindowWeeks"])

    wa_outer = weather_anom(o) if groups.get("weather_climatology") else None
    wa_inner = weather_anom(cal_start - 1) if groups.get("weather_climatology") and cal_start - 1 > s else None

    def design(p: np.ndarray, h: int, wa: np.ndarray | None) -> tuple[np.ndarray, np.ndarray, list[str]]:
        t = p + h
        S = _seasonal_anchor(L, t, anchor, cfg["anchorYears"])
        cols = [_get(lv, p) - _seasonal_anchor(lv, p, anchor, cfg["anchorYears"])]
        names = [f"origin_log_anomaly_vs_{anchor}"]
        for k in range(1, cfg["fourierOrder"] + 1):
            ang = 2 * np.pi * k * buckets_all[t] / FOURIER_PERIOD
            cols += [np.sin(ang), np.cos(ang)]
            names += [f"fourier_sin{k}", f"fourier_cos{k}"]
        if groups.get("arrivals_lag"):
            cols.append(_get(la, p) - _get(la, p - WEEKS_PER_YEAR))
            names.append("arrivals_yoy_log_anomaly_at_origin")
        if groups.get("weather_climatology"):
            # Lagged by weatherLagWeeks so archive publication delay never forces a missing origin value.
            lag = cfg["weatherLagWeeks"]
            cols.append(_get(wa, p - lag) if wa is not None else np.full(p.shape, np.nan))
            names.append(f"weather_{cfg['weatherWindowWeeks']}w_anomaly_lag{lag}")
        return np.column_stack(cols), S, names

    preds = []
    for w, h in targets:
        if h > WEEKS_PER_YEAR:
            preds.append(abstain(model_id, ctx.market_id, w, h, "horizon_over_52_weeks_not_supported"))
            continue
        hk = int(h)
        if hk not in info["perHorizon"]:
            p_all = np.arange(max(0, s - h), o - h + 1)
            p_all = p_all[p_all + h >= s]
            X, S, names = design(p_all, h, wa_outer)
            z = _get(L, p_all + h) - S
            ok = np.isfinite(z) & np.all(np.isfinite(X), axis=1)
            t_all = p_all + h
            inner = ok & (t_all < cal_start)
            calib = ok & (t_all >= cal_start)
            entry: dict[str, Any] = {"nPairs": int(ok.sum()), "nInnerFit": int(inner.sum()), "nCalibration": int(calib.sum()),
                                     "features": names, "status": "ok"}
            if ok.sum() < cfg["minFitPairs"] or inner.sum() < cfg["minFitPairs"]:
                entry["status"] = "insufficient_training_pairs"
            elif calib.sum() < cfg["minCalibrationPairs"]:
                entry["status"] = "insufficient_calibration_pairs"
            else:
                X_in, z_in = X, z
                if groups.get("weather_climatology"):
                    if wa_inner is None:
                        entry["status"] = "insufficient_weather_climatology_years"
                    else:
                        # Inner split uses a climatology fitted before the calibration weeks (no peeking).
                        X_in, S_in, _ = design(p_all, h, wa_inner)
                        z_in = _get(L, p_all + h) - S_in
                ok_in = np.isfinite(z_in) & np.all(np.isfinite(X_in), axis=1)
                inner_fit, calib_eval = inner & ok_in, calib & ok_in
                if entry["status"] == "ok" and (inner_fit.sum() < cfg["minFitPairs"] or calib_eval.sum() < cfg["minCalibrationPairs"]):
                    entry["status"] = "insufficient_calibration_pairs"
                if entry["status"] == "ok":
                    m_inner = _ridge_fit(X_in[inner_fit], z_in[inner_fit], cfg["ridgeAlpha"])
                    resid = z_in[calib_eval] - _ridge_predict(m_inner, X_in[calib_eval])
                    m_full = _ridge_fit(X[ok], z[ok], cfg["ridgeAlpha"])
                    entry.update({"model": m_full, "resid": resid, "nCalibration": int(calib_eval.sum()),
                                  "nInnerFit": int(inner_fit.sum()),
                                  "coefficients": {nm: round(float(b), 6) for nm, b in zip(names, m_full["beta"])}})
            info["perHorizon"][hk] = entry
        entry = info["perHorizon"][hk]
        if entry["status"] != "ok":
            preds.append(abstain(model_id, ctx.market_id, w, h, entry["status"]))
            continue
        Xo, So, _ = design(np.array([o]), h, wa_outer)
        if not (np.all(np.isfinite(Xo)) and np.isfinite(So[0])):
            preds.append(abstain(model_id, ctx.market_id, w, h, "missing_feature_at_origin"))
            continue
        mu = float(So[0] + _ridge_predict(entry["model"], Xo)[0])
        r = entry["resid"]
        med = float(np.median(r))
        q = [float(np.exp(mu + np.quantile(r, tau) - med)) for tau in QUANTILE_LEVELS]
        preds.append(finalize(model_id, ctx.market_id, w, h, *q))
    # Strip non-serialisable fitted arrays from the info record.
    for hk, e in info["perHorizon"].items():
        e.pop("model", None)
        r = e.pop("resid", None)
        if r is not None:
            e["calibrationResidualQ10Q50Q90"] = [round(float(np.quantile(r, t)), 6) for t in QUANTILE_LEVELS]
    info["perHorizon"] = {str(k): v for k, v in sorted(info["perHorizon"].items())}
    info["fittedModelId"] = f"{model_id}@{_model_hash({'m': model_id, 'd': ctx.data_hash, 'cfg': cfg, 'g': groups, 'a': anchor})}"
    return preds, info
