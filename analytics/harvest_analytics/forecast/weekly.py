"""Weekly target construction.

Target (documented in docs/FORECASTING.md):
  weekly_median_modal: per market/product, the daily value is the median modal INR/kg across the
  distinct sources reporting that day; the weekly value is the median of valid daily values within
  the ISO week (Monday..Sunday, region-local calendar dates).
  weekly_arrival_weighted_modal: sum(modal * arrivals) / sum(arrivals) over the week's days, only
  when every reporting day has a valid positive arrivals value; otherwise the week is missing
  (recorded), never silently replaced by the median statistic.
Missing weeks are NaN, never zero. min/max are carried separately as quotation ranges.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .availability import ExclusionLog

STATISTICS = {
    "weekly_median_modal": "Median of valid daily modal prices (INR/kg) within the ISO week; daily value = median across sources.",
    "weekly_arrival_weighted_modal": "Arrival-weighted mean of daily modal prices (INR/kg) within the ISO week; only weeks where every reporting day has valid positive arrivals.",
}


def week_start(dates: pd.Series | pd.DatetimeIndex) -> pd.Series:
    d = pd.Series(pd.to_datetime(dates))
    return (d - pd.to_timedelta(d.dt.day_of_week, unit="D")).dt.normalize()


def valid_price_mask(df: pd.DataFrame) -> pd.Series:
    modal, lo, hi = df["modalInrPerKg"], df["minInrPerKg"], df["maxInrPerKg"]
    ok = np.isfinite(modal) & (modal > 0)
    ok &= lo.isna() | (lo <= modal)
    ok &= hi.isna() | (modal <= hi)
    ok &= lo.isna() | hi.isna() | (lo <= hi)
    return ok


def daily_values(df: pd.DataFrame, log: ExclusionLog | None = None) -> pd.DataFrame:
    """One row per (marketId, observedOn). Invalid prices are excluded and logged, not repaired."""
    mask = valid_price_mask(df)
    if log is not None:
        log.add("invalid_price_or_ordering", df.loc[~mask, "rowId"])
    v = df[mask]
    if v.empty:
        return pd.DataFrame(columns=["marketId", "observedOn", "modal", "min", "max", "arrivals", "nSources", "availableAt"])
    g = v.groupby(["marketId", "observedOn"], sort=True)
    out = g.agg(
        modal=("modalInrPerKg", "median"),
        min=("minInrPerKg", "min"),
        max=("maxInrPerKg", "max"),
        arrivals=("arrivalsTonnes", "first"),
        nSources=("sourceId", "nunique"),
        availableAt=("availableAt", "max"),
    ).reset_index()
    # Arrivals from several sources on one day are ambiguous (double counting risk): set missing.
    out.loc[out["nSources"] > 1, "arrivals"] = np.nan
    return out


def weekly_series(daily: pd.DataFrame, statistic: str = "weekly_median_modal", *,
                  start: pd.Timestamp | None = None, end: pd.Timestamp | None = None,
                  log: ExclusionLog | None = None) -> dict[str, pd.DataFrame]:
    """Per market: DataFrame indexed by ISO week start (Monday), full weekly range, NaN = missing."""
    if statistic not in STATISTICS:
        raise ValueError(f"unknown target statistic {statistic}")
    result: dict[str, pd.DataFrame] = {}
    if daily.empty:
        return result
    d = daily.assign(weekStart=week_start(daily["observedOn"]).values)
    for market, m in d.groupby("marketId", sort=True):
        g = m.groupby("weekStart", sort=True)
        w = pd.DataFrame({
            "nDays": g["modal"].count(),
            "minInrPerKg": g["min"].min(),
            "maxInrPerKg": g["max"].max(),
            "labelAvailableAt": g["availableAt"].max(),
        })
        arr_ok = g["arrivals"].apply(lambda s: bool(len(s)) and bool(np.all(np.isfinite(s.to_numpy(float)) & (s.to_numpy(float) > 0))))
        w["arrivalsTonnes"] = g["arrivals"].sum(min_count=1).where(arr_ok)
        if statistic == "weekly_median_modal":
            w["value"] = g["modal"].median()
        else:
            num = (m["modal"] * m["arrivals"]).groupby(m["weekStart"]).sum()
            den = g["arrivals"].sum()
            w["value"] = (num / den).where(arr_ok)
            if log is not None:
                bad = w.index[~arr_ok]
                log.add("week_missing_arrivals_for_weighted_statistic", [f"{market}:{x.date()}" for x in bad])
        lo = start if start is not None else w.index.min()
        hi = end if end is not None else w.index.max()
        idx = pd.date_range(week_start(pd.Series([lo])).iloc[0], week_start(pd.Series([hi])).iloc[0], freq="7D")
        w = w.reindex(idx)
        w.index.name = "weekStart"
        w["nDays"] = w["nDays"].fillna(0).astype(int)
        result[str(market)] = w
    return result
