import type { StageDefinition } from '@harvest/contracts';

/**
 * Stage windows from duration RANGES and a planting date (or planting window).
 * There is no fixed day count: each stage yields an earliest/latest start and
 * earliest/latest end. Repeated harvests produce one window per occurrence.
 * Windows are calendar-day estimates ('derived'), not a mechanistic growth model.
 *
 * Convention: a stage's end date is the day on which the next stage starts
 * (durations are added to the start date). Dates are UTC calendar dates.
 */
export interface StageWindow {
  stageId: string;
  earliestStart: string;
  latestStart: string;
  earliestEnd: string;
  latestEnd: string;
  /** Envelope: earliest possible start, latest possible end. */
  earliest: string;
  latest: string;
  occurrence: number;
  isHarvest: boolean;
}

export type StageWindowResult =
  | { status: 'ok'; windows: StageWindow[]; harvestWindows: StageWindow[]; limitations: string[] }
  | { status: 'unsupported'; reason: string; stageIds: string[] };

const DAY_MS = 86_400_000;

export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}

export function computeStageWindows(
  stages: StageDefinition[],
  planting: { earliest: string; latest: string },
): StageWindowResult {
  if (planting.earliest > planting.latest) return { status: 'unsupported', reason: 'planting_window_inverted', stageIds: [] };
  const thermal = stages.filter((s) => s.method !== 'calendar_days');
  if (thermal.length > 0) {
    return { status: 'unsupported', reason: 'thermal_time_method_not_implemented', stageIds: thermal.map((s) => s.stageId) };
  }
  const byId = new Map(stages.map((s) => [s.stageId, s]));
  if (byId.size !== stages.length) return { status: 'unsupported', reason: 'duplicate_stage_id', stageIds: [] };

  // Offsets from planting: [minStartOffset, maxStartOffset]
  const offsets = new Map<string, { min: number; max: number }>();
  const visiting = new Set<string>();
  const offsetOf = (s: StageDefinition): { min: number; max: number } => {
    const cached = offsets.get(s.stageId);
    if (cached) return cached;
    if (visiting.has(s.stageId)) throw new Error(`cycle at stage ${s.stageId}`);
    visiting.add(s.stageId);
    let r = { min: 0, max: 0 };
    if (s.startsAfter !== null) {
      const prev = byId.get(s.startsAfter);
      if (!prev) throw new Error(`unknown startsAfter ${s.startsAfter}`);
      const po = offsetOf(prev);
      r = { min: po.min + prev.durationDays.min, max: po.max + prev.durationDays.max };
    }
    visiting.delete(s.stageId);
    offsets.set(s.stageId, r);
    return r;
  };

  let windows: StageWindow[];
  try {
    windows = [...stages]
      .sort((a, b) => a.order - b.order)
      .flatMap((s) => {
        const o = offsetOf(s);
        const occurrences = s.repeat ? s.repeat.maxOccurrences : 1;
        const out: StageWindow[] = [];
        for (let k = 0; k < occurrences; k++) {
          const minShift = k * (s.repeat?.intervalDays.min ?? 0);
          const maxShift = k * (s.repeat?.intervalDays.max ?? 0);
          const earliestStart = addDays(planting.earliest, o.min + minShift);
          const latestStart = addDays(planting.latest, o.max + maxShift);
          const earliestEnd = addDays(earliestStart, s.durationDays.min);
          const latestEnd = addDays(latestStart, s.durationDays.max);
          out.push({ stageId: s.stageId, earliestStart, latestStart, earliestEnd, latestEnd, earliest: earliestStart, latest: latestEnd, occurrence: k + 1, isHarvest: s.isHarvest });
        }
        return out;
      });
  } catch (e) {
    return { status: 'unsupported', reason: (e as Error).message, stageIds: [] };
  }
  const limitations = [...new Set(stages.flatMap((s) => s.limitations))];
  if (stages.some((s) => s.repeat)) limitations.push('Repeated harvest windows widen with each occurrence; the number of pickings actually achieved is not predicted.');
  return { status: 'ok', windows, harvestWindows: windows.filter((w) => w.isHarvest), limitations };
}
