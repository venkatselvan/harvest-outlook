import { GeographicBoundary, ringsOverlap, ringWithin, type PlantCrop } from "@harvest/contracts";

/**
 * Fields inside a farm (FIELDS_MULTICROP_SOIL_SPEC.md section 6): pure helpers for the Fields panel, the plant dialog and
 * the Today field chips. No DOM and no Solid, so node tests import them directly. Geometry is planar WGS84 degrees, like the
 * contract's own checks (`ringWithin`, `ringsOverlap`), which is adequate at field scale; areas use the spherical formula the
 * farm boundary already uses.
 */
export type Ring = [number, number][];
export type Polygon = { type: "Polygon"; coordinates: number[][][] };
/** A field as the workspace stores it (`FarmField` in the contracts, with the web's looser polygon type). */
export interface FieldLike {
  id: string;
  name: string;
  boundary: Polygon;
  notes?: string;
}
type FarmField = FieldLike;
/** A cycle as the workspace stores it (only what these helpers read). */
export interface FieldCycleLike {
  id: string;
  cropId: string;
  cropName?: string | undefined;
  sowingDate: string;
  establishmentDate?: string | undefined;
  stage: string;
  fieldId?: string | undefined;
  companion?: { cropId: string; cropName?: string | undefined; rowRatio?: string | undefined } | undefined;
}
export interface FieldPlanLike {
  id: string;
  year: number;
  season: string;
  cropId: string;
  cropName?: string | undefined;
  fieldId?: string | undefined;
}

export const MAX_FIELDS = 50;
export const MIN_STRIPS = 2;
export const MAX_STRIPS = 12;
export const HA_TO_ACRES = 2.4710538;

const ringOf = (boundary: Polygon | null | undefined): Ring => (boundary?.coordinates[0] ?? []) as Ring;

/** Spherical area of a WGS84 polygon in hectares (same formula as the farm boundary area in state.tsx). */
export function polygonAreaHa(boundary: Polygon | null | undefined): number {
  const r = ringOf(boundary);
  let area = 0;
  for (let i = 0; i < r.length - 1; i++) {
    const a = r[i]!,
      b = r[i + 1]!;
    area += (((b[0] - a[0]) * Math.PI) / 180) * (2 + Math.sin((a[1] * Math.PI) / 180) + Math.sin((b[1] * Math.PI) / 180));
  }
  return Math.abs((area * 6378137 * 6378137) / 2) / 10000;
}

/** "1.00 acres · 0.40 ha" (acres first: what most farmers in India use). */
export function areaText(ha: number): string {
  const acres = ha * HA_TO_ACRES;
  return `${acres.toFixed(2)} ${acres.toFixed(2) === "1.00" ? "acre" : "acres"} · ${ha.toFixed(2)} ha`;
}

/** A URL-safe field id (the contract allows letters, digits, "_", "." and "-"). */
export function newFieldId(prefix = "field", random: () => number = Math.random): string {
  const tail = Math.floor(random() * 36 ** 6)
    .toString(36)
    .padStart(6, "0");
  return `${prefix}-${Date.now().toString(36)}-${tail}`;
}

const anchorOf = (cycle: Pick<FieldCycleLike, "establishmentDate" | "sowingDate">) => cycle.establishmentDate ?? cycle.sowingDate;
/** The field's current cycle: the latest unharvested cycle naming it (the same rule as the API's `currentCycle`). */
export function currentCycleOf<C extends FieldCycleLike>(fieldId: string, cycles: readonly C[]): C | null {
  return (
    [...cycles]
      .filter((c) => c.stage !== "harvested" && c.fieldId === fieldId)
      .sort((a, b) => anchorOf(b).localeCompare(anchorOf(a)))[0] ?? null
  );
}

/** "Paddy + black gram", "Maize", or "No crop". */
export function cropLabel(
  cycle: Pick<FieldCycleLike, "cropId" | "cropName" | "companion"> | null | undefined,
  name: (cropId: string) => string,
): string {
  if (!cycle) return "No crop";
  const main = cycle.cropName ?? name(cycle.cropId);
  if (!cycle.companion) return main;
  const companion = cycle.companion.cropName ?? name(cycle.companion.cropId);
  return `${main} + ${companion.charAt(0).toLowerCase()}${companion.slice(1)}`;
}

// ------------------------------------------------------------------ checks before a save

/** Plain error text for a field name, or null when it can be saved. Names are unique case-insensitively (contract rule). */
export function checkFieldName(name: string, fields: readonly Pick<FarmField, "id" | "name">[], ignoreId?: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Give the field a name.";
  if (trimmed.length > 80) return "Keep the field name to 80 characters.";
  const clash = fields.find((f) => f.id !== ignoreId && f.name.trim().toLowerCase() === trimmed.toLowerCase());
  return clash ? `Another field is already called ${clash.name}. Choose a different name.` : null;
}

/**
 * Plain error text for a drawn field outline, or null when it can be saved: a valid polygon (the farm boundary validator),
 * inside the farm boundary when one is drawn (`ringWithin`), and not overlapping another field (`ringsOverlap`; shared edges
 * and corners are allowed). The same checks run on the server.
 */
export function checkFieldOutline(
  farmBoundary: Polygon | null | undefined,
  fields: readonly Pick<FarmField, "id" | "name" | "boundary">[],
  outline: Polygon,
  ignoreId?: string,
): string | null {
  if (!GeographicBoundary.safeParse(outline).success)
    return "The field outline crosses itself or has no area. Undo a point and trace the corners in order. Your points are kept.";
  const ring = ringOf(outline);
  const farm = ringOf(farmBoundary);
  if (farm.length >= 4 && !ringWithin(farm, ring))
    return "The field goes outside the farm boundary. Keep every corner inside the dashed farm outline. Your points are kept.";
  const other = fields.find((f) => f.id !== ignoreId && ringsOverlap(ringOf(f.boundary), ring));
  if (other)
    return `The field overlaps ${other.name}. Fields may share an edge but not the same land. Your points are kept.`;
  if (fields.filter((f) => f.id !== ignoreId).length >= MAX_FIELDS) return `A farm can hold up to ${MAX_FIELDS} fields.`;
  return null;
}

/** Records that name the field: deleting it is refused while any exist (the contract rejects a cycle or plan naming a missing field). */
export function fieldReferences(fieldId: string, cycles: readonly FieldCycleLike[], plans: readonly FieldPlanLike[] = []) {
  return { cycles: cycles.filter((c) => c.fieldId === fieldId), plans: plans.filter((p) => p.fieldId === fieldId) };
}
/** The refusal message for deleting a field, or null when nothing names it. */
export function deleteRefusal(
  field: Pick<FarmField, "id" | "name">,
  cycles: readonly FieldCycleLike[],
  plans: readonly FieldPlanLike[],
  name: (cropId: string) => string,
): string | null {
  const refs = fieldReferences(field.id, cycles, plans);
  if (!refs.cycles.length && !refs.plans.length) return null;
  const parts = [
    ...refs.cycles.map((c) => `${c.cropName ?? name(c.cropId)} sown ${anchorOf(c)}`),
    ...refs.plans.map((p) => `${p.cropName ?? name(p.cropId)} planned for ${p.season} ${p.year}`),
  ];
  const shown = parts.slice(0, 3).join("; ") + (parts.length > 3 ? `; and ${parts.length - 3} more` : "");
  return `${field.name} can't be deleted while crop records name it (${shown}). Those records keep their field so their history stays correct.`;
}

// ------------------------------------------------------------------ split into equal strips

/** Coordinates of computed cut points are rounded to 9 decimals (about 0.1 mm); the contract's checks tolerate 1e-7 degrees. */
const round9 = (v: number) => Math.round(v * 1e9) / 1e9;
/** A farm vertex this close to a cut line (degrees) is snapped onto it, so no sliver edge is created. */
const SNAP_DEG = 1e-10;

/**
 * Drop zero-width spikes the slab clip leaves along a cut line: a vertex whose neighbours lie on the same cut line on the
 * same side of it (the outline runs out along the line and straight back). Happens when a farm corner sits on the cut.
 */
function removeSpikes(strip: Ring, k: 0 | 1) {
  let changed = true;
  while (changed && strip.length > 3) {
    changed = false;
    for (let i = 0; i < strip.length; i++) {
      const prev = strip[(i + strip.length - 1) % strip.length]!,
        v = strip[i]!,
        next = strip[(i + 1) % strip.length]!;
      const o = 1 - k;
      if (prev[k] === v[k] && v[k] === next[k] && (v[o]! - prev[o]!) * (next[o]! - v[o]!) <= 0) {
        strip.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
}

export type StripSplit =
  | { ok: true; axis: "east-west" | "north-south"; rings: Polygon[]; areasHa: number[] }
  | { ok: false; reason: string };

/**
 * Split the farm into `n` strips of equal width along the longer side of its bounding box (measured in metres, so a
 * square-looking farm in degrees is judged by its real shape), each clipped to the farm polygon with a half-plane clip.
 * Widths are equal; areas are only approximately equal when the farm is not a rectangle. A farm whose shape would cut a
 * strip into separate pieces (a U shape across the cut) is refused rather than saved as an invalid polygon. Every strip is
 * checked with the contract's validator, `ringWithin` and `ringsOverlap` before it is returned.
 *
 * Implementation: the farm ring is first refined with every crossing of every cut line (the coordinate on the cut axis set
 * exactly to the cut value), so adjacent strips share identical cut vertices; a strip is then the refined ring's vertices
 * inside its slab in ring order (Sutherland-Hodgman with no new intersections left to compute).
 */
export function splitIntoStrips(farmBoundary: Polygon | null | undefined, n: number): StripSplit {
  if (!Number.isInteger(n) || n < MIN_STRIPS || n > MAX_STRIPS) return { ok: false, reason: `Choose between ${MIN_STRIPS} and ${MAX_STRIPS} strips.` };
  const closed = ringOf(farmBoundary);
  if (closed.length < 4 || !GeographicBoundary.safeParse(farmBoundary).success) return { ok: false, reason: "Draw the farm boundary first." };
  const ring: Ring = closed.slice(0, -1).map((p) => [p[0], p[1]]);
  const xs = ring.map((p) => p[0]),
    ys = ring.map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const midLat = ((minY + maxY) / 2) * (Math.PI / 180);
  const widthM = (maxX - minX) * Math.cos(midLat),
    heightM = maxY - minY;
  // Strips run across the longer side: an east-west farm is cut by north-south lines (axis 0 = longitude).
  const k: 0 | 1 = widthM >= heightM ? 0 : 1;
  const lo = k === 0 ? minX : minY,
    hi = k === 0 ? maxX : maxY;
  const cuts = Array.from({ length: n - 1 }, (_, i) => lo + ((hi - lo) * (i + 1)) / n);
  // Snap farm vertices lying (almost) on a cut line onto it.
  for (const p of ring) for (const c of cuts) if (Math.abs(p[k] - c) <= SNAP_DEG) p[k] = c;
  // Refine: insert every crossing of a cut line, in order along each edge.
  const refined: Ring = [];
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!,
      q = ring[(i + 1) % ring.length]!;
    refined.push(p);
    const crossings = cuts
      .filter((c) => (p[k] - c) * (q[k] - c) < 0)
      .map((c) => {
        const t = (c - p[k]) / (q[k] - p[k]);
        const other = round9(p[1 - k]! + t * (q[1 - k]! - p[1 - k]!));
        return { t, point: (k === 0 ? [c, other] : [other, c]) as [number, number] };
      })
      .sort((a, b) => a.t - b.t);
    for (const c of crossings) refined.push(c.point);
  }
  const bounds = [lo, ...cuts, hi];
  const rings: Polygon[] = [];
  for (let s = 0; s < n; s++) {
    const a = bounds[s]!,
      b = bounds[s + 1]!;
    const inside = refined.filter((p) => p[k] >= a && p[k] <= b);
    const strip: Ring = [];
    for (const p of inside) {
      const last = strip.at(-1);
      if (!last || last[0] !== p[0] || last[1] !== p[1]) strip.push([p[0], p[1]]);
    }
    if (strip.length > 1 && strip[0]![0] === strip.at(-1)![0] && strip[0]![1] === strip.at(-1)![1]) strip.pop();
    removeSpikes(strip, k);
    const polygon: Polygon = { type: "Polygon", coordinates: [[...strip, [strip[0]?.[0] ?? 0, strip[0]?.[1] ?? 0]]] };
    if (strip.length < 3 || !GeographicBoundary.safeParse(polygon).success || !ringWithin(closed, ringOf(polygon)))
      return { ok: false, reason: "This farm's shape can't be cut into straight strips without splitting a strip in two. Draw the fields by hand instead." };
    rings.push(polygon);
  }
  for (let i = 0; i < rings.length; i++)
    for (let j = 0; j < i; j++)
      if (ringsOverlap(ringOf(rings[j]), ringOf(rings[i])))
        return { ok: false, reason: "This farm's shape can't be cut into straight strips cleanly. Draw the fields by hand instead." };
  return { ok: true, axis: k === 0 ? "east-west" : "north-south", rings, areasHa: rings.map(polygonAreaHa) };
}

/** The strips as fields named "Strip 1".."Strip N" (west to east, or south to north). Refused when the farm already has fields. */
export function stripFields(
  farmBoundary: Polygon | null | undefined,
  existing: readonly unknown[],
  n: number,
  id: (index: number) => string = (i) => newFieldId(`strip-${i + 1}`),
): { ok: true; fields: FarmField[]; areasHa: number[] } | { ok: false; reason: string } {
  if (existing.length) return { ok: false, reason: "This farm already has fields. Splitting into strips works only on a farm without fields." };
  const split = splitIntoStrips(farmBoundary, n);
  if (!split.ok) return split;
  return {
    ok: true,
    areasHa: split.areasHa,
    fields: split.rings.map((boundary, i) => ({ id: id(i), name: `Strip ${i + 1}`, boundary })),
  };
}

// ------------------------------------------------------------------ plant dialog

/** Default field in the plant dialog: the field selected on Today, else the first field without a current cycle, else none. */
export function defaultPlantField(
  fields: readonly Pick<FarmField, "id">[],
  cycles: readonly FieldCycleLike[],
  selected: string | null | undefined,
): string {
  if (selected && fields.some((f) => f.id === selected)) return selected;
  return fields.find((f) => !currentCycleOf(f.id, cycles))?.id ?? "";
}

/** "4:2" from "4 : 2"; null when the text is empty; false when it is not two whole numbers from 1 to 20. */
export function normalizeRowRatio(text: string): string | null | false {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const match = /^(\d{1,2})\s*:\s*(\d{1,2})$/.exec(trimmed);
  if (!match) return false;
  const [a, b] = [Number(match[1]), Number(match[2])];
  return a >= 1 && b >= 1 && a <= 20 && b <= 20 ? `${a}:${b}` : false;
}

export interface PlantInput {
  clientEntryId: string;
  cropId: string;
  productId?: string | null | undefined;
  method: string;
  date: string;
  expectedWorkspaceVersion: number;
  note?: string | null | undefined;
  /** Required by the API when the farm has fields. */
  fieldId?: string | null | undefined;
  companion?: { cropId: string; productId?: string | null | undefined; rowRatio?: string | null | undefined } | null | undefined;
}
/** The POST /cycles body (`PlantCrop`): optional parts only when set, so a farm without fields sends exactly what it did before. */
export function buildPlantPayload(input: PlantInput): PlantCrop {
  const note = input.note?.trim();
  const ratio = input.companion?.rowRatio ? normalizeRowRatio(input.companion.rowRatio) : null;
  return {
    clientEntryId: input.clientEntryId,
    cropId: input.cropId,
    ...(input.productId ? { productId: input.productId } : {}),
    establishmentMethod: input.method,
    establishmentDate: input.date,
    expectedWorkspaceVersion: input.expectedWorkspaceVersion,
    ...(note ? { notes: note } : {}),
    ...(input.fieldId ? { fieldId: input.fieldId } : {}),
    ...(input.companion?.cropId
      ? {
          companion: {
            cropId: input.companion.cropId,
            ...(input.companion.productId ? { productId: input.companion.productId } : {}),
            ...(ratio ? { rowRatio: ratio } : {}),
          },
        }
      : {}),
  };
}

/** The box around a set of polygons as a closed rectangle: the farm frame for the overview when a farm has fields but no outer boundary. */
export function boundsPolygon(polygons: readonly (Polygon | null | undefined)[]): Polygon | null {
  const points = polygons.flatMap((p) => ringOf(p));
  if (!points.length) return null;
  const xs = points.map((p) => p[0]),
    ys = points.map((p) => p[1]);
  const [w, e, s, n] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  if (!(e > w && n > s)) return null;
  return { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
}
