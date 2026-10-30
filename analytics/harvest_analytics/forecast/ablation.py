"""Ablation harness: run every model variant across rolling planting-decision cutoffs.

Variants (default): A_last_value, B_seasonal_reference, C_snaive (single-year seasonal-naive anchor),
C_base (multi-year seasonal-reference anchor + lag anomaly + Fourier seasonality), C_arrivals
(+arrivals lag), C_weather (+weather climatology anomaly), C_satellite (placeholder -> abstains).
Each feature group is toggled independently so its addition is measured separately.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import subprocess
from pathlib import Path
from typing import Any


from .. import __version__
from .contracts import inputs_frame, observations_frame, validate
from .errors import ContractError, LeakageError
from .metrics import breakdown, common_set, summarize
from .replay import run_replay

PACKAGE_DIR = Path(__file__).resolve().parent
REPO_ROOT = PACKAGE_DIR.parents[2]
DEFAULT_RESULTS_DIR = REPO_ROOT / "evals" / "results"

DEFAULT_CANDIDATES = [
    {"id": "C_snaive", "anchor": "seasonal_naive", "featureGroups": {}},
    {"id": "C_base", "featureGroups": {}},
    {"id": "C_arrivals", "featureGroups": {"arrivals_lag": True}},
    {"id": "C_weather", "featureGroups": {"weather_climatology": True}},
    {"id": "C_satellite", "featureGroups": {"satellite_anomaly": True}},
]
DEFAULT_POLICY = {"kind": "expanding", "minTrainWeeks": 80}

BASE_LIMITATIONS = [
    "Weather group = observed precipitation anomaly versus a training-window climatology up to the cutoff (lagged for publication delay). No weather forecast is used: archived forecasts exist only for 1-7 day leads from 2024, so planting-time weather for harvest horizons is climatological (docs/DATA_AUDIT.md section 7).",
    "satellite_anomaly is a placeholder feature group; it abstains and never fabricates values. A regional vegetation anomaly would be a proxy, not crop acreage or yield.",
    "Seasonal lags use 52 weeks; years with ISO week 53 shift the alignment by one week.",
    "Quantiles come from empirical log residuals (training pairs for A/B, inner temporal calibration split for C); small residual samples make interval coverage noisy. Sample counts are reported per horizon.",
    "Mandi min/max are quotation ranges, not prediction interval endpoints; a modal price is a wholesale reference, not a farm-gate price.",
    "Selection on the evaluation set: the C anchor (seasonal_reference) and the C quantile scheme (median-centred inner-calibration residuals) were chosen on the same synthetic series used to report C_base vs C_snaive. Those comparisons are therefore optimistic for C_base. This is a model-selection caveat on synthetic data, not a breach of a real-data holdout (no real data has been evaluated). A pre-registered holdout policy (fixed seasons, fixed model and quantile choices) is required before any real-data evaluation.",
    "Baseline A abstains with stale_last_quote when its last valid quote was observed before (origin week - maxStaleWeeks); such targets are counted under abstentions, not scored.",
    "Numerical replay depends on no LLM. Any LLM explanation of a replay must receive only the frozen evidence bundle; a pretrained model may still know historical events.",
]


def seasons_from_template(t: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for y in t["seasonStartYears"]:
        y = int(y)
        hw = t["harvestWindow"]
        out.append({
            "seasonId": f"{y}-{(y + 1) % 100:02d}",
            "decisionCutoff": f"{y}-{t['decisionMonthDay']}T00:00:00+05:30",
            "plantingWindow": {"start": f"{y}-{t['plantingWindow']['startMonthDay']}", "end": f"{y}-{t['plantingWindow']['endMonthDay']}"},
            "harvestWindow": {"start": f"{y}-{hw['startMonthDay']}", "end": f"{y + int(hw.get('endYearOffset', 0))}-{hw['endMonthDay']}"},
            "horizonWeeks": int(t["horizonWeeks"]),
        })
    return out


def code_version() -> dict[str, Any]:
    h = hashlib.sha256()
    for path in sorted(list(PACKAGE_DIR.glob("*.py")) + list((PACKAGE_DIR.parent / "schemas").glob("*.json"))):
        h.update(path.name.encode())
        h.update(path.read_bytes())
    sha, dirty = None, None
    try:
        r = subprocess.run(["git", "rev-parse", "HEAD"], cwd=REPO_ROOT, capture_output=True, text=True, timeout=10)
        if r.returncode == 0:
            sha = r.stdout.strip()
            d = subprocess.run(["git", "status", "--porcelain", "--", "analytics"], cwd=REPO_ROOT, capture_output=True, text=True, timeout=10)
            dirty = bool(d.stdout.strip()) if d.returncode == 0 else None
    except (OSError, subprocess.SubprocessError):
        pass
    return {"gitSha": sha, "gitDirty": dirty, "packageVersion": __version__, "sourceHash": h.hexdigest()[:16],
            "note": None if sha else "no git commit available; sourceHash identifies the analytics code"}


def _jsonable(obj: Any) -> Any:
    return json.loads(json.dumps(obj, allow_nan=False, default=lambda o: o.item() if hasattr(o, "item") else str(o)))


def run_ablation(case: dict[str, Any], *, seasons: list[dict[str, Any]] | None = None,
                 model_config: dict[str, Any] | None = None, training_policy: dict[str, Any] | None = None,
                 run_id: str | None = None, results_dir: Path | None = None, write: bool = True,
                 run_date: str | None = None, real_data: dict[str, Any] | None = None,
                 extra_limitations: list[str] | None = None,
                 real_data_hook: Any = None) -> dict[str, Any]:
    """real_data / extra_limitations / real_data_hook(records, report) -> dict are used by real_loader for
    non-synthetic runs; the hook's output is merged into report["realData"] before schema validation."""
    synthetic = bool(case.get("synthetic"))
    mode = "synthetic" if synthetic else "replay"
    obs = observations_frame(case["observations"])
    weather = inputs_frame(case["weatherInputs"]) if case.get("weatherInputs") else None
    sat = inputs_frame(case["satelliteInputs"]) if case.get("satelliteInputs") else None
    seasons = seasons or seasons_from_template(case["seasonTemplate"])
    mc = dict(model_config or {})
    mc.setdefault("candidates", DEFAULT_CANDIDATES)
    cand_cfg = dict(mc.get("candidate", {}))
    cand_cfg.setdefault("weatherRegionByMarket", case.get("weatherRegionByMarket", {}))
    mc["candidate"] = cand_cfg
    policy = {**DEFAULT_POLICY, **(training_policy or {})}
    cv = code_version()
    run_date = run_date or dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    run_id = run_id or f"{mode}-{run_date[:10].replace('-', '')}-{cv['sourceHash'][:8]}"

    per_cutoff, records, checks = [], [], []
    exclusions: dict[str, Any] = {}
    resolved_cfg = None
    prev_cutoff = None
    for season in seasons:
        request = {
            "decisionCutoff": season["decisionCutoff"], "seasonId": season["seasonId"], "productId": case["productId"],
            "marketIds": case["marketIds"], "plantingWindow": season["plantingWindow"], "harvestWindow": season["harvestWindow"],
            "trainingPolicy": policy, "dataSnapshotId": case["dataSnapshotId"], "horizonWeeks": season["horizonWeeks"],
            "modelConfig": mc,
        }
        out = run_replay(request, obs, weather, sat, mode=mode)
        resolved_cfg = out["resolvedModelConfig"]
        records += out["scores"]["records"]
        first_target = out["target"]["weeks"][0]["targetWeek"] if out["target"]["weeks"] else None
        disjoint = all(a.get("lastWeekEnd") is None or (first_target is not None and a["lastWeekEnd"] < first_target)
                       for a in out["featureAudit"]["trainingLabels"])
        increasing = prev_cutoff is None or out["decisionCutoff"] > prev_cutoff
        prev_cutoff = out["decisionCutoff"]
        season_checks = out["leakageChecks"] + [
            {"name": "training_label_weeks_end_before_first_target_week", "passed": bool(disjoint)},
            {"name": "cutoffs_strictly_increasing", "passed": bool(increasing)},
        ]
        checks += [{"seasonId": season["seasonId"], **c} for c in season_checks]
        exclusions[season["seasonId"]] = out["exclusionReport"]
        per_cutoff.append({
            "seasonId": season["seasonId"], "decisionCutoff": out["decisionCutoff"],
            "decisionCutoffLocalDate": out["decisionCutoffLocalDate"], "originWeek": out["originWeek"],
            "plantingWindow": season["plantingWindow"], "harvestWindow": season["harvestWindow"],
            "targetWeeks": out["target"]["weeks"], "predictionsHash": out["predictionsHash"],
            "trainingLabels": out["featureAudit"]["trainingLabels"], "featureGroups": out["featureAudit"]["featureGroups"],
            "notes": out["featureAudit"]["notes"],
            "fittedModels": [{"modelId": f["modelId"], "marketId": f["marketId"], "fittedModelId": f.get("fittedModelId"),
                              "status": f.get("status", "fitted"),
                              "perHorizon": f.get("perHorizon"), "residualPairsByHorizon": f.get("residualPairsByHorizon"),
                              "looResiduals": f.get("looResiduals")} for f in out["fittedModels"]],
            "perModel": out["scores"]["perModel"],
            "realizedTarget": out["realizedTarget"],
            "leakageChecks": season_checks,
        })

    model_ids = list(dict.fromkeys(r["modelId"] for r in records))
    aggregate = {
        "models": [{"modelId": m, **summarize([r for r in records if r["modelId"] == m])} for m in model_ids],
        "commonSet": common_set(records),
        "breakdowns": {m: {k: breakdown([r for r in records if r["modelId"] == m], k)
                           for k in ("marketId", "productId", "horizonWeeks", "seasonId")} for m in model_ids},
    }
    passed = all(c["passed"] for c in checks)
    if not passed:
        raise LeakageError("ablation leakage checks failed", [c for c in checks if not c["passed"]])
    limitations = []
    if synthetic:
        limitations.append("SYNTHETIC INPUTS: these scores show how the code behaves on a generated series with known seasonality and an injected shock. They are not evidence of forecast accuracy for ginger or any real market.")
        limitations.append("No real market evaluation exists yet: mandi price history is key-gated (docs/DATA_AUDIT.md). Unblock: data.gov.in API key (or authorized manual export), product/grade identity resolution, and >= 3 independent harvest seasons per market.")
    n_seasons = len({r.get("seasonId") for r in records if r.get("scored")})
    if n_seasons < 5:
        limitations.append(f"Only {n_seasons} scored season(s): no uncertainty interval is reported for MAE and no broad accuracy claim is supported.")
    limitations += list(extra_limitations or [])
    # The synthetic model-selection caveat says no real data was evaluated; real runs state their own version instead.
    limitations += [x for x in BASE_LIMITATIONS if synthetic or not x.startswith("Selection on the evaluation set")]
    report = {
        "schemaVersion": "1.0",
        "runId": run_id,
        "mode": mode,
        "synthetic": synthetic,
        "banner": "SYNTHETIC DATA - NOT A MARKET EVALUATION" if synthetic else "TEMPORAL REPLAY ON SOURCE DATA",
        "inputLabel": case.get("label"),
        "runDate": run_date,
        "codeVersion": cv,
        "dataSnapshotId": case["dataSnapshotId"],
        "productId": case["productId"],
        "marketIds": case["marketIds"],
        "target": {"statistic": resolved_cfg["targetStatistic"], "unit": "INR/kg"} if resolved_cfg else None,
        "trainingPolicy": policy,
        "modelConfig": resolved_cfg,
        "perCutoff": per_cutoff,
        "aggregate": aggregate,
        "exclusions": exclusions,
        "leakageChecks": {"passed": passed, "nChecks": len(checks), "checks": checks},
        "limitations": limitations,
    }
    if real_data is not None:
        if synthetic:
            raise ContractError("realData is only valid for non-synthetic runs")
        rd = dict(real_data)
        if real_data_hook is not None:
            rd.update(real_data_hook(records, report))
        report["realData"] = rd
    report = _jsonable(report)
    validate(report, "replay_report", what="replay report")
    if write:
        root = Path(results_dir) if results_dir is not None else DEFAULT_RESULTS_DIR
        if not root.is_dir():
            raise ContractError(f"results directory does not exist: {root}")
        out_dir = root / run_id
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "report.json").write_text(json.dumps(report, indent=1, sort_keys=True, allow_nan=False) + "\n")
        (out_dir / "records.json").write_text(json.dumps(_jsonable(records), sort_keys=True, allow_nan=False) + "\n")
        (out_dir / "summary.md").write_text(markdown_summary(report))
        report["_written"] = {"dir": str(out_dir.relative_to(REPO_ROOT)) if out_dir.is_relative_to(REPO_ROOT) else str(out_dir),
                              "files": ["report.json", "records.json", "summary.md"]}
    return report


def _f(x: Any, nd: int = 3) -> str:
    return "n/a" if x is None else (f"{x:.{nd}f}" if isinstance(x, float) else str(x))


def aggregate_table(report: dict[str, Any]) -> str:
    lines = ["| model | targets | abstained | unscored (no realized) | scored | MAE INR/kg | MASE | pinball q10/q50/q90 | WIS80 | coverage80 | mean width80 |",
             "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    for m in report["aggregate"]["models"]:
        pb = m["pinball"]
        pbs = "n/a" if pb is None else f"{_f(pb['q10'])}/{_f(pb['q50'])}/{_f(pb['q90'])}"
        cov = "n/a" if m["coverage80"] is None else f"{_f(m['coverage80'])} (n={m['nScored']})"
        lines.append(f"| {m['modelId']} | {m['nTargets']} | {m['nAbstained']} | {m['nUnscoredMissingRealized']} | {m['nScored']} | "
                     f"{_f(m['mae'])} | {_f(m['mase'])} (n={m['nMase']}) | {pbs} | {_f(m['wis80'])} | {cov} | {_f(m['meanWidth80'])} |")
    return "\n".join(lines)


def real_data_markdown(report: dict[str, Any]) -> str:
    rd = report["realData"]
    out = [f"## Real data run: mode {report['mode']} (real source data, not synthetic)\n"]
    pr = rd["preRegistration"]
    out.append(f"- Pre-registered policy: `{pr['policyPath']}`, commit {pr.get('commit') or 'n/a'}; amendments: {', '.join(pr.get('amendments') or []) or 'none'}")
    out.append(f"- Variant: **{rd.get('variant', 'primary')}**; used for release decision: {rd.get('usedForRelease')}")
    for k, v in rd["availabilityAssumptions"].items():
        out.append(f"- Availability ({k}): {v}")
    em = rd["exportManifest"]
    out.append(f"- Export: {em.get('path')} sha256(json) {em.get('sha256Json', '')[:16]}..., price rows exported {em.get('pricesExported')}, weather rows {em.get('weatherExported')}")
    out.append(f"- Exclusions before replay (by reason): {json.dumps(em.get('excludedByReason'), sort_keys=True)}")
    out.append(f"- Exclusions before replay (by market): {json.dumps(em.get('excludedByMarket'), sort_keys=True)}\n")
    if rd.get("perMarket"):
        out.append("### Per market (all scored seasons)\n")
        out.append("| market | model | targets | abstained | scored | MAE INR/kg | MASE | WIS80 | coverage80 | width80 |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
        for mk, models in rd["perMarket"].items():
            for m, s in models.items():
                out.append(f"| {mk} | {m} | {s['nTargets']} | {s['nAbstained']} | {s['nScored']} | {_f(s['mae'])} | {_f(s['mase'])} | {_f(s['wis80'])} | {_f(s['coverage80'])} | {_f(s['meanWidth80'])} |")
        out.append("")
    if rd.get("perMarketSeason"):
        out.append("### Per market and season: MAE INR/kg (n scored / abstained)\n")
        seasons = [c["seasonId"] for c in report["perCutoff"]]
        out.append("| market | model | " + " | ".join(seasons) + " |\n| --- | --- |" + " --- |" * len(seasons))
        for mk, models in rd["perMarketSeason"].items():
            for m, by in models.items():
                out.append(f"| {mk} | {m} | " + " | ".join(
                    (f"{_f(by[s]['mae'], 2)} ({by[s]['nScored']}/{by[s]['nAbstained']})" if s in by else "n/a") for s in seasons) + " |")
        out.append("")
    dec = rd["releaseDecision"]
    out.append("### Release decision under the registered rule\n")
    out.append(f"Rule: {dec['rule']}\n")
    out.append("| market | release model | best baseline | C choice | common n | reason |\n| --- | --- | --- | --- | --- | --- |")
    for mk, d in dec["perMarket"].items():
        out.append(f"| {mk} | **{d['releaseModel']}** | {d.get('bestBaseline')} | {d.get('cChoice')} | {d.get('nCommon')} | {d['reason']} |")
    out.append("")
    if rd.get("leakagePerturbation"):
        lp = rd["leakagePerturbation"]
        out.append(f"### Post-cutoff perturbation check\n\n{lp['description']} Result: {'passed' if lp['passed'] else 'FAILED'} ({lp['nCutoffs']} cutoffs).\n")
    return "\n".join(out) + "\n"


def markdown_summary(report: dict[str, Any]) -> str:
    out = []
    if report["synthetic"]:
        out.append("> **SYNTHETIC DATA - NOT A MARKET EVALUATION.** Generated series for code verification only; not ginger data and not any real market.\n")
    out.append(f"# Forecast ablation report `{report['runId']}`\n")
    cv = report["codeVersion"]
    out.append(f"- mode: **{report['mode']}{' (real)' if not report['synthetic'] else ''}**\n- runDate: {report['runDate']}\n- codeVersion: git {cv['gitSha'] or 'none'}, sourceHash {cv['sourceHash']}, package {cv['packageVersion']}\n"
               f"- dataSnapshotId: {report['dataSnapshotId']}\n- product: {report['productId']}; markets: {', '.join(report['marketIds'])}\n"
               f"- target: {report['target']['statistic']} ({report['target']['unit']})\n- training policy: {json.dumps(report['trainingPolicy'], sort_keys=True)}\n"
               f"- cutoffs: {', '.join(c['decisionCutoff'] for c in report['perCutoff'])}\n- leakage checks: {'passed' if report['leakageChecks']['passed'] else 'FAILED'} ({report['leakageChecks']['nChecks']} checks)\n")
    if report.get("realData"):
        out.append(real_data_markdown(report))
    out.append("## Aggregate (all cutoffs, all markets)\n")
    out.append(aggregate_table(report) + "\n")
    cs = report["aggregate"]["commonSet"]
    out.append(f"## Paired comparison on common targets (n={cs['nCommonTargets']})\n")
    out.append(f"Excluded (no scored targets): {', '.join(cs['modelsExcludedNoScoredTargets']) or 'none'}\n")
    out.append("| model | MAE | MASE | WIS80 | coverage80 |\n| --- | --- | --- | --- | --- |")
    for m, s in cs["perModel"].items():
        out.append(f"| {m} | {_f(s['mae'])} | {_f(s['mase'])} | {_f(s['wis80'])} | {_f(s['coverage80'])} |")
    out.append("\n## Per season MAE (n scored)\n")
    seasons = [c["seasonId"] for c in report["perCutoff"]]
    out.append("| model | " + " | ".join(seasons) + " |\n| --- |" + " --- |" * len(seasons))
    for m in report["aggregate"]["models"]:
        rows = {b["value"]: b for b in report["aggregate"]["breakdowns"][m["modelId"]]["seasonId"]}
        out.append(f"| {m['modelId']} | " + " | ".join(f"{_f(rows[s]['mae'])} ({rows[s]['nScored']})" if s in rows else "n/a" for s in seasons) + " |")
    out.append("\n## Abstentions\n")
    for m in report["aggregate"]["models"]:
        if m["abstainReasons"]:
            out.append(f"- {m['modelId']}: {json.dumps(m['abstainReasons'], sort_keys=True)}")
    out.append("\n## Limitations\n")
    out += [f"- {x}" for x in report["limitations"]]
    return "\n".join(out) + "\n"
