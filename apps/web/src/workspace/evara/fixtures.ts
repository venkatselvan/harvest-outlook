import type { CropJourney, EvaraUi, SeasonPreview } from "@harvest/contracts";
import type { Cycle, Rotation } from "../state";
import { seasonPreviewFixture } from "../season/fixtures";
import type { EvaraContext, LocalAssistantMessage, PlanCropRequest } from "./actions";

/**
 * Synthetic fixtures for the Evara UI kit tests. Every tree, season and journey here is made up for tests; none of it is
 * live output of the assistant or of the image service.
 */
export const FARM_ID = "11111111-1111-4111-8111-111111111111";
export const FIELD_ID = "field-hassan-a";
export const REVIEW_ID = "33333333-3333-4333-8333-333333333333";
export const JOURNEY_ID = "44444444-4444-4444-8444-444444444444";
export const TODAY = "2026-11-04";

const cell = (text: string, tone: "good" | "watch" | "short" | "neutral" | null = null, note: string | null = null) => ({ text, tone, note });

/** One tree with every node type and every action kind, as the server would resolve it. */
export function evaraTreeFixture(): EvaraUi {
  return {
    version: "1",
    origin: "model",
    dropped: [],
    root: {
      type: "stack",
      children: [
        { type: "text", blockId: "b1", kind: "text", text: "Your standing paddy comes first.\n\nThree crops could follow it." },
        { type: "text", blockId: "b2", kind: "warning", text: "Pigeon pea is planned but not sown." },
        { type: "text", blockId: "b3", kind: "limitation", text: "Water fit uses typical rain, not a forecast." },
        { type: "callout", tone: "info", text: "Ranked as replacements for Pigeon pea.", blockId: "b4" },
        {
          type: "farm_snapshot",
          fieldName: "Hassan field A",
          crop: "Paddy",
          stage: "Flowering",
          dayOfSeason: "Day 74",
          rainNext7Days: "12 mm",
          nextAction: "Drain the field",
          nextActionWindow: "6 to 9 Nov",
          openAlerts: 2,
        },
        {
          type: "crop_compare",
          columns: ["fit", "sowing", "duration", "water", "harvest", "profit", "replaces"],
          rows: [
            {
              cropId: "ginger",
              cropName: "Ginger",
              productName: "Fresh rhizome",
              cells: {
                fit: cell("78 of 100", "good"),
                sowing: cell("12 Feb 2027"),
                duration: cell("240 to 260 days"),
                water: cell("Needs irrigation", "watch", "Typical rain covers about half"),
                harvest: cell("20 Sep to 15 Oct 2027"),
                profit: cell("—", null, "No price history for this district"),
                replaces: cell("Pigeon pea (planned 20 Feb 2027)"),
              },
              actions: [
                { kind: "pick_crop", label: "Plan Ginger", cropId: "ginger", cropName: "Ginger", productId: "ginger-fresh", sowingDate: "2027-02-12" },
                { kind: "show_journey", label: "See how it could grow", cropId: "ginger", cropName: "Ginger", sowingDate: "2027-02-12" },
              ],
            },
            {
              cropId: "turmeric",
              cropName: "Turmeric",
              productName: null,
              cells: { fit: cell("61 of 100", "short"), sowing: cell("12 Feb 2027") },
              actions: [{ kind: "pick_crop", label: "Plan Turmeric", cropId: "turmeric", cropName: "Turmeric", productId: null, sowingDate: null }],
            },
          ],
          note: "Fit scores come from the stored crop fit review.",
        },
        {
          type: "plan_options",
          source: "alternatives",
          basis: "replace_planned",
          note: "Alternatives under the same conditions.",
          options: [
            {
              optionId: "alt-1",
              reviewId: REVIEW_ID,
              label: "Alternative A",
              chips: ["Replaces a planned season"],
              slots: [
                { cropName: "Ginger", productName: "Fresh rhizome", kind: "crop", sowing: "2027-02-12", harvest: { earliest: "2027-09-20", latest: "2027-10-15" }, profitForField: "INR 1.2 lakh", replaces: "Pigeon pea" },
                { cropName: "Sunn hemp", productName: null, kind: "green_manure", sowing: "2027-11-01", harvest: { earliest: "2027-12-15", latest: "2027-12-30" }, profitForField: null, replaces: null },
              ],
              actions: [{ kind: "use_plan", label: "Use instead of Pigeon pea", reviewId: REVIEW_ID, optionId: "alt-1", alternative: true, fieldId: FIELD_ID }],
            },
          ],
        },
        {
          type: "growth_journey",
          cropId: "ginger",
          cropName: "Ginger",
          productId: null,
          fieldId: FIELD_ID,
          sowingDate: "2027-02-12",
          stages: [
            { stageId: "establishment", name: "Establishment", from: "2027-02-12", to: "2027-04-12", basis: "sourced" },
            { stageId: "vegetative", name: "Vegetative growth", from: "2027-04-13", to: "2027-07-30", basis: "sourced" },
            { stageId: "rhizome", name: "Rhizome bulking", from: "2027-07-31", to: "2027-09-19", basis: "sourced" },
          ],
          journeyId: null,
          note: null,
        },
        {
          type: "choice",
          prompt: "Which crop should I put in the plan?",
          blockId: "b5",
          options: [
            { kind: "add_season", label: "Add Ginger for 12 Feb 2027", cropId: "ginger", cropName: "Ginger", productId: "ginger-fresh", sowingDate: "2027-02-12" },
            { kind: "replace_season", label: "Replace Pigeon pea with Ginger", rotationPlanId: "rot-pigeon", fromCropName: "Pigeon pea", cropId: "ginger", cropName: "Ginger", productId: null, sowingDate: "2027-02-12" },
          ],
        },
        {
          type: "actions",
          items: [
            { kind: "compare", label: "Compare these crops", cropIds: ["ginger", "turmeric"] },
            { kind: "open", label: "Open the plan", target: "plan" },
            { kind: "ask", label: "What could I have planted instead?", promptKey: "what_could_have_been" },
          ],
        },
      ],
    },
  };
}

export function pigeonPlan(over: Partial<Rotation> = {}): Rotation {
  return {
    id: "rot-pigeon",
    year: 2027,
    season: "Summer",
    cropId: "pigeon-pea",
    cropName: "Pigeon pea",
    productId: "pigeon-pea-whole",
    productName: "Whole",
    plannedSowingDate: "2027-02-20",
    plannedHarvestDate: "2027-08-10",
    fieldId: FIELD_ID,
    ...over,
  };
}

export function gingerPreview(over: Partial<SeasonPreview> = {}): SeasonPreview {
  return seasonPreviewFixture({
    planId: null,
    origin: "custom",
    cropId: "ginger",
    cropName: "Ginger",
    productId: "ginger-fresh",
    productName: "Fresh rhizome",
    sowing: "2027-02-12",
    harvest: { earliest: "2027-09-20", latest: "2027-10-15" },
    ...over,
  });
}

export interface CtxCalls {
  asked: string[];
  navigated: string[];
  sheets: PlanCropRequest[];
  journeys: string[];
  notices: string[];
  said: LocalAssistantMessage[];
  saved: { rotationPlans: Rotation[] }[];
  compare: { farmId: string; productIds: string[] }[];
  /** Order of side effects of a finished save, so a test can see refresh came before the toast and the chat message. */
  order: string[];
}

export function ctxStub(over: Partial<EvaraContext> = {}, state: { plans?: Rotation[]; cycles?: Cycle[]; saveError?: unknown } = {}): { ctx: EvaraContext; calls: CtxCalls } {
  const calls: CtxCalls = { asked: [], navigated: [], sheets: [], journeys: [], notices: [], said: [], saved: [], compare: [], order: [] };
  const ctx: EvaraContext = {
    farmId: FARM_ID,
    fieldId: FIELD_ID,
    language: "en",
    tab: "today",
    today: () => TODAY,
    rotationPlans: () => state.plans ?? [pigeonPlan()],
    cycles: () => state.cycles ?? [],
    fields: () => [{ id: FIELD_ID, name: "Hassan field A" }],
    cropName: (id) => ({ ginger: "Ginger", turmeric: "Turmeric", "pigeon-pea": "Pigeon pea" })[id] ?? id,
    fieldBoundary: () => null,
    productIdFor: (id) => ({ ginger: "ginger-fresh", turmeric: "turmeric-fresh" })[id] ?? null,
    save: async (patch) => {
      if (state.saveError) throw state.saveError;
      calls.saved.push(patch);
    },
    refreshWorkspace: async () => {
      calls.order.push("refresh");
    },
    notify: (text) => {
      calls.notices.push(text);
      calls.order.push("notify");
    },
    say: (message) => {
      calls.said.push(message);
      calls.order.push("say");
    },
    ask: (q) => calls.asked.push(q),
    navigate: (href) => calls.navigated.push(href),
    writeCompareSelection: (farmId, productIds) => calls.compare.push({ farmId, productIds }),
    openSheet: (request) => calls.sheets.push(request),
    showJourney: (action) => calls.journeys.push(action.cropId),
    ...over,
  };
  return { ctx, calls };
}

export function journeyFixture(over: Partial<CropJourney> = {}): CropJourney {
  const stage = (n: number, status: CropJourney["stages"][number]["status"], extra: Partial<CropJourney["stages"][number]> = {}): CropJourney["stages"][number] => ({
    stageId: `stage-${n}`,
    name: ["Establishment", "Vegetative growth", "Rhizome bulking"][n] ?? `Stage ${n}`,
    from: "2027-02-12",
    to: "2027-04-12",
    targetDate: "2027-02-12",
    illustrated: true,
    status,
    reason: null,
    assetId: status === "ready" ? `55555555-5555-4555-8555-55555555555${n}` : null,
    imagePath: status === "ready" ? `/api/v1/farms/${FARM_ID}/future-look/55555555-5555-4555-8555-55555555555${n}/image` : null,
    guidance: "Synthetic guidance sentence.",
    label: "Illustrative growth, generated image, not a prediction",
    ...extra,
  });
  return {
    journeyId: JOURNEY_ID,
    farmId: FARM_ID,
    fieldId: FIELD_ID,
    cropId: "ginger",
    cropName: "Ginger",
    productId: null,
    sowingDate: "2027-02-12",
    status: "queued",
    reason: null,
    source: { kind: "satellite", itemId: "S2A_TEST", date: "2026-10-28" },
    deduplicated: false,
    stages: [stage(0, "queued"), stage(1, "queued"), stage(2, "queued")],
    disclaimer: "Illustrations only.",
    limitations: [],
    createdAt: "2026-11-04T08:00:00.000Z",
    updatedAt: "2026-11-04T08:00:00.000Z",
    ...over,
  };
}

/** The journey with its stages in the given states (index order). */
export function journeyWith(status: CropJourney["status"], stages: CropJourney["stages"][number]["status"][], over: Partial<CropJourney> = {}): CropJourney {
  const base = journeyFixture();
  return {
    ...base,
    status,
    stages: base.stages.map((s, i) => {
      const next = stages[i] ?? "queued";
      return { ...s, status: next, assetId: next === "ready" ? `55555555-5555-4555-8555-55555555555${i}` : null, imagePath: next === "ready" ? `/api/v1/farms/${FARM_ID}/future-look/55555555-5555-4555-8555-55555555555${i}/image` : null };
    }),
    ...over,
  };
}
