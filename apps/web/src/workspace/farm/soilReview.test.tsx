import { describe, expect, it } from "vitest";
import { renderToString as ssr } from "solid-js/web";
import type { JSX } from "solid-js";
import { SoilReview, type SoilReading } from "@harvest/contracts";
import {
  HASSAN_READINGS,
  SOIL_FIXTURE_FARM_ID,
  UNRATED_ZINC,
  errorSoilReview,
  noReportSoilReview,
  pendingSoilReview,
  readyCodeReview,
  readyModelReview,
  withUnratedReview,
} from "./soilReviewFixtures";
import {
  bandRangeText,
  bandSegments,
  barPosition,
  beyondAxis,
  isActive,
  ratedAsText,
  ratingChipTone,
  ratingLabel,
  sampleDateText,
  showAiMark,
  splitReadings,
  valueText,
  zoneIndexOf,
  zoneTone,
} from "./soilReviewModel";
import { BiomarkerBar, ReadingDetail, SoilBiomarkers } from "./SoilBiomarkers";
import { SoilReviewView } from "./SoilReviewPanel";
import { SoilReviewContractError, loadSoilReview, pollSoilReview, refreshAndPoll, refreshSoilReview } from "./soilReviewApi";

/** SSR markup without hydration keys and markers, so assertions read the real elements. */
const renderToString = (fn: () => JSX.Element) => ssr(fn).replace(/ data-hk="[^"]*"/g, "").replace(/<!--[^>]*-->/g, "");
const read = (parameter: string): SoilReading => HASSAN_READINGS.find((r) => r.parameter === parameter)!;
const count = (html: string, needle: string) => html.split(needle).length - 1;
const view = (review: SoilReview, over: Partial<{ refreshing: boolean; refreshError: string }> = {}) =>
  renderToString(() => <SoilReviewView review={review} farmId={SOIL_FIXTURE_FARM_ID} refreshing={over.refreshing ?? false} refreshError={over.refreshError ?? ""} onRefresh={() => undefined} />);

describe("bar geometry", () => {
  it("places the value within the axis as a 0..1 fraction and clamps outside it", () => {
    const axis = { min: 4, max: 10 };
    expect(barPosition(7.2, axis)).toBeCloseTo(3.2 / 6, 10);
    expect(barPosition(4, axis)).toBe(0);
    expect(barPosition(10, axis)).toBe(1);
    expect(barPosition(3, axis)).toBe(0);
    expect(barPosition(12, axis)).toBe(1);
    expect(beyondAxis(12, axis)).toBe("above");
    expect(beyondAxis(3, axis)).toBe("below");
    expect(beyondAxis(7, axis)).toBeNull();
  });

  it("draws nothing without a value, an axis or a usable range", () => {
    expect(barPosition(null, { min: 0, max: 1 })).toBeNull();
    expect(barPosition(0.5, null)).toBeNull();
    expect(barPosition(0.5, { min: 1, max: 1 })).toBeNull();
    expect(barPosition(Number.NaN, { min: 0, max: 1 })).toBeNull();
    expect(bandSegments(read("ph").bands, null)).toEqual([]);
  });

  it("zones tile the axis: contiguous, summing to the whole width, open ends extended to the edges", () => {
    for (const r of HASSAN_READINGS) {
      const segments = bandSegments(r.bands, r.axis);
      expect(segments.length, r.parameter).toBe(r.bands.length);
      expect(segments[0]!.left).toBe(0);
      segments.slice(1).forEach((s, i) => expect(s.left).toBeCloseTo(segments[i]!.left + segments[i]!.width, 10));
      expect(segments.reduce((sum, s) => sum + s.width, 0)).toBeCloseTo(1, 10);
    }
    const ph = bandSegments(read("ph").bands, read("ph").axis);
    expect(ph[0]!.width).toBeCloseTo(1.6 / 6, 10);
    expect(ph.map((s) => s.tone)).toEqual(["bad", "caution", "good", "caution", "bad"]);
  });

  it("drops a zone that lies wholly beyond a shorter axis", () => {
    const ec = read("electrical_conductivity");
    expect(bandSegments(ec.bands, { min: 0, max: 3 })).toHaveLength(3);
  });

  it("each fixture value sits in the zone named by its rating (half-open bands, as the server states them)", () => {
    for (const r of HASSAN_READINGS) {
      const v = r.ratedValue!;
      const zone = r.bands.find((b) => (b.from === null || v >= b.from) && (b.to === null || v < b.to))!;
      expect(zone.label, r.parameter).toBe(r.rating);
    }
  });

  it("highlights the zone that holds the value when two zones share a label", () => {
    const ec = read("electrical_conductivity");
    expect(zoneIndexOf({ ...ec, rating: "critical", ratedValue: 1.5 })).toBe(1);
    expect(zoneIndexOf({ ...ec, rating: "critical", ratedValue: 3 })).toBe(2);
    expect(zoneIndexOf(ec)).toBe(0);
    expect(zoneIndexOf(read("ph"))).toBe(2);
  });
});

describe("ratings, labels and text", () => {
  it("maps ratings to zone and chip tones and readable labels", () => {
    expect(zoneTone("low")).toBe("bad");
    expect(zoneTone("deficient")).toBe("bad");
    expect(zoneTone("critical")).toBe("caution");
    expect(zoneTone("medium")).toBe("ok");
    expect(zoneTone("neutral")).toBe("good");
    expect(zoneTone("unrated")).toBe("none");
    expect(ratingChipTone("low")).toBe("warning");
    expect(ratingChipTone("acidic")).toBe("watch");
    expect(ratingChipTone("medium")).toBe("neutral");
    expect(ratingChipTone("sufficient")).toBe("done");
    expect(ratingLabel("strongly_acidic")).toBe("Strongly acidic");
    expect(ratingLabel("very_low")).toBe("Very low");
    expect(ratingLabel("unrated")).toBe("Not rated");
  });

  it("shows printed values with their unit (no unit for pH) and a rated-as line only when the rating used something else", () => {
    expect(valueText(read("ph"))).toBe("7.2");
    expect(valueText(read("electrical_conductivity"))).toBe("0.86 dS/m");
    expect(valueText(read("nitrogen_unspecified"))).toBe("278 kg/ha");
    expect(valueText({ value: null, unit: null })).toBe("Not a single number");
    expect(ratedAsText(read("ph"))).toBeNull();
    expect(ratedAsText(read("electrical_conductivity"))).toBeNull();
    expect(ratedAsText(read("nitrogen_unspecified"))).toBeNull();
    expect(ratedAsText(read("organic_matter"))).toBe("Rated as 1.392 %");
    expect(ratedAsText(read("phosphorus_total"))).toBe("Rated as 16 kg P/ha");
    expect(ratedAsText(UNRATED_ZINC)).toBeNull();
  });

  it("formats the sample date and the zone ranges", () => {
    expect(sampleDateText("2026-09-15")).toBe("15 Sep 2026");
    expect(sampleDateText("2026-01-05")).toBe("5 Jan 2026");
    expect(sampleDateText(null)).toBeNull();
    expect(bandRangeText({ label: "low", from: null, to: 280, note: null })).toBe("Below 280");
    expect(bandRangeText({ label: "medium", from: 280, to: 560, note: null })).toBe("280 to 560");
    expect(bandRangeText({ label: "high", from: 560, to: null, note: null })).toBe("560 and above");
    expect(bandRangeText({ label: "low", from: null, to: 280, note: "Below 280 kg/ha" })).toBe("Below 280 kg/ha");
  });

  it("splits rated readings (bars, fixed order) from the rest", () => {
    const { rated, other } = splitReadings([UNRATED_ZINC, ...[...HASSAN_READINGS].reverse()]);
    expect(rated.map((r) => r.parameter)).toEqual(["ph", "electrical_conductivity", "organic_matter", "nitrogen_unspecified", "phosphorus_total", "potassium_total"]);
    expect(other.map((r) => r.parameter)).toEqual(["zinc_available"]);
  });

  it("puts the AI mark only on model-written text or text still being written", () => {
    expect(showAiMark(readyModelReview)).toBe(true);
    expect(showAiMark(pendingSoilReview)).toBe(true);
    expect(showAiMark(readyCodeReview)).toBe(false);
    expect(showAiMark(errorSoilReview)).toBe(false);
    expect(showAiMark(noReportSoilReview)).toBe(false);
    expect(isActive(pendingSoilReview)).toBe(true);
    expect(isActive(readyModelReview)).toBe(false);
  });
});

describe("fixtures", () => {
  it("every fixture parses with SoilReview.parse, also after a JSON round trip", () => {
    for (const f of [readyModelReview, readyCodeReview, pendingSoilReview, errorSoilReview, withUnratedReview, noReportSoilReview]) {
      expect(SoilReview.safeParse(f).success).toBe(true);
      expect(SoilReview.safeParse(JSON.parse(JSON.stringify(f))).success).toBe(true);
    }
    expect(readyModelReview.readings).toHaveLength(6);
    expect(HASSAN_READINGS.filter((r) => r.assumption)).toHaveLength(4);
  });
});

describe("biomarker rows", () => {
  const html = renderToString(() => <SoilBiomarkers readings={HASSAN_READINGS} />);

  it("renders six band bars, one per rated value, each described for assistive technology", () => {
    expect(count(html, 'class="sb-bar')).toBe(6);
    expect(count(html, 'role="img"')).toBe(6);
    expect(html).toMatch(/aria-label="pH 7\.2, neutral\. Zones: strongly acidic/);
    expect(count(html, 'class="sb-row"')).toBe(6);
    expect(count(html, 'aria-haspopup="dialog"')).toBe(6);
  });

  it("places the markers on the axis (pH 7.2 on 4 to 10, N 278 on 0 to 840)", () => {
    expect(html).toContain("left:53.33%");
    expect(html).toContain("left:33.1%");
  });

  it("shows rating chips, the Assumed form chip on exactly the four inferred ratings, and the sample date on every row", () => {
    for (const label of ["Neutral", "Normal", "Low", "High", "Medium"]) expect(html, label).toContain(`>${label}<`);
    expect(count(html, ">Assumed form<")).toBe(4);
    expect(count(html, "Sampled 15 Sep 2026")).toBe(6);
    expect(html).toContain("Rated as 1.392 %");
    expect(html).toContain("ui-chip-warning"); // low nitrogen
  });

  it("has no Other values list when every reading is rated", () => {
    expect(html).not.toContain("Other values");
  });

  it("lists unrated readings in a collapsed Other values list with the reason and the printed value", () => {
    const withOther = renderToString(() => <SoilBiomarkers readings={withUnratedReview.readings} />);
    expect(withOther).toContain("Other values (1)");
    expect(withOther).toContain("Zinc (DTPA)");
    expect(withOther).toContain("0.5 ppm");
    expect(withOther).toContain("Printed as a range or limit");
    expect(withOther).toContain("a single exact value is needed to rate");
    expect(withOther).toMatch(/<details class="sb-other">/);
    expect(withOther).not.toMatch(/<details[^>]* open/);
    expect(count(withOther, 'class="sb-bar')).toBe(6);
  });

  it("says so when nothing could be rated", () => {
    const none = renderToString(() => <SoilBiomarkers readings={[UNRATED_ZINC]} />);
    expect(none).toContain("None of the confirmed values could be rated");
    expect(none).toContain("Other values (1)");
  });

  it("draws the marker pinned to the edge when the value is beyond the scale", () => {
    const high = { ...read("ph"), ratedValue: 11.5, value: 11.5, rating: "strongly_alkaline" as const };
    const edge = renderToString(() => <BiomarkerBar reading={high} />);
    expect(edge).toContain("left:100%");
    expect(edge).toContain("sb-marker-edge");
    expect(edge).toContain("beyond the top of the scale");
  });
});

describe("reading sheet content", () => {
  const detail = (r: SoilReading) => renderToString(() => <ReadingDetail reading={r} />);

  it("shows zones with the current one marked, the source with its link, method, assumption, note and crop needs", () => {
    const html = detail(read("nitrogen_unspecified"));
    expect(count(html, 'class="sb-swatch')).toBe(3);
    expect(count(html, "Your value")).toBe(1);
    expect(html).toMatch(/<li class="is-current">[^]*?Low[^]*?Below 280 kg\/ha/);
    expect(html).toContain("Assumed form");
    expect(html).toContain("rated as available N (alkaline permanganate)");
    expect(html).toContain("The report does not state the nitrogen method");
    expect(html).toContain("Methods Manual: Soil Testing in India");
    expect(html).toContain("Section 4.1 Table 1, printed page 33");
    expect(html).toContain('href="https://biharsoilhealth.in/documents/manualgoi.pdf"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("Not printed on the report");
    expect(html).toContain("Taken 15 Sep 2026");
    expect(html).toContain("Paddy: High need");
    expect(html).toContain("Groundnut: Medium need");
    expect(html).toContain("It is not a fertilizer dose");
  });

  it("omits the assumption and crop needs for a plain pH reading and states the converted value for organic matter", () => {
    const ph = detail(read("ph"));
    expect(ph).not.toContain("Assumed form");
    expect(ph).not.toContain("Current crop");
    expect(ph).toContain("Neutral");
    expect(detail(read("organic_matter"))).toContain("Rated as 1.392 %.");
  });

  it("says when the sample date is not printed", () => {
    expect(detail({ ...read("ph"), collectionDate: null })).toContain("Sample date not printed on the report");
  });
});

describe("panel states", () => {
  it("pending: shows the pending indicator and the AI mark, keeps the calculated bars, disables Refresh, no narrative yet", () => {
    const html = view(pendingSoilReview);
    expect(html).toContain("Writing the review");
    expect(html).toContain("The ratings below are already calculated.");
    expect(html).toContain('role="status"');
    expect(html).toContain("ai-spark");
    expect(count(html, 'class="sb-bar')).toBe(6);
    expect(html).not.toContain("After this harvest");
    expect(html).toMatch(/<button[^>]*sr-refresh[^>]*disabled|<button[^>]*disabled[^>]*sr-refresh/);
  });

  it("no_report: links to the soil report upload, no AI mark, no Refresh, no bars", () => {
    const html = view(noReportSoilReview);
    expect(html).toContain("No confirmed soil report for this field yet");
    expect(html).toContain(`href="/farm/settings?farmId=${SOIL_FIXTURE_FARM_ID}"`);
    expect(html).toContain("Upload a soil report");
    expect(html).not.toContain("ai-spark");
    expect(html).not.toContain("Refresh");
    expect(html).not.toContain("sb-bar");
    expect(html).not.toContain("Full report values");
  });

  it("ready (model): the narrative blocks with their headings, the AI mark, the origin line, Refresh enabled, the Full report values anchor", () => {
    const html = view(readyModelReview);
    expect(html).toContain("After this harvest");
    expect(html).toContain("For the next crop");
    expect(html).toContain("Paddy is expected to take up about 130 kg N/ha.");
    expect(html).toContain("Groundnut needs medium nitrogen and low phosphorus and potassium.");
    expect(html).toContain("ai-spark");
    expect(html).toContain("Written by Meta from the facts below");
    expect(html).not.toMatch(/<button[^>]*sr-refresh[^>]*disabled/);
    expect(html).toContain("Refresh");
    expect(html).toMatch(/<a[^>]*href="#soil-report-values"[^>]*>[^<]*Full report values/);
    expect(html).toContain("Growing now: Paddy");
    expect(html).toContain("Next: Groundnut (from your applied year plan)");
    expect(count(html, 'class="sb-bar')).toBe(6);
  });

  it("ready (code-written): no AI mark and it says the text was written by code", () => {
    const html = view(readyCodeReview);
    expect(html).not.toContain("ai-spark");
    expect(html).toContain("Written by code from the facts below");
    expect(html).toContain("Meta was not available in this runtime");
    expect(html).toContain("What this review is based on");
    expect(html).toContain("Limiting for Paddy: nitrogen (soil low, crop need high).");
  });

  it("error: says the text could not be written and keeps the ratings; a refresh error and a refresh in flight are shown", () => {
    const html = view(errorSoilReview);
    expect(html).toContain("The review text could not be written");
    expect(html).toContain('role="alert"');
    expect(count(html, 'class="sb-bar')).toBe(6);
    expect(view(readyModelReview, { refreshError: "Could not refresh." })).toContain("Could not refresh.");
    expect(view(readyModelReview, { refreshing: true })).toMatch(/<button[^>]*sr-refresh[^>]*disabled/);
  });

  it("with an unrated value, the Other values list sits under the bars in the full panel", () => {
    const html = view(withUnratedReview);
    expect(html).toContain("Other values (1)");
    expect(html.indexOf("Other values")).toBeGreaterThan(html.indexOf("sb-list"));
  });
});

describe("soil review client", () => {
  const envelope = (data: unknown) =>
    new Response(JSON.stringify({ requestId: "t", mode: "synthetic", asOf: "2026-11-01T00:00:00Z", data, warnings: [], error: null }), { status: 200, headers: { "content-type": "application/json" } });
  function fake(queue: unknown[]) {
    const calls: { method: string; url: string; body: unknown }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/session") return envelope({ authenticated: true, csrfToken: "test" });
      calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : null });
      return envelope(queue.length > 1 ? queue.shift() : queue[0]);
    }) as typeof fetch;
    return { calls, fetchImpl };
  }

  it("polls the GET endpoint while pending and stops when the review is ready", async () => {
    const { calls, fetchImpl } = fake([pendingSoilReview, pendingSoilReview, readyModelReview]);
    const seen: string[] = [];
    const final = await pollSoilReview(SOIL_FIXTURE_FARM_ID, pendingSoilReview, { fetchImpl, intervalMs: 1, onUpdate: (r) => seen.push(r.status) });
    expect(final.status).toBe("ready");
    expect(seen).toEqual(["pending", "pending", "ready"]);
    expect(calls.every((c) => c.method === "GET" && c.url === `/api/v1/farms/${SOIL_FIXTURE_FARM_ID}/soil-review`)).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it("does not poll a settled review, and stops at once when aborted", async () => {
    const { calls, fetchImpl } = fake([readyModelReview]);
    expect((await pollSoilReview(SOIL_FIXTURE_FARM_ID, readyModelReview, { fetchImpl, intervalMs: 1 })).status).toBe("ready");
    const ctrl = new AbortController();
    const running = pollSoilReview(SOIL_FIXTURE_FARM_ID, pendingSoilReview, { fetchImpl, intervalMs: 50, signal: ctrl.signal });
    ctrl.abort();
    expect((await running).status).toBe("pending");
    expect(calls).toHaveLength(0);
  });

  it("Refresh posts {} once, then polls until the review settles", async () => {
    const { calls, fetchImpl } = fake([pendingSoilReview, readyModelReview]);
    const final = await refreshAndPoll(SOIL_FIXTURE_FARM_ID, { fetchImpl, intervalMs: 1 });
    expect(final.status).toBe("ready");
    expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{}]);
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(1);
  });

  it("rejects an answer that does not match the contract instead of rendering partial data", async () => {
    const { fetchImpl } = fake([{ ...readyModelReview, readings: [{ markerId: "x" }] }]);
    await expect(loadSoilReview(SOIL_FIXTURE_FARM_ID, { fetchImpl })).rejects.toBeInstanceOf(SoilReviewContractError);
    await expect(refreshSoilReview(SOIL_FIXTURE_FARM_ID, { fetchImpl })).rejects.toBeInstanceOf(SoilReviewContractError);
  });
});
