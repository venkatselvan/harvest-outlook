import { describe, expect, it } from "vitest";
import { renderToString } from "solid-js/web";
import type { FieldSummary } from "@harvest/contracts";
import { cropAreas, TodayGreennessWeb } from "./TodayCropArea";

const field = (id: string, ndvi: number | null, areaHa = 1): FieldSummary => ({
  id, name: `Field ${id}`, areaHa,
  boundary: { type: "Polygon", coordinates: [[[77, 12], [77.01, 12], [77.01, 12.01], [77, 12]]] },
  cycle: { id: `cycle-${id}`, cropId: "ginger", cropName: "Ginger", companion: { cropId: "maize", cropName: "Maize" }, establishmentDate: "2026-06-01", stage: null, daysToHarvest: null },
  greenness: ndvi == null ? null : { ndvi, observedOn: "2026-11-01", verdict: "no_reference" }, alertCount: 0,
});

describe("Today factual crop charts", () => {
  it("counts main-crop area once even with a companion crop", () => {
    expect(cropAreas([field("a", .4, 2), field("b", .5, 3)])).toEqual([{ id: "ginger", name: "Ginger", area: 5, fields: 2 }]);
  });
  it("requires three valid observations instead of drawing missing readings as zero", () => {
    const html = renderToString(() => <TodayGreennessWeb fields={[field("a", .4), field("b", null), field("c", 2)]} />);
    expect(html).not.toContain('<svg');
    expect(html).toContain("At least three fields");
    expect(html.match(/Unavailable/g)).toHaveLength(2);
  });
  it("draws comparable raw values and keeps missing fields and dates explicit", () => {
    const html = renderToString(() => <TodayGreennessWeb fields={[field("a", -.2), field("b", .4), field("c", .8), field("d", null)]} />);
    expect(html).toContain('<svg');
    expect(html).toContain("−1 to 1 scale");
    expect(html).toContain("-0.20");
    expect(html).toContain("Observed 1 Nov 2026");
    expect(html).toContain("Field d");
    expect(html).toContain("omitted from the web");
  });
  it("lists all readings when the number exceeds the readable web limit", () => {
    const html = renderToString(() => <TodayGreennessWeb fields={Array.from({ length: 9 }, (_, i) => field(String(i), .4))} />);
    expect(html).not.toContain('<svg');
    expect(html).toContain("all field readings are listed below");
    expect(html).toContain("Field 8");
  });
});
