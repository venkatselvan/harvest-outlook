import numpy as np
import pandas as pd

from harvest_analytics.forecast.availability import ExclusionLog
from harvest_analytics.forecast.contracts import observations_frame
from harvest_analytics.forecast.weekly import daily_values, weekly_series

from forecast_helpers import obs_row


def frame():
    return observations_frame([
        obs_row("a1", "2023-01-02", 10.0, lo=9, hi=11, arrivals=5),     # week of 2023-01-02
        obs_row("a2", "2023-01-04", 12.0, lo=11, hi=13, arrivals=15),
        obs_row("a3", "2023-01-05", 30.0, lo=8, hi=20),                 # modal > max: invalid, excluded
        obs_row("a4", "2023-01-05", 11.0, source="syn.other"),
        obs_row("a5", "2023-01-05", 13.0, source="syn.third"),
        # week of 2023-01-09 has no rows at all
        obs_row("b1", "2023-01-17", 20.0, arrivals=1),
    ])


def test_missing_weeks_are_nan_not_zero_and_medians_are_used():
    log = ExclusionLog()
    w = weekly_series(daily_values(frame(), log), "weekly_median_modal")["syn.mkt_a"]
    assert list(w.index.strftime("%Y-%m-%d")) == ["2023-01-02", "2023-01-09", "2023-01-16"]
    assert np.isnan(w.loc["2023-01-09", "value"]) and w.loc["2023-01-09", "nDays"] == 0
    # daily values: 10, 12, median(11, 13)=12 -> weekly median 12
    assert w.loc["2023-01-02", "value"] == 12.0
    assert log.counts == {"invalid_price_or_ordering": 1}
    # min/max preserved separately (quotation range, not an interval)
    assert w.loc["2023-01-02", "minInrPerKg"] == 9 and w.loc["2023-01-02", "maxInrPerKg"] == 13


def test_arrival_weighted_requires_valid_arrivals_every_day():
    log = ExclusionLog()
    df = frame()
    df = df[df["rowId"].isin(["a1", "a2", "b1"])]
    w = weekly_series(daily_values(df), "weekly_arrival_weighted_modal", log=log)["syn.mkt_a"]
    assert w.loc["2023-01-02", "value"] == (10 * 5 + 12 * 15) / 20
    df2 = frame()
    df2 = df2[df2["rowId"].isin(["a1", "a4"])]  # a4 has no arrivals -> week missing, not replaced
    w2 = weekly_series(daily_values(df2), "weekly_arrival_weighted_modal", log=log)["syn.mkt_a"]
    assert np.isnan(w2.loc["2023-01-02", "value"])
    assert log.counts["week_missing_arrivals_for_weighted_statistic"] >= 1
