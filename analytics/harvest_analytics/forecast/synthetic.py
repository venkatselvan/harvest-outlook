"""Seeded synthetic series for tests and development ONLY.

The output is labelled `synthetic: true`. It is not ginger data, not any real market, and must never
be shown as an observation or used as evidence of forecast accuracy. Shape is "ginger-like" only in
having one price season per year, sparse weekly reporting, arrivals, a supply-region rainfall
series, a multi-month price shock and occasional source revisions.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

import numpy as np
import pandas as pd

from .contracts import normalize_source_rows

LABEL = "SYNTHETIC SERIES FOR TESTS/DEVELOPMENT ONLY - NOT GINGER DATA, NOT ANY REAL MARKET"

DEFAULTS: dict[str, Any] = {
    "seed": 7,
    "startDate": "2018-01-01",
    "endDate": "2024-03-31",
    "productId": "syn.ginger_like",
    "markets": [{"marketId": "syn.mkt_a", "levelInrPerKg": 40.0}, {"marketId": "syn.mkt_b", "levelInrPerKg": 46.0}],
    "regionId": "syn.region_1",
    "seasonalAmplitude": 0.30,
    "peakDayOfYear": 220,
    "trendPerYear": 0.03,
    "noiseSd": 0.05,
    "noiseAr": 0.7,
    "weekReportProbability": 0.92,
    "daysPerReportedWeek": [1],
    "dailyReporting": False,
    "shock": {"start": "2022-10-01", "end": "2023-03-31", "logLift": 0.45},
    "rainDeficit": {"start": "2022-06-01", "end": "2022-09-30", "factor": 0.5},
    "revisionRate": 0.02,
    "missingBlocks": [{"marketId": "syn.mkt_b", "start": "2020-07-01", "end": "2020-08-15"}],
    "publicationLagDays": 1,
    "weatherPublicationLagDays": 6,
    "includeWeather": True,
    "seasonTemplate": {
        "decisionMonthDay": "05-01",
        "plantingWindow": {"startMonthDay": "05-01", "endMonthDay": "05-31"},
        "harvestWindow": {"startMonthDay": "12-01", "endMonthDay": "02-28", "endYearOffset": 1},
        "seasonStartYears": [2020, 2021, 2022, 2023],
        "horizonWeeks": 44,
    },
}


def _merge(params: dict[str, Any] | None) -> dict[str, Any]:
    p = json.loads(json.dumps(DEFAULTS))
    for k, v in (params or {}).items():
        if k not in DEFAULTS:
            raise ValueError(f"unknown synthetic parameter {k}")
        p[k] = v
    return p


def generate(params: dict[str, Any] | None = None) -> dict[str, Any]:
    p = _merge(params)
    rng = np.random.default_rng(int(p["seed"]))
    days = pd.date_range(p["startDate"], p["endDate"], freq="D")
    weeks = pd.date_range(days[0] - pd.Timedelta(days=days[0].weekday()), days[-1], freq="7D")
    t_years = (days - days[0]).days.to_numpy() / 365.25
    doy = days.day_of_year.to_numpy()
    seasonal = p["seasonalAmplitude"] * np.cos(2 * np.pi * (doy - p["peakDayOfYear"]) / 365.25)
    # Shared weekly AR(1) noise, held constant within the week.
    eps = np.zeros(len(weeks))
    for i in range(1, len(weeks)):
        eps[i] = p["noiseAr"] * eps[i - 1] + rng.normal(0, p["noiseSd"])
    week_idx = ((days - weeks[0]).days // 7).to_numpy()
    shock = np.zeros(len(days))
    if p["shock"]:
        m = (days >= p["shock"]["start"]) & (days <= p["shock"]["end"])
        shock[m] = p["shock"]["logLift"]

    raw_rows: list[dict[str, Any]] = []
    for mi, mk in enumerate(p["markets"]):
        mid = mk["marketId"]
        blocked = np.zeros(len(days), bool)
        for b in p["missingBlocks"]:
            if b["marketId"] == mid:
                blocked |= (days >= b["start"]) & (days <= b["end"])
        logp = np.log(mk["levelInrPerKg"]) + p["trendPerYear"] * t_years + seasonal + eps[week_idx] + shock
        logp += rng.normal(0, p["noiseSd"] * 0.3, len(days)) if p["noiseSd"] > 0 else 0.0
        if p["dailyReporting"]:
            report = np.ones(len(days), bool)
        else:
            report = np.zeros(len(days), bool)
            for wi in range(len(weeks)):
                if rng.random() > p["weekReportProbability"]:
                    continue
                k = int(rng.choice(p["daysPerReportedWeek"]))
                dd = rng.choice(6, size=k, replace=False)  # Mon..Sat
                for d in dd:
                    j = wi * 7 + int(d) - int((days[0] - weeks[0]).days)
                    if 0 <= j < len(days):
                        report[j] = True
        report &= ~blocked
        for j in np.flatnonzero(report):
            modal_q = int(round(float(np.exp(logp[j])) * 100))
            lo_q = int(round(modal_q * rng.uniform(0.8, 0.92))) if p["noiseSd"] > 0 else modal_q
            hi_q = int(round(modal_q * rng.uniform(1.06, 1.2))) if p["noiseSd"] > 0 else modal_q
            arrivals_q = None if rng.random() < 0.05 else int(round(400 * np.exp(-1.5 * seasonal[j] + rng.normal(0, 0.15))))
            day = days[j]
            avail = (day + pd.Timedelta(days=p["publicationLagDays"], hours=12, minutes=30)).strftime("%Y-%m-%dT%H:%M:%SZ")
            rid = f"{'ab'[mi] if mi < 2 else mi}{j:05d}"
            raw_rows.append({"rowId": rid, "marketId": mid, "productId": p["productId"], "observedOn": day.strftime("%Y-%m-%d"),
                             "minPrice": lo_q, "maxPrice": hi_q, "modalPrice": modal_q, "priceUnit": "INR/quintal",
                             "arrivals": arrivals_q, "arrivalsUnit": "quintal", "sourceId": "syn.gen",
                             "availableAt": avail, "revisionOf": None})
            if p["revisionRate"] > 0 and rng.random() < p["revisionRate"]:
                rev_modal = min(int(round(modal_q * 1.04)), hi_q)
                raw_rows.append({**raw_rows[-1], "rowId": rid + "r", "modalPrice": rev_modal, "revisionOf": rid,
                                 "availableAt": (day + pd.Timedelta(days=p["publicationLagDays"] + 9, hours=12, minutes=30)).strftime("%Y-%m-%dT%H:%M:%SZ")})

    observations = normalize_source_rows(raw_rows)
    weather_rows: list[dict[str, Any]] = []
    if p["includeWeather"]:
        for wi, ws in enumerate(weeks):
            we = ws + pd.Timedelta(days=6)
            if we > days[-1]:
                break
            monsoon = ws.month in (6, 7, 8, 9)
            mean = 60.0 if monsoon else 8.0
            if p["rainDeficit"] and pd.Timestamp(p["rainDeficit"]["start"]) <= ws <= pd.Timestamp(p["rainDeficit"]["end"]):
                mean *= p["rainDeficit"]["factor"]
            val = round(float(rng.gamma(2.0, mean / 2.0)), 1)
            weather_rows.append({"rowId": f"w{wi:04d}", "regionId": p["regionId"], "periodStart": ws.strftime("%Y-%m-%d"),
                                 "periodEnd": we.strftime("%Y-%m-%d"), "variable": "precipitation_sum", "value": val, "unit": "mm",
                                 "sourceId": "syn.gen",
                                 "availableAt": (we + pd.Timedelta(days=p["weatherPublicationLagDays"])).strftime("%Y-%m-%dT00:00:00Z"),
                                 "revisionOf": None})
    digest = hashlib.sha256(json.dumps(p, sort_keys=True).encode()).hexdigest()[:12]
    return {
        "synthetic": True,
        "mode": "synthetic",
        "label": LABEL,
        "generator": {"name": "harvest_analytics.forecast.synthetic", "version": "1", "params": p},
        "dataSnapshotId": f"synthetic-{digest}",
        "productId": p["productId"],
        "marketIds": [m["marketId"] for m in p["markets"]],
        "weatherRegionByMarket": {m["marketId"]: p["regionId"] for m in p["markets"]} if p["includeWeather"] else {},
        "seasonTemplate": p["seasonTemplate"],
        "observations": observations,
        "weatherInputs": weather_rows,
        "satelliteInputs": [],
    }
