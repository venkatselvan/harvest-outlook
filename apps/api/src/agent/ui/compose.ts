import type { EvaraAction, EvaraNode, EvaraUi } from "@harvest/contracts";
import { buildActions, buildCropCompare, buildFarmSnapshot, buildGrowthJourney, buildPlanOptions, cropOf, openAction, pickCropAction, type Built } from "./build";
import { CLARIFY_FIRST, NO_ANSWER, langOf } from "./labels";
import type { Dropped } from "./parse";
import type { EvaraResolveData } from "./types";

/**
 * Fallback composer (docs/research/EVARA_ACTIONS_SPEC.md 2.7). Code builds the tree when the program is empty or its root
 * does not survive, and appends the intent's data component when a crop, plan or journey program left it out:
 *
 *  - explore_crops, compare_crops: the answer blocks, CropCompare(top 3 crops), Actions([PickCrop(each), Open("fit")]);
 *  - plan_question: the answer blocks, PlanOptions(alternatives when present, else plan; else the saved seasons), Actions([Open("plan")]);
 *  - growth_journey: the answer blocks, GrowthJourney(the first crop this run resolved, else the current crop, null);
 *  - anything else: the answer blocks.
 * With no approved block the tree starts with a code-written callout in the turn language and the FarmSnapshot.
 */

export const CROP_INTENTS: ReadonlySet<string> = new Set(["explore_crops", "compare_crops"]);

const MAX_CHILDREN = 12;

/** A Stack of the nodes; more than 12 are nested so every Stack keeps the contract's 12-child limit. */
export function stackOf(nodes: EvaraNode[]): EvaraNode {
  if (nodes.length <= MAX_CHILDREN) return { type: "stack", children: nodes };
  return { type: "stack", children: [...nodes.slice(0, MAX_CHILDREN - 1), stackOf(nodes.slice(MAX_CHILDREN - 1))] };
}

export function appendNodes(root: EvaraNode, nodes: EvaraNode[]): EvaraNode {
  if (!nodes.length) return root;
  return stackOf(root.type === "stack" ? [...root.children, ...nodes] : [root, ...nodes]);
}

export function prependNodes(root: EvaraNode, nodes: EvaraNode[]): EvaraNode {
  if (!nodes.length) return root;
  return stackOf(root.type === "stack" ? [...nodes, ...root.children] : [...nodes, root]);
}

/** Top 3 crops for the fallback CropCompare: crop-fit picks of the viewed field (pass-2 aware), then its best candidates, then screening, then the briefing's picks. */
export function fallbackCompareCrops(d: EvaraResolveData): string[] {
  const out: string[] = [];
  const add = (id: string) => {
    const c = cropOf(d, id);
    if (c && !out.includes(c.slug) && out.length < 3) out.push(c.slug);
  };
  if (d.cropFit) {
    for (const p of [...d.cropFit.picks].sort((a, b) => a.rank - b.rank)) add(p.cropId);
    if (out.length < 2) for (const c of [...d.cropFit.candidates].sort((a, b) => a.rank - b.rank)) add(c.cropId);
  }
  if (out.length < 2 && d.screening) {
    for (const o of ["eligible", "requires_review"]) for (const r of d.screening.results) if (r.outcome === o) add(r.cropId);
  }
  if (out.length < 2 && d.briefing?.cropFit) for (const p of d.briefing.cropFit.picks) add(p.cropId);
  return out;
}

/** The crop for the fallback GrowthJourney: the first crop this run resolved, else the current crop. */
export function fallbackJourneyCrop(d: EvaraResolveData): string | null {
  for (const id of d.resolvedCropIds) {
    const c = cropOf(d, id);
    if (c) return c.slug;
  }
  const cur = d.currentCycle?.cropId ?? d.briefing?.cycle?.cropId ?? null;
  return cur ? (cropOf(d, cur)?.slug ?? null) : null;
}

const okOrRecord = <T>(b: Built<T>, dropped: Dropped[], what: string): T | null => {
  if (b.ok) return b.value;
  dropped.push({ line: 0, code: b.code, detail: `${what}: ${b.detail}`.slice(0, 200) });
  return null;
};

/**
 * The intent's data component(s) the tree lacks. `compose` = building the whole fallback tree (the navigation action is
 * added even when the data component cannot be built); otherwise the actions come only with an appended component and
 * only when the tree has no Actions or Choice of its own.
 */
export function dataComponentsFor(d: EvaraResolveData, present: ReadonlySet<EvaraNode["type"]>, dropped: Dropped[], compose = false): EvaraNode[] {
  const intent = d.intent ?? "";
  const out: EvaraNode[] = [];
  const hasActions = present.has("actions") || present.has("choice");
  if (CROP_INTENTS.has(intent) && !present.has("crop_compare")) {
    const crops = fallbackCompareCrops(d);
    const table = crops.length >= 2 ? okOrRecord(buildCropCompare(d, crops), dropped, "fallback CropCompare") : (dropped.push({ line: 0, code: "empty-after-resolve", detail: `fallback CropCompare: ${crops.length} ranked or screened crops` }), null);
    if (table) out.push(table);
    if ((table && !hasActions) || compose) {
      const acts: EvaraAction[] = [...crops.flatMap((c) => okOrRecord(pickCropAction(d, c), dropped, "fallback PickCrop") ?? []), okOrRecord(openAction(d, "fit"), dropped, "fallback Open")!];
      const a = okOrRecord(buildActions(acts), dropped, "fallback Actions");
      if (a) out.push(a);
    }
  } else if (intent === "plan_question" && !present.has("plan_options")) {
    const b = buildPlanOptions(d, null);
    const plans = b.ok ? b.value : okOrRecord(buildPlanOptions(d, "saved"), dropped, "fallback PlanOptions");
    if (!b.ok && plans) dropped.push({ line: 0, code: b.code, detail: `fallback PlanOptions: ${b.detail}`.slice(0, 200) });
    if (plans) out.push(plans);
    if ((plans && !hasActions) || compose) {
      const a = okOrRecord(buildActions([okOrRecord(openAction(d, "plan"), dropped, "fallback Open")!]), dropped, "fallback Actions");
      if (a) out.push(a);
    }
  } else if (intent === "growth_journey" && !present.has("growth_journey")) {
    const crop = fallbackJourneyCrop(d);
    const j = crop ? okOrRecord(buildGrowthJourney(d, crop, null), dropped, "fallback GrowthJourney") : (dropped.push({ line: 0, code: "empty-after-resolve", detail: "fallback GrowthJourney: no crop resolved and no current crop" }), null);
    if (j) out.push(j);
  }
  return out;
}

const textNodes = (d: EvaraResolveData): EvaraNode[] => d.blocks.map((b) => ({ type: "text", blockId: b.id, kind: b.kind, text: b.text }));

export function composeFallback(d: EvaraResolveData, dropped: Dropped[] = []): EvaraUi {
  const rec = [...dropped];
  const l = langOf(d.language);
  const texts = textNodes(d);
  const lead: EvaraNode[] = [];
  if (!texts.length) {
    lead.push({ type: "callout", tone: "info", text: (d.hasClarification ? CLARIFY_FIRST : NO_ANSWER)[l], blockId: null });
    const snap = buildFarmSnapshot(d);
    if (snap.ok) lead.push(snap.value);
  }
  const data = dataComponentsFor(d, new Set(), rec, true);
  return { version: "1", origin: "fallback", root: stackOf([...lead, ...texts, ...data]), dropped: rec.slice(0, 20) };
}

/** Last resort when even the composed tree does not fit the contract. */
export function minimalUi(d: EvaraResolveData, dropped: Dropped[] = []): EvaraUi {
  return { version: "1", origin: "fallback", root: { type: "stack", children: [{ type: "callout", tone: "info", text: NO_ANSWER[langOf(d.language)], blockId: null }] }, dropped: dropped.slice(0, 20) };
}
