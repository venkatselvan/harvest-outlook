"""Shared helpers for forecast tests. All data here is synthetic."""

from __future__ import annotations

import copy
from functools import lru_cache

from harvest_analytics.forecast.synthetic import generate


@lru_cache(maxsize=None)
def _case(key: str):
    if key == "default":
        return generate()
    if key == "perfect":
        return generate({"noiseSd": 0.0, "trendPerYear": 0.0, "shock": None, "revisionRate": 0.0, "missingBlocks": [],
                         "dailyReporting": True, "rainDeficit": None, "includeWeather": False,
                         "markets": [{"marketId": "syn.mkt_a", "levelInrPerKg": 40.0}]})
    raise KeyError(key)


def case(key: str = "default"):
    return copy.deepcopy(_case(key))


def obs_row(row_id, day, modal, *, market="syn.mkt_a", product="syn.p", available=None, revision_of=None,
            lo=None, hi=None, arrivals=None, basis=None, source="syn.src"):
    r = {"rowId": row_id, "marketId": market, "productId": product, "observedOn": day,
         "minInrPerKg": lo, "maxInrPerKg": hi, "modalInrPerKg": modal, "arrivalsTonnes": arrivals,
         "sourceId": source, "availableAt": available or f"{day}T12:00:00Z", "revisionOf": revision_of,
         "sourceUnit": "INR/kg"}
    if basis:
        r["availableAtBasis"] = basis
    return r


def request(season_year=2022, **over):
    r = {
        "decisionCutoff": f"{season_year}-05-01T00:00:00+05:30", "seasonId": f"{season_year}",
        "productId": "syn.ginger_like", "marketIds": ["syn.mkt_a", "syn.mkt_b"],
        "plantingWindow": {"start": f"{season_year}-05-01", "end": f"{season_year}-05-31"},
        "harvestWindow": {"start": f"{season_year}-12-01", "end": f"{season_year + 1}-02-28"},
        "trainingPolicy": {"kind": "expanding", "minTrainWeeks": 80},
        "dataSnapshotId": "test", "horizonWeeks": 44,
        "modelConfig": {"candidates": [{"id": "C_base", "featureGroups": {}},
                                       {"id": "C_weather", "featureGroups": {"weather_climatology": True}}],
                        "candidate": {"weatherRegionByMarket": {"syn.mkt_a": "syn.region_1", "syn.mkt_b": "syn.region_1"}}},
    }
    r.update(over)
    return r
