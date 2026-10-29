"""Ginger CropRule candidates and StageDefinitions (Hassan, Karnataka; kharif).

Candidates are written with reviewStatus "candidate". `curate.apply_rule_labels`
derives the reviewed set from evals/labels/extraction/ginger-rules-labels.json:
  correct -> approved, incorrect -> disabled, unsupported -> candidate.
Only allowlisted RuleContext fields (packages/contracts/src/rules.ts) are used.
"""

from __future__ import annotations

from typing import Any

E = "ev.ginger.iisr2025."
C = "ev.ginger.crida2011."
HASSAN_ID = "IN-KA-hassan"
KARNATAKA_ID = "IN-KA"


def _rule(rid: str, *, scope: dict[str, Any], when: dict[str, Any], effect: tuple[str, str], evidence: list[str],
          exceptions: list[dict[str, Any]] | None = None, product: str | None = "ginger.fresh") -> dict[str, Any]:
    return {
        "schemaVersion": "1.0",
        "id": rid,
        "version": 1,
        "mode": "live",
        "cropId": "ginger",
        "productId": product,
        "scope": scope,
        "when": when,
        "exceptions": exceptions or [],
        "effect": {"type": effect[0], "reasonCode": effect[1]},
        "alternatives": [],
        "evidenceIds": evidence,
        "reviewStatus": "candidate",
    }


NATIONAL_ANY = {"regionIds": ["IN"], "seasons": [], "irrigation": []}

CANDIDATE_RULES: list[dict[str, Any]] = [
    _rule(
        "rule.ginger.soil-drainage-poor",
        scope=NATIONAL_ANY,
        when={"field": "soil.drainage", "op": "eq", "value": "poor"},
        effect=("requires_review", "poor_drainage_soft_rot_risk"),
        evidence=[E + "p3.soil-well-drained", E + "p16.soft-rot-drainage", E + "p15.drainage-channels"],
    ),
    _rule(
        "rule.ginger.soil-drainage-unknown",
        scope=NATIONAL_ANY,
        when={"field": "soil.drainage", "op": "known", "value": False},
        effect=("requires_review", "drainage_unknown_soft_rot_risk"),
        evidence=[E + "p16.soft-rot-drainage"],
    ),
    _rule(
        "rule.ginger.soil-drainage-good",
        scope=NATIONAL_ANY,
        when={"field": "soil.drainage", "op": "eq", "value": "good"},
        effect=("prefer", "well_drained_soil"),
        evidence=[E + "p3.soil-well-drained"],
    ),
    _rule(
        "rule.ginger.soil-texture-listed",
        scope=NATIONAL_ANY,
        when={"field": "soil.texture", "op": "in", "value": ["sandy_loam", "clay_loam", "loam"]},
        effect=("prefer", "source_listed_soil_texture"),
        evidence=[E + "p3.soil-well-drained"],
    ),
    _rule(
        "rule.ginger.soil-texture-unlisted",
        scope=NATIONAL_ANY,
        when={"field": "soil.texture", "op": "in", "value": ["sand", "loamy_sand", "silt_loam", "silty_clay", "clay"]},
        effect=("caution", "soil_texture_not_listed_by_source"),
        evidence=[E + "p3.soil-well-drained"],
    ),
    _rule(
        "rule.ginger.elevation-above-source-range",
        scope=NATIONAL_ANY,
        when={"not": {"field": "elevation.m", "op": "lte", "value": 1500}},
        effect=("requires_review", "elevation_above_source_cultivation_range"),
        evidence=[E + "p3.altitude-and-water-regime"],
    ),
    _rule(
        "rule.ginger.rainfed-rainfall-below-requirement",
        scope={"regionIds": ["IN"], "seasons": [], "irrigation": ["rainfed"]},
        when={"not": {"field": "rainfall.seasonalMm", "op": "gte", "value": 1300}},
        effect=("caution", "rainfed_rainfall_below_crop_water_requirement"),
        evidence=[E + "p14.water-requirement", E + "p14.rainfed-vs-irrigated"],
    ),
    # State-wide rule with a district-level exception built from the two
    # documents' differing scopes: IISR (national water need, rainfed only in
    # high-rainfall areas) + CRIDA (Hassan district normal annual rainfall).
    _rule(
        "rule.ginger.ka.rainfed-rainfall-unknown",
        scope={"regionIds": [KARNATAKA_ID], "seasons": [], "irrigation": ["rainfed"]},
        when={"field": "rainfall.seasonalMm", "op": "known", "value": False},
        effect=("requires_review", "rainfed_rainfall_unknown"),
        evidence=[E + "p14.rainfed-vs-irrigated", E + "p14.water-requirement"],
        exceptions=[
            {
                "id": "exc.ginger.hassan-district-normal-rainfall",
                "when": {"field": "location.districtId", "op": "eq", "value": HASSAN_ID},
                "effect": {"type": "caution", "reasonCode": "hassan_normal_annual_rainfall_below_crop_requirement"},
                "evidenceIds": [C + "p1.rainfall-annual", E + "p14.water-requirement"],
                "note": "CRIDA Hassan district normal annual rainfall 1031.2 mm (p1) is below the IISR crop-cycle water requirement of 1300-1500 mm (p14). Annual rain exceeds crop-cycle rain, so the comparison is conservative. District normal; intra-district variation not sourced.",
            }
        ],
    ),
    _rule(
        "rule.ginger.planting-month-outside-sourced-window",
        scope={"regionIds": ["IN"], "seasons": [], "irrigation": ["rainfed"]},
        when={"not": {"field": "planting.month", "op": "eq", "value": 5}},
        effect=("requires_review", "planting_month_outside_sourced_window"),
        evidence=[E + "p10.planting-season-west-coast"],
    ),
    _rule(
        "rule.ginger.hassan.may-premonsoon-planting",
        scope={"regionIds": [HASSAN_ID], "seasons": [], "irrigation": ["rainfed"]},
        when={"field": "planting.month", "op": "eq", "value": 5},
        effect=("prefer", "may_premonsoon_planting"),
        evidence=[E + "p10.planting-season-west-coast", C + "p10.rain-onset", C + "p1.rainfall-summer"],
    ),
    _rule(
        "rule.ginger.irrigated-early-planting",
        scope={"regionIds": ["IN"], "seasons": [], "irrigation": ["irrigated"]},
        when={"field": "planting.month", "op": "in", "value": [2, 3]},
        effect=("prefer", "irrigated_early_planting_feb_mar"),
        evidence=[E + "p10.planting-irrigated-early"],
    ),
]


# ---------------- Stage definitions ----------------
_STAGE_LIMITS = [
    "Durations are calendar-day values from the national ICAR-IISR guide (Feb 2025), not Hassan-specific measurements; actual growth must be confirmed by field observations.",
    "Thermal-time (degree-day) timing is unsupported: no validated base temperature or GDD parameters were sourced.",
]


def _stage(stage_id: str, name: str, order: int, starts_after: str | None, dmin: int, dmax: int, evidence: list[str],
           limitations: list[str], is_harvest: bool = False) -> dict[str, Any]:
    return {
        "schemaVersion": "1.0",
        "id": f"stage.ginger.hassan-kharif.{stage_id}",
        "mode": "live",
        "cropId": "ginger",
        "varietyId": None,
        "scope": {"level": "district", "ids": [HASSAN_ID]},
        "seasons": ["kharif"],
        "stageId": stage_id,
        "name": name,
        "order": order,
        "startsAfter": starts_after,
        "prerequisites": [starts_after] if starts_after else ["planting_confirmed"],
        "method": "calendar_days",
        "durationDays": {"min": dmin, "max": dmax},
        "thermal": None,
        "isHarvest": is_harvest,
        "repeat": None,
        "evidenceIds": evidence,
        "limitations": _STAGE_LIMITS + limitations,
        "reviewStatus": "candidate",
    }


STAGES: list[dict[str, Any]] = [
    _stage(
        "sprouting_vegetative", "Sprouting and vegetative growth (planting to rhizome initiation)", 0, None, 90, 90,
        [E + "p14.critical-stages", E + "p3.rainfall-pattern", E + "p15.soft-rot-monsoon-moisture"],
        ["The source gives rhizome initiation as a single point (90 DAP), not a range; min = max = 90 is the source value, not a precision claim.",
         "Sprouting/emergence duration is not stated in the sources."],
    ),
    _stage(
        "rhizome_initiation", "Rhizome initiation (90 to 135 DAP)", 1, "sprouting_vegetative", 45, 45,
        [E + "p14.critical-stages", E + "p14.mulching-repeat"],
        ["Bounded by two single-point source values (90 and 135 DAP); no range is sourced."],
    ),
    _stage(
        "rhizome_development", "Rhizome development (135 to 180 DAP)", 2, "rhizome_initiation", 45, 45,
        [E + "p14.critical-stages", E + "p25.maturity-days"],
        ["Ends where the source says vegetable-purpose harvest may start (after 180 days); Table 5 gives 5-6 months for vegetable purpose, which is earlier than 180 days."],
    ),
    _stage(
        "maturation", "Maturation (180 DAP to full maturity); fresh vegetable-purpose harvest possible on demand", 3, "rhizome_development", 30, 60,
        [E + "p25.maturity-days", E + "p25.irrigation-stop", E + "p3.rainfall-pattern", E + "p25.end-use-dry"],
        ["Range 30-60 days = full maturity 210-240 DAP minus 180 DAP.",
         "Source: irrigation is stopped one month before harvest and dry weather for about a month before harvest is necessary."],
    ),
    _stage(
        "harvest_full_maturity", "Harvest at full maturity (leaves turn yellow and start drying)", 4, "maturation", 0, 0,
        [E + "p25.maturity-days", E + "p25.harvest-indicator-dry", E + "p25.late-harvest"],
        ["Harvest window opens at 210-240 DAP. The leaf yellowing/drying indicator is stated for dry-ginger harvest at full maturity.",
         "Late harvest is practiced for 'some months' per source; that duration is not quantified, so the window length is 0 days here and must not be read as a deadline."],
        is_harvest=True,
    ),
]

# Source-stated total crop duration used by the chain-sum test.
SOURCE_TOTAL_DURATION_DAYS = {"min": 210, "max": 240, "evidenceId": E + "p25.maturity-days"}
