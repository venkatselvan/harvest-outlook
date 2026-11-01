import { describe, expect, it } from "vitest";
import { renderToString } from "solid-js/web";
import { CropFitReview } from "@harvest/contracts";
import {
  CANDIDATES,
  PLAN_CANDIDATES,
  assumedShareCandidate,
  calculatedReview,
  dateFreshReview,
  emptyReview,
  pendingReview,
  planErrorReview,
  planPendingReview,
  planReview,
  planRunningReview,
  readyModelReview,
  runningReview,
  seasonReview,
  unavailableModelReview,
} from "./cropFitFixtures";
import {
  MAX_DAYS_AHEAD,
  addDaysIso,
  controlsFromReview,
  defaultControls,
  formatInr,
  grownBeforeText,
  pickCards,
  pickerControls,
  pickerSections,
  picksChip,
  priceHarvestText,
  priceNowText,
  profitText,
  queryFor,
  rankedCandidates,
  resolvedLine,
  rowAction,
  soilChipText,
  soilLine,
  sowingProblem,
  waitLine,
  yearPlanText,
} from "./cropFitModel";
import { CropFitPickerView } from "./CropFitPicker";
import { cropFitPath } from "./cropFitApi";
import { CropFitControls } from "./CropFitControls";
import { CropFitCard } from "./CropFitCard";
import { CandidateDetail } from "./CropFitSheet";
import { CropFitResults } from "./CropFitView";

/**
 * Crop fit view (ROUND2_SPEC.md 4.2). Component tests run in node with the Solid SSR transform (renderToString), as the
 * rest of the web suite does; interaction is covered through the pure model and the rendered states. Fixtures are
 * SYNTHETIC (cropFitFixtures.ts).
 */
const text = (html: string) => html.replace(/<!--[^>]*-->/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
const noop = () => undefined;
const TODAY = "2026-11-01";

describe("crop fit fixtures", () => {
  it("parse with the shared CropFitReview contract", () => {
    for (const r of [readyModelReview, unavailableModelReview, calculatedReview, pendingReview, runningReview, seasonReview, dateFreshReview, emptyReview]) expect(() => CropFitReview.parse(r)).not.toThrow();
  });
});

describe("crop fit model", () => {
  it("builds the query for each mode and leaves out parameters that do not apply", () => {
    expect(queryFor({ mode: "next", season: "kharif", sowing: "2027-01-01", after: null })).toBe("?mode=next");
    expect(queryFor({ mode: "season", season: "rabi", sowing: "2027-01-01", after: null })).toBe("?mode=season&season=rabi");
    expect(queryFor({ mode: "date", season: "rabi", sowing: "2027-05-17", after: null })).toBe("?mode=date&sowing=2027-05-17");
    expect(queryFor(null)).toBe("");
    expect(cropFitPath("farm 1", null)).toBe("/api/v1/farms/farm%201/crop-fit");
  });
  it("defaults the controls to today and follows the review the server resolved", () => {
    expect(defaultControls(TODAY)).toEqual({ mode: "date", season: "rabi", sowing: TODAY, after: null });
    expect(controlsFromReview(readyModelReview, defaultControls(TODAY))).toEqual({ mode: "next", season: "rabi", sowing: TODAY, after: null });
    expect(controlsFromReview(seasonReview, defaultControls(TODAY))).toMatchObject({ mode: "season", season: "kharif" });
  });
  it("checks the picked date: today up to about a year ahead", () => {
    expect(sowingProblem("2026-10-31", TODAY)).toMatch(/today or a later/);
    expect(sowingProblem("2027-12-31", TODAY)).toBeNull();
    expect(sowingProblem(addDaysIso(TODAY, MAX_DAYS_AHEAD), TODAY)).toBeNull();
    expect(sowingProblem(addDaysIso(TODAY, MAX_DAYS_AHEAD + 1), TODAY)).toMatch(/within about four years/);
    expect(MAX_DAYS_AHEAD).toBe(1461); // routes/crop-fit.ts SOWING_LIMIT_DAYS: the end of plan year 3
    expect(sowingProblem("2027-02-30", TODAY)).toMatch(/Enter a sowing date/);
    expect(sowingProblem("2027-05-17", TODAY)).toBeNull();
  });
  it("states the resolved sowing date and the previous crop", () => {
    expect(resolvedLine(readyModelReview)).toBe("Sowing from 4 Feb 2027, after paddy");
    expect(resolvedLine(seasonReview)).toBe("Kharif windows from 1 Apr 2027, after paddy; each crop uses its own window");
    expect(resolvedLine(dateFreshReview)).toBe("Sowing from 17 May 2027");
    expect(resolvedLine({ ...seasonReview, resolvedSowing: null, status: "pending" })).toBe("Each crop uses its own kharif sowing window");
  });
  it("names the picks state: model, unavailable (provider failure), calculated, pending", () => {
    expect(picksChip(readyModelReview)).toBe("model");
    expect(picksChip(unavailableModelReview)).toBe("unavailable");
    expect(picksChip(calculatedReview)).toBe("calculated");
    expect(picksChip(pendingReview)).toBe("pending");
    expect(picksChip(runningReview)).toBe("pending");
    expect(picksChip(emptyReview)).toBeNull();
  });
  it("formats the card rows from the code numbers only", () => {
    const [maize, , , chilli, sorghum] = CANDIDATES;
    expect(priceNowText(maize!)).toBe("₹22.5/kg on 30 Oct");
    expect(priceHarvestText(maize!)).toBe("₹20 to ₹29/kg at harvest");
    expect(profitText(maize!, 0.16)).toEqual({ text: "₹4,200 to ₹9,300 for your 0.16 ha", caption: null });
    expect(profitText({ ...maize!, profitForField: null }, null)).toEqual({ text: "₹26,000 to ₹58,000 per ha", caption: "Per hectare; draw the boundary for your field total" });
    expect(profitText(chilli!, 0.16).text).toBe("Not shown: cost of cultivation not sourced");
    expect(profitText(sorghum!, 0.16).text).toBe("Not shown: no regional yield");
    expect(priceNowText(sorghum!)).toBe("No recent mandi quotes");
    expect(formatInr(-2300)).toBe("−₹2,300");
    expect(formatInr(123456)).toBe("₹1,23,456");
  });
  it("writes soil chips as 'N low · needs high' and a one-line verdict", () => {
    const checks = CANDIDATES[0]!.soil.checks;
    expect(checks.map(soilChipText)).toEqual(["pH 7.2 · outside crop range", "N low · needs high", "P medium · needs medium", "K medium · needs low", "EC normal"]);
    expect(soilLine(CANDIDATES[0]!)).toBe("pH watch, N short, P watch");
    expect(soilLine(dateFreshReview.candidates[0]!)).toBe("No confirmed soil report");
  });
  it("joins picks to candidates in pick order", () => {
    expect(pickCards(readyModelReview).map((c) => [c.pick.rank, c.candidate.cropId])).toEqual([[1, "groundnut"], [2, "maize"], [3, "onion"]]);
    expect(pickCards({ ...readyModelReview, candidates: CANDIDATES.slice(0, 1) }).map((c) => c.candidate.cropId)).toEqual(["maize"]);
  });
});

describe("crop fit controls (rendered)", () => {
  const render = (mode: "next" | "season" | "date", over: Partial<Parameters<typeof CropFitControls>[0]> = {}) =>
    renderToString(() => (
      <CropFitControls state={{ mode, season: "kharif", sowing: "2027-05-17", after: null }} todayIso={TODAY} resolved="Sowing from 4 Feb 2027, after paddy" busy={false} stale={false} refreshing={false} dateError={null} onChange={noop} onDateError={noop} onRefresh={noop} {...over} />
    ));
  it("marks the selected mode and shows only the inputs that apply", () => {
    const next = render("next");
    expect(next).toMatch(/aria-pressed="true"[^>]*>Next crop/);
    expect(next).toMatch(/aria-pressed="false"[^>]*>By season/);
    expect(next).not.toContain('aria-label="Season"');
    expect(next).not.toContain('type="date"');
    expect(text(next)).toContain("Sowing from 4 Feb 2027, after paddy");
    const season = render("season");
    expect(season).toContain('aria-label="Season"');
    expect(season).toMatch(/aria-pressed="true"[^>]*>Kharif/);
    expect(season).toMatch(/aria-pressed="false"[^>]*>Rabi/);
    const date = render("date");
    expect(date).toContain('type="date"');
    expect(date).toContain('min="2026-11-01"');
    expect(date).toContain(`max="${addDaysIso(TODAY, MAX_DAYS_AHEAD)}"`);
    expect(date).toContain('value="2027-05-17"');
  });
  it("shows a date error and the out-of-date refresh", () => {
    const html = render("date", { dateError: "Pick today or a later date.", stale: true });
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain("Pick today or a later date.");
    expect(html).toContain('aria-invalid="true"');
    expect(text(html)).toContain("Out of date, refresh");
  });
});

describe("crop fit cards and states (rendered)", () => {
  it("renders a pick card: name, headline, score ring, three reasons and the four rows", () => {
    const card = pickCards(readyModelReview)[0]!;
    const html = renderToString(() => <CropFitCard card={card} fieldAreaHa={0.16} onOpen={noop} />);
    const t = text(html);
    expect(t).toContain("Pick 1");
    expect(t).toContain("Groundnut");
    expect(t).toContain("A legume that gives back nitrogen after paddy");
    expect(html).toContain('aria-label="Fit score 64 out of 100"');
    expect((html.match(/<li/g) ?? []).length).toBe(3);
    expect(t).toContain("Now ₹22.5/kg on 30 Oct");
    expect(t).toContain("₹20 to ₹29/kg at harvest");
    expect(t).toContain("3,800 to 4,500 kg/ha · district record");
    expect(t).toContain("Profit for your field ₹4,200 to ₹9,300 for your 0.16 ha");
    expect(t).toContain("N low · needs high");
    expect(html).toContain("ui-chip-warning");
    expect(t).toContain("+1 more");
  });
  it("model picks show the AI mark; provider failure shows the unavailable chip; synthetic mode says calculated", () => {
    const model = renderToString(() => <CropFitResults review={readyModelReview} showAll={false} onToggleAll={noop} onOpen={noop} onRetry={noop} retrying={false} />);
    expect(text(model)).toContain("Picked by AI");
    expect(model).toContain("AI used: Top crop picks for your field");
    expect((model.match(/class="cf-card"/g) ?? []).length).toBe(3);
    expect(text(model)).toContain("See all 5 crops");
    expect(text(model)).not.toContain("Model unavailable");
    const failed = text(renderToString(() => <CropFitResults review={unavailableModelReview} showAll={false} onToggleAll={noop} onOpen={noop} onRetry={noop} retrying={false} />));
    expect(failed).toContain("Model unavailable, showing calculated picks");
    expect(failed).not.toContain("Picked by AI");
    const calculated = text(renderToString(() => <CropFitResults review={calculatedReview} showAll={false} onToggleAll={noop} onOpen={noop} onRetry={noop} retrying={false} />));
    expect(calculated).toContain("Calculated picks");
    expect(calculated).not.toContain("Model unavailable");
  });
  it("pending shows the activity chip and placeholders; running shows the calculated cards while Meta picks", () => {
    const pending = renderToString(() => <CropFitResults review={pendingReview} showAll={false} onToggleAll={noop} onOpen={noop} onRetry={noop} retrying={false} />);
    expect(text(pending)).toContain("Scoring crops…");
    expect(pending).toContain("cf-card-skeleton");
    expect(text(pending)).not.toContain("See all");
    const running = renderToString(() => <CropFitResults review={runningReview} showAll={false} onToggleAll={noop} onOpen={noop} onRetry={noop} retrying={false} />);
    expect(text(running)).toContain("Picking…");
    expect((running.match(/class="cf-card"/g) ?? []).length).toBe(3);
  });
  it("the ranked list shows score, sowing, harvest window, profit range and the soil verdict", () => {
    const html = text(renderToString(() => <CropFitResults review={readyModelReview} showAll onToggleAll={noop} onOpen={noop} onRetry={noop} retrying={false} />));
    expect(html).toContain("Hide the ranked list");
    expect(html).toContain("Sow 10 Feb 2027 (moved 6 days into the sowing window)");
    expect(html).toContain("Harvest 15 May to 4 Jun 2027");
    expect(html).toContain("₹4,200 to ₹9,300 for your field · pH watch, N short, P watch");
    expect(html).toContain("Chilli (dry)");
    expect(html).toContain("Profit not shown");
  });
  it("an empty review explains why nothing fits", () => {
    const html = text(renderToString(() => <CropFitResults review={emptyReview} showAll={false} onToggleAll={noop} onOpen={noop} onRetry={noop} retrying={false} />));
    expect(html).toContain("No crop fits this sowing date");
    expect(html).toContain("Not ranked (maize, paddy)");
  });
  it("the detail shows the soil comparison table, profit bands, notes and basis", () => {
    const maize = CANDIDATES[0]!;
    const html = renderToString(() => <CandidateDetail candidate={maize} review={readyModelReview} pick={readyModelReview.picks[1]} />);
    const t = text(html);
    for (const h of ["Marker", "Your value", "Rating", "Crop need", "Verdict", "Source"]) expect(html).toContain(`>${h}</th>`);
    expect(t).toContain("Nitrogen (pool not printed) 278 kg/ha low high Short");
    expect(t).toContain("Assumption: Pool not printed; rated as available N (test).");
    expect(t).toContain("Likely ₹26,000 to ₹58,000 ₹4,200 to ₹9,300");
    expect(t).toContain("Likely = middle half of the simulated outcomes; possible = 10th to 90th percentile.");
    expect(t).toContain("Usual rain 310 mm plus 150 mm irrigation against a need of 500 mm.");
    expect(t).toContain("After paddy: different crop family.");
    expect(t).toContain("Why it was picked");
    expect(html).toContain('href="https://example.org/yield"');
  });
});

// ---------------------------------------------------------------- round 3
const get = (html: string) => html.replace(/<!--[^>]*-->/g, "");
const titles = (html: string) => [...get(html).matchAll(/<h4[^>]*>([^<]*)<\/h4>/g)].map((m) => m[1]);
// One merged props object: spreading `{ review: undefined }` after `review={planReview}` would be ignored by Solid's mergeProps.
const picker = (over: Partial<Parameters<typeof CropFitPickerView>[0]> = {}) => {
  const props: Parameters<typeof CropFitPickerView>[0] = { sowing: "2027-05-16", after: "paddy", review: planReview, failure: undefined, current: null, retrying: false, onPick: noop, onKeep: noop, onRetry: noop, onClose: noop, ...over };
  return renderToString(() => <CropFitPickerView {...props} />);
};

describe("round 3 fixtures and request", () => {
  it("parse with the shared contract, including the intercrop companion and the after override", () => {
    for (const r of [planReview, planRunningReview, planPendingReview, planErrorReview]) expect(() => CropFitReview.parse(r)).not.toThrow();
    expect(() => CropFitReview.parse({ ...planReview, candidates: [assumedShareCandidate] })).not.toThrow();
  });
  it("sends after only in date mode and only when set", () => {
    expect(queryFor(pickerControls("2027-05-16", "paddy"))).toBe("?mode=date&sowing=2027-05-16&after=paddy");
    expect(queryFor(pickerControls("2027-05-16", null))).toBe("?mode=date&sowing=2027-05-16");
    expect(queryFor({ mode: "next", season: "rabi", sowing: "2027-05-16", after: "paddy" })).toBe("?mode=next");
    expect(cropFitPath("f1", pickerControls("2027-05-16", "finger-millet"))).toBe("/api/v1/farms/f1/crop-fit?mode=date&sowing=2027-05-16&after=finger-millet");
    expect(controlsFromReview(planReview, defaultControls(TODAY))).toMatchObject({ mode: "date", sowing: "2027-05-16", after: "paddy" });
  });
});

describe("round 3 model", () => {
  it("orders by rankScore (score minus the wait penalty), not by raw score or array order", () => {
    expect(PLAN_CANDIDATES.map((c) => c.cropId)).toEqual(["sorghum", "maize", "finger-millet", "pigeon-pea"]);
    expect(rankedCandidates(planReview).map((c) => [c.cropId, c.rank])).toEqual([["pigeon-pea", 1], ["finger-millet", 2], ["sorghum", 3], ["maize", 4]]);
    // The highest raw score (sorghum 72) is third once the idle weeks are charged.
    expect(Math.max(...PLAN_CANDIDATES.map((c) => c.score))).toBe(72);
  });
  it("writes the wait line from waitDays and waitPenalty, and says nothing without a wait", () => {
    const [sorghum, maize, , pigeon] = PLAN_CANDIDATES;
    expect(waitLine(pigeon!)).toBe("Field idle 7 weeks before sowing, −2 points");
    expect(waitLine(maize!)).toBe("Field idle 13 weeks before sowing, −3 points");
    expect(waitLine(sorghum!)).toBe("Field idle 3 weeks before sowing, no penalty");
    expect(waitLine({ waitDays: 49, waitPenalty: null })).toBe("Field idle 7 weeks before sowing");
    expect(waitLine({ waitDays: 9, waitPenalty: 0.4 })).toBe("Field idle 9 days before sowing, less than 1 point");
    expect(waitLine({ waitDays: 0, waitPenalty: 0 })).toBeNull();
    expect(waitLine({})).toBeNull();
  });
  it("names the year-plan labels and the farm's own history", () => {
    expect(yearPlanText(PLAN_CANDIDATES[3]!)).toBe("In your year plan: Best overall");
    expect(yearPlanText(PLAN_CANDIDATES[2]!)).toBe("In your year plan: Soil enrichment, Best profit");
    expect(yearPlanText(PLAN_CANDIDATES[0]!)).toBeNull();
    expect(grownBeforeText(PLAN_CANDIDATES[3]!)).toBe("Grown here before: 2025");
    expect(grownBeforeText(PLAN_CANDIDATES[2]!)).toBe("Grown here before: 2024 (3 seasons)");
    expect(grownBeforeText({ grownBefore: null })).toBeNull();
    expect(grownBeforeText({})).toBeNull();
  });
  it("puts the current crop first, drops it from the lists below, and keeps a sole crop and its intercrop apart", () => {
    const s = pickerSections(planReview, { cropId: "sorghum", productId: "sorghum-grain" });
    expect(s.current?.cropId).toBe("sorghum");
    expect(s.picks.map((c) => c.candidate.cropId)).toEqual(["pigeon-pea", "finger-millet"]);
    expect(s.rest.map((c) => c.cropId)).toEqual(["pigeon-pea", "finger-millet", "maize"]);
    const intercrop = pickerSections(planReview, { cropId: "finger-millet", productId: "finger-millet-grain", systemId: "finger-millet-pigeon-pea-8-1" });
    expect(intercrop.current?.kind).toBe("intercrop");
    // The same main crop without the system id is a different row: nothing is current.
    expect(pickerSections(planReview, { cropId: "finger-millet", productId: "finger-millet-grain" }).current).toBeNull();
    expect(pickerSections(planReview, { cropId: "paddy", productId: "paddy-grain" }).current).toBeNull();
  });
  it("the current crop's button keeps (no change); every other row uses the crop", () => {
    const cur = { cropId: "sorghum", productId: "sorghum-grain" };
    expect(rowAction(PLAN_CANDIDATES[0]!, cur)).toBe("keep");
    expect(rowAction(PLAN_CANDIDATES[3]!, cur)).toBe("use");
    expect(rowAction(PLAN_CANDIDATES[3]!, null)).toBe("use");
  });
});

describe("crop fit picker (rendered)", () => {
  it("while a pick is being saved, disables only 'Use this crop'; Keep and Cancel still close the picker", () => {
    const buttons = (busy: boolean) =>
      [...get(picker({ current: { cropId: "sorghum", productId: "sorghum-grain" }, busy })).matchAll(/<button([^>]*)>(.*?)<\/button>/g)].map((m) => ({
        disabled: /\sdisabled(=|\s|>|$)/.test(m[1]!),
        text: m[2]!.replace(/<[^>]+>/g, "").trim(),
      }));
    const idle = buttons(false);
    expect(idle.filter((b) => b.text === "Use this crop").length).toBeGreaterThan(0);
    expect(idle.some((b) => b.disabled)).toBe(false);
    const busy = buttons(true);
    expect(busy.filter((b) => b.text === "Use this crop").every((b) => b.disabled)).toBe(true);
    expect(busy.filter((b) => b.text === "Keep" || b.text === "Cancel").map((b) => b.disabled)).toEqual([false, false]);
    // The error card's retry waits too, so a pick cannot race a reload.
    expect(get(picker({ review: undefined, failure: { kind: "server", message: "x" }, busy: true }))).toMatch(/<button[^>]*disabled[^>]*>Try again/);
  });
  it("lists the current crop first, pre-selected with its rank and score and a Keep button, then picks, then every ranked crop", () => {
    const html = picker({ current: { cropId: "sorghum", productId: "sorghum-grain" } });
    expect(titles(html)).toEqual(["Sorghum", "Pigeon pea", "Finger millet + pigeon pea (8:1)", "Pigeon pea", "Finger millet + pigeon pea (8:1)", "Maize"]);
    const t = text(html);
    expect(t).toContain("Crops for sowing on 16 May 2027");
    expect(t).toContain("Sowing from 16 May 2027, after paddy");
    expect(t).toContain("In this plan");
    expect(t).toContain("Rank 3 · Score 72");
    expect(html).toContain('aria-label="Keep Sorghum"');
    expect(html).toContain('aria-current="true"');
    expect(html).toContain('aria-label="Use this crop: Pigeon pea"');
    expect(html).toContain('aria-label="Use this crop: Finger millet + pigeon pea (8:1)"');
    expect(html).not.toContain('aria-label="Use this crop: Sorghum"');
    expect(t).toContain("All ranked crops (4)");
    // Picks are marked in the full list and carry Meta's spark and reasons.
    expect(t).toContain("Pick 1");
    expect(html).toContain("Picked by AI");
    expect(html).toContain("AI used: Top crop picks for your field");
    expect(t).toContain("Fits the May window and fixes nitrogen");
    expect(t).toContain("A legume after paddy returns nitrogen.");
  });
  it("shows score, profit for the field, soil chips, the year-plan label, the history chip and the wait line per crop", () => {
    const t = text(picker());
    expect(t).toContain("Rank 1 · Score 70");
    expect(t).toContain("₹3,100 to ₹7,600 for your 0.16 ha");
    expect(t).toContain("About 70 to 110 kg from your field");
    expect(t).toContain("N low · needs high");
    expect(t).toContain("In your year plan: Best overall");
    expect(t).toContain("Grown here before: 2025");
    expect(t).toContain("Field idle 7 weeks before sowing, −2 points");
    expect(t).toContain("No confirmed soil report");
    expect(text(picker({ current: null }))).not.toContain("Keep");
  });
  it("shows an intercrop as Main + companion (ratio) with the share-basis chip", () => {
    const html = picker();
    expect(text(html)).toContain("Finger millet + pigeon pea (8:1)");
    expect(text(html)).toContain("Sourced shares");
    expect(text(html)).toContain("Intercrop");
    const assumed = text(picker({ review: { ...planReview, candidates: [assumedShareCandidate], picks: [] } }));
    expect(assumed).toContain("Assumed shares");
    expect(assumed).not.toContain("Sourced shares");
  });
  it("shows a Keep row when the current crop is not ranked for the date, and says so", () => {
    const html = picker({ current: { cropId: "paddy", productId: "paddy-grain" } });
    expect(titles(html)[0]).toBe("Paddy");
    expect(text(html)).toContain("Not ranked for this date");
    expect(html).toContain('aria-label="Keep Paddy"');
  });
  it("shows the skeleton while loading or pending, and keeps the current crop's Keep button reachable", () => {
    for (const html of [picker({ review: undefined, current: { cropId: "sorghum", productId: "sorghum-grain" } }), picker({ review: planPendingReview, current: { cropId: "sorghum", productId: "sorghum-grain" } })]) {
      expect(html).toContain("cf-card-skeleton");
      expect(text(html)).toContain("Scoring crops for this date…");
      expect(text(html)).toContain("Scoring this crop for the date…");
      expect(html).toContain('aria-label="Keep Sorghum"');
      expect(html).not.toContain("Use this crop");
    }
  });
  it("while Meta picks, the ranked crops are already usable and the picks chip says Picking", () => {
    const html = picker({ review: planRunningReview });
    expect(text(html)).toContain("Picking…");
    expect(html).toContain('aria-label="Use this crop: Maize"');
  });
  it("shows the retry card for a failed request and for an error review", () => {
    const failed = picker({ review: undefined, failure: { kind: "offline", message: "Could not reach the server. Check the connection and try again." } });
    expect(failed).toContain('role="alert"');
    expect(text(failed)).toContain("Could not reach the server");
    expect(text(failed)).toContain("Try again");
    expect(failed).not.toContain("Use this crop");
    const errored = picker({ review: planErrorReview });
    expect(errored).toContain('role="alert"');
    expect(text(errored)).toContain("The scoring job failed.");
    expect(text(errored)).toContain("Try again");
  });
  it("explains an empty result instead of listing nothing", () => {
    const t = text(picker({ review: emptyReview }));
    expect(t).toContain("No crop fits this sowing date");
    expect(t).not.toContain("Use this crop");
  });
});

describe("round 3 cards, list and detail (rendered)", () => {
  it("the pick card shows the year-plan chip, the history chip, the wait line, field yield and both prices of an intercrop", () => {
    const card = pickCards(planReview)[1]!;
    expect(card.candidate.kind).toBe("intercrop");
    const html = renderToString(() => <CropFitCard card={card} fieldAreaHa={0.16} onOpen={noop} />);
    const t = text(html);
    expect(t).toContain("Finger millet + pigeon pea (8:1)");
    expect(t).toContain("In your year plan: Soil enrichment, Best profit");
    expect(t).toContain("Grown here before: 2024 (3 seasons)");
    expect(t).toContain("Sourced shares");
    expect(t).toContain("Field idle 8 weeks before sowing, −2 points");
    expect(t).toContain("About 300 to 420 kg from your field");
    expect(t).toContain("Finger millet: ₹20 to ₹29/kg at harvest");
    expect(t).toContain("Pigeon pea: ₹60 to ₹78/kg at harvest");
  });
  it("the ranked list follows rankScore and shows the plan chip and the wait line", () => {
    const html = renderToString(() => <CropFitResults review={planReview} showAll onToggleAll={noop} onOpen={noop} onRetry={noop} retrying={false} />);
    const names = [...get(html).matchAll(/class="cf-list-name"[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(names).toEqual(["Pigeon pea", "Finger millet + pigeon pea (8:1)", "Sorghum", "Maize"]);
    expect(text(html)).toContain("In your year plan: Best overall");
    expect(text(html)).toContain("Field idle 13 weeks before sowing, −3 points");
  });
  it("says once that crop fit and the year plan use the same candidates, dates and scoring", () => {
    const html = text(renderToString(() => <CropFitResults review={planReview} showAll={false} onToggleAll={noop} onOpen={noop} onRetry={noop} retrying={false} />));
    expect(html.match(/Same candidates, dates and scoring as the year plan/g)?.length).toBe(1);
  });
  it("the detail sheet shows the companion block with both prices, the ratio, the share basis and the source", () => {
    const intercrop = PLAN_CANDIDATES[2]!;
    const t = text(renderToString(() => <CandidateDetail candidate={intercrop} review={planReview} pick={planReview.picks[1]} />));
    expect(t).toContain("Companion crop");
    expect(t).toContain("Pigeon pea in rows 8:1 with finger millet, as alternate rows");
    expect(t).toContain("Sourced shares");
    expect(t).toContain("Finger millet: ₹20 to ₹29/kg at harvest");
    expect(t).toContain("Pigeon pea: ₹60 to ₹78/kg at harvest");
    expect(t).toContain("500 to 700 kg/ha as a sole crop · state record");
    expect(t).toContain("Nitrogen left for the next crop: 15 to 30 kg/ha");
    expect(t).toContain("Synthetic intercrop source (test) · Table 2");
    expect(t).toContain("Field idle 8 weeks before sowing, −2 points");
    expect(t).toContain("Ranked on 67 (score minus the wait penalty).");
    const sole = text(renderToString(() => <CandidateDetail candidate={PLAN_CANDIDATES[0]!} review={planReview} />));
    expect(sole).not.toContain("Companion crop");
  });
});
