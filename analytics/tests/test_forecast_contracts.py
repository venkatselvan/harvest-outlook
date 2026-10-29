import pytest

from harvest_analytics.forecast.contracts import (KG_PER_QUINTAL, arrivals_to_tonnes, normalize_source_rows,
                                                  observations_frame, price_to_inr_per_kg)
from harvest_analytics.forecast.errors import ContractError

from forecast_helpers import obs_row


def src(**over):
    r = {"rowId": "r1", "marketId": "m.a", "productId": "p.x", "observedOn": "2023-01-02", "minPrice": 2000,
         "maxPrice": 3150, "modalPrice": 2575, "priceUnit": "INR/quintal", "arrivals": 125, "arrivalsUnit": "quintal",
         "sourceId": "s", "availableAt": "2023-01-03T06:00:00Z", "revisionOf": None}
    r.update(over)
    return r


def test_quintal_conversion_is_explicit_and_exact():
    assert KG_PER_QUINTAL == 100
    assert price_to_inr_per_kg(2575, "INR/quintal") == 25.75
    assert price_to_inr_per_kg(0.1 + 0.2, "INR/kg") == 0.3
    assert price_to_inr_per_kg(None, "INR/quintal") is None
    assert arrivals_to_tonnes(125, "quintal") == 12.5


@pytest.mark.parametrize("unit", [None, "", "Rs/qtl", "INR/tonne"])
def test_unknown_or_missing_price_unit_raises(unit):
    with pytest.raises(ContractError):
        price_to_inr_per_kg(2500, unit)


def test_arrivals_without_unit_raise():
    with pytest.raises(ContractError):
        arrivals_to_tonnes(10, None)


def test_loader_converts_and_records_source_unit():
    [row] = normalize_source_rows([src()])
    assert (row["minInrPerKg"], row["maxInrPerKg"], row["modalInrPerKg"]) == (20.0, 31.5, 25.75)
    assert row["arrivalsTonnes"] == 12.5
    assert row["sourceUnit"] == "INR/quintal"


def test_loader_rejects_row_without_unit():
    bad = src()
    del bad["priceUnit"]
    with pytest.raises(ContractError):
        normalize_source_rows([bad])


def test_observation_schema_requires_offset_and_unique_ids():
    with pytest.raises(ContractError):
        observations_frame([obs_row("a", "2023-01-02", 10.0, available="2023-01-02T12:00:00")])
    with pytest.raises(ContractError):
        observations_frame([obs_row("a", "2023-01-02", 10.0), obs_row("a", "2023-01-03", 11.0)])
    with pytest.raises(ContractError):
        observations_frame([obs_row("b", "2023-01-02", 10.0, revision_of="missing")])
