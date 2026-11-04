import { describe, expect, it } from "vitest";
import { renderToString } from "solid-js/web";
import type { JSX } from "solid-js";
import { FieldId, GeographicBoundary, PlantCrop, ringsOverlap, ringWithin } from "@harvest/contracts";
import {
  areaText,
  boundsPolygon,
  buildPlantPayload,
  checkFieldName,
  checkFieldOutline,
  cropLabel,
  currentCycleOf,
  defaultPlantField,
  deleteRefusal,
  normalizeRowRatio,
  polygonAreaHa,
  splitIntoStrips,
  stripFields,
  type FieldCycleLike,
  type FieldLike,
  type Polygon,
} from "./fieldsModel";
import { FieldsPanel, nextFieldName } from "./FieldsPanel";

const html = (fn: () => JSX.Element) => renderToString(fn).replace(/ data-hk="[^"]*"/g, "").replace(/<!--[^>]*-->/g, "");
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const noop = () => undefined;
const name = (id: string) => id.replace(/_/g, " ");

const poly = (pts: [number, number][]): Polygon => ({ type: "Polygon", coordinates: [[...pts, pts[0]!]] });
const ring = (p: Polygon) => p.coordinates[0] as [number, number][];
const O = [76.1, 13.0] as const;
const S = 0.001;
const scaled = (pts: [number, number][], sy = 1) => poly(pts.map(([x, y]) => [O[0] + x * S, O[1] + y * S * sy] as [number, number]));
/** A 4 x 1 (about 430 m x 110 m) rectangle and an L-shaped farm (2 x 2 with the top-right quarter missing). */
const RECT = scaled([[0, 0], [4, 0], [4, 1], [0, 1]]);
const L_FARM = scaled([[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]]);
const U_FARM = scaled([[0, 0], [3, 0], [3, 3], [2, 3], [2, 1], [1, 1], [1, 3], [0, 3]], 1.2);

function expectCleanStrips(farm: Polygon, n: number) {
  const split = splitIntoStrips(farm, n);
  expect(split.ok, `split ${n}`).toBe(true);
  if (!split.ok) return;
  expect(split.rings).toHaveLength(n);
  for (const strip of split.rings) {
    expect(GeographicBoundary.safeParse(strip).success).toBe(true);
    expect(ringWithin(ring(farm), ring(strip))).toBe(true);
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) expect(ringsOverlap(ring(split.rings[i]!), ring(split.rings[j]!))).toBe(false);
  // The strips cover the farm: their areas add up to the farm's.
  const total = split.areasHa.reduce((a, b) => a + b, 0);
  expect(total).toBeCloseTo(polygonAreaHa(farm), 6);
  return split;
}

describe("split into equal strips", () => {
  it("cuts a rectangle into N equal, non-overlapping strips within the farm, along its longer side (N = 2..12)", () => {
    for (let n = 2; n <= 12; n++) {
      const split = expectCleanStrips(RECT, n)!;
      expect(split.axis).toBe("east-west");
      const [first, ...rest] = split.areasHa;
      for (const a of rest) expect(a).toBeCloseTo(first!, 6);
    }
  });
  it("cuts an L-shaped farm into N clean strips, including cuts through its inner corner", () => {
    for (const n of [2, 3, 4, 5, 7, 12]) expectCleanStrips(L_FARM, n);
    // Equal widths, not equal areas: the strips above the notch are half as large.
    const split = splitIntoStrips(L_FARM, 2);
    expect(split.ok && split.areasHa[0]! / split.areasHa[1]!).toBeCloseTo(2, 2);
  });
  it("refuses a shape that would cut a strip into separate pieces, and bad counts", () => {
    expect(splitIntoStrips(U_FARM, 2)).toMatchObject({ ok: false });
    expect(splitIntoStrips(RECT, 1)).toMatchObject({ ok: false });
    expect(splitIntoStrips(RECT, 13)).toMatchObject({ ok: false });
    expect(splitIntoStrips(null, 3)).toMatchObject({ ok: false, reason: "Draw the farm boundary first." });
  });
  it("names the strips Strip 1..N with URL-safe ids, and is refused when the farm already has fields", () => {
    const result = stripFields(RECT, [], 3);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fields.map((f) => f.name)).toEqual(["Strip 1", "Strip 2", "Strip 3"]);
      for (const f of result.fields) expect(FieldId.safeParse(f.id).success).toBe(true);
      expect(new Set(result.fields.map((f) => f.id)).size).toBe(3);
    }
    expect(stripFields(RECT, [{ id: "a" }], 3)).toEqual({
      ok: false,
      reason: "This farm already has fields. Splitting into strips works only on a farm without fields.",
    });
  });
});

describe("drawing a field", () => {
  const west: FieldLike = { id: "west", name: "West", boundary: scaled([[0, 0], [2, 0], [2, 1], [0, 1]]) };
  it("accepts a field beside another (shared edge) inside the farm", () => {
    expect(checkFieldOutline(RECT, [west], scaled([[2, 0], [4, 0], [4, 1], [2, 1]]))).toBeNull();
  });
  it("names the problem: outside the farm, overlap, crossing outline", () => {
    expect(checkFieldOutline(RECT, [], scaled([[3, 0], [5, 0], [5, 1], [3, 1]]))).toMatch(/outside the farm boundary/);
    expect(checkFieldOutline(RECT, [west], scaled([[1, 0], [3, 0], [3, 1], [1, 1]]))).toMatch(/overlaps West/);
    expect(checkFieldOutline(RECT, [], scaled([[0, 0], [1, 1], [1, 0], [0, 1]]))).toMatch(/crosses itself/);
    // Editing a field ignores its own outline.
    expect(checkFieldOutline(RECT, [west], west.boundary, "west")).toBeNull();
  });
  it("checks names case-insensitively and suggests the next free name", () => {
    expect(checkFieldName("west", [west])).toMatch(/already called West/);
    expect(checkFieldName("West", [west], "west")).toBeNull();
    expect(checkFieldName("  ", [])).toBe("Give the field a name.");
    expect(nextFieldName([west])).toBe("Field 2");
  });
  it("shows areas in acres and hectares", () => {
    expect(areaText(0.4047)).toBe("1.00 acre · 0.40 ha");
    expect(areaText(1.2)).toBe("2.97 acres · 1.20 ha");
    expect(boundsPolygon([west.boundary])?.coordinates[0]).toHaveLength(5);
  });
});

describe("deleting a field", () => {
  const field = { id: "north", name: "North strip" };
  const cycle: FieldCycleLike = { id: "c1", cropId: "paddy", cropName: "Paddy", sowingDate: "2026-07-01", stage: "growing", fieldId: "north" };
  it("is refused while a crop record names the field", () => {
    const refused = deleteRefusal(field, [cycle], [], name);
    expect(refused).toMatch(/^North strip can't be deleted while crop records name it \(Paddy sown 2026-07-01\)/);
    // A harvested cycle still names the field (its history), so it still blocks deletion.
    expect(deleteRefusal(field, [{ ...cycle, stage: "harvested" }], [], name)).not.toBeNull();
    expect(deleteRefusal(field, [], [{ id: "p1", year: 2027, season: "rabi", cropId: "black_gram", fieldId: "north" }], name)).toMatch(/black gram planned for rabi 2027/);
  });
  it("is allowed when nothing names it", () => {
    expect(deleteRefusal(field, [{ ...cycle, fieldId: "south" }], [], name)).toBeNull();
  });
});

describe("plant dialog", () => {
  const base = { clientEntryId: "planting-1", cropId: "paddy", method: "transplanting", date: "2026-11-01", expectedWorkspaceVersion: 4 };
  it("the payload carries the field and the companion with a normalised row ratio", () => {
    const payload = buildPlantPayload({ ...base, productId: "paddy-grain", fieldId: "north", companion: { cropId: "black_gram", productId: null, rowRatio: "4 : 2" } });
    expect(payload).toEqual({ ...{ clientEntryId: "planting-1", cropId: "paddy", productId: "paddy-grain", establishmentMethod: "transplanting", establishmentDate: "2026-11-01", expectedWorkspaceVersion: 4 }, fieldId: "north", companion: { cropId: "black_gram", rowRatio: "4:2" } });
    expect(PlantCrop.safeParse(payload).success).toBe(true);
  });
  it("a farm without fields sends exactly the old payload", () => {
    const payload = buildPlantPayload({ ...base, note: "  ", fieldId: null, companion: null });
    expect(Object.keys(payload).sort()).toEqual(["clientEntryId", "cropId", "establishmentDate", "establishmentMethod", "expectedWorkspaceVersion"]);
    expect(PlantCrop.safeParse(payload).success).toBe(true);
  });
  it("row ratios are two whole numbers", () => {
    expect(normalizeRowRatio("")).toBeNull();
    expect(normalizeRowRatio("6:1")).toBe("6:1");
    expect(normalizeRowRatio("four to two")).toBe(false);
    expect(normalizeRowRatio("0:2")).toBe(false);
  });
  it("defaults to the field selected on Today, else the first field without a crop", () => {
    const fields = [{ id: "north" }, { id: "middle" }, { id: "south" }];
    const cycles: FieldCycleLike[] = [{ id: "c1", cropId: "maize", sowingDate: "2026-09-15", stage: "growing", fieldId: "north" }];
    expect(defaultPlantField(fields, cycles, "south")).toBe("south");
    expect(defaultPlantField(fields, cycles, null)).toBe("middle");
    expect(defaultPlantField(fields, cycles, "gone")).toBe("middle");
    expect(defaultPlantField([{ id: "north" }], cycles, null)).toBe("");
    expect(currentCycleOf("north", cycles)?.id).toBe("c1");
    expect(cropLabel({ cropId: "paddy", cropName: "Paddy", companion: { cropId: "black_gram", cropName: "Black gram" } }, name)).toBe("Paddy + black gram");
  });
});

describe("FieldsPanel", () => {
  const split = stripFields(RECT, [], 3);
  const fields = split.ok ? split.fields.map((f, i) => ({ ...f, id: ["north", "middle", "south"][i]! })) : [];
  const cycles: FieldCycleLike[] = [{ id: "c1", cropId: "paddy", cropName: "Paddy", sowingDate: "2026-07-01", stage: "growing", fieldId: "north", companion: { cropId: "black_gram", cropName: "Black gram" } }];
  const panel = (over: Partial<Parameters<typeof FieldsPanel>[0]> = {}) =>
    html(() => (
      <FieldsPanel
        fields={fields}
        farmBoundary={RECT}
        cycles={cycles}
        plans={[]}
        cropName={name}
        saving={false}
        onSave={async () => undefined}
        drawing={false}
        drawn={null}
        onStartDraw={noop}
        onEndDraw={noop}
        todayHref={(id) => `/farm?tab=today&field=${id}`}
        {...over}
      />
    ));
  it("lists each field with area, crop (with companion) and a Show on Today link", () => {
    const markup = panel();
    expect(markup).toContain('data-testid="fields-list"');
    expect((markup.match(/data-field-id=/g) ?? []).length).toBe(3);
    expect(text(markup)).toContain("Strip 1 3.98 acres · 1.61 ha · Paddy + black gram");
    expect(text(markup)).toContain("Strip 2 3.98 acres · 1.61 ha · No crop");
    expect(markup).toContain('href="/farm?tab=today&amp;field=north"');
    expect(markup).toContain('aria-label="Rename Strip 1"');
    expect(markup).toContain('aria-label="Delete Strip 1"');
    // Split is refused once the farm has fields.
    expect(markup).toMatch(/<button[^>]*disabled[^>]*data-testid="fields-split"/);
    expect(text(markup)).toContain("Splitting works only on a farm without fields.");
  });
  it("a farm without fields offers Add field and Split; without a boundary both wait for it", () => {
    const empty = panel({ fields: [] });
    expect(empty).toContain('data-testid="fields-empty"');
    expect(empty).not.toMatch(/<button[^>]*disabled[^>]*data-testid="fields-split"/);
    const noBoundary = panel({ fields: [], farmBoundary: null });
    expect(text(noBoundary)).toContain("Draw the farm boundary first.");
    expect(noBoundary).toMatch(/<button[^>]*disabled[^>]*data-testid="fields-add"/);
  });
  it("offers existing-outline adjustment and requires Finish before its explicit save", () => {
    const available = panel({ onEditOutline: noop });
    expect(available).toContain('aria-label="Edit outline for Strip 1"');
    const adjusting = panel({ editingFieldId: "north", drawing: true, drawn: fields[0]!.boundary, onEditOutline: noop });
    expect(text(adjusting)).toContain("Adjusting the field outline.");
    expect(text(adjusting)).not.toContain("Save field boundary");
    const finished = panel({ editingFieldId: "north", drawing: false, drawn: fields[0]!.boundary, onEditOutline: noop });
    expect(text(finished)).toContain("Adjusted field:");
    expect(text(finished)).toContain("Save field boundary");
  });
  it("names a finished outline before saving it", () => {
    const markup = panel({ fields: [], drawn: scaled([[0, 0], [1, 0], [1, 1], [0, 1]]) });
    expect(markup).toContain('data-testid="fields-draw"');
    expect(markup).toContain('data-testid="fields-new-name"');
    expect(text(markup)).toContain("Save field");
  });
});
