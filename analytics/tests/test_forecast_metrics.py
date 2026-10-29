import numpy as np
import pytest

from harvest_analytics.forecast.metrics import covered, interval_score, mase_scale, pinball, summarize, wis


def test_pinball_hand_computed():
    y = np.array([10.0, 10.0, 10.0])
    q = np.array([8.0, 10.0, 13.0])
    assert pinball(y, q, 0.1).tolist() == pytest.approx([0.2, 0.0, 2.7])
    assert pinball(y, q, 0.9).tolist() == pytest.approx([1.8, 0.0, 0.3])
    assert pinball(y, q, 0.5).tolist() == pytest.approx([1.0, 0.0, 1.5])


def test_interval_score_wis_coverage_width_hand_computed():
    y = np.array([5.0, 12.0, 20.0])
    lo, med, hi = np.array([8.0, 8.0, 8.0]), np.array([10.0, 10.0, 10.0]), np.array([14.0, 14.0, 14.0])
    # IS_0.2: width 6 + 10*(below) + 10*(above)
    assert interval_score(y, lo, hi, 0.2).tolist() == pytest.approx([36.0, 6.0, 66.0])
    # WIS = (0.5|y-m| + 0.1*IS) / 1.5
    assert wis(y, lo, med, hi, 0.2).tolist() == pytest.approx([(2.5 + 3.6) / 1.5, (1.0 + 0.6) / 1.5, (5.0 + 6.6) / 1.5])
    assert covered(y, lo, hi).tolist() == [False, True, False]
    assert (hi - lo).mean() == 6.0


def test_mase_scale_uses_seasonal_naive_on_given_training_values():
    v = np.r_[np.arange(52, dtype=float), np.arange(52, dtype=float) + 2.0]
    assert mase_scale(v) == pytest.approx(2.0)
    assert mase_scale(np.arange(10.0)) is None
    v[60] = np.nan
    assert mase_scale(v) == pytest.approx(2.0)


def test_summary_keeps_denominators():
    base = {"marketId": "m", "targetWeek": "2023-01-02", "seasonId": "s", "horizonWeeks": 30}
    recs = [
        {**base, "abstained": True, "abstainReason": "insufficient_training_weeks", "realized": 10.0, "scored": False},
        {**base, "abstained": False, "realized": None, "scored": False, "quantiles": {"q10": 1, "q50": 2, "q90": 3}},
        {**base, "abstained": False, "realized": 10.0, "scored": True, "absError": 2.0, "scaledAbsError": 1.0,
         "pinball": {"q10": 0.1, "q50": 1.0, "q90": 1.8}, "wis80": 1.2, "covered80": True, "width80": 4.0},
    ]
    s = summarize(recs)
    assert (s["nTargets"], s["nAbstained"], s["nPredicted"], s["nUnscoredMissingRealized"], s["nScored"]) == (3, 1, 2, 1, 1)
    assert s["abstainReasons"] == {"insufficient_training_weeks": 1}
    assert s["mae"] == 2.0 and s["coverage80"] == 1.0 and s["maeCI90"] is None
