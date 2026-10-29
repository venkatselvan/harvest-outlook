import pandas as pd
import pytest

from harvest_analytics.forecast.availability import AvailableView, snapshot_as_of, to_utc
from harvest_analytics.forecast.contracts import observations_frame
from harvest_analytics.forecast.errors import LeakageError

from forecast_helpers import obs_row

CUTOFF = to_utc("2023-03-01T00:00:00Z")


def test_feature_row_after_cutoff_raises_leakage_error_with_rows():
    df = observations_frame([obs_row("ok", "2023-02-20", 10.0), obs_row("late", "2023-02-27", 11.0, available="2023-03-02T00:00:00Z")])
    with pytest.raises(LeakageError) as e:
        AvailableView(df, CUTOFF, "price_observation")
    assert [r["rowId"] for r in e.value.rows] == ["late"]


def test_revision_after_cutoff_is_excluded_and_original_used():
    df = observations_frame([
        obs_row("orig", "2023-02-20", 10.0, available="2023-02-21T12:00:00Z"),
        obs_row("rev", "2023-02-20", 99.0, available="2023-03-05T00:00:00Z", revision_of="orig"),
    ])
    view = snapshot_as_of(df, CUTOFF, kind="p", date_col="observedOn")
    assert view.frame["rowId"].tolist() == ["orig"]
    assert view.frame["modalInrPerKg"].tolist() == [10.0]
    assert view.exclusions.counts == {"revision_not_yet_available": 1}
    later = snapshot_as_of(df, to_utc("2023-03-10T00:00:00Z"), kind="p", date_col="observedOn")
    assert later.frame["rowId"].tolist() == ["rev"]
    assert later.exclusions.counts == {"superseded_by_revision": 1}


def test_revision_chain_picks_latest_available_version():
    df = observations_frame([
        obs_row("o", "2023-02-01", 10.0, available="2023-02-02T00:00:00Z"),
        obs_row("r1", "2023-02-01", 11.0, available="2023-02-10T00:00:00Z", revision_of="o"),
        obs_row("r2", "2023-02-01", 12.0, available="2023-03-10T00:00:00Z", revision_of="r1"),
    ])
    view = snapshot_as_of(df, CUTOFF, kind="p", date_col="observedOn")
    assert view.frame["rowId"].tolist() == ["r1"]


def test_unverifiable_vintage_and_unpublished_rows_are_excluded():
    df = observations_frame([
        obs_row("est", "2023-02-01", 10.0, basis="estimated"),
        obs_row("ub", "2023-02-02", 10.0, basis="conservative_upper_bound"),
        obs_row("pub_late", "2023-02-28", 10.0, available="2023-03-01T06:00:00Z"),
        obs_row("future", "2023-03-03", 10.0),
    ])
    view = snapshot_as_of(df, CUTOFF, kind="p", date_col="observedOn")
    assert view.frame["rowId"].tolist() == ["ub"]
    assert view.exclusions.counts == {"observed_after_cutoff": 1, "published_after_cutoff": 1, "unverifiable_vintage": 1}


def test_cutoff_requires_timezone():
    with pytest.raises(ValueError):
        to_utc("2023-03-01T00:00:00")
    assert to_utc("2023-03-01T05:30:00+05:30") == pd.Timestamp("2023-03-01T00:00:00Z")
