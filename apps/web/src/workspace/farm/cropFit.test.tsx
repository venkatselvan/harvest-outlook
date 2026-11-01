import { describe, expect, it } from "vitest";
import { renderToString } from "solid-js/web";
import { CropFitReview } from "@harvest/contracts";
import {
  CANDIDATES,
  calculatedReview,
  dateFreshReview,
  emptyReview,
  pendingReview,
  readyModelReview,
  runningReview,
  seasonReview,
  unavailableModelReview,
} from "./cropFitFixtures";
import {
  controlsFromReview,
  defaultControls,
  formatInr,
  pickCards,
  picksChip,
  priceHarvestText,
  priceNowText,
  profitText,
  queryFor,
  resolvedLine,
  soilChipText,
  soilLine,
  sowingProblem,
} from "./cropFitModel";
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
    expect(queryFor({ mode: "next", season: "kharif", sowing: "2027-01-01" })).toBe("?mode=next");
    expect(queryFor({ mode: "season", season: "rabi", sowing: "2027-01-01" })).toBe("?mode=season&season=rabi");
    expect(queryFor({ mode: "date", season: "rabi", sowing: "2027-05-17" })).toBe("?mode=date&sowing=2027-05-17");
    expect(queryFor(null)).toBe("");
    expect(cropFitPath("farm 1", null)).toBe("/api/v1/farms/farm%201/crop-fit");
  });
  it("defaults the controls to today and follows the review the server resolved", () => {
    expect(defaultControls(TODAY)).toEqual({ mode: "date", season: "rabi", sowing: TODAY });
    expect(controlsFromReview(readyModelReview, defaultControls(TODAY))).toEqual({ mode: "next", season: "rabi", sowing: TODAY });
    expect(controlsFromReview(seasonReview, defaultControls(TODAY))).toMatchObject({ mode: "season", season: "kharif" });
  });
  it("checks the picked date: today up to about a year ahead", () => {
    expect(sowingProblem("2026-10-31", TODAY)).toMatch(/today or a later/);
    expect(sowingProblem("2027-12-31", TODAY)).toMatch(/within about a year/);
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
      <CropFitControls state={{ mode, season: "kharif", sowing: "2027-05-17" }} todayIso={TODAY} resolved="Sowing from 4 Feb 2027, after paddy" busy={false} stale={false} refreshing={false} dateError={null} onChange={noop} onDateError={noop} onRefresh={noop} {...over} />
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
    expect(date).toContain('max="2027-12-06"');
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
