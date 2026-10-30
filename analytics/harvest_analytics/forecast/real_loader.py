"""Real-data replay: load a DB export (scripts/replay/export-price-rows.ts) under a pre-registered request.

The request (evals/cases/forecast/<case>/request.json) and its holdout-policy.md are committed before any replay. This
module only executes them: markets, seasons, model configuration, training policy, exclusion rules and the release rule
come from the request; nothing is tuned here.

Availability: the export assigns `availableAt` by a declared policy (observation date + lag; basis
`assumed_publication_lag_1d` / `assumed_reanalysis_lag_6d`) because stored `available_at` is the fetch time. The report
states this assumption and counts rows per basis. The same AvailableView guard as synthetic runs applies.
"""

from __future__ import annotations

import gzip
import hashlib
import json
from pathlib import Path
from typing import Any, Callable

import pandas as pd

from .ablation import REPO_ROOT, code_version, run_ablation
from .contracts import inputs_frame, normalize_source_rows, observations_frame
from .errors import ContractError, LeakageError
from .metrics import summarize, target_key
from .replay import canonical_hash, resolve_config, run_replay

ALLOWED_REQUEST_ROOT = REPO_ROOT / "evals" / "cases"
ALLOWED_EXPORT_ROOTS = (REPO_ROOT / "data", REPO_ROOT / "evals" / "cases")
BASELINES = ("A_last_value", "B_seasonal_reference")
ASSUMED_BASES = ("assumed_publication_lag_1d", "assumed_reanalysis_lag_6d")


def _resolve(path_str: str, roots: tuple[Path, ...], suffixes: tuple[str, ...]) -> Path:
    p = Path(path_str)
    p = (REPO_ROOT / p if not p.is_absolute() else p).resolve()
    if not any(str(p).endswith(s) for s in suffixes) or not any(p.is_relative_to(r.resolve()) for r in roots):
        raise ContractError(f"path {path_str!r} must end with {suffixes} and be under one of {[str(r) for r in roots]}")
    return p


def canonical_market_id(source_market_id: str, aliases: dict[str, list[str]]) -> str | None:
    """Canonicalisation hook: source market_id -> registered canonical ID via the request's pinned alias table.

    Name-level joins across source renames are inferences recorded in the request, never applied implicitly.
    Returns None for markets outside the registered set.
    """
    for canon, members in aliases.items():
        if source_market_id == canon or source_market_id in members:
            return canon
    return None


def suffixed(path: str, variant: str | None) -> str:
    if not variant:
        return path
    for ext in (".json.gz", ".json"):
        if path.endswith(ext):
            return path[: -len(ext)] + f"-{variant}" + ext
    raise ContractError(f"cannot derive variant path from {path}")


def load_request(path_str: str) -> tuple[dict[str, Any], str]:
    p = _resolve(path_str, (ALLOWED_REQUEST_ROOT,), (".json",))
    text = p.read_text()
    req = json.loads(text)
    for k in ("caseId", "productId", "marketIds", "marketAliases", "seasons", "trainingPolicy", "modelConfig",
              "exportPath", "exportManifestPath", "availabilityPolicy", "releaseRule"):
        if k not in req:
            raise ContractError(f"request missing {k}")
    if req.get("synthetic") is not False or req.get("dataMode") != "replay":
        raise ContractError("real-data request must declare synthetic: false and dataMode: replay")
    return req, hashlib.sha256(text.encode()).hexdigest()


def load_export(req: dict[str, Any], variant: str | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
    """Read the gzip export and its manifest; the export's sha256 must match the manifest."""
    mpath = _resolve(suffixed(req["exportManifestPath"], variant), ALLOWED_EXPORT_ROOTS, (".json",))
    epath = _resolve(suffixed(req["exportPath"], variant), ALLOWED_EXPORT_ROOTS, (".json.gz", ".json"))
    manifest = json.loads(mpath.read_text())
    raw = epath.read_bytes()
    text = gzip.decompress(raw) if epath.suffix == ".gz" else raw
    if hashlib.sha256(text).hexdigest() != manifest["export"]["sha256Json"]:
        raise ContractError("export does not match its manifest sha256Json; re-run pnpm replay:export")
    payload = json.loads(text)
    if payload.get("caseId") != req["caseId"] or payload.get("productId") != req["productId"]:
        raise ContractError("export caseId/productId does not match the request")
    return payload, manifest


def build_case(req: dict[str, Any], payload: dict[str, Any], manifest: dict[str, Any]) -> dict[str, Any]:
    rows = payload["sourcePriceRows"]
    registered = set(req["marketIds"])
    for r in rows:
        canon = canonical_market_id(r["marketId"], req["marketAliases"])
        if canon is None or canon not in registered:
            raise ContractError(f"export row {r['rowId']} has unregistered market {r['marketId']}")
        r["marketId"] = canon
        if r["productId"] != req["productId"]:
            raise ContractError(f"export row {r['rowId']} has product {r['productId']}")
        if any(str(m).startswith("syn.") for m in (r["marketId"], r["productId"])):
            raise ContractError("synthetic IDs in a real export")
    observations = normalize_source_rows(rows)
    return {
        "synthetic": False, "mode": "replay",
        "label": f"REAL SOURCE DATA: data.gov.in/Agmarknet {req.get('sourceCommodity', req['productId'])}, Karnataka; availability assumed (see realData)",
        "dataSnapshotId": f"{req['caseId']}:{manifest['export']['sha256Json'][:16]}",
        "productId": req["productId"], "marketIds": req["marketIds"],
        "observations": observations, "weatherInputs": payload.get("weatherInputs") or [], "satelliteInputs": [],
        "weatherRegionByMarket": req["modelConfig"].get("candidate", {}).get("weatherRegionByMarket", {}),
    }


def _by_market(records: list[dict[str, Any]], market: str, model: str) -> list[dict[str, Any]]:
    return [r for r in records if r["marketId"] == market and r["modelId"] == model]


def _common(records: list[dict[str, Any]], market: str, models: list[str]) -> tuple[int, dict[str, dict[str, Any]]]:
    scored = {m: {target_key(r): r for r in _by_market(records, market, m) if r.get("scored")} for m in models}
    keys = set.intersection(*(set(v) for v in scored.values())) if scored else set()
    return len(keys), {m: summarize([scored[m][k] for k in keys]) for m in models}


def _beats(a: dict[str, Any], b: dict[str, Any]) -> bool:
    return a["mae"] is not None and b["mae"] is not None and a["mae"] < b["mae"] and a["wis80"] < b["wis80"]


def release_decision(records: list[dict[str, Any]], market_ids: list[str], rule: dict[str, Any]) -> dict[str, Any]:
    """Apply the registered release rule (holdout-policy.md section 7) per market."""
    min_common, min_cov = int(rule["minCommonTargets"]), float(rule["minCoverage80"])
    out: dict[str, Any] = {}
    for mk in market_ids:
        own = {m: summarize(_by_market(records, mk, m)) for m in (*BASELINES, "C_base", "C_weather")}
        live_baselines = [m for m in BASELINES if own[m]["nScored"] > 0]
        if not live_baselines:
            out[mk] = {"releaseModel": "none", "bestBaseline": None, "cChoice": None, "nCommon": 0,
                       "reason": "both baselines abstained or unscored: no evaluated forecast (scenario only)"}
            continue
        best_baseline = min(live_baselines, key=lambda m: (own[m]["wis80"], own[m]["mae"]))
        d: dict[str, Any] = {"bestBaseline": best_baseline, "ownScored": own}
        c_choice = "C_base"
        if own["C_base"]["nScored"] and own["C_weather"]["nScored"]:
            n_w, cw = _common(records, mk, ["C_base", "C_weather"])
            d["weatherVsBase"] = {"nCommon": n_w, **{m: {k: cw[m][k] for k in ("mae", "wis80", "coverage80")} for m in cw}}
            if n_w and _beats(cw["C_weather"], cw["C_base"]):
                c_choice = "C_weather"
        d["cChoice"] = c_choice if own[c_choice]["nScored"] else None
        if d["cChoice"] is None:
            d.update(releaseModel=best_baseline, nCommon=0, reason=f"{c_choice} scored no target; baseline {best_baseline} (lower WIS80 on own scored targets)")
            out[mk] = d
            continue
        n_c, cs = _common(records, mk, [*BASELINES, c_choice] if all(own[m]["nScored"] for m in BASELINES) else [*live_baselines, c_choice])
        d["nCommon"] = n_c
        d["commonSet"] = {m: {k: cs[m][k] for k in ("mae", "wis80", "coverage80", "nScored")} for m in cs}
        if n_c == 0:
            d.update(releaseModel=best_baseline, reason="no common scored targets between C and the baselines")
            out[mk] = d
            continue
        base_on_common = min((m for m in cs if m in BASELINES), key=lambda m: (cs[m]["wis80"], cs[m]["mae"]))
        c = cs[c_choice]
        checks = {"nCommon>=min": n_c >= min_common, "beatsBaselineMAE": c["mae"] < cs[base_on_common]["mae"],
                  "beatsBaselineWIS80": c["wis80"] < cs[base_on_common]["wis80"], "coverage80>=min": (c["coverage80"] or 0) >= min_cov}
        d["candidateChecks"] = {"againstBaselineOnCommon": base_on_common, **checks}
        if all(checks.values()):
            d.update(releaseModel=c_choice, reason=f"{c_choice} beats {base_on_common} on MAE and WIS80 on {n_c} common targets with coverage80 {c['coverage80']}")
        else:
            failed = [k for k, v in checks.items() if not v]
            d.update(releaseModel=best_baseline, reason=f"{c_choice} not adopted (failed: {', '.join(failed)}); baseline {best_baseline} has the lower WIS80 on its own scored targets")
        out[mk] = d
    return {"rule": ("C variant only if it beats the better baseline on both MAE and WIS80 on the per-market common set, with "
                     f"coverage80 >= {min_cov} and >= {min_common} common targets; otherwise the baseline with lower WIS80 on its own "
                     "scored targets (MAE tie-break); C_weather over C_base only if it beats C_base on both MAE and WIS80"),
            "perMarket": out}


def per_market_tables(records: list[dict[str, Any]], market_ids: list[str]) -> tuple[dict, dict]:
    models = list(dict.fromkeys(r["modelId"] for r in records))
    per_market = {mk: {m: summarize(_by_market(records, mk, m)) for m in models} for mk in market_ids}
    per_ms: dict[str, dict[str, dict[str, Any]]] = {}
    for mk in market_ids:
        per_ms[mk] = {}
        for m in models:
            recs = _by_market(records, mk, m)
            seasons = sorted({r.get("seasonId") for r in recs})
            per_ms[mk][m] = {s: {k: v for k, v in summarize([r for r in recs if r.get("seasonId") == s]).items()
                                 if k in ("nTargets", "nAbstained", "nScored", "mae", "mase", "wis80", "coverage80", "meanWidth80", "abstainReasons", "nUnscoredMissingRealized")}
                             for s in seasons}
    return per_market, per_ms


def perturbation_check(req: dict[str, Any], case: dict[str, Any], model_config: dict[str, Any]) -> dict[str, Any]:
    """Multiply every post-cutoff price by 10 and add 5000 mm to every post-cutoff weather row; predictions must not change."""
    obs = observations_frame(case["observations"], validated=True)
    weather = inputs_frame(case["weatherInputs"]) if case["weatherInputs"] else None
    results = []
    for s in req["seasons"]:
        request = {"decisionCutoff": s["decisionCutoff"], "seasonId": s["seasonId"], "productId": req["productId"],
                   "marketIds": req["marketIds"], "plantingWindow": s["plantingWindow"], "harvestWindow": s["harvestWindow"],
                   "trainingPolicy": req["trainingPolicy"], "dataSnapshotId": case["dataSnapshotId"], "horizonWeeks": s["horizonWeeks"],
                   "modelConfig": model_config}
        cutoff = pd.Timestamp(s["decisionCutoff"]).tz_convert("UTC")
        h0 = run_replay(request, obs, weather, None, mode="replay")["predictionsHash"]
        o2 = obs.copy()
        late = o2["availableAt"] > cutoff
        for c in ("minInrPerKg", "maxInrPerKg", "modalInrPerKg"):
            o2.loc[late, c] = o2.loc[late, c] * 10
        w2 = None
        if weather is not None:
            w2 = weather.copy()
            w2.loc[w2["availableAt"] > cutoff, "value"] = w2.loc[w2["availableAt"] > cutoff, "value"] + 5000.0
        h1 = run_replay(request, o2, w2, None, mode="replay")["predictionsHash"]
        results.append({"seasonId": s["seasonId"], "nPerturbedPriceRows": int(late.sum()), "hashBefore": h0, "hashAfter": h1, "passed": h0 == h1})
    passed = all(r["passed"] for r in results)
    if not passed:
        raise LeakageError("post-cutoff perturbation changed predictions", [r for r in results if not r["passed"]])
    return {"description": "Every price row with availableAt after the cutoff was multiplied by 10 and every such weather row had 5000 mm added; the predictions hash must be unchanged.",
            "passed": passed, "nCutoffs": len(results), "perCutoff": results}


def run_real(payload: dict[str, Any]) -> dict[str, Any]:
    req, req_sha = load_request(payload["requestPath"])
    variant = payload.get("sensitivity")
    declared = {v["id"]: v for v in req.get("sensitivityRuns", [])}
    if variant and variant not in declared:
        raise ContractError(f"sensitivity {variant!r} is not declared in the request")
    export, manifest = load_export(req, variant)
    if manifest.get("requestSha256") and manifest["requestSha256"] != req_sha:
        raise ContractError("export manifest was produced from a different request.json; re-run pnpm replay:export")
    case = build_case(req, export, manifest)
    basis_counts: dict[str, int] = {}
    for r in case["observations"]:
        b = r.get("availableAtBasis", "recorded")
        basis_counts[b] = basis_counts.get(b, 0) + 1
    w_basis: dict[str, int] = {}
    for r in case["weatherInputs"]:
        w_basis[r.get("availableAtBasis", "recorded")] = w_basis.get(r.get("availableAtBasis", "recorded"), 0) + 1
    model_config = req["modelConfig"]
    perturb = perturbation_check(req, case, model_config) if payload.get("perturbationCheck", True) else None
    run_date = payload.get("runDate")
    real_data = {
        "variant": variant or "primary",
        "usedForRelease": not bool(variant),
        "preRegistration": {"policyPath": str(Path(req["exportManifestPath"]).parent / req.get("policy", "holdout-policy.md")),
                            "requestSha256": req_sha, "commit": payload.get("preRegistrationCommit"),
                            "amendments": payload.get("amendments") or []},
        "availabilityAssumptions": {
            "prices": (f"availableAt = observedOn + {req['availabilityPolicy']['prices']['lagDays']} day at 00:00 Asia/Kolkata "
                       f"(basis {req['availabilityPolicy']['prices']['basis']}): assumed next-day Agmarknet publication, NOT a recorded "
                       "publication time. Stored available_at is the 2026-10-30 fetch time. Later vintages keep their recorded fetch time."),
            "weather": (f"availableAt = date + {req['availabilityPolicy']['weather']['lagDays']} days (basis {req['availabilityPolicy']['weather']['basis']}): "
                        "Open-Meteo archive reanalysis with a documented ~5-day delay plus 1 day margin; the model adds a further 2-week lag."),
            "priceRowsByBasis": basis_counts, "weatherRowsByBasis": w_basis,
        },
        "exportManifest": {"path": manifest["export"]["path"], "sha256Json": manifest["export"]["sha256Json"],
                           "pricesExported": manifest["prices"]["exported"], "weatherExported": manifest["weather"]["exported"],
                           "excludedByReason": manifest["prices"]["excludedByReason"], "excludedByMarket": manifest["prices"]["excludedByMarket"],
                           "perMarket": manifest["prices"]["perMarket"], "rules": manifest.get("rules"), "unitBasis": manifest["source"]["unitBasis"],
                           "sensitivity": manifest.get("sensitivity")},
        "leakagePerturbation": perturb,
    }

    def hook(records: list[dict[str, Any]], report: dict[str, Any]) -> dict[str, Any]:
        pm, pms = per_market_tables(records, req["marketIds"])
        dec = release_decision(records, req["marketIds"], req["releaseRule"])
        if variant:
            dec["note"] = "sensitivity run: not used for the release choice (holdout-policy.md Amendment 1)"
        return {"perMarket": pm, "perMarketSeason": pms, "releaseDecision": dec}

    run_id = payload.get("runId")
    if not run_id:
        import datetime as dt
        day = (run_date or dt.datetime.now(dt.timezone.utc).isoformat())[:10].replace("-", "")
        run_id = f"ginger-ka-{day}-{code_version()['sourceHash'][:8]}" + (f"-{variant}" if variant else "")
    report = run_ablation(case, seasons=[{k: s[k] for k in ("seasonId", "decisionCutoff", "plantingWindow", "harvestWindow", "horizonWeeks")} for s in req["seasons"]],
                          model_config=model_config, training_policy=req["trainingPolicy"], run_id=run_id,
                          write=bool(payload.get("writeReport", False)), run_date=run_date,
                          real_data=real_data, extra_limitations=list(req.get("limitations", [])) + REAL_LIMITATIONS, real_data_hook=hook)
    return report


REAL_LIMITATIONS = [
    "REAL SOURCE DATA with ASSUMED availability: price availableAt = observed date + 1 day (assumed next-day Agmarknet publication). The stored available_at is the 2026-10-30 fetch time; true historical publication times are not recorded. A later publication would make this replay optimistic.",
    "Subset of upstream rows: rows were obtained by page-capped, non-chronological API paging plus market-filtered pulls; repeated pages were observed (duplicates ignored), so some upstream rows may be missing.",
    "Unit assumed INR/quintal (Agmarknet convention; the API field metadata states no unit), converted to INR/kg by /100.",
    "Market renames from Nov 2025 (' APMC' suffix, Bengaluru/Bengaluru South districts) are joined by a pinned alias table; that the renamed entries are the same physical market is an inference from the name.",
    "Hassan-district quotes (~1,500 INR/quintal) sit far below Bengaluru-area quotes (~4,500); the gap is unexplained (grade, product form or reporting). Belur (Hassan district) is scored as a lower-confidence demonstration market and the state-median scaling rule is sensitive to this mix (see Amendment 1 sensitivity run).",
    "Weather = Open-Meteo archive reanalysis at one Hassan grid cell, used as a supply-region proxy for all three markets (assumption). It is not station data and not a forecast.",
    "Model configuration (C anchor, quantile scheme, ridgeAlpha, windows) was fixed from T07 synthetic development defaults before any real data was scored; it was not tuned on these seasons.",
    "Five seasons x three markets is a small sample; season-block intervals are wide and no broad accuracy claim is supported. Modal prices are wholesale references, not farm-gate prices.",
]
