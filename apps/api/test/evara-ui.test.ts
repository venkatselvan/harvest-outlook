import { describe, expect, it } from "vitest";
import { CropFitReview, EvaraUi, FarmBriefing, YearPlanReview, type EvaraNode } from "@harvest/contracts";
import { capProgram, MAX_PROGRAM_CHARS, parseEvaraLang, parseLine } from "../src/agent/ui/parse";
import { evaraOccupants } from "../src/agent/ui/load";
import { resolveEvaraUi } from "../src/agent/ui/resolve";
import { composeFallback } from "../src/agent/ui/compose";
import { EVARA_LIBRARY_PROMPT, EXAMPLE_PROGRAMS } from "../src/agent/ui/prompt";
import { ACTIONS, COMPONENTS } from "../src/agent/ui/library";
import { emptyEvaraData, timelineKey, type EvaraResolveData } from "../src/agent/ui/types";
import { INTERPRETATION_INSTRUCTIONS, PROMPT_HASH, PROMPT_VERSION, SYNTHESIS_INSTRUCTIONS } from "../src/agent/prompts";

/** Evara Lang parser, resolver, fallback composer and prompt generator (docs/EVARA_LANG.md). Pure: no database. */

const REVIEW_ID = "11111111-1111-4111-8111-111111111111";
const GINGER_UUID = "00000000-0000-4000-8000-0000000000c1";
const q = (value: number, unit: string) => ({ value, unit });
const comps = { price: 0.5, yield: 0.5, soilRotation: 0.5, water: 0.5, confidence: 0.5 };
const weights = { price: 40, yield: 30, soilRotation: 15, water: 10, confidence: 5 } as const;

const BRIEFING = FarmBriefing.parse({
  asOf: "2026-11-04T05:00:00.000Z",
  today: "2026-11-04",
  farm: { districtId: "IN-KA-hassan", districtName: "Hassan", stateId: "IN-KA", stateName: "Karnataka", area: q(0.16, "ha"), waterCategory: "rainfed", labour: "family", budget: null },
  cycle: { cropId: "paddy", cropName: "Paddy", productId: "paddy-grain", productName: "Paddy grain", sowingDate: "2026-10-31", establishmentDate: null, establishmentMethod: null, workspaceStage: "sowed", dayOfSeason: q(4, "days"), stageToday: { id: "s1", name: "Establishment", from: "2026-10-31", to: "2026-11-20", basis: "sourced" }, nextStage: null, harvestWindow: { earliest: "2027-02-20", latest: "2027-03-05" }, daysToHarvest: null, timelineBasis: null, satellitePhase: null },
  weather: { source: "Open-Meteo", issuedAt: "2026-11-04T00:00:00.000Z", observed: [], forecast: [], rainLast7Days: null, rainNext7Days: q(31.5, "mm") },
  satellite: null,
  alerts: [{ id: "a1", type: "weather", severity: "watch", title: "Heavy rain", detail: "Rain expected", validFrom: "2026-11-05", validTo: "2026-11-06", suggestedStep: null, source: "Open-Meteo forecast", sourceDate: "2026-11-04" }],
  steps: { nextAction: { id: "n1", kind: "care", title: "Check field drains", detail: null, dueFrom: "2026-11-05", dueTo: "2026-11-07", status: "open" }, upcoming: [] },
  price: null,
  economics: null,
  soil: null,
  plans: null,
  cropFit: { generatedAt: "2026-11-03T00:00:00.000Z", picks: [{ rank: 1, cropId: "green-gram", cropName: "Green gram", productName: "Green gram whole", reason: "Short season", replacesCropName: "Pigeon pea" }] },
  journal: null,
  fields: { count: 2, viewedField: "North strip" },
  limitations: [],
});

const candidate = (cropId: string, cropName: string, rank: number, over: Record<string, unknown> = {}) => ({
  cropId, productId: `${cropId}-main`, cropName, productName: `${cropName} grain`, establishmentMethod: null, rank, score: 80 - rank, components: comps,
  sowing: "2027-02-10", harvest: { earliest: "2027-04-25", latest: "2027-05-10" }, durationDays: { low: 75, high: 90 },
  window: { scope: "district", season: "rabi", fit: 1, shiftedDays: 0 }, yieldKgPerHa: null, yieldBasis: null, price: null, marketNow: null, cost: null, profitPerHa: null,
  profitForField: { central: 6000, likely: { low: 3000, high: 9000 }, possible: { low: 1000, high: 12000 } },
  soil: { status: "no_report", checks: [] }, water: { fit: 0.8, needMm: null, rainMm: null, verdict: "Rain covers most of the need" },
  rotation: { previousCropId: "paddy", rule: "legume_after_cereal", note: null }, confidence: "medium", reasonCodes: [], uncertainties: [], basis: [], ...over,
});
const REPL = { rotationPlanId: "rp-planned", cropId: "pigeon-pea", cropName: "Pigeon pea", plannedSowingDate: "2027-02-12" };

const CROP_FIT = CropFitReview.parse({
  reviewId: REVIEW_ID, jobId: null, contextHash: "h", status: "ready", stale: false, request: { mode: "next", season: null, sowing: null }, resolvedSowing: "2027-02-10",
  previousCropId: "paddy", currentCycleId: "c1", fieldAreaHa: 0.16, generatedAt: "2026-11-03T00:00:00.000Z", modelInvocation: null,
  picks: [{ cropId: "green-gram", productId: "green-gram-main", rank: 1, headline: "Short season", reasons: [] }, { cropId: "black-gram", productId: "black-gram-main", rank: 2, headline: "Fits rabi", reasons: [] }],
  pickOrigin: "deterministic",
  candidates: [candidate("green-gram", "Green gram", 1, { replaces: [REPL] }), candidate("black-gram", "Black gram", 2, { replaces: [REPL] }), candidate("maize", "Maize", 7, { profitForField: null })],
  weights, soilReportStatus: "none", summary: "Pigeon pea is planned but not sown, so these are ranked as replacements.", limitations: [], fieldId: "north", replacePass: true,
});

const slot = (cropId: string, cropName: string, sowing: string, latest: string, fixed = false) => ({
  slotId: `${cropId}-${sowing}`, cropId, productId: `${cropId}-main`, cropName, productName: `${cropName} grain`, establishmentMethod: null, fixed, sowing,
  harvest: { earliest: latest, latest }, occupancy: { from: sowing, to: latest }, durationDays: { low: 80, high: 90 }, yieldKgPerHa: null, yieldBasis: null, price: null, cost: null,
  revenuePerHa: null, profitPerHa: null, profitForField: { central: 5000, likely: { low: 2000, high: 8000 }, possible: { low: 0, high: 10000 } }, score: 70, components: comps, confidence: "medium",
  transitionNote: null, reasonCodes: [], uncertainties: [], basis: [],
});
const option = (optionId: string, label: string, slots: ReturnType<typeof slot>[]) => ({ optionId, label, origin: "deterministic", score: 70, components: comps, slots, idleMonths: 1, reasons: [], totalRevenuePerHa: null, totalProfitPerHa: null, warnings: [], editable: true });
const yearPlan = (alternatives: unknown) =>
  YearPlanReview.parse({
    reviewId: REVIEW_ID, jobId: null, contextHash: "h", status: "ready", stale: false, inputVersions: { farm: 1, workspace: 1 }, generatedAt: "2026-11-03T00:00:00.000Z", retryAfter: null, modelInvocation: null,
    scenario: {
      kind: "occupied", horizon: { from: "2026-11-01", to: "2027-10-31" }, currentCycleId: "c1", previousCropId: null, fieldAreaHa: 0.16, irrigationCategory: "rainfed", stateId: "KA", districtId: "IN-KA-hassan", soilSummary: null, neighbourhoodActiveMonths: null,
      occupied: [{ id: "rp-planned", source: "saved_season", cropId: "pigeon-pea", productId: null, cropName: "Pigeon pea", productName: null, kind: "crop", companion: null, establishmentMethod: null, sowing: "2027-02-12", harvestDate: null, occupancy: { from: "2027-02-12", to: "2027-08-30" }, occupancyBasis: "planned", note: null, realisation: "planned" }],
    },
    weights,
    options: [option("best", "Best overall", [slot("paddy", "Paddy", "2026-10-31", "2027-03-05", true)])],
    noFreeWindow: true, alternatives, candidatesConsidered: 10, summary: "Planned seasons fill the year.", limitations: [], appliedOptionIds: [], fieldId: "north", fieldAreaHa: 0.16,
  });
const ALT_REPLACE = { basis: "replace_planned", summary: "x", replaces: [REPL], horizon: { from: "2026-11-01", to: "2027-10-31" }, options: [option("alt-1", "Green gram instead", [slot("paddy", "Paddy", "2026-10-31", "2027-03-05", true), slot("green-gram", "Green gram", "2027-03-15", "2027-06-10")])], limitations: [] };
const ALT_SOWN = { ...ALT_REPLACE, basis: "sown_comparison", replaces: [] };

const CROPS = {
  paddy: { slug: "paddy", en: "Paddy", hi: "धान", ta: "நெல்" },
  "green-gram": { slug: "green-gram", en: "Green gram", hi: "मूंग", ta: "பாசிப்பயறு" },
  "black-gram": { slug: "black-gram", en: "Black gram" },
  maize: { slug: "maize", en: "Maize" },
  ginger: { slug: "ginger", en: "Ginger", hi: "अदरक" },
  turmeric: { slug: "turmeric", en: "Turmeric" },
  "pigeon-pea": { slug: "pigeon-pea", en: "Pigeon pea" },
  [GINGER_UUID]: { slug: "ginger", en: "Ginger", hi: "अदरक" },
};

const BLOCKS = [
  { id: "b1", kind: "text" as const, text: "Green gram and black gram can replace the planned pigeon pea." },
  { id: "b2", kind: "text" as const, text: "Which one would you like to plan?" },
  { id: "b3", kind: "warning" as const, text: "Heavy rain is forecast this week." },
];

const STAGES = { stages: [{ id: "sprout", name: "Sprouting", from: "2026-11-04", to: "2026-12-04", basis: "sourced" }, { id: "rhizome", name: "Rhizome growth", from: "2026-12-05", to: "2027-05-01", basis: "sourced" }], harvest: { earliest: "2027-05-01", latest: "2027-06-01" } };

const data = (over: Partial<EvaraResolveData> = {}): EvaraResolveData =>
  emptyEvaraData({
    language: "en",
    today: "2026-11-04",
    intent: "compare_crops",
    blocks: BLOCKS,
    briefing: BRIEFING,
    cropFit: CROP_FIT,
    yearPlan: yearPlan(ALT_REPLACE),
    fieldId: "north",
    occupants: [
      { rotationPlanId: "rp-planned", cropId: "pigeon-pea", cropName: "Pigeon pea", productId: null, productName: null, season: "Summer", year: 2027, kind: "crop", plannedSowingDate: "2027-02-12", plannedHarvestDate: null, realisation: "planned", occupancyTo: "2027-08-30" },
      { rotationPlanId: "rp-sown", cropId: "paddy", cropName: "Paddy", productId: null, productName: null, season: "Rabi", year: 2026, kind: "crop", plannedSowingDate: "2026-10-30", plannedHarvestDate: "2027-03-05", realisation: "sown", occupancyTo: null },
    ],
    currentCycle: { cropId: "paddy", productId: "paddy-grain", sowingDate: "2026-10-31" },
    crops: CROPS,
    screening: { results: [{ cropId: "turmeric", productIds: ["turmeric-dry"], outcome: "requires_review", ruleResults: [], unknownFields: [], coverage: [], dimensions: [] }] },
    catalogueRows: { turmeric: { cropId: "turmeric", cropName: "Turmeric", outcome: "requires_review", season: "kharif", plantingWindow: { fromMonth: 5, toMonth: 6 }, durationDays: null, water: { fit: "partial", needClass: "medium" }, harvest: null } },
    timelines: { [timelineKey("ginger", "2026-11-04")]: STAGES },
    ...over,
  });

const resolve = (program: string, over: Partial<EvaraResolveData> = {}) => {
  const ui = resolveEvaraUi(program, data(over));
  expect(EvaraUi.safeParse(ui).success).toBe(true);
  return ui;
};
const codes = (ui: EvaraUi) => ui.dropped.map((d) => d.code);
const kids = (n: EvaraNode): EvaraNode[] => (n.type === "stack" ? n.children : [n]);
const find = <T extends EvaraNode["type"]>(n: EvaraNode, t: T): Extract<EvaraNode, { type: T }> | undefined => {
  if (n.type === t) return n as Extract<EvaraNode, { type: T }>;
  if (n.type === "stack") for (const c of n.children) { const f = find(c, t); if (f) return f; }
  return undefined;
};

describe("Evara Lang grammar", () => {
  it("parses every literal kind, lists, refs, calls and actions", () => {
    expect(parseLine('x = Foo("a-b:c/d_e.f", -2.5, 3, true, false, null, [y, "z"], @Ask("plant_next"))').expr).toEqual({
      k: "call", name: "Foo",
      args: [{ k: "str", v: "a-b:c/d_e.f" }, { k: "num", v: -2.5 }, { k: "num", v: 3 }, { k: "bool", v: true }, { k: "bool", v: false }, { k: "null" }, { k: "list", items: [{ k: "ref", name: "y" }, { k: "str", v: "z" }] }, { k: "action", name: "Ask", args: [{ k: "str", v: "plant_next" }] }],
    });
    expect(parseLine("x = []").expr).toEqual({ k: "list", items: [] });
    expect(parseLine('x = "say \\"hi\\""').expr).toEqual({ k: "str", v: 'say "hi"' });
  });

  it("skips blank lines, whole-line and trailing comments and Markdown fences; line numbers are 1-based", () => {
    const p = parseEvaraLang('```evara\n# heading\n\nroot = Stack([a]) # trailing\na = Text("b1")\n```');
    expect(p.dropped).toEqual([]);
    expect(p.statements.map((s) => [s.name, s.line])).toEqual([["root", 4], ["a", 5]]);
  });

  it("forward references resolve; the later of two same-named statements wins", () => {
    const ui = resolve('root = Stack([a, b])\na = Text("b2")\nb = Text("b1")\na = Text("b3")');
    expect(ui.origin).toBe("fallback"); // compare_crops intent without a CropCompare gets one appended
    expect(kids(ui.root).slice(0, 2).map((n) => (n as { blockId: string }).blockId)).toEqual(["b3", "b1"]);
  });

  it("without root the first Stack is the entry (no-root); with neither the composer runs", () => {
    const ui = resolve('a = Text("b1")\nmain = Stack([a])', { intent: "observation" });
    expect(ui.origin).toBe("model");
    expect(ui.dropped).toContainEqual({ line: 2, code: "no-root", detail: expect.stringContaining("main") });
    const none = resolve('a = Text("b1")', { intent: "observation" });
    expect(none.origin).toBe("fallback");
    expect(kids(none.root).map((n) => n.type)).toEqual(["text", "text", "text"]);
    expect(resolveEvaraUi(null, data({ intent: "observation" })).origin).toBe("fallback");
  });
});

describe("drop codes (each with a counterexample that survives)", () => {
  const obs = { intent: "observation" };
  const cases: [string, string, string][] = [
    ["parse-failed", 'root = Stack([Text("b1")]\n', 'root = Stack([Text("b1")])'],
    ["unknown-component", 'root = Stack([Table("b1"), Text("b2")])', 'root = Stack([Text("b1"), Text("b2")])'],
    ["unknown-action", 'root = Stack([Actions([@Delete("x"), @Open("plan")])])', 'root = Stack([Actions([@Open("plan")])])'],
    ["missing-required", 'root = Stack([Text(), Text("b2")])', 'root = Stack([Text("b1"), Text("b2")])'],
    ["type-mismatch", 'root = Stack([Callout("loud", "b1"), Text(2)])', 'root = Stack([Callout("warning", "b1")])'],
    ["excess-args", 'root = Stack([Text("b1", "b2"), Text("b3")])', 'root = Stack([Text("b1"), Text("b3")])'],
    ["unknown-ref", "root = Stack([missing, a])\na = Text(\"b1\")", 'root = Stack([a])\na = Text("b1")'],
    ["cycle", "root = Stack([a, c])\na = Stack([b])\nb = Stack([a])\nc = Text(\"b1\")", 'root = Stack([a])\na = Stack([c])\nc = Text("b1")'],
    ["prose-not-allowed", 'root = Stack([Text("Grow ginger now"), Text("b1")])', 'root = Stack([Text("b1")])'],
    ["unknown-id", 'root = Stack([Text("b9"), Text("b1")])', 'root = Stack([Text("b1")])'],
    ["not-replaceable", 'root = Stack([Text("b1"), Actions([@ReplaceSeason("rp-sown", "ginger"), @Open("plan")])])', 'root = Stack([Text("b1"), Actions([@ReplaceSeason("rp-planned", "ginger")])])'],
    ["empty-after-resolve", 'root = Stack([Stack([Text("b9")]), Text("b1")])', 'root = Stack([Stack([Text("b2")]), Text("b1")])'],
  ];
  for (const [code, bad, good] of cases) {
    it(code, () => {
      const b = resolve(bad, obs);
      expect(codes(b)).toContain(code);
      const g = resolve(good, obs);
      expect(codes(g)).not.toContain(code);
      expect(g.origin).toBe("model");
    });
  }

  it("FarmSnapshot without a briefing is empty-after-resolve; an empty root falls back to the composer", () => {
    const ui = resolve("root = Stack([FarmSnapshot()])", { intent: "observation", briefing: null });
    expect(codes(ui)).toEqual(expect.arrayContaining(["empty-after-resolve"]));
    expect(ui.origin).toBe("fallback");
  });

  it("lists longer than their maximum are cut and recorded as excess-args, the statement survives", () => {
    const ui = resolve('root = Stack([Text("b1"), CropCompare(["green-gram", "black-gram", "maize", "turmeric", "ginger"])])');
    expect(ui.dropped).toContainEqual({ line: 1, code: "excess-args", detail: "CropCompare: cropIds cut to 4 items" });
    expect(find(ui.root, "crop_compare")!.rows).toHaveLength(4);
  });
});

describe("no prose in the program (2.3)", () => {
  it("a sentence, a space or a non-id character in any string drops the statement", () => {
    for (const s of ["Grow ginger", "₹6000", "ginger!", "x".repeat(121)]) {
      const ui = resolve(`root = Stack([a, Text("b1")])\na = Callout("info", "${s}")`, { intent: "observation" });
      expect(ui.dropped.find((d) => d.code === "prose-not-allowed")?.line).toBe(2);
      expect(kids(ui.root).map((n) => n.type)).toEqual(["text", "text", "text"]);
    }
  });
  it("numbers are never accepted as a parameter value", () => {
    expect(codes(resolve('root = Stack([GrowthJourney("ginger", 20261104), Text("b1")])', { intent: "observation" }))).toContain("type-mismatch");
  });
  it("text nodes carry only approved block text; every other string is code-written", () => {
    const ui = resolve('root = Stack([Text("b1"), CropCompare(["green-gram", "black-gram"])])');
    expect(find(ui.root, "text")!.text).toBe(BLOCKS[0]!.text);
    expect(JSON.stringify(ui)).not.toMatch(/Grow ginger/);
  });
});

describe("id validation (2.5)", () => {
  it("crop ids: slugs and catalogue UUIDs map to the slug; unknown crops are unknown-id", () => {
    const ui = resolve(`root = Stack([Text("b1"), Actions([@PickCrop("${GINGER_UUID}"), @PickCrop("mango")])])`, { intent: "observation" });
    expect(find(ui.root, "actions")!.items).toEqual([expect.objectContaining({ kind: "pick_crop", cropId: "ginger", cropName: "Ginger" })]);
    expect(ui.dropped).toContainEqual(expect.objectContaining({ code: "unknown-id", detail: expect.stringContaining("mango") }));
  });
  it("option ids against the stored review and its alternatives; a sown_comparison alternative is not-replaceable", () => {
    const ok = resolve('root = Stack([Text("b1"), Actions([@UsePlan("plan", "best"), @UsePlan("alternatives", "alt-1"), @UsePlan("plan", "alt-9")])])', { intent: "observation" });
    expect(find(ok.root, "actions")!.items).toEqual([
      expect.objectContaining({ kind: "use_plan", optionId: "best", alternative: false, reviewId: REVIEW_ID, fieldId: "north" }),
      expect.objectContaining({ kind: "use_plan", optionId: "alt-1", alternative: true, label: "Use instead of Pigeon pea" }),
    ]);
    expect(codes(ok)).toContain("unknown-id");
    const sown = resolve('root = Stack([Text("b1"), Actions([@UsePlan("alternatives", "alt-1"), @Open("plan")])])', { intent: "observation", yearPlan: yearPlan(ALT_SOWN) });
    expect(codes(sown)).toContain("not-replaceable");
  });
  it("rotation plan ids: unknown is unknown-id, sown is not-replaceable, planned resolves with the crop-fit sowing", () => {
    const ui = resolve('root = Stack([Text("b1"), Actions([@ReplaceSeason("rp-x", "green-gram"), @ReplaceSeason("rp-sown", "green-gram"), @ReplaceSeason("rp-planned", "green-gram")])])', { intent: "observation" });
    expect(codes(ui)).toEqual(expect.arrayContaining(["unknown-id", "not-replaceable"]));
    expect(find(ui.root, "actions")!.items).toEqual([{ kind: "replace_season", label: "Replace Pigeon pea with Green gram", rotationPlanId: "rp-planned", fromCropName: "Pigeon pea", cropId: "green-gram", cropName: "Green gram", productId: "green-gram-main", sowingDate: "2027-02-10" }]);
  });
  it("AddSeason: a past date is ignored for the crop-fit sowing; no date and no crop-fit sowing is missing-required", () => {
    const ui = resolve('root = Stack([Text("b1"), Actions([@AddSeason("green-gram", "2026-01-01"), @AddSeason("ginger", null), @AddSeason("green-gram", null)])])', { intent: "observation" });
    expect(codes(ui)).toEqual(expect.arrayContaining(["type-mismatch", "missing-required"]));
    expect(ui.dropped).toContainEqual(expect.objectContaining({ code: "type-mismatch", detail: expect.stringContaining("sowing outside window") }));
    expect(find(ui.root, "actions")!.items.map((a) => [a.kind, (a as { sowingDate: string }).sowingDate])).toEqual([["add_season", "2027-02-10"], ["add_season", "2027-02-10"]]);
  });

  // Review fix E7c-4: a model-chosen sowing stands only when it is the crop-fit sowing, or lies within today..today+730 days
  // and inside the crop's regional catalogue planting window when one is loaded; otherwise the crop-fit sowing replaces it.
  it("AddSeason: model-chosen sowing dates are bounded by the crop-fit sowing, 730 days and the catalogue planting window", () => {
    const sow = (program: string, over: Partial<EvaraResolveData> = {}) => {
      const ui = resolve(`root = Stack([Text("b1"), Actions([${program}])])`, { intent: "observation", ...over });
      const acts = find(ui.root, "actions")?.items ?? [];
      return { dates: acts.map((a) => (a as { sowingDate: string }).sowingDate), outside: ui.dropped.filter((d) => d.code === "type-mismatch" && /sowing outside window/.test(d.detail ?? "")).length };
    };
    // the crop-fit candidate's own sowing is always accepted
    expect(sow('@AddSeason("green-gram", "2027-02-10")')).toEqual({ dates: ["2027-02-10"], outside: 0 });
    // a crop-fit crop with no catalogue window: any date up to today + 730 days (2028-11-03) stands; later falls back
    expect(sow('@AddSeason("green-gram", "2028-11-03")')).toEqual({ dates: ["2028-11-03"], outside: 0 });
    expect(sow('@AddSeason("green-gram", "2028-11-04")')).toEqual({ dates: ["2027-02-10"], outside: 1 });
    expect(sow('@AddSeason("green-gram", "2031-06-01")')).toEqual({ dates: ["2027-02-10"], outside: 1 });
    // turmeric: no crop-fit candidate, catalogue window May - Jun; a date outside it has nothing to fall back to and is dropped
    expect(sow('@AddSeason("turmeric", "2027-05-20")')).toEqual({ dates: ["2027-05-20"], outside: 0 });
    expect(sow('@AddSeason("turmeric", "2027-09-01")')).toEqual({ dates: [], outside: 1 });
    // a crop-fit crop whose catalogue window is loaded: a date in it stands, a date outside falls back to the crop-fit sowing
    const gg = { "green-gram": { cropId: "green-gram", cropName: "Green gram", outcome: "eligible" as const, season: "rabi", plantingWindow: { fromMonth: 1, toMonth: 2 }, durationDays: null, water: null, harvest: null } };
    expect(sow('@AddSeason("green-gram", "2027-01-20")', { catalogueRows: gg })).toEqual({ dates: ["2027-01-20"], outside: 0 });
    expect(sow('@AddSeason("green-gram", "2027-07-01")', { catalogueRows: gg })).toEqual({ dates: ["2027-02-10"], outside: 1 });
    // a window across the new year (Nov - Feb) and a second product's window (Jun - Jul)
    const pp = { "pigeon-pea": { cropId: "pigeon-pea", cropName: "Pigeon pea", outcome: "eligible" as const, season: "rabi", plantingWindow: { fromMonth: 11, toMonth: 2 }, plantingWindows: [{ fromMonth: 11, toMonth: 2 }, { fromMonth: 6, toMonth: 7 }], durationDays: null, water: null, harvest: null } };
    expect(sow('@AddSeason("pigeon-pea", "2027-01-15"), @AddSeason("pigeon-pea", "2026-12-01"), @AddSeason("pigeon-pea", "2027-06-10")', { catalogueRows: pp }).dates).toEqual(["2027-01-15", "2026-12-01", "2027-06-10"]);
    expect(sow('@AddSeason("pigeon-pea", "2027-03-01")', { catalogueRows: pp })).toEqual({ dates: [], outside: 1 });
    // no window and no candidate: the 730-day bound only
    expect(sow('@AddSeason("ginger", "2027-09-01")')).toEqual({ dates: ["2027-09-01"], outside: 0 });
    expect(sow('@AddSeason("ginger", "2029-06-01")')).toEqual({ dates: [], outside: 1 });
  });
});

describe("component fills", () => {
  it("FarmSnapshot from the briefing", () => {
    const ui = resolve('root = Stack([FarmSnapshot(), Text("b1")])', { intent: "observation" });
    expect(find(ui.root, "farm_snapshot")).toEqual({ type: "farm_snapshot", fieldName: "North strip", crop: "Paddy", stage: "Establishment", dayOfSeason: "Day 4", rainNext7Days: "31.5 mm", nextAction: "Check field drains", nextActionWindow: "5 Nov – 7 Nov 2026", openAlerts: 1 });
  });

  it("CropCompare from the crop-fit review (pass 2), screening and the catalogue; unknown cells are dashes with a reason", () => {
    const ui = resolve('root = Stack([Text("b1"), CropCompare(["green-gram", "turmeric", "mango"])])');
    const t = find(ui.root, "crop_compare")!;
    expect(t.columns).toEqual(["fit", "sowing", "duration", "water", "harvest", "profit", "replaces"]);
    const [gg, tu] = t.rows;
    expect(gg).toMatchObject({ cropId: "green-gram", cropName: "Green gram", productName: "Green gram grain" });
    expect(gg!.cells.fit).toMatchObject({ text: "Rank 1, score 79", tone: "good" });
    expect(gg!.cells.sowing!.text).toBe("10 Feb 2027 (rabi)");
    expect(gg!.cells.duration!.text).toBe("75 – 90 days");
    expect(gg!.cells.profit!.text).toBe("₹6,000 (₹3,000 – ₹9,000)");
    expect(gg!.cells.replaces).toMatchObject({ text: "Pigeon pea, planned 12 Feb 2027", tone: "watch" });
    expect(gg!.actions.map((a) => a.kind)).toEqual(["pick_crop", "show_journey"]);
    expect(tu!.cells.fit).toMatchObject({ text: "Needs review", tone: "watch" });
    expect(tu!.cells.sowing!.text).toBe("May – Jun (kharif)");
    expect(tu!.cells.water!.text).toBe("Water partly fits, need medium");
    expect(tu!.cells.duration).toMatchObject({ text: "—", note: "No sourced crop duration." });
    expect(t.note).toMatch(/replacements for planned seasons/);
    expect(ui.dropped).toContainEqual(expect.objectContaining({ code: "unknown-id", detail: expect.stringContaining("mango") }));
    expect(codes(resolve('root = Stack([Text("b1"), CropCompare(["green-gram", "mango"])])'))).toContain("empty-after-resolve");
  });

  it("PlanOptions: plan, replace_planned alternatives, sown_comparison and saved seasons", () => {
    const plan = find(resolve('root = Stack([Text("b1"), PlanOptions("plan")])', { intent: "plan_question" }).root, "plan_options")!;
    expect(plan.options[0]).toMatchObject({ optionId: "best", reviewId: REVIEW_ID, label: "Best overall", actions: [{ kind: "use_plan", alternative: false }] });
    const alt = find(resolve('root = Stack([Text("b1"), PlanOptions(null)])', { intent: "plan_question" }).root, "plan_options")!;
    expect(alt).toMatchObject({ source: "alternatives", basis: "replace_planned" });
    expect(alt.options[0]!.slots[1]).toMatchObject({ cropName: "Green gram", replaces: "Pigeon pea, planned 12 Feb 2027", profitForField: "₹5,000 (₹2,000 – ₹8,000)" });
    expect(alt.options[0]!.actions).toEqual([expect.objectContaining({ kind: "use_plan", alternative: true, optionId: "alt-1" })]);
    const sown = find(resolve('root = Stack([Text("b1"), PlanOptions("alternatives")])', { intent: "plan_question", yearPlan: yearPlan(ALT_SOWN) }).root, "plan_options")!;
    expect(sown.basis).toBe("sown_comparison");
    expect(sown.options[0]!.actions).toEqual([]);
    expect(sown.options[0]!.chips).toContain("For comparison only");
    const saved = find(resolve('root = Stack([Text("b1"), PlanOptions("saved")])', { intent: "plan_question" }).root, "plan_options")!;
    expect(saved.options.map((o) => [o.optionId, o.chips])).toEqual([["rp-planned", ["Planned, not sown"]], ["rp-sown", ["Sown"]]]);
    expect(saved.options[0]!.actions.map((a) => (a as { cropId: string }).cropId)).toEqual(["green-gram", "black-gram"]);
    expect(saved.options[1]!.actions).toEqual([]);
    expect(codes(resolve('root = Stack([Text("b1"), PlanOptions("alternatives")])', { intent: "plan_question", yearPlan: yearPlan(null) }))).toContain("empty-after-resolve");
  });

  it("GrowthJourney from the stage calendar; unknown crop or no stages is dropped", () => {
    const ui = resolve('root = Stack([Text("b1"), GrowthJourney("ginger", null)])', { intent: "growth_journey" });
    expect(find(ui.root, "growth_journey")).toMatchObject({ cropId: "ginger", cropName: "Ginger", sowingDate: "2026-11-04", fieldId: "north", journeyId: null, stages: [{ stageId: "sprout", name: "Sprouting" }, { stageId: "rhizome" }] });
    expect(codes(resolve('root = Stack([Text("b1"), GrowthJourney("mango", null)])', { intent: "observation" }))).toContain("unknown-id");
    expect(codes(resolve('root = Stack([Text("b1"), GrowthJourney("ginger", "2027-01-01")])', { intent: "observation" }))).toContain("empty-after-resolve");
  });

  it("Choice and Actions labels are code-written in the turn language (English fallback for crop names)", () => {
    const ui = resolve('root = Stack([Choice("b2", [@PickCrop("green-gram"), @PickCrop("black-gram"), @Open("fit"), @Ask("plant_next")]), Text("b1")])', { language: "hi", intent: "observation" });
    const c = find(ui.root, "choice")!;
    expect(c.prompt).toBe(BLOCKS[1]!.text);
    expect(c.options.map((o) => o.label)).toEqual(["मूंग की योजना बनाएँ", "Black gram की योजना बनाएँ", "फसल उपयुक्तता खोलें", "आगे क्या बोएँ"]);
    expect(find(resolve('root = Stack([Actions([@Open("today")]), Text("b1")])', { language: "ta", intent: "observation" }).root, "actions")!.items[0]!.label).toBe("இன்றைய பக்கத்தைத் திறக்க");
  });

  it("approved blocks the program left out are shown: prepended when none is shown, else appended", () => {
    const none = resolve("root = Stack([FarmSnapshot()])", { intent: "observation" });
    expect(kids(none.root).map((n) => n.type)).toEqual(["text", "text", "text", "farm_snapshot"]);
    const some = resolve('root = Stack([Text("b2"), FarmSnapshot()])', { intent: "observation" });
    expect(kids(some.root).map((n) => (n.type === "text" ? n.blockId : n.type))).toEqual(["b2", "farm_snapshot", "b1", "b3"]);
  });
});

describe("fallback composer (2.7)", () => {
  const types = (ui: EvaraUi) => kids(ui.root).map((n) => n.type);
  it("explore_crops / compare_crops: blocks, CropCompare of the crop-fit picks, PickCrop actions and Open fit", () => {
    const ui = composeFallback(data({ intent: "explore_crops" }));
    expect(EvaraUi.safeParse(ui).success).toBe(true);
    expect(types(ui)).toEqual(["text", "text", "text", "crop_compare", "actions"]);
    // the picks; candidates fill in only when fewer than 2 crops are picked
    expect(find(ui.root, "crop_compare")!.rows.map((r) => r.cropId)).toEqual(["green-gram", "black-gram"]);
    expect(find(ui.root, "actions")!.items.map((a) => a.kind)).toEqual(["pick_crop", "pick_crop", "open"]);
    const one = composeFallback(data({ intent: "explore_crops", cropFit: { ...CROP_FIT, picks: CROP_FIT.picks.slice(0, 1) } }));
    expect(find(one.root, "crop_compare")!.rows.map((r) => r.cropId)).toEqual(["green-gram", "black-gram", "maize"]);
    // without crop fit: screening crops
    const scr = composeFallback(data({ intent: "compare_crops", cropFit: null, briefing: null, screening: { results: ["maize", "turmeric", "ginger"].map((cropId, i) => ({ cropId, productIds: [], outcome: i === 1 ? "eligible" : "requires_review", ruleResults: [], unknownFields: [], coverage: [], dimensions: [] })) } }));
    expect(find(scr.root, "crop_compare")!.rows.map((r) => r.cropId)).toEqual(["turmeric", "maize", "ginger"]);
  });
  it("plan_question: alternatives when present, else plan; Open plan", () => {
    const ui = composeFallback(data({ intent: "plan_question" }));
    expect(types(ui)).toEqual(["text", "text", "text", "plan_options", "actions"]);
    expect(find(ui.root, "plan_options")!.source).toBe("alternatives");
    expect(find(composeFallback(data({ intent: "plan_question", yearPlan: yearPlan(null) })).root, "plan_options")!.source).toBe("plan");
  });
  it("growth_journey: the first crop this run resolved, else the current crop", () => {
    const ui = composeFallback(data({ intent: "growth_journey", resolvedCropIds: [GINGER_UUID] }));
    expect(find(ui.root, "growth_journey")!.cropId).toBe("ginger");
    const cur = composeFallback(data({ intent: "growth_journey", timelines: { [timelineKey("paddy", "2026-10-31")]: STAGES } }));
    expect(find(cur.root, "growth_journey")).toMatchObject({ cropId: "paddy", sowingDate: "2026-10-31" });
  });
  it("everything else: the blocks; with no block a code callout and the FarmSnapshot", () => {
    expect(types(composeFallback(data({ intent: "market_question" })))).toEqual(["text", "text", "text"]);
    const empty = composeFallback(data({ intent: "market_question", blocks: [] }));
    expect(kids(empty.root)[0]).toEqual({ type: "callout", tone: "info", text: "I could not produce a checked answer; here is what the farm shows.", blockId: null });
    expect(types(empty)).toEqual(["callout", "farm_snapshot"]);
    expect((kids(composeFallback(data({ intent: "market_question", blocks: [], hasClarification: true, language: "ta" })).root)[0] as { text: string }).text).toMatch(/கேள்விக்குப் பதில்/);
  });
  it("a crop intent program without a CropCompare gets one appended (origin fallback); with one it stays model", () => {
    const ui = resolve('root = Stack([Text("b1"), Text("b2"), Text("b3")])', { intent: "explore_crops" });
    expect(ui.origin).toBe("fallback");
    expect(types(ui)).toEqual(["text", "text", "text", "crop_compare", "actions"]);
    const model = resolve('root = Stack([Text("b1"), Text("b2"), Text("b3"), CropCompare(["green-gram", "black-gram"])])', { intent: "explore_crops" });
    expect(model.origin).toBe("model");
  });
});

describe("generated prompt (2.6)", () => {
  it("every example program parses to a non-empty root and resolves with matching data without drops", () => {
    for (const e of EXAMPLE_PROGRAMS) {
      const p = parseEvaraLang(e.program);
      expect(p.dropped).toEqual([]);
      const root = p.statements.find((s) => s.name === "root")!;
      expect(root.expr).toMatchObject({ k: "call", name: "Stack" });
      const intent = { crop_choice: "compare_crops", plan: "plan_question", journey: "growth_journey", care: "plan_question" }[e.family];
      const ui = resolve(e.program, { intent: e.family === "care" ? "observation" : intent });
      expect(ui.dropped).toEqual([]);
      expect(ui.origin).toBe("model");
      expect(kids(ui.root).length).toBeGreaterThan(1);
      expect(EVARA_LIBRARY_PROMPT).toContain(e.program);
    }
  });
  it("lists every component and action with its positional parameters; the synthesis prompt carries it and the hash covers it", () => {
    for (const c of COMPONENTS) expect(EVARA_LIBRARY_PROMPT).toContain(`- ${c.name}(`);
    for (const a of ACTIONS) expect(EVARA_LIBRARY_PROMPT).toContain(`- @${a.name}(`);
    expect(EVARA_LIBRARY_PROMPT).toContain("GrowthJourney(cropId: string (catalogue crop id), sowingDate?: YYYY-MM-DD | null");
    expect(PROMPT_VERSION).toBe("2026-11-04.1");
    expect(SYNTHESIS_INSTRUCTIONS).toContain(EVARA_LIBRARY_PROMPT);
    expect(SYNTHESIS_INSTRUCTIONS).toMatch(/Write ui as an Evara Lang program/);
    expect(SYNTHESIS_INSTRUCTIONS).toMatch(/present them as what the farmer can do instead of saying nothing can be planned/);
    expect(SYNTHESIS_INSTRUCTIONS).toMatch(/offer them only through the GrowthJourney component, never describe them as field data or predictions/);
    expect(SYNTHESIS_INSTRUCTIONS).not.toMatch(/Do not offer or request generated crop scenes as field data/);
    expect(INTERPRETATION_INSTRUCTIONS).toMatch(/is intent growth_journey/);
    expect(PROMPT_HASH).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ------------------------------------------------------------------ review fixes E7c (2026-11-04)

const allActions = (n: EvaraNode): { kind: string }[] => {
  if (n.type === "stack") return n.children.flatMap(allActions);
  if (n.type === "actions") return n.items;
  if (n.type === "choice") return n.options;
  if (n.type === "plan_options") return n.options.flatMap((o) => o.actions);
  if (n.type === "crop_compare") return n.rows.flatMap((r) => r.actions);
  return [];
};
const allOfType = <T extends EvaraNode["type"]>(n: EvaraNode, t: T): Extract<EvaraNode, { type: T }>[] =>
  n.type === t ? [n as Extract<EvaraNode, { type: T }>] : n.type === "stack" ? n.children.flatMap((c) => allOfType(c, t)) : [];
const staleYearPlan = () => ({ ...yearPlan(ALT_REPLACE), stale: true });

describe("review fixes E7c", () => {
  it("fix 1: a stale year-plan review offers no plan or alternatives and no use_plan; saved seasons stay with their chips", () => {
    const stale = staleYearPlan();
    for (const program of ['root = Stack([Text("b1"), PlanOptions("plan")])', 'root = Stack([Text("b1"), PlanOptions("alternatives")])', 'root = Stack([Text("b1"), PlanOptions(null), Actions([@UsePlan("plan", "best"), @UsePlan("alternatives", "alt-1"), @Open("plan")])])']) {
      const ui = resolve(program, { intent: "plan_question", yearPlan: stale });
      expect(ui.dropped).toContainEqual(expect.objectContaining({ code: "empty-after-resolve", detail: "stale review" }));
      const plans = allOfType(ui.root, "plan_options");
      expect(plans.map((p) => p.source)).toEqual(["saved"]);
      expect(plans[0]!.options.map((o) => [o.optionId, o.chips])).toEqual([["rp-planned", ["Planned, not sown"]], ["rp-sown", ["Sown"]]]);
      expect(allActions(ui.root).some((a) => a.kind === "use_plan")).toBe(false);
    }
    // the fallback composer on a stale review: saved seasons only
    const fb = composeFallback(data({ intent: "plan_question", yearPlan: stale }));
    expect(allOfType(fb.root, "plan_options").map((p) => p.source)).toEqual(["saved"]);
    expect(allActions(fb.root).some((a) => a.kind === "use_plan")).toBe(false);
    // the same review, not stale, still offers its alternatives and use_plan (counterexample)
    const fresh = resolve('root = Stack([Text("b1"), PlanOptions(null)])', { intent: "plan_question" });
    expect(allOfType(fresh.root, "plan_options").map((p) => p.source)).toEqual(["alternatives"]);
    expect(allActions(fresh.root).some((a) => a.kind === "use_plan")).toBe(true);
  });

  it("fix 1: realisation is computed fresh from the workspace; a stale review's 'planned' never makes a sown season replaceable", () => {
    const review = yearPlan(ALT_REPLACE);
    // The stored review (computed before paddy was sown) still calls the paddy season planned, and the pigeon pea season was moved.
    review.scenario.occupied = [
      { ...review.scenario.occupied![0]!, id: "rp-paddy", cropId: "paddy", cropName: "Paddy", sowing: "2026-11-02", occupancy: { from: "2026-11-02", to: "2027-03-10" }, realisation: "planned" },
      { ...review.scenario.occupied![0]!, sowing: "2027-01-20", occupancy: { from: "2027-01-20", to: "2027-07-30" } },
      { ...review.scenario.occupied![0]!, id: "rp-late", cropId: "maize", cropName: "Maize", sowing: "2027-06-01", occupancy: { from: "2027-06-01", to: "2027-09-30" }, realisation: "sown" },
    ];
    const view = {
      cycles: [{ id: "c1", cropId: "paddy", cropName: "Paddy", sowingDate: "2026-10-31", stage: "sowed" as const }],
      rotationPlans: [
        { id: "rp-paddy", year: 2026, season: "Rabi", cropId: "paddy", cropName: "Paddy", plannedSowingDate: "2026-11-02" },
        { id: "rp-planned", year: 2027, season: "Summer", cropId: "pigeon-pea", cropName: "Pigeon pea", plannedSowingDate: "2027-02-12" },
        { id: "rp-late", year: 2027, season: "Kharif", cropId: "maize", cropName: "Maize", plannedSowingDate: "2027-06-01" },
      ],
    } as unknown as Parameters<typeof evaraOccupants>[0];
    const occ = evaraOccupants(view, review, "2026-11-04");
    expect(occ.map((o) => [o.rotationPlanId, o.realisation, o.occupancyTo])).toEqual([
      ["rp-paddy", "sown", "2027-03-10"],
      ["rp-planned", "planned", null], // the stored interval starts on the old date: not this season's window
      ["rp-late", "planned", "2027-09-30"], // the stored 'sown' is not taken either
    ]);
    const ui = resolve('root = Stack([Text("b1"), Actions([@ReplaceSeason("rp-paddy", "green-gram"), @ReplaceSeason("rp-late", "green-gram")])])', { intent: "observation", occupants: occ, yearPlan: review });
    expect(ui.dropped).toContainEqual(expect.objectContaining({ code: "not-replaceable", detail: expect.stringContaining("rp-paddy is sown") }));
    expect(find(ui.root, "actions")!.items.map((a) => (a as { rotationPlanId: string }).rotationPlanId)).toEqual(["rp-late"]);
  });

  it("fix 2: a saved season without a planned harvest or occupancy has harvest null, never the sowing date", () => {
    const base = data().occupants[0]!;
    const occupants = [
      { ...base, rotationPlanId: "rp-none", plannedHarvestDate: null, occupancyTo: null },
      { ...base, rotationPlanId: "rp-occ", plannedHarvestDate: null, occupancyTo: "2027-08-30" },
      { ...base, rotationPlanId: "rp-harv", plannedHarvestDate: "2027-07-15", occupancyTo: "2027-08-30" },
      { ...base, rotationPlanId: "rp-bad", plannedHarvestDate: "2027-01-01", occupancyTo: null },
    ];
    const saved = find(resolve('root = Stack([Text("b1"), PlanOptions("saved")])', { intent: "plan_question", occupants }).root, "plan_options")!;
    expect(saved.options.map((o) => [o.optionId, o.slots[0]!.harvest])).toEqual([
      ["rp-none", null],
      ["rp-occ", { earliest: "2027-08-30", latest: "2027-08-30" }],
      ["rp-harv", { earliest: "2027-07-15", latest: "2027-07-15" }],
      ["rp-bad", null], // a planned harvest before the sowing is not a window
    ]);
  });

  it("fix 3: capProgram cuts at the last newline before 4000 characters and records parse-failed / program truncated", () => {
    expect(capProgram('root = Stack([Text("b1")])')).toEqual({ program: 'root = Stack([Text("b1")])', dropped: null });
    const line = `x = Text("b1") # ${"p".repeat(83)}`; // 100 characters + newline (under the parser's 60 statements)
    const long = Array.from({ length: 50 }, () => line).join("\n");
    expect(long.length).toBeGreaterThan(MAX_PROGRAM_CHARS);
    const c = capProgram(long);
    expect(c.program.length).toBeLessThanOrEqual(MAX_PROGRAM_CHARS);
    expect(c.program.endsWith(line)).toBe(true);
    const keptLines = c.program.split("\n").length;
    expect(keptLines).toBe(Math.floor((MAX_PROGRAM_CHARS + 1) / (line.length + 1)));
    expect(c.dropped).toEqual({ line: keptLines + 1, code: "parse-failed", detail: "program truncated" });
    expect(parseEvaraLang(c.program).dropped).toEqual([]);
    // one over-long line: cut at the limit
    expect(capProgram("x".repeat(5000)).program).toHaveLength(MAX_PROGRAM_CHARS);
    // the resolver carries a pre-recorded entry into EvaraUi.dropped, first
    const ui = resolveEvaraUi('root = Stack([Text("b1")])', data({ intent: "observation" }), { dropped: [c.dropped!] });
    expect(ui.dropped[0]).toEqual({ line: keptLines + 1, code: "parse-failed", detail: "program truncated" });
  });
});
