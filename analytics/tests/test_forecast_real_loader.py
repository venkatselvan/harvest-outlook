"""Real-data loader (T07b): canonicalisation, export integrity, availability basis, release rule, end-to-end run.

The end-to-end test converts the SYNTHETIC generator series into the export format with non-syn test IDs; it checks
plumbing only and says nothing about real accuracy.
"""

from __future__ import annotations

import gzip
import hashlib
import json

import pytest

from harvest_analytics.forecast import real_loader as rl
from harvest_analytics.forecast.contracts import normalize_source_rows
from harvest_analytics.forecast.errors import ContractError

from forecast_helpers import case as syn_case

ALIASES = {"t:mkt_a": ["src:a-old", "src:a-new-apmc"], "t:mkt_b": ["src:b"]}


def test_canonical_market_id_uses_pinned_aliases_only():
    assert rl.canonical_market_id("src:a-new-apmc", ALIASES) == "t:mkt_a"
    assert rl.canonical_market_id("t:mkt_b", ALIASES) == "t:mkt_b"
    assert rl.canonical_market_id("src:a-new", ALIASES) is None  # no fuzzy matching


def test_suffixed_paths():
    assert rl.suffixed("data/x/rows.json.gz", "v1") == "data/x/rows-v1.json.gz"
    assert rl.suffixed("e/m.json", "v1") == "e/m-v1.json"
    assert rl.suffixed("e/m.json", None) == "e/m.json"


def test_assumed_basis_is_accepted_and_converted():
    out = normalize_source_rows([{"rowId": "mo:1", "marketId": "t:mkt_a", "productId": "p", "observedOn": "2020-01-01",
                                  "minPrice": 1500, "maxPrice": 2500, "modalPrice": 2000, "priceUnit": "INR/quintal",
                                  "sourceId": "src:x", "availableAt": "2020-01-01T18:30:00Z",
                                  "availableAtBasis": "assumed_publication_lag_1d", "revisionOf": None}])
    assert out[0]["modalInrPerKg"] == 20.0 and out[0]["availableAtBasis"] == "assumed_publication_lag_1d"


def _req(tmp_path, seasons, markets=("t:mkt_a", "t:mkt_b")):
    return {"caseId": "t-case", "synthetic": False, "dataMode": "replay", "productId": "p", "marketIds": list(markets),
            "marketAliases": {m: [] for m in markets}, "seasons": seasons,
            "trainingPolicy": {"kind": "expanding", "minTrainWeeks": 80},
            "modelConfig": {"candidates": [{"id": "C_base", "featureGroups": {}}, {"id": "C_weather", "featureGroups": {"weather_climatology": True}}],
                            "candidate": {"weatherRegionByMarket": {m: "t:region" for m in markets}}},
            "exportPath": str(tmp_path / "rows.json.gz"), "exportManifestPath": str(tmp_path / "manifest.json"),
            "availabilityPolicy": {"prices": {"basis": "assumed_publication_lag_1d", "lagDays": 1},
                                   "weather": {"basis": "assumed_reanalysis_lag_6d", "lagDays": 6}},
            "releaseRule": {"minCommonTargets": 20, "minCoverage80": 0.6}}


def _write_export(tmp_path, req, price_rows, weather_rows, tamper=False):
    payload = {"caseId": req["caseId"], "productId": req["productId"], "sourcePriceRows": price_rows, "weatherInputs": weather_rows}
    text = json.dumps(payload).encode()
    (tmp_path / "rows.json.gz").write_bytes(gzip.compress(text + (b" " if tamper else b"")))
    manifest = {"export": {"path": "rows.json.gz", "sha256Json": hashlib.sha256(text).hexdigest()},
                "prices": {"exported": len(price_rows), "excludedByReason": {}, "excludedByMarket": {}, "perMarket": {}},
                "weather": {"exported": len(weather_rows)}, "source": {"unitBasis": "test"}}
    (tmp_path / "manifest.json").write_text(json.dumps(manifest))


def _from_synthetic():
    c = syn_case("default")
    rename = {"syn.mkt_a": "t:mkt_a", "syn.mkt_b": "t:mkt_b"}
    prices = [{"rowId": o["rowId"].replace("syn.", "t.", 1), "marketId": rename[o["marketId"]], "productId": "p", "observedOn": o["observedOn"],
               "minPrice": None if o["minInrPerKg"] is None else round(o["minInrPerKg"] * 100, 2),
               "maxPrice": None if o["maxInrPerKg"] is None else round(o["maxInrPerKg"] * 100, 2),
               "modalPrice": None if o["modalInrPerKg"] is None else round(o["modalInrPerKg"] * 100, 2),
               "priceUnit": "INR/quintal", "arrivals": None, "arrivalsUnit": None, "sourceId": "src:t",
               "availableAt": o["availableAt"], "availableAtBasis": "assumed_publication_lag_1d",
               "revisionOf": None if o["revisionOf"] is None else o["revisionOf"].replace("syn.", "t.", 1)} for o in c["observations"]]
    weather = [{**w, "rowId": w["rowId"].replace("syn.", "t.", 1), "regionId": "t:region", "sourceId": "src:w",
                "availableAtBasis": "assumed_reanalysis_lag_6d"} for w in c["weatherInputs"]]
    from harvest_analytics.forecast.ablation import seasons_from_template
    seasons = seasons_from_template(c["seasonTemplate"])[2:]
    return prices, weather, seasons


def test_export_hash_mismatch_is_rejected(tmp_path, monkeypatch):
    monkeypatch.setattr(rl, "ALLOWED_EXPORT_ROOTS", (tmp_path,))
    req = _req(tmp_path, [])
    _write_export(tmp_path, req, [], [], tamper=True)
    with pytest.raises(ContractError, match="sha256"):
        rl.load_export(req)


def test_unregistered_market_and_syn_ids_are_rejected(tmp_path, monkeypatch):
    monkeypatch.setattr(rl, "ALLOWED_EXPORT_ROOTS", (tmp_path,))
    req = _req(tmp_path, [])
    row = {"rowId": "mo:1", "marketId": "t:other", "productId": "p", "observedOn": "2020-01-01", "minPrice": None,
           "maxPrice": None, "modalPrice": 2000, "priceUnit": "INR/quintal", "sourceId": "src:x",
           "availableAt": "2020-01-01T18:30:00Z", "revisionOf": None}
    _write_export(tmp_path, req, [row], [])
    payload, manifest = rl.load_export(req)
    with pytest.raises(ContractError, match="unregistered market"):
        rl.build_case(req, payload, manifest)


def test_export_path_must_stay_under_allowed_roots():
    with pytest.raises(ContractError):
        rl.load_request("/etc/hosts.json")


def _rec(model, market, week, err, lo, hi, season="s1", scored=True):
    y = 100.0
    return {"modelId": model, "marketId": market, "productId": "p", "seasonId": season, "targetWeek": week, "abstained": not scored,
            "abstainReason": None if scored else "x", "realized": y, "scored": scored, "absError": abs(err),
            "scaledAbsError": abs(err) / 10, "pinball": {"q10": 1.0, "q50": abs(err) / 2, "q90": 1.0},
            "wis80": abs(err) + (hi - lo) / 10, "covered80": lo <= y <= hi, "width80": hi - lo}


def test_release_rule_prefers_baseline_unless_candidate_wins_on_both():
    recs = []
    for i in range(25):
        w = f"2022-W{i}"
        recs += [_rec("A_last_value", "m", w, 10, 80, 120), _rec("B_seasonal_reference", "m", w, 8, 85, 115),
                 _rec("C_base", "m", w, 6, 90, 110), _rec("C_weather", "m", w, 7, 90, 110)]
    dec = rl.release_decision(recs, ["m"], {"minCommonTargets": 20, "minCoverage80": 0.6})["perMarket"]["m"]
    assert dec["cChoice"] == "C_base" and dec["releaseModel"] == "C_base"
    # Candidate better on MAE but intervals miss: coverage below the floor -> baseline.
    recs2 = [r if r["modelId"] != "C_base" else {**r, "covered80": False} for r in recs]
    dec2 = rl.release_decision(recs2, ["m"], {"minCommonTargets": 20, "minCoverage80": 0.6})["perMarket"]["m"]
    assert dec2["releaseModel"] == "B_seasonal_reference"
    # Too few common targets -> baseline.
    dec3 = rl.release_decision(recs[:40], ["m"], {"minCommonTargets": 20, "minCoverage80": 0.6})["perMarket"]["m"]
    assert dec3["releaseModel"] == "B_seasonal_reference" and dec3["nCommon"] == 10


def test_release_rule_no_baseline_means_no_forecast():
    recs = [_rec("A_last_value", "m", "w1", 1, 0, 200, scored=False), _rec("B_seasonal_reference", "m", "w1", 1, 0, 200, scored=False),
            _rec("C_base", "m", "w1", 1, 90, 110)]
    assert rl.release_decision(recs, ["m"], {"minCommonTargets": 1, "minCoverage80": 0.6})["perMarket"]["m"]["releaseModel"] == "none"


def test_end_to_end_real_path_on_converted_synthetic_series(tmp_path, monkeypatch):
    monkeypatch.setattr(rl, "ALLOWED_EXPORT_ROOTS", (tmp_path,))
    monkeypatch.setattr(rl, "ALLOWED_REQUEST_ROOT", tmp_path)
    prices, weather, seasons = _from_synthetic()
    req = _req(tmp_path, seasons)
    _write_export(tmp_path, req, prices, weather)
    (tmp_path / "request.json").write_text(json.dumps(req))
    report = rl.run_real({"requestPath": str(tmp_path / "request.json"), "runId": "t-run", "runDate": "2026-10-30T00:00:00Z"})
    assert report["mode"] == "replay" and report["synthetic"] is False
    rd = report["realData"]
    assert rd["leakagePerturbation"]["passed"] and rd["leakagePerturbation"]["nCutoffs"] == len(seasons)
    assert rd["availabilityAssumptions"]["priceRowsByBasis"]["assumed_publication_lag_1d"] > 0
    assert set(rd["releaseDecision"]["perMarket"]) == {"t:mkt_a", "t:mkt_b"}
    assert report["leakageChecks"]["passed"]
    assert any("ASSUMED availability" in x for x in report["limitations"])
    assert not any(x.startswith("Selection on the evaluation set") for x in report["limitations"])
