import { Unit, type ToolName } from "@harvest/contracts";

/**
 * Server-side source of truth for the unit of a number a numericRef points at (F8, review R3a #2).
 * The model's `presentation.sourceUnit` is a declaration only: the gate derives the unit here and
 * rejects a ref whose declaration differs, or whose target has no derivable unit (fail closed).
 *
 * Two derivations, in order:
 * 1. Unit-bearing record: the pointer targets `value`/`amount` (or `value|amount/low|central|high`) of an
 *    object whose own `unit` field is a contract Unit (ValueRecord quantity/range, AreaValue, typed
 *    price/yield inputs). A ValueRecord whose `kind` is not quantity/range is refused.
 * 2. Legacy scalar fields whose unit is fixed by the contract field definition (EconomicsFigures
 *    `...Inr`, WaterRun `...Mm`, ForecastArtifact quantiles = target.unit 'INR/kg'), listed per tool below.
 *    `*` matches one pointer segment; `{a|b}` expands alternatives.
 *
 * Contract numbers with no Unit-enum equivalent are deliberately absent and therefore refused:
 * WaterRun.grossLitresPerHa (L/ha), FarmProfile water capacityMmPerWeek (mm/week), soil ph, soil
 * availableWaterMmPerM (mm/m), interpret_observation uncertainty.value, get_job_status progress,
 * request_visual_keyframes allowedStageCount, forecast missingness.fractionMissingWeeks, quantile levels.
 */
type UnitRule = { pattern: string; unit: Unit | ((result: unknown, segs: string[]) => Unit | null) };

const INR_FIGURES = "{grossRevenueInr|cashProductionCostInr|harvestCostInr|saleAndTransportCostInr|processingCostInr|netCashReturnInr|economicReturnInr}";
const RUN_MM = "{tawMm|etcMm|effectiveRainMm|effectiveRainFromForecastMm|netIrrigationMm|grossIrrigationMm|deepPercolationMm}";

export const TOOL_UNIT_MAP: Partial<Record<ToolName, UnitRule[]>> = {
  calculate_scenarios: [
    { pattern: `/result/scenarios/*/perHa/${INR_FIGURES}`, unit: "INR/ha" },
    { pattern: `/result/scenarios/*/total/${INR_FIGURES}`, unit: "INR" },
    { pattern: "/result/scenarios/*/perHa/marketableKgTotal", unit: "kg/ha" },
    { pattern: "/result/scenarios/*/total/marketableKgTotal", unit: "kg" },
    { pattern: "/result/scenarios/*/perHa/marketableQuantityKg/*/kg", unit: "kg/ha" },
    { pattern: "/result/scenarios/*/total/marketableQuantityKg/*/kg", unit: "kg" },
    { pattern: "/result/scenarios/*/{perHa|total}/breakEvenPriceInrPerKg", unit: "INR/kg" },
    { pattern: "/result/scenarios/*/{perHa|total}/breakEvenMarketableYieldKgPerHa", unit: "kg/ha" },
    { pattern: "/result/sensitivity/*/{netCashAtLowInputInrPerHa|netCashAtHighInputInrPerHa}", unit: "INR/ha" },
  ],
  calculate_water_balance: [
    { pattern: `/result/runs/*/${RUN_MM}`, unit: "mm" },
    { pattern: "/result/runs/*/grossLitresTotal", unit: "L" },
    { pattern: "/result/runs/*/stressDays", unit: "days" },
    { pattern: "/result/runs/*/events/*/netMm", unit: "mm" },
    { pattern: "/result/runs/*/daily/*/{etcMm|effectiveRainMm|irrigationNetMm|depletionEndMm}", unit: "mm" },
  ],
  get_market_outlook: [
    // ForecastArtifact.target.unit is the contract literal 'INR/kg'.
    { pattern: "/forecasts/*/predictions/*/quantiles/*/value", unit: "INR/kg" },
    { pattern: "/forecasts/*/horizonDays", unit: "days" },
  ],
  get_farm_context: [
    {
      pattern: "/farm/budget/value/amountInr",
      unit: (result) => {
        const per = (result as { farm?: { budget?: { value?: { per?: unknown } } } })?.farm?.budget?.value?.per;
        return per === "farm" ? "INR" : per === "ha" ? "INR/ha" : null;
      },
    },
  ],
};

/**
 * F13 (review R4 #7): where a unit-bearing record may sit, per tool. The record's own pointer (the object that
 * holds `unit`) must match one of these patterns exactly; a {value, unit} object anywhere else in a stored
 * result is refused. Only server-computed or catalogue-derived records are listed. Deliberately absent:
 * interpret_observation proposals and propose_plan_revision changes/diffs (model-proposed values), and every
 * tool not listed (no unit records accepted). Audit (F13): get_market_outlook echoes `marketIds` strings only;
 * screen_crops filters by the requested cropIds but its ValueRecords are built from the catalogue (kind
 * "category", no unit); no handler copies a model-supplied {value, unit} object into its result.
 */
export const UNIT_RECORD_OWNERS: Partial<Record<ToolName, string[]>> = {
  get_farm_context: ["/farm/area/value", "/farm/monitoring/references/*"],
  screen_crops: ["/results/*/dimensions/*/value"],
  get_market_outlook: ["/references/*"],
  // 2026-11-02 (ASSISTANT_FARM_BRIEFING_SPEC.md 2.1): every unit record the code-written farm briefing carries. The drift test
  // in apps/api/test/farm-briefing.test.ts walks a full briefing and fails when a {value, unit} sits anywhere else.
  get_farm_briefing: [
    "/farm/{area|budget}",
    "/cycle/{dayOfSeason|daysToHarvest}",
    "/weather/{observed|forecast}/*/{rainMm|tMinC|tMaxC}",
    "/weather/{rainLast7Days|rainNext7Days}",
    "/satellite/{ndvi|neighbourhoodNdvi|typicalRange|clearShare}",
    "/satellite/previous/ndvi",
    "/satellite/indices/*/mean",
    "/price/{harvestPrice|likelyRange}",
    "/price/latestObserved/median",
    "/economics/harvest/{yieldForField|revenueForField|costPerHa|profitForField}",
    "/economics/residue/surplusForField",
    "/economics/residue/options/*/incomeForField",
    "/economics/energy/{inputEnergyForField|residueEnergyForField}",
    "/economics/carbon/emissionsForField",
    "/economics/carbon/largestTerm/amount",
    "/soil/samples/*/depth",
    "/soil/readings/*/measured",
    "/plans/option/slots/*/{yield|harvestPrice|cost|margin}",
    "/journal/entries/*/{quantity|expense|sale}",
    "/journal/totalsSinceSowing/{sales|expenses}",
  ],
};

/** Expanded owner patterns per tool (for the briefing drift test). */
export function unitRecordOwnerPatterns(tool: ToolName): string[] {
  return (UNIT_RECORD_OWNERS[tool] ?? []).flatMap(expand);
}

/**
 * 2026-11-02: refs into a farm briefing are forecast-backed only under the forecast part of its weather section; observed
 * weather and every other section are not forecasts.
 */
export function isForecastBriefingPointer(pointer: string): boolean {
  return /^\/weather\/(forecast|rainNext7Days)(\/|$)/.test(pointer);
}

/** Map pointers that hold a marketable/yield quantity (kg/ha, kg): shown as yields, never as an input dose. */
const YIELD_POINTERS: Partial<Record<ToolName, string[]>> = {
  calculate_scenarios: [
    "/result/scenarios/*/{perHa|total}/marketableKgTotal",
    "/result/scenarios/*/{perHa|total}/marketableQuantityKg/*/kg",
    "/result/scenarios/*/{perHa|total}/breakEvenMarketableYieldKgPerHa",
  ],
  get_farm_briefing: ["/economics/harvest/yieldForField/value/{low|central|high}", "/plans/option/slots/*/yield/value/{low|central|high}"],
};

const matches = (patternSegs: string[], segs: string[]) => patternSegs.length === segs.length && patternSegs.every((s, i) => s === "*" || s === segs[i]);

function expand(pattern: string): string[] {
  const m = /\{([^}]+)\}/.exec(pattern);
  if (!m) return [pattern];
  return m[1]!.split("|").flatMap((alt) => expand(pattern.slice(0, m.index) + alt + pattern.slice(m.index + m[0].length)));
}
const COMPILED: Partial<Record<string, { segs: string[]; unit: UnitRule["unit"] }[]>> = Object.fromEntries(
  Object.entries(TOOL_UNIT_MAP).map(([tool, rules]) => [tool, rules!.flatMap((r) => expand(r.pattern).map((p) => ({ segs: p.slice(1).split("/"), unit: r.unit })))]),
);

/** All expanded map pointers per tool (for the contract drift test). */
export function mappedPointers(): Record<string, string[]> {
  return Object.fromEntries(Object.entries(COMPILED).map(([t, rs]) => [t, rs!.map((r) => `/${r.segs.join("/")}`)]));
}

const OWNERS_COMPILED: Partial<Record<string, string[][]>> = Object.fromEntries(Object.entries(UNIT_RECORD_OWNERS).map(([t, ps]) => [t, ps!.flatMap(expand).map((p) => p.slice(1).split("/"))]));
const YIELD_COMPILED: Partial<Record<string, string[][]>> = Object.fromEntries(Object.entries(YIELD_POINTERS).map(([t, ps]) => [t, ps!.flatMap(expand).map((p) => p.slice(1).split("/"))]));

/** True when `pointer` is a mapped yield/marketable-quantity field of the tool's stored output (F13). */
export function isYieldPointer(toolName: string, pointer: string): boolean {
  const segs = segments(pointer);
  return !!segs && (YIELD_COMPILED[toolName] ?? []).some((p) => matches(p, segs));
}

const segments = (pointer: string): string[] | null => (pointer.startsWith("/") ? pointer.slice(1).split("/").map((k) => k.replace(/~1/g, "/").replace(/~0/g, "~")) : null);

function walk(doc: unknown, segs: string[]): { found: boolean; value: unknown } {
  let cur = doc;
  for (const key of segs) {
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= cur.length) return { found: false, value: undefined };
      cur = cur[Number(key)];
    } else if (typeof cur === "object" && cur !== null && Object.prototype.hasOwnProperty.call(cur, key)) cur = (cur as Record<string, unknown>)[key];
    else return { found: false, value: undefined };
  }
  return { found: true, value: cur };
}

export type UnitBasis = "unit_record" | "tool_unit_map";

/** The unit of the number at `pointer` in a stored tool result, or null when it cannot be derived. */
export function unitAtPointer(toolName: string, result: unknown, pointer: string): { unit: Unit; basis: UnitBasis } | null {
  const segs = segments(pointer);
  if (!segs || segs.length === 0) return null;
  const n = segs.length;
  // 1. unit-bearing record (parent for value/amount; grandparent for value|amount/low|central|high).
  for (const k of [1, 2]) {
    if (n < k) continue;
    const below = segs.slice(n - k);
    const shapeOk = k === 1 ? ["value", "amount"].includes(below[0]!) : ["value", "amount"].includes(below[0]!) && ["low", "central", "high"].includes(below[1]!);
    if (!shapeOk) continue;
    const ownerSegs = segs.slice(0, n - k);
    // F13: a unit record is accepted only at an allowlisted location for this tool.
    if (!(OWNERS_COMPILED[toolName] ?? []).some((p) => matches(p, ownerSegs))) continue;
    const owner = walk(result, ownerSegs);
    if (!owner.found || typeof owner.value !== "object" || owner.value === null || Array.isArray(owner.value)) continue;
    const o = owner.value as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(o, "unit")) continue;
    if ("kind" in o && o.kind !== "quantity" && o.kind !== "range") return null;
    const u = Unit.safeParse(o.unit);
    return u.success ? { unit: u.data, basis: "unit_record" } : null;
  }
  // 2. legacy scalar map.
  for (const r of COMPILED[toolName] ?? []) {
    if (r.segs.length !== n || !r.segs.every((s, i) => s === "*" || s === segs[i])) continue;
    const unit = typeof r.unit === "function" ? r.unit(result, segs) : r.unit;
    return unit ? { unit, basis: "tool_unit_map" } : null;
  }
  return null;
}
