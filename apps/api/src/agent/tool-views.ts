/**
 * L5: compact model-visible views of large tool results. The full result stays stored unchanged in
 * tool_results; the compact view keeps every crop's outcome and reasons and gives JSON pointers into the
 * stored result, so numericRefs remain verifiable by the gate. Observed live: a whole-catalogue screen_crops
 * result was ~187,000 characters and the old 4,000-character preview hid every crop after the first.
 */
type Obj = Record<string, unknown>;
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v.filter((x) => typeof x === "object" && x !== null) as Obj[]) : []);
const str = (v: unknown, max = 160): string | null => (v === null || v === undefined ? null : (typeof v === "string" ? v : JSON.stringify(v)).slice(0, max));

export function compactScreenCrops(output: unknown): Obj {
  const results = arr((output as Obj | null)?.results);
  return {
    compacted: true,
    note: "Compact view of a large screen_crops result. JSON pointers refer to the full stored result (relative to its \"result\" object), e.g. /results/3/dimensions/0/value/value.",
    resultCount: results.length,
    results: results.map((r, i) => ({
      index: i,
      cropId: r.cropId,
      productIds: r.productIds,
      outcome: r.outcome,
      unknownFields: r.unknownFields,
      rules: arr(r.ruleResults).map((x) => ({ ruleId: x.ruleId, effect: x.effect, reasonCodes: arr(x.reasons).map((y) => y.reasonCode), unknownFields: x.unknownFields })),
      dimensions: arr(r.dimensions).map((d, j) => {
        const v = (d.value as Obj | undefined) ?? {};
        return { dimension: d.dimension, pointer: `/results/${i}/dimensions/${j}/value`, kind: v.kind ?? null, value: str(v.value), unit: v.unit ?? null, evidenceState: v.evidenceState ?? null, missingReason: v.missingReason ?? null, evidenceIds: v.evidenceIds ?? [] };
      }),
      screeningCoverage: arr(r.coverage)
        .filter((c) => typeof c.capability === "string" && c.capability.startsWith("screening"))
        .map((c) => ({ capability: c.capability, region: c.region, season: c.season, supportStatus: c.supportStatus, missingReason: c.missingReason })),
    })),
  };
}

export const COMPACT_VIEWS: Record<string, (output: unknown) => Obj> = { screen_crops: compactScreenCrops };
