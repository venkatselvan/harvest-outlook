import copy

import pandas as pd

from harvest_analytics.forecast.availability import snapshot_as_of, to_utc
from harvest_analytics.forecast.contracts import inputs_frame
from harvest_analytics.forecast.features import weekly_climatology, weekly_input_series

from forecast_helpers import case

CUTOFF = to_utc("2021-05-01T00:00:00+05:30")


def clim_for(rows):
    view = snapshot_as_of(inputs_frame(rows), CUTOFF, kind="weather_input", date_col="periodEnd")
    idx = pd.date_range("2017-12-25", "2021-04-19", freq="7D")
    s = weekly_input_series(view, "syn.region_1", "precipitation_sum", idx)
    return weekly_climatology(s, first_week=idx[0], last_week=idx[-1]), view


def test_climatology_uses_training_years_only_future_spike_does_not_move_it():
    rows = case()["weatherInputs"]
    base, _ = clim_for(rows)
    spiked = copy.deepcopy(rows)
    for r in spiked:
        if r["periodStart"] >= "2022-01-01":
            r["value"] = 10_000.0  # implausible future spike
    moved, view = clim_for(spiked)
    pd.testing.assert_series_equal(base, moved)
    assert view.max_available_at <= CUTOFF


def test_climatology_window_bound_is_respected_even_for_available_rows():
    rows = case()["weatherInputs"]
    view = snapshot_as_of(inputs_frame(rows), to_utc("2024-03-31T00:00:00Z"), kind="w", date_col="periodEnd")
    idx = pd.date_range("2017-12-25", "2024-03-18", freq="7D")
    s = weekly_input_series(view, "syn.region_1", "precipitation_sum", idx)
    a = weekly_climatology(s, first_week=idx[0], last_week=pd.Timestamp("2020-12-28"))
    s2 = s.copy()
    s2[s2.index > pd.Timestamp("2020-12-28")] = 10_000.0
    b = weekly_climatology(s2, first_week=idx[0], last_week=pd.Timestamp("2020-12-28"))
    pd.testing.assert_series_equal(a, b)
