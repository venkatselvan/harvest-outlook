import { describe, expect, it, vi } from "vitest";
import { renderToString } from "solid-js/web";
import { IssueCategory, SeasonReport, type IssueTrendWeek } from "@harvest/contracts";

// SYNTHETIC: every value below is invented test data; nothing here is a live response.
vi.mock("../state", () => ({
  useWorkspace: () => ({}),
  dateLabel: (d: string) => d,
  today: () => "2026-11-03",
}));
vi.mock("../FarmPage", () => ({ PageHeading: (p: { title: string }) => <h1>{p.title}</h1> }));
vi.mock("@solidjs/router", () => ({ useLocation: () => ({ search: "" }), useNavigate: () => () => undefined, A: (p: { href: string; children?: unknown }) => <a href={p.href}>{p.children as never}</a> }));

import { SeasonReportView, reportTotals } from "./SeasonReportPage";
import { IssueTrendChart, trendLayout } from "./IssueTrendChart";
import { describeReportError, parseSelector, reportCsvPath, reportHref, reportPath } from "./reportApi";
import { ApiError } from "../../lib/api";

const U = "11111111-1111-4111-8111-111111111111";
const E5 = "22222222-2222-4222-8222-222222222222";
const zero = Object.fromEntries(IssueCategory.options.map((c) => [c, 0])) as IssueTrendWeek["counts"];
const html = (render: () => unknown) => renderToString(render as never).replace(/<!--[^>]*-->/g, "");
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const entry = (id: string, observedOn: string, over: Record<string, unknown> = {}) => ({ id, observedOn, activity: "other", note: null, quantity: null, expense: null, sale: null, media: [], facts: [], provenanceLabel: "Farmer-reported. Saved as you entered it.", ...over });
const baseReport = (over: Record<string, unknown> = {}) => SeasonReport.parse({
  farm: { id: U, name: "Test farm", district: "Wayanad", state: "IN-KL", areaHa: 1.5 },
  field: { id: "north", name: "North strip", areaHa: 0.5 },
  cycle: { id: "c1", cropId: "maize", cropName: "Maize", sowingDate: "2026-10-01", establishmentDate: "2026-10-01", establishmentMethod: "direct_sowing", stage: "growing", fieldId: "north" },
  period: { from: "2026-10-01", to: "2026-11-03" },
  entries: [
    entry("e1", "2026-10-10", { activity: "irrigation", quantity: { value: 20, unit: "mm" } }),
    entry("e2", "2026-10-12", { activity: "expense", expense: { amountInr: "1200.50", category: "seed" } }),
    entry("e3", "2026-10-20", { activity: "harvest", quantity: { value: 2, unit: "quintal" }, media: [{ id: "m1", contentPath: "/api/v1/media/m1/content?variant=normalized", label: "Your photo" }] }),
    entry("e4", "2026-10-25", { activity: "sale", sale: { amountInr: "5000", note: null } }),
    entry(E5, "2026-10-26", { activity: "other", note: "Field check on North strip: nothing found." }),
  ],
  checks: [{ id: "check:c1:2026-10-26", kind: "interval", fieldId: "north", cycleId: "c1", issueId: null, cropName: "Maize", dueFrom: "2026-10-26", dueTo: "2026-10-28", status: "completed", intervalDays: 7, checklist: [], completedOn: "2026-10-26", journalEntryId: E5, scope: "field" }],
  issues: [], careCompletions: [{ taskId: "t", title: "First weeding", completedOn: "2026-10-15" }], alerts: [], ndvi: [{ date: "2026-10-12", meanNdvi: 0.412, clearFraction: 0.9, verdict: "usable" }],
  issueTrend: [], previousSeasons: [], generatedAt: "2026-11-03T06:00:00.000Z", limitations: ["No alerts were stored for this period."],
  ...over,
});

describe("reportTotals: the same arithmetic as the Journal's season totals", () => {
  it("adds the report's entries exactly, with the field area for mm to m3", () => {
    const { totals, records } = reportTotals(baseReport());
    expect(totals).toMatchObject({ entries: 5, expenseInr: 1200.5, saleInr: 5000, netInr: 3799.5, harvestKg: 200 });
    expect(records.harvest.totalKg).toBe(200);
    expect(records.water.events).toBe(1);
    expect(records.water).toMatchObject({ mm: "20", areaHa: 0.5, mmAsM3: 100 });
  });
});

describe("SeasonReportView", () => {
  const markup = html(() => <SeasonReportView report={baseReport()} csvHref="/api/v1/farms/x/season-report.csv?cycleId=c1" fmtDate={(d) => d} />);
  it("carries the farmer-recorded label, totals, both actions and the CSV link with the same query", () => {
    const t = text(markup);
    expect(t).toContain("Farmer recorded · not an estimate");
    expect(t).toContain("Maize on North strip");
    expect(t).toContain("Spent ₹1,200.50");
    expect(t).toContain("Sold ₹5,000");
    expect(t).toContain("Harvest recorded: 200 kg");
    expect(t).toContain("Print or save as PDF");
    expect(markup).toMatch(/href="\/api\/v1\/farms\/x\/season-report\.csv\?cycleId=c1"/);
    expect(t).toContain("Harvest and inputs");
  });
  it("lists a check with the note of its journal entry, care, satellite and the empty sections with a reason", () => {
    const t = text(markup);
    expect(t).toContain("Field check on North strip: nothing found.");
    expect(t).toContain("First weeding");
    expect(t).toContain("0.41");
    expect(t).toContain("No issues were recorded for this crop.");
    expect(t).toContain("No alerts were stored for these dates.");
    expect(t).toContain("No earlier season is recorded for this field.");
    expect(t).toContain("No alerts were stored for this period.");
  });
  it("marks the issues and checks sections to start a new printed page, hides actions in print, and prints photo thumbnails with their date", () => {
    expect(markup).toMatch(/report-break-before[^>]*aria-labelledby="rep-issues"/);
    expect(markup).toMatch(/report-break-before[^>]*aria-labelledby="rep-checks"/);
    expect(markup).not.toMatch(/report-break-before[^>]*aria-labelledby="rep-care"/);
    expect(markup).toMatch(/class="report-actions no-print"/);
    expect(markup).toMatch(/<img src="\/api\/v1\/media\/m1\/content\?variant=normalized" alt="Your photo, 2026-10-20"/);
    expect(text(markup)).toMatch(/2026-10-20 [^<]*2026-10-20/);
  });
  it("shows an issue with its response, the label-wait arithmetic note and no advice", () => {
    const issue = {
      id: U, farmId: U, fieldId: "north", cycleId: "c1", observedOn: "2026-10-18", category: "pest", severity: "medium", title: "Holes in leaves", mediaIds: [], photoMarks: [], status: "treating", cropId: "maize", cropName: "Maize",
      journalEntryId: U, recheckOn: "2026-11-05", earliestHarvestOn: "2026-11-10", scope: "field", createdAt: "2026-10-18T06:00:00.000Z", updatedAt: "2026-10-19T06:00:00.000Z",
      seenBefore: [{ issueId: U, observedOn: "2026-09-01", cropName: "Ragi", status: "resolved" }],
      events: [
        { id: U, kind: "reported", occurredOn: "2026-10-18", status: "open", response: null, note: null, mediaIds: [], journalEntryId: U, createdAt: "2026-10-18T06:00:00.000Z" },
        { id: U, kind: "response_recorded", occurredOn: "2026-10-19", status: null, response: { method: "mechanical", description: "Picked by hand", labelWaitDays: 14 }, note: null, mediaIds: [], journalEntryId: U, createdAt: "2026-10-19T06:00:00.000Z" },
      ],
    };
    const t = text(html(() => <SeasonReportView report={baseReport({ issues: [issue], issueTrend: [{ weekStart: "2026-10-12", counts: { ...zero, pest: 1 } }] })} csvHref="#" fmtDate={(d) => d} />));
    expect(t).toContain("Holes in leaves");
    expect(t).toContain("Picked by hand");
    expect(t).toContain("label wait 14 days (as you entered it)");
    expect(t).toContain("Earliest harvest from the label you entered: 2026-11-10 (arithmetic; not checked by the app)");
    expect(t).toContain("1 earlier issue of this kind, last 2026-09-01");
    expect(t).not.toMatch(/recommend|you should|apply /i);
  });
});

describe("IssueTrendChart", () => {
  const weeks: IssueTrendWeek[] = [
    { weekStart: "2026-10-12", counts: { ...zero, pest: 2, weed: 1 } },
    { weekStart: "2026-10-19", counts: { ...zero } },
    { weekStart: "2026-10-26", counts: { ...zero, disease: 4 } },
  ];
  it("stacks categories in a fixed order with heights proportional to counts, on integer ticks", () => {
    const l = trendLayout(weeks);
    expect(l.max).toBe(4);
    expect(l.ticks.map((t) => t.value)).toEqual([0, 1, 2, 3, 4]);
    const unit = (l.plotBottom - l.plotTop) / 4;
    const first = l.bars[0]!;
    expect(first.segments.map((s) => [s.category, s.count])).toEqual([["pest", 2], ["weed", 1]]);
    expect(first.segments[0]!.height).toBeCloseTo(2 * unit);
    expect(first.segments[0]!.y + first.segments[0]!.height).toBeCloseTo(l.plotBottom);
    expect(first.segments[1]!.y + first.segments[1]!.height).toBeCloseTo(first.segments[0]!.y);
    expect(l.bars[1]!.segments).toEqual([]);
    expect(l.bars[2]!.total).toBe(4);
  });
  it("draws one rect per non-zero segment and an equivalent table with matching totals", () => {
    const markup = html(() => <IssueTrendChart weeks={weeks} />);
    expect((markup.match(/<rect /g) ?? []).length).toBe(3);
    expect(markup).toContain("<summary>As a table</summary>");
    expect(markup).toMatch(/role="img"[^>]*aria-label="Issues logged per week, 3 weeks, 7 in total/);
    const t = text(markup);
    expect(t).toContain("Pest");
    expect(t).not.toContain("Animal damage"); // categories with no issue stay out of the legend and table
    expect(markup).toMatch(/<td[^>]*data-label="Total">0<\/td>/);
  });
  it("says so when there is nothing to chart", () => {
    expect(text(html(() => <IssueTrendChart weeks={[]} />))).toContain("No issues were recorded, so there is nothing to chart.");
  });
});

describe("reportApi", () => {
  it("builds the JSON and CSV paths with the same query, and the page links", () => {
    expect(reportPath("f 1", { cycleId: "c/1" })).toBe("/api/v1/farms/f%201/season-report?cycleId=c%2F1");
    expect(reportCsvPath("f1", { fieldId: "north" })).toBe("/api/v1/farms/f1/season-report.csv?fieldId=north");
    expect(reportCsvPath("f1", {})).toBe("/api/v1/farms/f1/season-report.csv");
    expect(reportHref({ cycleId: "c1" })).toBe("/farm/report?cycle=c1");
    expect(reportHref({ fieldId: "north" })).toBe("/farm/report?field=north");
    expect(parseSelector("?cycle=c1&field=north")).toEqual({ cycleId: "c1", fieldId: "north" });
    expect(parseSelector("")).toEqual({});
  });
  it("tells a missing field choice from a missing crop and from a plain failure", () => {
    expect(describeReportError(new ApiError("field_required", "x", 400)).kind).toBe("choose");
    expect(describeReportError(new ApiError("cycle_not_found", "x", 404)).kind).toBe("missing");
    expect(describeReportError(new ApiError("internal_error", "boom", 500))).toEqual({ kind: "other", message: "boom" });
  });
});
