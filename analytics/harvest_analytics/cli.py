"""Fixed JSON-in/JSON-out entrypoint registry.

Usage: python -m harvest_analytics <entrypoint> < input.json > output.json

The worker launches this with an allowlisted argv list (no shell). Entrypoints are looked up in
ENTRYPOINTS only; the name is never used to import or execute anything dynamically.
Exit codes: 0 ok, 2 usage/unknown entrypoint, 3 invalid input JSON, 4 entrypoint error.
"""

from __future__ import annotations

import json
import sys
from typing import Any, Callable, TextIO

from . import __version__
from .forecast import entrypoints as forecast_ep

Entrypoint = Callable[[dict[str, Any]], dict[str, Any]]


def ping(payload: dict[str, Any]) -> dict[str, Any]:
    return {"ok": True, "version": __version__, "echo": payload}


ENTRYPOINTS: dict[str, Entrypoint] = {
    "ping": ping,
    "forecast.replay": forecast_ep.replay,
    "forecast.ablation": forecast_ep.ablation,
    "forecast.synthetic_series": forecast_ep.synthetic_series,
}


# --- T05b: agronomy evidence extraction (separate block to minimise merge friction) ---
from .extract.pdf_text import pdf_text_entrypoint as _extract_pdf_text  # noqa: E402

ENTRYPOINTS["extract.pdf_text"] = _extract_pdf_text
# --- end T05b ---

def main(argv: list[str] | None = None, stdin: TextIO | None = None, stdout: TextIO | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout
    if len(argv) != 1 or argv[0] not in ENTRYPOINTS:
        print(json.dumps({"error": "unknown_entrypoint", "allowed": sorted(ENTRYPOINTS)}), file=sys.stderr)
        return 2
    try:
        payload = json.loads(stdin.read() or "{}")
        if not isinstance(payload, dict):
            raise ValueError("input must be a JSON object")
    except ValueError as exc:
        print(json.dumps({"error": "invalid_input", "message": str(exc)}), file=sys.stderr)
        return 3
    try:
        result = ENTRYPOINTS[argv[0]](payload)
    except Exception as exc:  # noqa: BLE001 - boundary: report, do not traceback to caller
        print(json.dumps({"error": "entrypoint_failed", "message": str(exc)}), file=sys.stderr)
        return 4
    json.dump(result, stdout, sort_keys=True, allow_nan=False)
    stdout.write("\n")
    return 0
