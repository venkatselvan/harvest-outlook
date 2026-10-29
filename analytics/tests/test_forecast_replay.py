import copy

import numpy as np
import pandas as pd
import pytest

from harvest_analytics.forecast.contracts import inputs_frame, observations_frame
from harvest_analytics.forecast.errors import ContractError, FreezeViolation
from harvest_analytics.forecast.models import finalize
from harvest_analytics.forecast.replay import RealizedVault, freeze, run_replay

from forecast_helpers import case, request


def frames(c):
    return observations_frame(c["observations"]), inputs_frame(c["weatherInputs"]) if c["weatherInputs"] else None


def test_finalize_rejects_crossing_and_flags_negative():
    w = pd.Timestamp("2023-01-02")
    assert finalize("m", "k", w, 30, 5, 4, 6)["abstainReason"] == "defect:quantile_crossing"
    assert finalize("m", "k", w, 30, np.nan, 4, 6)["abstainReason"] == "defect:non_finite_quantile"
    p = finalize("m", "k", w, 30, -1.0, 2.0, 3.0)
    assert p["quantiles"]["q10"] == 0.0 and p["negativeQuantilesReported"] is True


def test_replay_predictions_ordered_non_negative_and_audited():
    obs, wx = frames(case())
    out = run_replay(request(2022), obs, wx, mode="synthetic")
    preds = [p for p in out["predictions"] if not p["abstained"]]
    assert preds, "expected some non-abstaining predictions"
    for p in preds:
        q = p["quantiles"]
        assert 0 <= q["q10"] <= q["q50"] <= q["q90"]
    assert {c["name"] for c in out["leakageChecks"]} >= {"feature_rows_available_by_cutoff", "predictions_frozen_before_realized_join"}
    assert all(c["passed"] for c in out["leakageChecks"])
    assert out["featureAudit"]["priceObservations"]["maxAvailableAt"] <= out["decisionCutoff"]
    assert out["mode"] == "synthetic" and out["synthetic"] is True


def test_predictions_invariant_to_post_cutoff_data():
    c = case()
    obs, wx = frames(c)
    a = run_replay(request(2022), obs, wx, mode="synthetic")
    c2 = copy.deepcopy(c)
    for r in c2["observations"]:
        if r["availableAt"] > "2022-04-30T18:30:00Z":
            r["modalInrPerKg"] *= 10
            r["maxInrPerKg"] *= 10
            r["minInrPerKg"] *= 10
    for r in c2["weatherInputs"]:
        if r["availableAt"] > "2022-04-30T18:30:00Z":
            r["value"] = 5000.0
    obs2, wx2 = frames(c2)
    b = run_replay(request(2022), obs2, wx2, mode="synthetic")
    assert a["predictionsHash"] == b["predictionsHash"]
    assert a["realizedTarget"] != b["realizedTarget"]  # realized values did change


def test_post_cutoff_revision_does_not_change_last_quote():
    c = case()
    obs, _ = frames(c)
    req = request(2022, modelConfig={"candidates": []})
    base = run_replay(req, obs, mode="synthetic")
    last = [r for r in c["observations"] if r["marketId"] == "syn.mkt_a" and r["availableAt"] < "2022-04-30T18:30:00Z"]
    last = max(last, key=lambda r: r["observedOn"])
    c["observations"].append({**last, "rowId": "late_rev", "modalInrPerKg": last["maxInrPerKg"], "revisionOf": last["rowId"],
                              "availableAt": "2022-05-03T00:00:00Z"})
    out = run_replay(req, observations_frame(c["observations"]), mode="synthetic")
    a_info = [f for f in out["fittedModels"] if f["modelId"] == "A_last_value" and f["marketId"] == "syn.mkt_a"][0]
    assert a_info["lastQuote"] == last["modalInrPerKg"]
    assert out["predictionsHash"] == base["predictionsHash"]
    assert out["exclusionReport"]["priceObservations"]["counts"]["revision_not_yet_available"] >= 1


def test_freeze_detects_mutation_and_vault_requires_freeze():
    obs, _ = frames(case())
    vault = RealizedVault(obs, "weekly_median_modal", True)
    preds = [{"modelId": "A", "marketId": "syn.mkt_a", "targetWeek": "2022-12-05", "quantiles": {"q50": 1.0}}]
    with pytest.raises(FreezeViolation):
        vault.realize(preds)
    frozen = freeze(preds)
    realized = vault.realize(frozen)
    assert realized[("syn.mkt_a", "2022-12-05")]["value"] is not None
    preds[0]["quantiles"]["q50"] = 2.0
    with pytest.raises(FreezeViolation):
        vault.realize(frozen)
    assert vault.reads == 1


def test_baseline_b_near_zero_on_perfectly_seasonal_series_and_a_is_not():
    obs, _ = frames(case("perfect"))
    req = request(2022, marketIds=["syn.mkt_a"], modelConfig={"candidates": []})
    out = run_replay(req, obs, mode="synthetic")
    pm = out["scores"]["perModel"]
    realized = np.mean([r["value"] for r in out["realizedTarget"] if r["value"] is not None])
    assert pm["B_seasonal_reference"]["nScored"] >= 10
    assert pm["B_seasonal_reference"]["mae"] < 0.02 * realized
    assert pm["A_last_value"]["mae"] > 10 * pm["B_seasonal_reference"]["mae"]


def test_rolling_policy_training_never_includes_test_weeks():
    obs, wx = frames(case())
    for year in (2020, 2021, 2022, 2023):
        req = request(year, trainingPolicy={"kind": "rolling", "minTrainWeeks": 60, "rollingWeeks": 104})
        out = run_replay(req, obs, wx, mode="synthetic")
        first_target = out["target"]["weeks"][0]["targetWeek"]
        for a in out["featureAudit"]["trainingLabels"]:
            assert a["nWeeks"] == 104
            assert a["lastWeekEnd"] < out["decisionCutoffLocalDate"] < first_target
            assert a["maxLabelAvailableAt"] <= out["decisionCutoff"]


def test_insufficient_training_weeks_abstains_all_models():
    obs, wx = frames(case())
    out = run_replay(request(2020, trainingPolicy={"kind": "expanding", "minTrainWeeks": 500}), obs, wx, mode="synthetic")
    assert all(p["abstained"] and p["abstainReason"] == "insufficient_training_weeks" for p in out["predictions"])


def test_targets_must_follow_cutoff_and_horizon_limit_is_reported():
    obs, wx = frames(case())
    with pytest.raises(ContractError):
        run_replay(request(2022, harvestWindow={"start": "2022-04-01", "end": "2022-06-30"}), obs, wx, mode="synthetic")
    out = run_replay(request(2022, horizonWeeks=35), obs, wx, mode="synthetic")
    assert out["exclusionReport"]["targetsBeyondHorizon"]
    assert max(t["horizonWeeks"] for t in out["target"]["weeks"]) <= 35


def test_baseline_a_abstains_on_stale_last_quote():
    """Review finding M2: data stopping 2021-05 with cutoff 2022-05-01 must not yield A forecasts from a ~49-week-old quote."""
    c = case()
    c["observations"] = [r for r in c["observations"] if r["observedOn"] < "2021-05-15"]
    out = run_replay(request(2022, modelConfig={"candidates": []}), observations_frame(c["observations"]), mode="synthetic")
    a = [p for p in out["predictions"] if p["modelId"] == "A_last_value"]
    assert a and all(p["abstained"] and p["abstainReason"] == "stale_last_quote" for p in a)
    summary = out["scores"]["perModel"]["A_last_value"]
    assert summary["nAbstained"] == len(a) and summary["abstainReasons"] == {"stale_last_quote": len(a)}
    info = [f for f in out["fittedModels"] if f["modelId"] == "A_last_value"]
    assert all(f["status"] == "stale_last_quote" and f["lastQuoteAgeDays"] > 3 * 7 for f in info)


def test_baseline_a_quote_within_stale_limit_still_predicts():
    c = case()
    # Drop only the last 2 weeks before the cutoff: the last quote is within maxStaleWeeks=3 of the origin week.
    c["observations"] = [r for r in c["observations"] if not ("2022-04-11" <= r["observedOn"] <= "2022-05-01")]
    out = run_replay(request(2022, modelConfig={"candidates": []}), observations_frame(c["observations"]), mode="synthetic")
    a = [p for p in out["predictions"] if p["modelId"] == "A_last_value"]
    assert not any(p["abstainReason"] == "stale_last_quote" for p in a)
    assert any(not p["abstained"] for p in a)
    # Tightening the limit to 0 weeks makes the same quote stale.
    out0 = run_replay(request(2022, modelConfig={"candidates": [], "maxStaleWeeks": 0}), observations_frame(c["observations"]), mode="synthetic")
    assert all(p["abstainReason"] == "stale_last_quote" for p in out0["predictions"] if p["modelId"] == "A_last_value")
