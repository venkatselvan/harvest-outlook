/**
 * Stage-to-stage blend weight for the season slider. Pure and deterministic.
 *
 * This is a presentation helper: it says which two illustrations to cross-fade at a given day after planting
 * (DAP). It is NOT a growth model; intermediate frames are a smooth fade between two illustrations, not
 * scientifically validated intermediate growth.
 */
export interface StageWindow {
  stageId: string;
  /** Inclusive start, days after planting. */
  startDap: number;
  /** End (start of the next stage for contiguous windows), days after planting. */
  endDap: number;
}

export interface StageBlend {
  /** null before the first stage begins: the base photo only. */
  fromStageId: string | null;
  toStageId: string | null;
  /** 0 = fully `from`, 1 = fully `to`. */
  t: number;
}

/** Full cross-fade span, centred on each stage boundary, shortened for short stages. */
export const DEFAULT_BLEND_DAYS = 14;

export function computeStageBlend(dap: number, windows: readonly StageWindow[], blendDays = DEFAULT_BLEND_DAYS): StageBlend {
  const ws = [...windows].filter((w) => Number.isFinite(w.startDap) && Number.isFinite(w.endDap)).sort((a, b) => a.startDap - b.startDap || a.endDap - b.endDap);
  if (ws.length === 0) return { fromStageId: null, toStageId: null, t: 0 };
  const first = ws[0]!;
  if (!Number.isFinite(dap) || dap < first.startDap) return { fromStageId: null, toStageId: first.stageId, t: 0 };
  for (let i = 0; i < ws.length - 1; i++) {
    const cur = ws[i]!;
    const next = ws[i + 1]!;
    // Boundary: the end of this stage, or the middle of a gap/overlap between the two windows.
    const b = cur.endDap === next.startDap ? cur.endDap : (cur.endDap + next.startDap) / 2;
    const lens = [cur.endDap - cur.startDap, next.endDap - next.startDap].filter((l) => l > 0);
    const half = lens.length === 0 ? 0 : Math.max(0, Math.min(blendDays / 2, ...lens.map((l) => l / 2)));
    const lo = b - half;
    const hi = b + half;
    if (dap < lo) return { fromStageId: cur.stageId, toStageId: cur.stageId, t: 0 };
    if (dap < hi) return { fromStageId: cur.stageId, toStageId: next.stageId, t: (dap - lo) / (hi - lo) };
  }
  const last = ws[ws.length - 1]!;
  return { fromStageId: last.stageId, toStageId: last.stageId, t: 0 };
}

/** Whole days between two YYYY-MM-DD dates (UTC), `date - planting`. */
export function dapBetween(plantingDate: string, date: string): number {
  const p = Date.parse(`${plantingDate}T00:00:00Z`);
  const d = Date.parse(`${date}T00:00:00Z`);
  return Math.round((d - p) / 86_400_000);
}
