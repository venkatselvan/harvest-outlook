import type { EvaraAction } from "@harvest/contracts";
import type { AskLanguage } from "../../features/ask/model";
import type { Boundary, Cycle, Rotation } from "../state";
import { farmHref, type FarmTab } from "../farmTabs";
import { askQuestion, kitLabels, labelDate } from "./labels";

/**
 * Evara action executor (docs/research/EVARA_ACTIONS_SPEC.md 2.5). The model never writes: it names an action from a fixed
 * allowlist, the server validates its ids, and this module runs it after the farmer taps a control. Anything that changes
 * saved data goes through a confirm sheet (`PlanCropSheet`) and the workspace PUT; nothing is written on open.
 *
 * `EvaraContext` is the whole surface the executor touches, so it is stubbed in tests and the panel supplies the real one.
 */

/** What the Plan-this-crop sheet is opened for. `pick`: the sheet decides add or replace from the field's saved seasons. */
export interface PlanCropRequest {
  mode: "pick" | "add" | "replace";
  cropId: string;
  cropName: string;
  productId: string | null;
  /** Candidate sowing date; null = today. */
  sowingDate: string | null;
  /** `replace`: the saved season to replace (a workspace rotation plan id). */
  rotationPlanId?: string;
}

/** A message Evara's panel appends on its own after a save, written by code in the panel's language. */
export interface LocalAssistantMessage {
  text: string;
  actions: EvaraAction[];
  language: AskLanguage;
}

export interface EvaraContext {
  farmId: string | null;
  /** The field viewed in the shell (`?field=`); null = the whole farm or a farm without fields. */
  fieldId: string | null;
  language: AskLanguage;
  /** The farm tab the farmer is on, so a compare opens beside what they were looking at. */
  tab: FarmTab;
  /** Today's calendar date (ISO, farm calendar). */
  today: () => string;
  /** The stored workspace of the selected farm, or undefined while it loads. */
  rotationPlans: () => Rotation[] | undefined;
  cycles: () => Cycle[] | undefined;
  fields: () => { id: string; name: string }[];
  cropName: (cropId: string) => string;
  /** The viewed field's outline for the schematics; null draws the default plot. */
  fieldBoundary: () => Boundary | null;
  /** The catalogue's first product of a crop (the compare selection is by product), or null when the crop has none. */
  productIdFor: (cropId: string) => string | null;
  /** The workspace PUT (it carries the expected version). */
  save: (patch: { rotationPlans: Rotation[] }) => Promise<unknown>;
  refreshWorkspace: () => Promise<unknown> | unknown;
  /** The workspace's toast. */
  notify: (text: string) => void;
  /** Append a code-written assistant message to the chat. */
  say: (message: LocalAssistantMessage) => void;
  /** Send a question as the farmer would (the panel's own send). */
  ask: (question: string) => void;
  navigate: (href: string) => void;
  /** Write the compare selection of this farm (`ho.compare.<owner>.<farmId>`, `manualProducts: true`). */
  writeCompareSelection: (farmId: string, productIds: string[]) => void;
  openSheet: (request: PlanCropRequest) => void;
  /** Render or expand the growth journey of a crop in the message the action came from. */
  showJourney: (action: Extract<EvaraAction, { kind: "show_journey" }>) => void;
  /** Test seam for the request used by the sheet and the journey strip. */
  fetchImpl?: typeof fetch;
}

/** The query parameters the Plan tab reads for `use_plan`: `?option=<optionId>` and, for an alternative plan, `&alternative=1`. */
export const USE_PLAN_OPTION_PARAM = "option";
export const USE_PLAN_ALTERNATIVE_PARAM = "alternative";

/** The Plan-tab URL a `use_plan` action opens: the plan of its field with the option to open, `alternative=1` for the alternatives source. */
export function usePlanHref(action: Extract<EvaraAction, { kind: "use_plan" }>, fallbackField: string | null): string {
  const base = farmHref("year", undefined, action.fieldId ?? fallbackField);
  return `${base}&${USE_PLAN_OPTION_PARAM}=${encodeURIComponent(action.optionId)}${action.alternative ? `&${USE_PLAN_ALTERNATIVE_PARAM}=1` : ""}`;
}

/** The compare drawer of the tab the farmer is on (`?tool=compare`, as FarmCommandCenter reads it). */
export const compareHref = (tab: FarmTab, fieldId: string | null) => `${farmHref(tab, undefined, fieldId)}&tool=compare`;

/** Where `open` goes. */
export function openHref(target: Extract<EvaraAction, { kind: "open" }>["target"], ctx: Pick<EvaraContext, "tab" | "fieldId">): string {
  switch (target) {
    case "plan":
      return farmHref("year", undefined, ctx.fieldId);
    case "fit":
      return farmHref("soil", "fit", ctx.fieldId);
    case "journal":
      return farmHref("soil", "activity", ctx.fieldId);
    case "compare":
      return compareHref(ctx.tab, ctx.fieldId);
    case "today":
      return farmHref("today", undefined, ctx.fieldId);
  }
}

/** Run one action. Synchronous: every write happens later, from the confirm sheet. */
export function runEvaraAction(action: EvaraAction, ctx: EvaraContext): void {
  switch (action.kind) {
    case "ask":
      ctx.ask(askQuestion(ctx.language, action.promptKey));
      return;
    case "show_journey":
      ctx.showJourney(action);
      return;
    case "compare": {
      if (!ctx.farmId) return ctx.notify(kitLabels(ctx.language).sheet.noFarm);
      const productIds = [...new Set(action.cropIds.map((id) => ctx.productIdFor(id)).filter((id): id is string => !!id))].slice(0, 4);
      if (productIds.length) ctx.writeCompareSelection(ctx.farmId, productIds);
      ctx.navigate(compareHref(ctx.tab, ctx.fieldId));
      return;
    }
    case "pick_crop":
      ctx.openSheet({ mode: "pick", cropId: action.cropId, cropName: action.cropName, productId: action.productId, sowingDate: action.sowingDate });
      return;
    case "use_plan":
      ctx.navigate(usePlanHref(action, ctx.fieldId));
      return;
    case "replace_season":
      ctx.openSheet({ mode: "replace", cropId: action.cropId, cropName: action.cropName, productId: action.productId, sowingDate: action.sowingDate, rotationPlanId: action.rotationPlanId });
      return;
    case "add_season":
      ctx.openSheet({ mode: "add", cropId: action.cropId, cropName: action.cropName, productId: action.productId, sowingDate: action.sowingDate });
      return;
    case "open":
      ctx.navigate(openHref(action.target, ctx));
      return;
  }
}

export type SeasonSaved =
  | { kind: "added"; cropName: string; sowing: string }
  | { kind: "replaced"; cropName: string; fromCropName: string; sowing: string };

/** The code-written confirmation after a save, with an `open plan` action: "Saved: Ginger replaces Pigeon pea, planned for 12 Feb 2027". */
export function savedMessage(saved: SeasonSaved, language: AskLanguage): LocalAssistantMessage {
  const t = kitLabels(language).saved;
  const date = labelDate(saved.sowing, language);
  return {
    language,
    text: saved.kind === "added" ? t.added(saved.cropName, date) : t.replaced(saved.cropName, saved.fromCropName, date),
    actions: [{ kind: "open", label: t.openPlan, target: "plan" }],
  };
}

/** After any save: reload the workspace, toast, and tell the chat what was saved. A failed reload does not undo the save, it is reported through the toast text only. */
export async function finishSeasonSave(ctx: EvaraContext, saved: SeasonSaved): Promise<void> {
  const message = savedMessage(saved, ctx.language);
  try {
    await ctx.refreshWorkspace();
  } catch {
    /* The save succeeded; the next workspace read shows it. */
  }
  ctx.notify(message.text);
  ctx.say(message);
}
