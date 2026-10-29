import { IsoDate, IrrigationCategory } from "@harvest/contracts";
import { addDays } from "@harvest/domain";
import type { PlanChange } from "../plans/types";
import { isPlanField, type PlanField } from "./types";

export type MappingResult =
  | { mapped: false }
  | { mapped: true; ok: true; field: PlanField; change: PlanChange }
  | { mapped: true; ok: false; field: PlanField; code: "unknown_stage" | "invalid_value"; message: string };

export interface MappingContext {
  /** Observation date (YYYY-MM-DD, region timezone). */
  observedOn: string;
  entryId: string;
  /** Stage ids known to the plan; null when the entry has no plan. */
  stageIds: ReadonlySet<string> | null;
}

/**
 * Maps a confirmed fact to the typed plan change it may trigger. Pure and deterministic: the model never
 * supplies the observation date or the change type. Facts on other fields never change a plan.
 */
export function factToPlanChange(fact: { field: string; value: unknown }, ctx: MappingContext): MappingResult {
  if (!isPlanField(fact.field)) return { mapped: false };
  const field = fact.field;
  const bad = (message: string, code: "unknown_stage" | "invalid_value" = "invalid_value"): MappingResult => ({ mapped: true, ok: false, field, code, message });
  if (typeof fact.value !== "string") return bad(`${field} needs a text value`);
  switch (field) {
    case "observed_stage": {
      if (!ctx.stageIds) return bad("this entry has no plan to revise", "unknown_stage");
      if (!ctx.stageIds.has(fact.value)) return bad(`stage '${fact.value}' is not part of the plan`, "unknown_stage");
      return { mapped: true, ok: true, field, change: { type: "observed_stage", stageId: fact.value, observedOn: ctx.observedOn, journalEntryId: ctx.entryId, basis: "farmer_reported" } };
    }
    case "irrigation_category": {
      const c = IrrigationCategory.safeParse(fact.value);
      if (!c.success) return bad("irrigation category must be rainfed, supplemental or irrigated");
      return { mapped: true, ok: true, field, change: { type: "irrigation_category", category: c.data } };
    }
    case "planting_date": {
      const d = IsoDate.safeParse(fact.value);
      if (!d.success) return bad("planting date must be a valid YYYY-MM-DD date");
      if (d.data > addDays(ctx.observedOn, 400) || d.data < addDays(ctx.observedOn, -800)) return bad("planting date is too far from the observation date");
      return { mapped: true, ok: true, field, change: { type: "planting_date", date: d.data } };
    }
  }
}

export type RecomputeKind = "stages" | "economics" | "water" | "tasks" | "visuals";

/** Which plan outputs a typed change recomputes (mirrors docs/PLAN_ENGINE.md; used for previews and the tool contract). */
export function recomputeFor(change: PlanChange): RecomputeKind[] {
  switch (change.type) {
    case "planting_date":
    case "observed_stage":
      return ["stages", "tasks", "water", "economics", "visuals"];
    case "irrigation_category":
      return ["tasks", "water"];
    case "area":
      return ["water", "economics"];
    default:
      return ["economics"];
  }
}
