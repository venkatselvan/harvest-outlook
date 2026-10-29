"""Data contracts: JSON Schema validation, explicit unit conversion, typed frames.

Canonical price unit is INR/kg. A source unit is never inferred from magnitude: every source row
must state its unit, and the conversion constant is explicit (1 quintal = 100 kg).
"""

from __future__ import annotations

import json
from decimal import Decimal
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable

import pandas as pd
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

from .errors import ContractError

SCHEMA_DIR = Path(__file__).resolve().parent.parent / "schemas"
SCHEMA_BASE = "https://harvest-outlook.local/analytics/schema/"

# Explicit, tested conversion constants. 1 quintal = 100 kg (Indian mandi convention).
KG_PER_QUINTAL = Decimal(100)
PRICE_FACTOR_TO_INR_PER_KG: dict[str, Decimal] = {
    "INR/kg": Decimal(1),
    "INR/quintal": Decimal(1) / KG_PER_QUINTAL,
}
TONNES_PER_QUINTAL = Decimal("0.1")
ARRIVALS_FACTOR_TO_TONNES: dict[str, Decimal] = {"tonnes": Decimal(1), "quintal": TONNES_PER_QUINTAL}

OBSERVATION_COLUMNS = [
    "rowId", "marketId", "productId", "observedOn", "minInrPerKg", "maxInrPerKg", "modalInrPerKg",
    "arrivalsTonnes", "sourceId", "availableAt", "availableAtBasis", "revisionOf", "sourceUnit",
]
INPUT_COLUMNS = [
    "rowId", "regionId", "periodStart", "periodEnd", "variable", "value", "unit", "sourceId",
    "availableAt", "availableAtBasis", "revisionOf",
]


@lru_cache(maxsize=None)
def _registry() -> Registry:
    resources = []
    for path in sorted(SCHEMA_DIR.glob("*.schema.json")):
        doc = json.loads(path.read_text())
        resources.append((doc["$id"], Resource.from_contents(doc)))
    return Registry().with_resources(resources)


@lru_cache(maxsize=None)
def load_schema(name: str) -> dict[str, Any]:
    return json.loads((SCHEMA_DIR / f"{name}.schema.json").read_text())


@lru_cache(maxsize=None)
def _validator(name: str) -> Draft202012Validator:
    return Draft202012Validator(load_schema(name), registry=_registry())


def validate(instance: Any, schema_name: str, *, what: str | None = None) -> None:
    errors = sorted(_validator(schema_name).iter_errors(instance), key=lambda e: list(e.absolute_path))
    if errors:
        msgs = [f"{'/'.join(map(str, e.absolute_path)) or '<root>'}: {e.message}" for e in errors[:10]]
        raise ContractError(f"{what or schema_name} failed schema validation: " + "; ".join(msgs))


def validate_rows(rows: Iterable[dict[str, Any]], schema_name: str) -> None:
    validator = _validator(schema_name)
    for i, row in enumerate(rows):
        errs = list(validator.iter_errors(row))
        if errs:
            e = errs[0]
            raise ContractError(f"row {i} ({row.get('rowId') if isinstance(row, dict) else '?'}) failed {schema_name}: "
                                f"{'/'.join(map(str, e.absolute_path)) or '<root>'}: {e.message}")


def price_to_inr_per_kg(value: float | int | None, unit: str) -> float | None:
    """Convert a source price to INR/kg with Decimal arithmetic. Unknown units raise."""
    if unit not in PRICE_FACTOR_TO_INR_PER_KG:
        raise ContractError(f"unsupported or missing price unit {unit!r}; units are never inferred")
    if value is None:
        return None
    return float((Decimal(str(value)) * PRICE_FACTOR_TO_INR_PER_KG[unit]).quantize(Decimal("0.0001")))


def arrivals_to_tonnes(value: float | int | None, unit: str | None) -> float | None:
    if value is None:
        return None
    if unit not in ARRIVALS_FACTOR_TO_TONNES:
        raise ContractError(f"arrivals value present but unit {unit!r} is not supported; units are never inferred")
    return float((Decimal(str(value)) * ARRIVALS_FACTOR_TO_TONNES[unit]).quantize(Decimal("0.0001")))


def normalize_source_rows(raw_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Source-unit rows -> canonical INR/kg observation rows. The source unit is recorded per row."""
    validate_rows(raw_rows, "source_price_row")
    out = []
    for r in raw_rows:
        unit = r["priceUnit"]
        out.append({
            "rowId": r["rowId"],
            "marketId": r["marketId"],
            "productId": r["productId"],
            "observedOn": r["observedOn"],
            "minInrPerKg": price_to_inr_per_kg(r["minPrice"], unit),
            "maxInrPerKg": price_to_inr_per_kg(r["maxPrice"], unit),
            "modalInrPerKg": price_to_inr_per_kg(r["modalPrice"], unit),
            "arrivalsTonnes": arrivals_to_tonnes(r.get("arrivals"), r.get("arrivalsUnit")),
            "sourceId": r["sourceId"],
            "availableAt": r["availableAt"],
            "revisionOf": r.get("revisionOf"),
            "sourceUnit": unit,
        })
        if r.get("availableAtBasis", "recorded") != "recorded":
            out[-1]["availableAtBasis"] = r["availableAtBasis"]
    validate_rows(out, "observation_row")
    return out


def _check_lineage(df: pd.DataFrame) -> None:
    if df["rowId"].duplicated().any():
        dups = df.loc[df["rowId"].duplicated(), "rowId"].tolist()[:10]
        raise ContractError(f"duplicate rowId values: {dups}")
    ids = set(df["rowId"])
    missing = [r for r in df["revisionOf"].dropna().tolist() if r not in ids]
    if missing:
        raise ContractError(f"revisionOf references unknown rowIds: {missing[:10]}")


def observations_frame(rows: list[dict[str, Any]], *, validated: bool = False) -> pd.DataFrame:
    """Validate canonical observation rows and return a typed frame.

    observedOn is a naive calendar date (region-local); availableAt is a tz-aware UTC timestamp.
    """
    if not validated:
        validate_rows(rows, "observation_row")
    df = pd.DataFrame(rows, columns=OBSERVATION_COLUMNS)
    df["availableAtBasis"] = df["availableAtBasis"].astype(object).where(df["availableAtBasis"].notna(), "recorded")
    df["observedOn"] = pd.to_datetime(df["observedOn"], format="%Y-%m-%d")
    df["availableAt"] = pd.to_datetime(df["availableAt"], utc=True, format="ISO8601")
    for c in ["minInrPerKg", "maxInrPerKg", "modalInrPerKg", "arrivalsTonnes"]:
        df[c] = pd.to_numeric(df[c], errors="coerce").astype(float)
    df["revisionOf"] = df["revisionOf"].astype(object).where(df["revisionOf"].notna(), None)
    _check_lineage(df)
    return df


def inputs_frame(rows: list[dict[str, Any]], *, validated: bool = False) -> pd.DataFrame:
    if not validated:
        validate_rows(rows, "input_row")
    df = pd.DataFrame(rows, columns=INPUT_COLUMNS)
    df["availableAtBasis"] = df["availableAtBasis"].astype(object).where(df["availableAtBasis"].notna(), "recorded")
    df["periodStart"] = pd.to_datetime(df["periodStart"], format="%Y-%m-%d")
    df["periodEnd"] = pd.to_datetime(df["periodEnd"], format="%Y-%m-%d")
    df["availableAt"] = pd.to_datetime(df["availableAt"], utc=True, format="ISO8601")
    df["value"] = pd.to_numeric(df["value"], errors="coerce").astype(float)
    df["revisionOf"] = df["revisionOf"].astype(object).where(df["revisionOf"].notna(), None)
    if ((df["periodEnd"] - df["periodStart"]).dt.days > 6).any() or (df["periodEnd"] < df["periodStart"]).any():
        raise ContractError("input rows must cover 1..7 days (periodStart <= periodEnd <= periodStart+6)")
    _check_lineage(df)
    return df
