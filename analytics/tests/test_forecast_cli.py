import io
import json
from pathlib import Path

from harvest_analytics import cli
from harvest_analytics.forecast.synthetic import generate

from forecast_helpers import case, request

FIXTURE = Path(__file__).resolve().parents[2] / "evals" / "cases" / "forecast" / "synthetic_ginger_like.json"


def run(name, payload):
    out, err = io.StringIO(), io.StringIO()
    import contextlib
    with contextlib.redirect_stderr(err):
        code = cli.main([name], io.StringIO(json.dumps(payload)), out)
    return code, (json.loads(out.getvalue()) if out.getvalue() else None), err.getvalue()


def test_forecast_entrypoints_registered():
    assert {"forecast.replay", "forecast.ablation", "forecast.synthetic_series"} <= set(cli.ENTRYPOINTS)


def test_synthetic_series_is_labelled():
    code, out, _ = run("forecast.synthetic_series", {"params": {"seed": 3}})
    assert code == 0 and out["synthetic"] is True and out["mode"] == "synthetic" and "NOT GINGER" in out["label"]
    assert all(r["productId"].startswith("syn.") for r in out["observations"])


def test_fixture_is_small_labelled_and_reproducible():
    assert FIXTURE.stat().st_size < 300_000
    data = json.loads(FIXTURE.read_text())
    assert data["synthetic"] is True and "NOT GINGER" in data["label"]
    assert data == json.loads(json.dumps(generate(data["generator"]["params"]), sort_keys=True))


def test_replay_entrypoint_and_mode_guards():
    c = case()
    payload = {"request": request(2022), "dataMode": "synthetic", "observations": c["observations"], "weatherInputs": c["weatherInputs"]}
    code, out, _ = run("forecast.replay", payload)
    assert code == 0 and out["mode"] == "synthetic" and len(out["predictionsHash"]) == 64
    code, _, err = run("forecast.replay", {**payload, "dataMode": "replay"})
    assert code == 4 and "refusing to mix modes" in err
    code, _, err = run("forecast.replay", {k: v for k, v in payload.items() if k != "dataMode"})
    assert code == 4 and "dataMode" in err


def test_ablation_case_path_is_restricted():
    code, _, err = run("forecast.ablation", {"casePath": "/etc/passwd.json"})
    assert code == 4 and "casePath" in err
    code, _, err = run("forecast.ablation", {"casePath": "../../analytics/pyproject.json"})
    assert code == 4


def test_ablation_via_fixture_summary_only():
    code, out, _ = run("forecast.ablation", {"casePath": "evals/cases/forecast/synthetic_ginger_like.json", "summaryOnly": True,
                                             "runDate": "2026-10-30T00:00:00Z"})
    assert code == 0 and out["synthetic"] is True and out["leakageChecks"]["passed"] is True
    assert "_written" not in out
