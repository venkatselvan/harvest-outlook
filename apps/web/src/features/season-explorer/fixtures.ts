import type { PlanView, TimelineDay, TimelineView, VisualsView } from "../../lib/plan-api";
import { addDaysIso } from "./model";

/** Test-only builders. SYNTHETIC shapes for exercising the view model; no value here is real data. */
export const STAGES = [
  { stageId: "s_veg", name: "Vegetative", days: 90 },
  { stageId: "s_init", name: "Initiation", days: 45 },
  { stageId: "s_dev", name: "Development", days: 45 },
  { stageId: "s_mat", name: "Maturation", days: 60 },
  { stageId: "s_harv", name: "Harvest", days: 15 },
];

export function makeTimeline(opts: { planting?: string; asOf?: string; forecastDays?: number; photoDates?: Record<string, string>; scenarioId?: "early" | "late" } = {}): TimelineView {
  const planting = opts.planting ?? "2026-06-01";
  const asOf = opts.asOf ?? "2026-08-01";
  const forecastDays = opts.forecastDays ?? 10;
  const from = addDaysIso(planting, -14);
  const total = 14 + STAGES.reduce((a, s) => a + s.days, 0);
  const days: TimelineDay[] = [];
  for (let i = 0; i < total; i++) {
    const date = addDaysIso(from, i);
    const dap = i - 14;
    let acc = 0;
    let stage: (typeof STAGES)[number] | null = null;
    let start = 0;
    for (const s of STAGES) {
      if (dap >= acc && dap < acc + s.days) { stage = s; start = acc; break; }
      acc += s.days;
    }
    const past = date < asOf;
    const fcEnd = addDaysIso(asOf, forecastDays - 1);
    const weather: TimelineDay["weather"] = past
      ? date >= addDaysIso(asOf, -5)
        ? { state: "observed", values: { rainMm: 3.2, et0Mm: 4, tMaxC: 29, tMinC: 20 }, issuedAt: null, horizonDays: null, assumptionId: null, sourceId: "obs-src", missingReason: null }
        : { state: "unavailable", values: null, issuedAt: null, horizonDays: null, assumptionId: null, sourceId: null, missingReason: "no_observation" }
      : date <= fcEnd
        ? { state: "forecast", values: { rainMm: 12, et0Mm: 4, tMaxC: 28, tMinC: 21 }, issuedAt: `${asOf}T00:30:00.000Z`, horizonDays: forecastDays, assumptionId: null, sourceId: "fc-src", missingReason: null }
        : { state: "scenario", values: { rainMm: 6, et0Mm: 4, tMaxC: 28, tMinC: 21 }, issuedAt: null, horizonDays: null, assumptionId: "climatology_1991-2020", sourceId: "clim-src", missingReason: null };
    const photo = opts.photoDates?.[date];
    const visual: TimelineDay["visual"] = photo ? { assetId: photo, state: "observed_photo" } : past ? { assetId: null, state: "none" } : stage ? { assetId: "asset-" + stage.stageId, state: "illustrative" } : { assetId: null, state: "none" };
    days.push({
      calendarDate: date,
      daysAfterPlanting: dap,
      markers: { planting: dap === 0, asOf: date === asOf, past },
      expectedStage: stage ? { stageId: stage.stageId, occurrence: 1, window: { start: addDaysIso(planting, start), end: addDaysIso(planting, start + stage.days - 1) }, inferred: true, basis: "calendar_estimate", possibleStageIds: [stage.stageId] } : null,
      tasks: { due: dap === 0 ? ["plant:1"] : [], overdue: [], done: [], conditionFlags: dap === 0 && !past ? [{ taskId: "plant:1", rainMm: 60, weatherState: "forecast", thresholdMm: 50, thresholdAssumptionId: "heavy" }] : [] },
      weather,
      water: { state: "unavailable", outputId: null, missingReason: "water_not_computed" },
      outlook: { state: "unavailable", harvestPeriodId: null, artifactId: null, issuedAt: null, missingReason: "outside_harvest_window" },
      visual,
      evidenceRefs: stage ? ["ev.one"] : [],
    });
  }
  return { planId: "plan-1", planContentHash: "h".repeat(64), scenarioId: opts.scenarioId ?? "early", dataVersion: "v1", asOfDate: asOf, cached: true, range: { from, to: days[days.length - 1]!.calendarDate }, days };
}

export function makePlan(planting = "2026-06-01"): PlanView {
  return {
    snapshot: { id: "plan-1", parentId: null, parentContentHash: null, contentHash: "h".repeat(64), farmId: "farm-1", cropId: "ginger", productId: "ginger-fresh", createdAt: "2026-08-01T00:00:00.000Z", decidedAt: "2026-08-01T00:00:00.000Z", mode: "synthetic", sourceSnapshotId: "catalogue-x", confirmedInputs: [], assumptions: [] },
    outputs: [
      { id: "o1", kind: "stage_windows", output: { plantingDate: planting, stages: STAGES.map((s, i) => ({ stageId: s.stageId, name: s.name, order: i, isHarvest: i === 4, evidenceIds: [], reviewStatus: "candidate" })), limitations: [] } },
      { id: "o2", kind: "tasks", output: { templateSet: { id: "t", version: 1 }, skipped: [], tasks: [{ templateId: "plant", stageId: "s_veg", occurrence: 1, description: "Plant seed pieces.", trigger: { type: "daily_rain_gte", thresholdAssumptionId: "heavy", thresholdMm: 50, thresholdBasis: "assumption" }, task: { id: "plant:1", taskType: "plant", timing: { kind: "window", window: { start: planting, end: planting } }, evidenceIds: ["ev.one"], reasonCode: "plant_seed_rhizome_pieces", state: "pending", dependsOn: [] } }] } },
    ],
    lineage: { parentId: null, childIds: [] },
    deduplicated: false,
  };
}

export function makeVisuals(state: "schematic" | "ready" = "schematic", reason: string | null = "synthetic_mode"): VisualsView {
  return {
    planId: "plan-1",
    generating: false,
    stages: STAGES.map((s, i) => ({
      stageId: s.stageId,
      name: s.name,
      order: i,
      state,
      label: state === "ready" ? "Illustrative growth — generated image, not a prediction" : "Schematic — simple drawing by stage order, not a growth model or prediction",
      asset: state === "ready" ? { assetId: `a${i}`, qaWarning: null, contentPath: `/api/v1/visuals/a${i}/content`, reason: null } : { assetId: `a${i}`, qaWarning: null, contentPath: null, reason },
    })),
  };
}
