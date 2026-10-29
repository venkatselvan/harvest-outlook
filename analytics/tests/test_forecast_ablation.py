import json

import pytest

from harvest_analytics.forecast.ablation import run_ablation
from harvest_analytics.forecast.contracts import validate
from harvest_analytics.forecast.errors import ContractError

from forecast_helpers import case


@pytest.fixture(scope="module")
def report(tmp_path_factory):
    out = tmp_path_factory.mktemp("results")
    rep = run_ablation(case(), run_id="test-run", results_dir=out, run_date="2026-10-30T00:00:00Z")
    return rep, out / "test-run"


def test_report_validates_and_is_marked_synthetic(report):
    rep, d = report
    on_disk = json.loads((d / "report.json").read_text())
    validate(on_disk, "replay_report")
    assert on_disk["mode"] == "synthetic" and on_disk["synthetic"] is True and "SYNTHETIC" in on_disk["banner"]
    assert on_disk["leakageChecks"]["passed"] is True
    assert "SYNTHETIC DATA - NOT A MARKET EVALUATION" in (d / "summary.md").read_text()
    assert any("No real market evaluation exists yet" in x for x in on_disk["limitations"])


def test_satellite_group_abstains_and_is_never_fabricated(report):
    rep, _ = report
    sat = [m for m in rep["aggregate"]["models"] if m["modelId"] == "C_satellite"][0]
    assert sat["nScored"] == 0 and sat["nAbstained"] == sat["nTargets"] > 0
    assert list(sat["abstainReasons"]) == ["feature_group_unavailable:satellite_anomaly:no_rows"]
    assert "C_satellite" in rep["aggregate"]["commonSet"]["modelsExcludedNoScoredTargets"]


def test_every_cutoff_trains_before_its_targets(report):
    rep, _ = report
    assert len(rep["perCutoff"]) == 4
    for c in rep["perCutoff"]:
        first = c["targetWeeks"][0]["targetWeek"]
        for a in c["trainingLabels"]:
            assert a["lastWeekEnd"] < first
        assert all(x["passed"] for x in c["leakageChecks"])


def test_schema_rejects_mislabelled_synthetic_report(report):
    rep, _ = report
    bad = json.loads(json.dumps({k: v for k, v in rep.items() if k != "_written"}))
    bad["mode"] = "replay"
    with pytest.raises(ContractError):
        validate(bad, "replay_report")
    bad = json.loads(json.dumps({k: v for k, v in rep.items() if k != "_written"}))
    bad["leakageChecks"]["passed"] = False
    with pytest.raises(ContractError):
        validate(bad, "replay_report")


def test_ablation_is_reproducible(report):
    rep, _ = report
    again = run_ablation(case(), run_id="test-run", write=False, run_date="2026-10-30T00:00:00Z")
    assert [c["predictionsHash"] for c in again["perCutoff"]] == [c["predictionsHash"] for c in rep["perCutoff"]]
    assert again["aggregate"] == rep["aggregate"]
