"""Exogenous feature groups. Every function receives an AvailableView, never a raw table.

weather_climatology: observed weekly totals of one weather variable for the market's mapped supply
region, expressed as an anomaly against a per-ISO-week climatology. The climatology is fitted only
on complete weeks inside the training window that ended before the decision cutoff; future weather
is never used. No weather forecast is used: archived multi-week forecasts do not exist for planting
horizons (docs/DATA_AUDIT.md section 7), so the future is implicitly climatological.

satellite_anomaly: placeholder. Enabled only when rows exist; even then this release has no
validated satellite transform, so the group abstains instead of fabricating a value.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .availability import AvailableView
from .weekly import week_start


def iso_week_bucket(weeks: pd.DatetimeIndex | pd.Series) -> np.ndarray:
    wk = pd.DatetimeIndex(weeks).isocalendar().week.to_numpy(dtype=int)
    return np.where(wk == 53, 52, wk)


def weekly_input_series(view: AvailableView, region_id: str, variable: str, index: pd.DatetimeIndex) -> pd.Series:
    """Weekly sums of the variable aligned to `index` (Monday starts). Weeks without full 7-day coverage are NaN."""
    f = view.frame
    f = f[(f["regionId"] == region_id) & (f["variable"] == variable) & f["value"].notna()]
    if f.empty:
        return pd.Series(np.nan, index=index)
    ws = week_start(f["periodStart"]).values
    days = (f["periodEnd"] - f["periodStart"]).dt.days + 1
    g = pd.DataFrame({"ws": ws, "v": f["value"].to_numpy(), "d": days.to_numpy()}).groupby("ws")
    total = g["v"].sum()
    covered = g["d"].sum()
    s = total.where(covered == 7)
    return s.reindex(index)


def weekly_climatology(weekly: pd.Series, *, first_week: pd.Timestamp, last_week: pd.Timestamp) -> pd.Series:
    """Mean weekly value per ISO week bucket (1..52; week 53 pooled with 52), fitted on [first_week, last_week] only."""
    w = weekly[(weekly.index >= first_week) & (weekly.index <= last_week)].dropna()
    if w.empty:
        return pd.Series(dtype=float)
    return pd.Series(w.to_numpy(), index=iso_week_bucket(w.index)).groupby(level=0).mean()


def window_anomaly(weekly: pd.Series, clim: pd.Series, window_weeks: int) -> np.ndarray:
    """For each position p: sum over weeks p-window+1..p of (value - climatology). NaN if any input missing."""
    buckets = iso_week_bucket(weekly.index)
    clim_vals = clim.reindex(buckets).to_numpy(dtype=float)
    dev = weekly.to_numpy(dtype=float) - clim_vals
    return pd.Series(dev).rolling(window_weeks, min_periods=window_weeks).sum().to_numpy()
