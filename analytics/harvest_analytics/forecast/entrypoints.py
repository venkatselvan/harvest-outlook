"""JSON-in/JSON-out handlers registered in harvest_analytics.cli. No dynamic imports, no shell."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .ablation import REPO_ROOT, run_ablation
from .contracts import inputs_frame, normalize_source_rows, observations_frame
from .errors import ContractError
from .real_loader import run_real
from .replay import run_replay
from .synthetic import generate

ALLOWED_CASE_ROOTS = (REPO_ROOT / "evals" / "cases", REPO_ROOT / "data" / "curated")
SYNTHETIC_PREFIX = "syn."


def load_case_path(path_str: str) -> dict[str, Any]:
    p = Path(path_str)
    p = (REPO_ROOT / p if not p.is_absolute() else p).resolve()
    if p.suffix != ".json" or not any(p.is_relative_to(root.resolve()) for root in ALLOWED_CASE_ROOTS):
        raise ContractError("casePath must be a .json file under evals/cases/ or data/curated/")
    return json.loads(p.read_text())


def check_mode_separation(case: dict[str, Any]) -> None:
    ids = [case.get("productId", "")] + list(case.get("marketIds", []))
    syn_ids = [i for i in ids if str(i).startswith(SYNTHETIC_PREFIX)]
    if case.get("synthetic") is True and len(syn_ids) != len(ids):
        raise ContractError("synthetic cases must use 'syn.' product and market IDs")
    if case.get("synthetic") is not True and syn_ids:
        raise ContractError("non-synthetic case uses synthetic 'syn.' IDs; refusing to mix modes")


def _case(payload: dict[str, Any]) -> dict[str, Any]:
    if "casePath" in payload:
        case = load_case_path(payload["casePath"])
    elif "case" in payload:
        case = payload["case"]
    else:
        raise ContractError("provide casePath or case")
    if "synthetic" not in case:
        raise ContractError("case must declare synthetic: true|false")
    check_mode_separation(case)
    return case


def synthetic_series(payload: dict[str, Any]) -> dict[str, Any]:
    return generate(payload.get("params"))


def ablation(payload: dict[str, Any]) -> dict[str, Any]:
    if "requestPath" in payload:
        # Real-data run under a pre-registered request (real_loader); no inline overrides of the registered config.
        if any(k in payload for k in ("case", "casePath", "seasons", "modelConfig", "trainingPolicy")):
            raise ContractError("requestPath runs take seasons, model and training policy only from the registered request")
        report = run_real(payload)
    else:
        report = _ablation_case(payload)
    if payload.get("summaryOnly"):
        return {k: report[k] for k in ("runId", "mode", "synthetic", "banner", "runDate", "codeVersion", "dataSnapshotId",
                                       "aggregate", "leakageChecks", "limitations", "realData") if k in report} | (
            {"_written": report["_written"]} if "_written" in report else {})
    return report


def _ablation_case(payload: dict[str, Any]) -> dict[str, Any]:
    case = _case(payload)
    return run_ablation(case, seasons=payload.get("seasons"), model_config=payload.get("modelConfig"),
                          training_policy=payload.get("trainingPolicy"), run_id=payload.get("runId"),
                          write=bool(payload.get("writeReport", False)), run_date=payload.get("runDate"))


def replay(payload: dict[str, Any]) -> dict[str, Any]:
    request = payload.get("request")
    if not isinstance(request, dict):
        raise ContractError("payload.request (replay request object) is required")
    if "casePath" in payload or "case" in payload:
        case = _case(payload)
    else:
        if payload.get("dataMode") not in ("synthetic", "replay"):
            raise ContractError("inline observations require dataMode: synthetic|replay")
        rows = payload.get("observations")
        if rows is None and payload.get("sourceRows") is not None:
            rows = normalize_source_rows(payload["sourceRows"])
        case = {"synthetic": payload["dataMode"] == "synthetic", "observations": rows or [],
                "weatherInputs": payload.get("weatherInputs") or [], "satelliteInputs": payload.get("satelliteInputs") or [],
                "productId": request["productId"], "marketIds": request["marketIds"]}
        check_mode_separation(case)
    obs = observations_frame(case["observations"])
    weather = inputs_frame(case["weatherInputs"]) if case.get("weatherInputs") else None
    sat = inputs_frame(case["satelliteInputs"]) if case.get("satelliteInputs") else None
    return run_replay(request, obs, weather, sat, mode="synthetic" if case["synthetic"] else "replay")
