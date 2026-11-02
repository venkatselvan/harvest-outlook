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
} from "../farm/soilReviewFixtures";
import { TodaySoilView } from "./TodaySoil";
import {
  dismissKey,
  headlineOf,
  pickReadings,
  provenanceOf,
  readDismissed,
  runSoilCard,
  sharedProvenance,
  writeDismissed,
  zoneLabels,
  type SoilCardApi,
  type SoilCardState,
} from "./todaySoilModel";

/** SSR markup without hydration keys and markers. The test environment is node (no DOM), so click wiring is asserted on the controller functions. */
const html = (fn: () => JSX.Element) => ssr(fn).replace(/ data-hk="[^"]*"/g, "").replace(/<!--[^>]*-->/g, "");
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const noop = () => undefined;
const card = (state: SoilCardState, over: Partial<{ dismissed: boolean }> = {}) =>
  html(() => <TodaySoilView state={state} dismissed={over.dismissed ?? false} onUpload={noop} onRecords={noop} onRetry={noop} onDismiss={noop} />);
const reviewState = (review: SoilReview, polling = false): SoilCardState => ({ kind: "review", review, polling });
const reading = (parameter: string): SoilReading => HASSAN_READINGS.find((r) => r.parameter === parameter)!;
const rated = (parameter: string, over: Partial<SoilReading> = {}): SoilReading => ({ ...reading("ph"), markerId: parameter, parameter, label: parameter, ...over });

class MemoryStore {
  data = new Map<string, string>();
  getItem = (k: string) => this.data.get(k) ?? null;
  setItem = (k: string, v: string) => void this.data.set(k, v);
}

describe("pickReadings", () => {
  it("orders pH, organic carbon, available N, P, K, then the rest in stored order, at most five", () => {
    const all = [
      rated("zinc_available"),
      rated("potassium_available"),
      rated("sulphur_available"),
      rated("nitrogen_available"),
      rated("organic_carbon"),
      rated("phosphorus_available"),
      rated("ph"),
    ];
    expect(pickReadings(all).map((r) => r.parameter)).toEqual(["ph", "organic_carbon", "nitrogen_available", "phosphorus_available", "potassium_available"]);
    const few = [rated("boron_available"), rated("ph"), rated("zinc_available")];
    expect(pickReadings(few).map((r) => r.parameter)).toEqual(["ph", "boron_available", "zinc_available"]);
    expect(pickReadings([rated("a"), rated("b"), rated("c"), rated("d"), rated("e"), rated("f")]).map((r) => r.parameter)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("never draws a reading that is not rated or has no axis or zones", () => {
    const picked = pickReadings([UNRATED_ZINC, rated("ph", { axis: null }), rated("organic_carbon", { bands: [] }), rated("nitrogen_available", { status: "unit_mismatch" }), rated("potassium_available")]);
    expect(picked.map((r) => r.parameter)).toEqual(["potassium_available"]);
  });
});

describe("zoneLabels", () => {
  it("names each zone at the position the bar draws it, and marks the zone that holds the value", () => {
    const labels = zoneLabels(reading("ph"));
    expect(labels.map((l) => l.label)).toEqual(["Strongly acidic", "Acidic", "Neutral", "Alkaline", "Strongly alkaline"]);
    expect(labels[0]).toMatchObject({ left: 0 });
    expect(labels[0]!.width).toBeCloseTo(1.6 / 6, 10);
    expect(labels.reduce((s, l) => s + l.width, 0)).toBeCloseTo(1, 10);
    expect(labels.filter((l) => l.current).map((l) => l.label)).toEqual(["Neutral"]);
  });

  it("merges neighbouring zones with the same rating so a name is not printed twice (two Critical salinity zones)", () => {
    const ec = zoneLabels(reading("electrical_conductivity"));
    expect(ec.map((l) => l.label)).toEqual(["Normal", "Critical", "Injurious"]);
    expect(ec.reduce((s, l) => s + l.width, 0)).toBeCloseTo(1, 10);
    expect(ec[1]!.left).toBeCloseTo(ec[0]!.width, 10);
  });
});

describe("headlineOf", () => {
  it("is the first narrative line for a model narrative, with no code note", () => {
    expect(headlineOf(readyModelReview)).toEqual({ text: "Soil pH 7.2 rates neutral and salinity is normal.", pending: false, note: null });
  });
  it("says the values are being rated while pending or running", () => {
    expect(headlineOf(pendingSoilReview)).toMatchObject({ text: "Rating your soil values…", pending: true });
    expect(headlineOf({ ...pendingSoilReview, status: "running" })).toMatchObject({ pending: true });
  });
  it("adds the written-by-code note for a deterministic narrative and has no line without one", () => {
    expect(headlineOf(readyCodeReview)).toMatchObject({ text: "Soil pH 7.2 rates neutral.", note: "Written by code from the confirmed values." });
    expect(headlineOf(errorSoilReview)).toEqual({ text: null, pending: false, note: null });
  });
});

describe("provenanceOf", () => {
  it("prints the date and the method, and leaves out what the reading does not carry", () => {
    expect(provenanceOf({ collectionDate: "2026-09-15", method: "Olsen" })).toBe("Collected 15 Sep 2026 · Olsen");
    expect(provenanceOf({ collectionDate: "2026-09-15", method: null })).toBe("Collected 15 Sep 2026");
    expect(provenanceOf({ collectionDate: null, method: "  " })).toBe("Collection date not printed on the report");
  });
  it("collapses to one line only when every row says the same", () => {
    expect(sharedProvenance([reading("ph"), reading("organic_matter")])).toBe("Collected 15 Sep 2026");
    expect(sharedProvenance([reading("ph"), { ...reading("organic_matter"), collectionDate: "2026-08-01" }])).toBeNull();
    expect(sharedProvenance([])).toBeNull();
  });
});

describe("the card", () => {
  it("rated review: rows in order with zone names, rating chips, a bar per row, provenance, and the AI mark only for a model narrative", () => {
    const model = card(reviewState(readyModelReview));
    // Fixture parameters are ph, ec, nitrogen_unspecified, organic_matter, phosphorus_total, potassium_total: none is a priority id except pH, so the rest follow stored order.
    const labels = [...model.matchAll(/class="today-soil-label">([^<]*)</g)].map((m) => m[1]);
    expect(labels).toEqual(["pH", "EC", "Nitrogen", "Total organic matter", "Total Phosphorus"]);
    expect([...model.matchAll(/class="sb-bar/g)]).toHaveLength(5);
    expect(model).toContain("Strongly acidic");
    expect(model).toContain("today-soil-zone is-current");
    expect(text(model)).toContain("Soil pH 7.2 rates neutral and salinity is normal.");
    expect(text(model)).toContain("Collected 15 Sep 2026");
    expect(model).toContain("All soil values");
    expect(model).toContain('aria-labelledby="today-soil-title"');
    expect(model).toMatch(/<h2 id="today-soil-title">Soil for this farm<\/h2>/);
    expect(model).toContain("ai-spark");
    expect(model).not.toContain("today-soil-code-note");

    const code = card(reviewState(readyCodeReview));
    expect(code).not.toContain("ai-spark");
    expect(code).toContain("today-soil-code-note");
    expect(text(code)).toContain("Written by code");
  });

  it("pending review: calculated rows with an aria-live line and the AI mark", () => {
    const pending = card(reviewState(pendingSoilReview, true));
    expect(pending).toContain("Rating your soil values…");
    expect(pending).toMatch(/aria-live="polite"[^>]*data-testid="today-soil-pending"/);
    expect(pending).toContain("ai-spark");
    expect([...pending.matchAll(/class="sb-bar/g)]).toHaveLength(5);
  });

  it("no_report: shows the upload prompt and no bars; dismissed hides it entirely", () => {
    const prompt = card(reviewState(noReportSoilReview));
    expect(prompt).toContain("Upload a soil report for better crop rotation planning");
    expect(prompt).toContain("Upload soil report");
    expect(prompt).toContain("Not now");
    expect(prompt).not.toContain("sb-bar");
    expect(card(reviewState(noReportSoilReview), { dismissed: true })).toBe("");
    // While loading, a dismissed farm shows nothing either (no flash before the prompt is hidden).
    expect(card({ kind: "loading" }, { dismissed: true })).toBe("");
    expect(card({ kind: "loading" })).toContain("Loading your soil values");
  });

  it("failures render one line with a Retry button and no readings", () => {
    for (const state of [{ kind: "failed", reason: "load" } as const, { kind: "failed", reason: "review" } as const]) {
      const failed = card(state);
      expect(failed).toContain('role="alert"');
      expect([...failed.matchAll(/>Retry</g)]).toHaveLength(1);
      expect(failed).not.toContain("sb-bar");
    }
  });

  it("an errored review that carries rated readings still draws them, with the summary note and one Retry in place of the headline", () => {
    for (const status of ["error", "unavailable"] as const) {
      const markup = card(reviewState({ ...errorSoilReview, status }));
      expect([...markup.matchAll(/class="sb-bar/g)]).toHaveLength(5);
      expect(text(markup)).toContain("The written soil summary could not be made.");
      expect([...markup.matchAll(/>Retry</g)]).toHaveLength(1);
      expect(markup).toContain("Collected 15 Sep 2026");
      expect(markup).not.toContain("today-overview-headline");
      expect(markup).not.toContain("ai-spark");
      expect(markup).not.toContain('data-testid="today-soil-error"');
    }
  });

  it("an errored review with no rated readings renders the single error line with Retry", async () => {
    const seen: SoilCardState[] = [];
    const empty = SoilReview.parse({ ...errorSoilReview, readings: [UNRATED_ZINC] });
    await runSoilCard("f", { load: async () => empty, refresh: async () => empty, poll: async (_f, i) => i }, (s) => seen.push(s), new AbortController().signal);
    expect(seen).toEqual([{ kind: "failed", reason: "review" }]);
    const markup = card(seen[0]!);
    expect(markup).toContain('data-testid="today-soil-error"');
    expect([...markup.matchAll(/>Retry</g)]).toHaveLength(1);
    expect(markup).not.toContain("sb-bar");
  });

  it("a review whose readings are all unrated says so instead of drawing empty bars", () => {
    const none = SoilReview.parse({ ...readyCodeReview, readings: [UNRATED_ZINC], narrative: null, narrativeOrigin: null });
    const markup = card(reviewState(none));
    expect(markup).toContain("None of the confirmed values could be rated");
    expect(markup).not.toContain("sb-bar");
  });
});

describe("dismissal storage", () => {
  it("persists per farm for the session and never throws when storage fails", () => {
    const store = new MemoryStore();
    expect(readDismissed("farm-a", store)).toBe(false);
    writeDismissed("farm-a", store);
    expect(readDismissed("farm-a", store)).toBe(true);
    expect(readDismissed("farm-b", store)).toBe(false);
    expect(store.data.has(dismissKey("farm-a"))).toBe(true);
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readDismissed("farm-a", broken)).toBe(false);
    expect(() => writeDismissed("farm-a", broken)).not.toThrow();
    expect(readDismissed("farm-a", null)).toBe(false);
    expect(() => writeDismissed("farm-a", null)).not.toThrow();
  });
});

describe("runSoilCard (load, poll, drop late answers)", () => {
  const deferred = <T,>() => {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
    return { promise, resolve, reject };
  };
  const api = (over: Partial<SoilCardApi>): SoilCardApi => ({
    load: async () => readyModelReview,
    refresh: async () => readyModelReview,
    poll: async (_f, initial) => initial,
    ...over,
  });

  it("loads once, then polls a pending review until it settles and reports each step", async () => {
    const seen: string[] = [];
    let loads = 0;
    let polls = 0;
    await runSoilCard(
      SOIL_FIXTURE_FARM_ID,
      api({
        load: async () => (loads++, pendingSoilReview),
        poll: async (_f, _i, opts) => (polls++, opts.onUpdate?.({ ...pendingSoilReview, status: "running" }), readyModelReview),
      }),
      (s) => seen.push(s.kind === "review" ? `${s.review.status}:${s.polling}` : s.kind),
      new AbortController().signal,
    );
    expect(loads).toBe(1);
    expect(polls).toBe(1);
    expect(seen).toEqual(["pending:true", "running:true", "ready:false"]);
  });

  it("drops a late response after the farm switched (aborted signal): nothing is emitted", async () => {
    const slow = deferred<SoilReview>();
    const ctrl = new AbortController();
    const seen: SoilCardState[] = [];
    const run = runSoilCard("farm-a", api({ load: () => slow.promise }), (s) => seen.push(s), ctrl.signal);
    ctrl.abort(); // the component aborts when farmId or epoch changes
    slow.resolve(readyModelReview);
    await run;
    expect(seen).toEqual([]);
    // and a failure that lands after the abort is dropped too
    const late = deferred<SoilReview>();
    const ctrl2 = new AbortController();
    const seen2: SoilCardState[] = [];
    const run2 = runSoilCard("farm-a", api({ load: () => late.promise }), (s) => seen2.push(s), ctrl2.signal);
    ctrl2.abort();
    late.reject(new Error("network"));
    await run2;
    expect(seen2).toEqual([]);
  });

  it("a new run for another farm is not affected by the previous run's late answer", async () => {
    const slowA = deferred<SoilReview>();
    const a = new AbortController();
    const b = new AbortController();
    const seen: string[] = [];
    const runA = runSoilCard("farm-a", api({ load: () => slowA.promise }), () => seen.push("A"), a.signal);
    a.abort();
    const runB = runSoilCard("farm-b", api({ load: async () => noReportSoilReview }), (s) => seen.push(`B:${s.kind === "review" ? s.review.status : s.kind}`), b.signal);
    slowA.resolve(readyModelReview);
    await Promise.all([runA, runB]);
    expect(seen).toEqual(["B:no_report"]);
  });

  it("a failed load emits one failure; a review that ended in error keeps its rated readings; Retry on it refreshes", async () => {
    const seen: SoilCardState[] = [];
    await runSoilCard("f", api({ load: async () => { throw new Error("offline"); } }), (s) => seen.push(s), new AbortController().signal);
    expect(seen).toEqual([{ kind: "failed", reason: "load" }]);

    const seen2: SoilCardState[] = [];
    await runSoilCard("f", api({ load: async () => errorSoilReview }), (s) => seen2.push(s), new AbortController().signal);
    expect(seen2).toEqual([{ kind: "review", review: errorSoilReview, polling: false }]);

    let refreshed = 0;
    const seen3: SoilCardState[] = [];
    await runSoilCard("f", api({ refresh: async () => (refreshed++, readyModelReview) }), (s) => seen3.push(s), new AbortController().signal, true);
    expect(refreshed).toBe(1);
    expect(seen3.map((s) => s.kind)).toEqual(["review"]);
  });

  it("a poll that gives up while the review is still active ends not polling, keeping the rated rows", async () => {
    const seen: SoilCardState[] = [];
    await runSoilCard("f", api({ load: async () => pendingSoilReview, poll: async (_f, i) => i }), (s) => seen.push(s), new AbortController().signal);
    expect(seen.at(-1)).toMatchObject({ kind: "review", polling: false });
  });
});
