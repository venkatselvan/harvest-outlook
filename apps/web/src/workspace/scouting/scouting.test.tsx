import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { formatDay } from "../today/model";
import { renderToString } from "solid-js/web";
import type { JSX } from "solid-js";
import { AddIssueEvent, CompleteCheck, CreateIssue, FieldIssue as issueSchema, TodayView as todaySchema, type FieldIssue, type UpcomingStep } from "@harvest/contracts";
import { ApiError } from "../../lib/api";
import { MemoryStore } from "../../features/journal/model";
import { FIXTURE_FARM_ID, FIXTURE_ISSUE_IDS, fieldCheckStepFixture, recheckStepFixture, todayChecksFixture, todayFixture } from "../today/fixtures";
import { UpcomingSteps } from "../today/UpcomingSteps";
import { FieldsPanel, intervalText, withCheckInterval } from "../fields/FieldsPanel";
import {
  addDaysIso,
  addMark,
  checkBody,
  checkProblems,
  clearScoutingDraft,
  countsOf,
  filterCount,
  filterIssues,
  isCheckDraft,
  issueBody,
  issueFromSearch,
  issueProblems,
  issuesLine,
  labelMark,
  loadScoutingDraft,
  locationInside,
  markPosition,
  marksOn,
  MAX_MARKS,
  missedText,
  newCheckDraft,
  newIssueDraft,
  newResponseDraft,
  parseInterval,
  removeMark,
  responseEvent,
  responseProblems,
  runCheckCompletion,
  checkCompletionNotice,
  saveScoutingDraft,
  seenBeforeLines,
  statusEvent,
  eventProblems,
  withId,
  withIssueParam,
  withoutId,
  withoutPhoto,
  LABEL_WAIT_HELP,
} from "./scoutingModel";
import { KEPT_ON_DEVICE, completeCheckPath, describeScoutingError, issueEventsPath, issuesPath } from "./scoutingApi";
import { IssueForm } from "./IssueForm";
import { CheckCompleteForm } from "./CheckCompleteSheet";
import { IssueSheetBody } from "./IssueSheet";
import { ResponseForm } from "./ResponseForm";
import { PhotoMarks } from "./PhotoMarks";
import { IssuesLine, IssuesListView } from "./IssuesList";

/** SSR markup without hydration keys and markers. The test environment is node (no DOM): clicks are asserted on the pure helpers. */
const html = (fn: () => JSX.Element) => renderToString(fn).replace(/ data-hk="[^"]*"/g, "").replace(/<!--[^>]*-->/g, "");
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const noop = () => undefined;
const TODAY = "2026-11-01";
const MEDIA = ["0b5c8f0e-1111-4aaa-8bbb-000000000001", "0b5c8f0e-1111-4aaa-8bbb-000000000002"] as const;
const FIELDS = [
  { id: "north", name: "North strip", boundary: { type: "Polygon" as const, coordinates: [[[76.1, 13], [76.101, 13], [76.101, 13.001], [76.1, 13.001], [76.1, 13]]] } },
  { id: "south", name: "South strip", boundary: { type: "Polygon" as const, coordinates: [[[76.1, 12.999], [76.101, 12.999], [76.101, 13], [76.1, 13], [76.1, 12.999]]] } },
];

/** An invented issue (fixture only): a pest report with a response carrying a farmer-entered label wait and a recheck. */
function issueFixture(over: Partial<FieldIssue> = {}): FieldIssue {
  return issueSchema.parse({
    id: FIXTURE_ISSUE_IDS.leaf,
    farmId: FIXTURE_FARM_ID,
    fieldId: "north",
    cycleId: "maize-cycle",
    observedOn: "2026-10-28",
    category: "pest",
    severity: "medium",
    title: "Holes in young leaves",
    detail: "Near the gate, about ten plants.",
    location: { lat: 13.0005, lon: 76.1005 },
    mediaIds: [MEDIA[0]],
    photoMarks: [{ mediaId: MEDIA[0], x: 0.25, y: 0.75, label: "fresh holes" }],
    status: "treating",
    cropId: "maize",
    cropName: "Maize",
    journalEntryId: "9d0e0f10-2222-4ccc-8ddd-000000000001",
    events: [
      { id: "9d0e0f10-2222-4ccc-8ddd-000000000011", kind: "reported", occurredOn: "2026-10-28", status: "open", response: null, note: null, mediaIds: [MEDIA[0]], journalEntryId: null, createdAt: "2026-10-28T06:00:00.000Z" },
      {
        id: "9d0e0f10-2222-4ccc-8ddd-000000000012",
        kind: "response_recorded",
        occurredOn: "2026-10-29",
        status: null,
        response: { method: "mechanical", description: "Picked off the damaged leaves", productName: "my own mix", labelWaitDays: 14, recheckOn: "2026-11-04" },
        note: null,
        mediaIds: [],
        journalEntryId: null,
        createdAt: "2026-10-29T06:00:00.000Z",
      },
    ],
    recheckOn: "2026-11-04",
    earliestHarvestOn: "2026-11-12",
    seenBefore: [{ issueId: "9d0e0f10-2222-4ccc-8ddd-000000000099", observedOn: "2025-10-10", cropName: "Ragi", status: "resolved" }],
    createdAt: "2026-10-28T06:00:00.000Z",
    updatedAt: "2026-10-29T06:00:00.000Z",
    scope: "field",
    ...over,
  });
}

describe("fixtures", () => {
  it("the Today fixture with checks and issues validates against the contract", () => {
    const view = todaySchema.parse(todayChecksFixture());
    expect(view.upcoming.filter((s) => s.kind === "field_check")).toHaveLength(2);
    expect(view.issues).toMatchObject({ open: 2, treating: 1 });
    expect(todaySchema.safeParse({ ...todayFixture(), upcoming: [fieldCheckStepFixture({ missedCount: 3 })] }).success).toBe(true);
  });
});

describe("field check steps in Today", () => {
  const steps = (list: UpcomingStep[], over: Partial<Parameters<typeof UpcomingSteps>[0]> = {}) =>
    html(() => <UpcomingSteps steps={list} nextAction={null} today={TODAY} busyId="" onDone={noop} error="" onCheck={noop} onOpenIssue={noop} {...over} />);

  it("lists the check with the interval caption, the sourced checklist and the general prompts", () => {
    const markup = steps([fieldCheckStepFixture(), recheckStepFixture()]);
    const words = text(markup);
    expect(words).toContain("Walk the field: Maize on North strip");
    expect(words).toContain("Your check interval: every 7 days (your own setting)");
    expect(words).toContain("Checklist");
    expect(words).toContain("Risk windows this week, from their sources");
    expect(markup).toContain('href="https://example.org/bulletin"');
    expect(words).toContain("20 Oct 2026");
    expect(words).toContain("General prompts (not crop-specific advice)");
    expect(words).toContain("Take a photo of anything unusual");
    // The server's long detail text is not repeated under a field check.
    expect(words).not.toContain("Your check interval: every 7 days (your own setting).");
    expect(markup).toContain('aria-label="Mark done: Walk the field: Maize on North strip"');
    // A recheck shows its title and opens its issue.
    expect(words).toContain("Recheck: Holes in young leaves");
    expect(markup).toContain('aria-label="Open issue: Recheck: Holes in young leaves"');
  });

  it("shows the missed count only when the server sends one", () => {
    expect(text(steps([fieldCheckStepFixture({ missedCount: 2 })]))).toContain("2 earlier checks were missed; this is the latest one.");
    expect(steps([fieldCheckStepFixture()])).not.toContain("sc-check-missed");
    expect(missedText(fieldCheckStepFixture({ missedCount: 1 }).fieldCheck!)).toBe("1 earlier check was missed; this is the latest one.");
  });

  it("offers no Done without a completion handler, and none on a completed check", () => {
    expect(html(() => <UpcomingSteps steps={[fieldCheckStepFixture()]} nextAction={null} today={TODAY} busyId="" onDone={noop} error="" />)).not.toContain("Mark done");
    expect(steps([fieldCheckStepFixture({ status: "completed" })])).not.toContain("Mark done");
  });
});

describe("check completion", () => {
  const draft = () => ({ ...newCheckDraft(FIXTURE_FARM_ID, "check:maize-cycle:2026-11-01", "check-0001-abcd", TODAY), result: "nothing_found" as const });

  it("validates the date and the result, and sends issue ids only with Issues found", () => {
    expect(checkProblems({ ...draft(), result: "" }, TODAY)).toContain("Choose what you found: nothing, or issues.");
    expect(checkProblems({ ...draft(), completedOn: "2026-11-02" }, TODAY)).toContain("The date cannot be in the future.");
    expect(checkProblems({ ...draft(), issueIds: [FIXTURE_ISSUE_IDS.leaf] }, TODAY).join(" ")).toContain("Choose Issues found");
    const found = checkBody({ ...draft(), result: "issues_found", issueIds: [FIXTURE_ISSUE_IDS.leaf], note: "  two spots  " });
    expect(CompleteCheck.parse(found)).toMatchObject({ result: "issues_found", issueIds: [FIXTURE_ISSUE_IDS.leaf], note: "two spots" });
    expect(checkBody({ ...draft(), issueIds: [FIXTURE_ISSUE_IDS.leaf] }).issueIds).toEqual([]);
    expect(completeCheckPath(FIXTURE_FARM_ID)).toBe(`/api/v1/farms/${FIXTURE_FARM_ID}/checks/complete`);
  });

  it("marks the step done at once, rolls back on a network failure and keeps the draft", async () => {
    const store = new MemoryStore();
    const d = draft();
    await saveScoutingDraft(store, "check", d.checkId, d);
    let done: ReadonlySet<string> = new Set();
    const seen: boolean[] = [];
    const outcome = await runCheckCompletion(checkBody(d), {
      mark: () => {
        done = withId(done, "step-1");
        seen.push(done.has("step-1"));
      },
      unmark: () => (done = withoutId(done, "step-1")),
      send: async () => {
        throw new ApiError("network_error", "Could not reach the server", 0);
      },
      clearDraft: () => clearScoutingDraft(store, "check", FIXTURE_FARM_ID, d.checkId, d.clientEntryId),
    });
    expect(seen).toEqual([true]);
    expect(done.has("step-1")).toBe(false);
    expect(outcome).toMatchObject({ ok: false, kept: KEPT_ON_DEVICE, error: { kind: "network" } });
    expect(KEPT_ON_DEVICE).toBe("Kept on this device; try again when online");
    expect(await loadScoutingDraft(store, "check", FIXTURE_FARM_ID, d.checkId, isCheckDraft)).toMatchObject({ clientEntryId: d.clientEntryId });
  });

  it("says Already recorded with the date on a replay and does not claim this note was saved; a first completion says recorded", () => {
    const check = { ...fieldCheckStepFixture().fieldCheck!, status: "completed" as const, completedOn: "2026-10-28" };
    const replay = checkCompletionNotice({ check, alreadyCompleted: true });
    expect(replay).toBe(`Already recorded on ${formatDay("2026-10-28")}. The earlier record was kept unchanged.`);
    expect(replay).not.toMatch(/Field check recorded|saved/i);
    expect(checkCompletionNotice({ check: { completedOn: null }, alreadyCompleted: true })).toMatch(/^Already recorded earlier/);
    expect(checkCompletionNotice({ check, alreadyCompleted: false })).toBe("Field check recorded in your field journal.");
  });

  it("clears the draft after the server confirms, and a refusal is not called a network failure", async () => {
    const store = new MemoryStore();
    const d = draft();
    await saveScoutingDraft(store, "check", d.checkId, d);
    const ok = await runCheckCompletion(checkBody(d), {
      mark: noop,
      unmark: noop,
      send: async () => ({ check: { ...fieldCheckStepFixture().fieldCheck!, status: "completed", completedOn: TODAY }, journalEntryId: "9d0e0f10-2222-4ccc-8ddd-000000000031", alreadyCompleted: false }),
      clearDraft: () => clearScoutingDraft(store, "check", FIXTURE_FARM_ID, d.checkId, d.clientEntryId),
    });
    expect(ok.ok).toBe(true);
    expect(await loadScoutingDraft(store, "check", FIXTURE_FARM_ID, d.checkId, isCheckDraft)).toBeNull();
    const refused = await runCheckCompletion(checkBody(d), {
      mark: noop,
      unmark: noop,
      send: async () => {
        throw new ApiError("idempotency_conflict", "used", 409);
      },
      clearDraft: async () => undefined,
    });
    expect(refused).toMatchObject({ ok: false, kept: null, error: { kind: "conflict" } });
  });

  it("renders the completion form with the result choices, the note and the logged issues", () => {
    const markup = html(() => (
      <CheckCompleteForm
        farmId={FIXTURE_FARM_ID}
        step={fieldCheckStepFixture()}
        today={TODAY}
        fields={FIELDS}
        onSubmit={noop}
        onClose={noop}
        store={new MemoryStore()}
        initialDraft={{ ...draft(), result: "issues_found", issueIds: [FIXTURE_ISSUE_IDS.leaf], issueTitles: { [FIXTURE_ISSUE_IDS.leaf]: "Holes in young leaves" } }}
      />
    ));
    const words = text(markup);
    for (const label of ["Date you walked the field", "Nothing found", "Issues found", "Holes in young leaves", "Log another issue", "Note (optional)", "Add a voice note (optional)", "Save check"])
      expect(words).toContain(label);
    expect(markup).toContain(`max="${TODAY}"`);
  });
});

describe("issue create", () => {
  it("requires the field on a farm with fields, the kind, the severity and a title; never a future date", () => {
    const empty = newIssueDraft(FIXTURE_FARM_ID, "issue-0001-abcd", TODAY, null);
    const problems = issueProblems({ ...empty, observedOn: "2026-11-05" }, { today: TODAY, hasFields: true }).map((p) => p.field);
    expect(problems).toEqual(["fieldId", "observedOn", "category", "severity", "title"]);
    expect(issueProblems(empty, { today: TODAY, hasFields: false }).map((p) => p.field)).not.toContain("fieldId");
  });

  it("builds a contract-valid body; removing a photo drops its marks", () => {
    const d = { ...newIssueDraft(FIXTURE_FARM_ID, "issue-0001-abcd", TODAY, "north"), category: "pest" as const, severity: "high" as const, title: " Holes ", mediaIds: [...MEDIA], photoMarks: [{ mediaId: MEDIA[0], x: 0.1, y: 0.2, label: "  " }, { mediaId: MEDIA[1], x: 0.5, y: 0.5, label: "here" }], location: { lat: 13.0005, lon: 76.1005 } };
    const body = CreateIssue.parse(issueBody(d));
    expect(body).toMatchObject({ fieldId: "north", title: "Holes", location: { lat: 13.0005, lon: 76.1005 } });
    expect(body.photoMarks[0]).not.toHaveProperty("label");
    expect(body.photoMarks[1]).toMatchObject({ label: "here" });
    const after = withoutPhoto(d, MEDIA[1]);
    expect(after).toEqual({ mediaIds: [MEDIA[0]], photoMarks: [d.photoMarks[0]] });
  });

  it("checks a device location against the field before using it", () => {
    expect(locationInside({ lat: 13.0005, lon: 76.1005 }, [FIELDS[0]!.boundary])).toBe(true);
    expect(locationInside({ lat: 12.9995, lon: 76.1005 }, [FIELDS[0]!.boundary])).toBe(false);
    expect(locationInside({ lat: 12.9995, lon: 76.1005 }, [null])).toBe(true);
  });

  it("renders labelled controls with the problems, and accepts a prefill (packet O2b)", () => {
    const d = newIssueDraft(FIXTURE_FARM_ID, "issue-0001-abcd", TODAY, null, { category: "pest", title: "Leaf damage consistent with insect feeding", mediaIds: [MEDIA[0]], fromFactId: "9d0e0f10-2222-4ccc-8ddd-000000000050" });
    expect(d).toMatchObject({ category: "pest", mediaIds: [MEDIA[0]], fromFactId: "9d0e0f10-2222-4ccc-8ddd-000000000050" });
    const markup = html(() => <IssueForm farmId={FIXTURE_FARM_ID} fields={FIELDS} today={TODAY} onCreated={noop} store={new MemoryStore()} initialDraft={{ ...d, title: "" }} showProblems />);
    const words = text(markup);
    for (const label of ["Field", "Date you saw it", "What kind of issue", "How bad does it look to you?", "Short title", "What you saw (optional)", "Photos (1 of 4)", "Use my location", "Mark on map", "Save issue"])
      expect(words).toContain(label);
    expect(words).toContain("Choose the field where you saw it.");
    expect(words).toContain("Give the issue a short title.");
    expect(markup).toMatch(/<label for="([^"]+)">Short title<\/label><input id="\1"/);
  });

  it("names the API refusals in plain words", () => {
    expect(describeScoutingError(new ApiError("location_outside_boundary", "x", 400)).kind).toBe("outside");
    expect(describeScoutingError(new ApiError("field_required", "x", 400)).kind).toBe("field");
    expect(describeScoutingError(new ApiError("network_error", "x", 0)).kind).toBe("network");
    expect(issuesPath(FIXTURE_FARM_ID, { fieldId: "north", status: "open" })).toBe(`/api/v1/farms/${FIXTURE_FARM_ID}/issues?fieldId=north&status=open`);
  });
});

describe("issue sheet and responses", () => {
  it("shows marks, location, the events, seen-before lines and the label-wait date", () => {
    const issue = issueFixture();
    const markup = html(() => <IssueSheetBody farmId={FIXTURE_FARM_ID} issue={issue} today={TODAY} fieldName={(id) => FIELDS.find((f) => f.id === id)?.name ?? null} onIssue={noop} />);
    const words = text(markup);
    expect(words).toContain("Seen 28 Oct 2026 · North strip · Maize");
    expect(words).toContain("Location: 13.00050, 76.10050");
    expect(words).toContain("Earliest harvest after the last application: 12 Nov 2026 (from the label you entered)");
    expect(words).toContain("Not checked by the app.");
    expect(words).toContain("Seen before: 10 Oct 2025 on Ragi");
    expect(words).toContain("By hand or with a tool: Picked off the damaged leaves");
    expect(words).toContain("Label wait: 14 days (from the label you entered)");
    expect(markup).toContain("left:25%");
    expect(words).toContain("fresh holes");
    for (const action of ["Change status", "Record what you did", "Add a note"]) expect(words).toContain(action);
    expect(seenBeforeLines({ seenBefore: [{ issueId: issue.id, observedOn: "2026-01-02", cropName: null, status: "open" }] })).toEqual(["Seen before: 2 Jan 2026"]);
  });

  it("the response form carries the label-wait line and defaults the recheck to a week later", () => {
    const markup = html(() => <ResponseForm farmId={FIXTURE_FARM_ID} issue={issueFixture()} today={TODAY} onSaved={noop} onCancel={noop} store={new MemoryStore()} />);
    const words = text(markup);
    expect(LABEL_WAIT_HELP).toBe("Only what you read on the label; the app does not check it.");
    expect(words).toContain("Days before harvest the label says to wait (optional)");
    expect(words).toContain(LABEL_WAIT_HELP);
    expect(words).toContain("Product name as you call it (optional)");
    expect(markup).toContain(`value="${addDaysIso(TODAY, 7)}"`);
    expect(markup).toMatch(/aria-describedby="[^"]*wait-help"/);
  });

  it("validates a response and builds a contract-valid event", () => {
    const base = newResponseDraft(FIXTURE_FARM_ID, FIXTURE_ISSUE_IDS.leaf, "response-0001-abcd", TODAY);
    expect(base.recheckOn).toBe("2026-11-08");
    const ctx = { today: TODAY, observedOn: "2026-10-28" };
    expect(responseProblems(base, ctx)).toEqual(["Choose how you dealt with it.", "Say what you did, in your own words."]);
    const filled = { ...base, method: "product_applied" as const, description: "Sprayed the rows", quantityValue: "2", quantityUnit: "L" as const, labelWaitDays: "21" };
    expect(responseProblems(filled, ctx)).toEqual([]);
    expect(responseProblems({ ...filled, labelWaitDays: "2.5" }, ctx)).toContain("The label wait must be whole days from 0 to 365.");
    expect(responseProblems({ ...filled, recheckOn: "2026-10-30" }, ctx)).toContain("The recheck date cannot be before the date you did it.");
    expect(responseProblems({ ...filled, occurredOn: "2026-10-20" }, ctx).join(" ")).toContain("before the issue was seen");
    const event = AddIssueEvent.parse(responseEvent(filled));
    expect(event.response).toEqual({ method: "product_applied", description: "Sprayed the rows", quantity: { value: 2, unit: "L" }, labelWaitDays: 21, recheckOn: "2026-11-08" });
    expect(event.response).not.toHaveProperty("productName");
    expect(eventProblems("status", { today: TODAY, observedOn: "2026-10-28", occurredOn: TODAY, status: "treating", current: "treating", note: "" })).toEqual(["The issue is already being treated."]);
    expect(AddIssueEvent.parse(statusEvent("event-0001-abcd", TODAY, "resolved", ""))).toMatchObject({ kind: "status_changed", status: "resolved" });
    expect(issueEventsPath(FIXTURE_FARM_ID, FIXTURE_ISSUE_IDS.leaf)).toBe(`/api/v1/farms/${FIXTURE_FARM_ID}/issues/${FIXTURE_ISSUE_IDS.leaf}/events`);
  });
});

describe("photo marks", () => {
  it("stores a tap as normalised coordinates from the top-left; a keyboard press marks the centre", () => {
    const rect = { left: 100, top: 50, width: 400, height: 300 };
    expect(markPosition(rect, 200, 125)).toEqual({ x: 0.25, y: 0.25 });
    expect(markPosition(rect, 600, 10)).toEqual({ x: 1, y: 0 });
    expect(markPosition(rect, 0, 0, true)).toEqual({ x: 0.5, y: 0.5 });
    expect(markPosition(rect, 233.33333, 50)).toEqual({ x: 0.3333, y: 0 });
  });

  it("adds, labels and removes marks, at most twelve across the photos", () => {
    let marks = addMark([], MEDIA[0], 0.1, 0.2);
    marks = addMark(marks, MEDIA[1], 0.3, 0.4);
    marks = labelMark(marks, 1, "eggs");
    expect(marks).toEqual([{ mediaId: MEDIA[0], x: 0.1, y: 0.2 }, { mediaId: MEDIA[1], x: 0.3, y: 0.4, label: "eggs" }]);
    expect(labelMark(marks, 1, " ")[1]).not.toHaveProperty("label");
    expect(marksOn(marks, MEDIA[1])).toEqual([{ mediaId: MEDIA[1], x: 0.3, y: 0.4, label: "eggs", index: 1, number: 2 }]);
    expect(removeMark(marks, 0)).toEqual([{ mediaId: MEDIA[1], x: 0.3, y: 0.4, label: "eggs" }]);
    const full = Array.from({ length: MAX_MARKS }, (_, i) => ({ mediaId: MEDIA[0], x: i / 12, y: 0 }));
    expect(addMark(full, MEDIA[0], 0.5, 0.5)).toHaveLength(MAX_MARKS);
  });

  it("draws editable marks as buttons that remove them, and read-only marks as dots", () => {
    const marks = [{ mediaId: MEDIA[0], x: 0.25, y: 0.5, label: "eggs" }];
    const editable = html(() => <PhotoMarks mediaId={MEDIA[0]} marks={marks} photoNumber={1} editable onChange={noop} />);
    expect(editable).toContain('aria-label="Remove mark 1 (eggs)"');
    expect(editable).toContain("left:25%;top:50%");
    expect(text(editable)).toContain("Mark 1 label (optional)");
    const readOnly = html(() => <PhotoMarks mediaId={MEDIA[0]} marks={marks} photoNumber={1} />);
    expect(readOnly).not.toContain("Remove mark");
    expect(readOnly).toContain('alt="Photo 1, 1 mark"');
  });
});

describe("issue list", () => {
  const issues = [
    issueFixture(),
    issueFixture({ id: FIXTURE_ISSUE_IDS.weeds, category: "weed", status: "open", title: "Weeds between rows", observedOn: "2026-10-30", seenBefore: [] }),
    issueFixture({ id: "9d0e0f10-2222-4ccc-8ddd-000000000077", status: "resolved", title: "Old damage", observedOn: "2026-09-01", fieldId: undefined, scope: "farm", seenBefore: [] }),
  ];
  const view = (filter: "all" | "open") =>
    html(() => (
      <IssuesListView
        issues={issues}
        counts={countsOf(issues)}
        filter={filter}
        onFilter={noop}
        fieldName={(id) => FIELDS.find((f) => f.id === id)?.name ?? null}
        onOpen={noop}
        onNew={noop}
        scope="North strip and farm-wide"
        status="ready"
      />
    ));

  it("filters by status, newest first, with counts on the chips", () => {
    expect(filterIssues(issues, "all").map((i) => i.title)).toEqual(["Weeds between rows", "Holes in young leaves", "Old damage"]);
    expect(filterIssues(issues, "open").map((i) => i.title)).toEqual(["Weeds between rows"]);
    expect(filterCount(countsOf(issues), "all")).toBe(3);
    expect(filterCount(countsOf(issues), "treating")).toBe(1);
    const open = view("open");
    expect(text(open)).toContain("Weeds between rows");
    expect(text(open)).not.toContain("Old damage");
    expect(open).toMatch(/aria-pressed="true" data-filter="open"/);
  });

  it("shows category, severity, date, field, status and the seen-before count on each row", () => {
    const words = text(view("all"));
    expect(words).toContain("Pest Holes in young leaves Medium Being treated 28 Oct 2026 North strip Seen before: 1 time");
    expect(words).toContain("Old damage");
    expect(words).toContain("Whole farm");
    expect(words).toContain("Log an issue");
  });

  it("puts the open count and the latest title under the alerts", () => {
    const block = todayChecksFixture().issues;
    expect(issuesLine(block)).toBe("2 open issues · 1 being treated · Holes in young leaves");
    expect(issuesLine({ open: 0, treating: 0, latest: [] })).toBeNull();
    expect(issuesLine(undefined)).toBeNull();
    expect(text(html(() => <IssuesLine issues={block} onShow={noop} />))).toContain("2 open issues");
    expect(html(() => <IssuesLine issues={undefined} onShow={noop} />)).toBe("");
  });
});

describe("deep link ?issue=", () => {
  it("reads only an issue id and keeps the other parameters when setting or clearing it", () => {
    const id = FIXTURE_ISSUE_IDS.leaf;
    expect(issueFromSearch(`?tab=today&field=north&issue=${id}`)).toBe(id);
    expect(issueFromSearch("?issue=not-an-id")).toBeNull();
    expect(withIssueParam("/farm", "?tab=today&field=north", id)).toBe(`/farm?tab=today&field=north&issue=${id}`);
    expect(withIssueParam("/farm", `?tab=today&issue=${id}`, null)).toBe("/farm?tab=today");
  });

  it("Today opens the issue sheet from the URL at its root, outside the loading states", () => {
    const source = readFileSync(new URL("../today/TodayView.tsx", import.meta.url), "utf8");
    expect(source).toContain("issueFromSearch(location.search)");
    expect(source.lastIndexOf("<IssueSheet")).toBeGreaterThan(source.lastIndexOf("</Switch>"));
  });
});

describe("check interval setting", () => {
  it("accepts whole days 3 to 30, blank for the farm's", () => {
    expect(parseInterval("")).toEqual({ ok: true, days: null });
    expect(parseInterval("10")).toEqual({ ok: true, days: 10 });
    for (const bad of ["2", "31", "7.5", "x"]) expect(parseInterval(bad).ok).toBe(false);
  });

  it("sets or removes a field's own interval and names where the interval comes from", () => {
    const field = { id: "north", name: "North strip", boundary: FIELDS[0]!.boundary };
    expect(withCheckInterval(field, 5)).toMatchObject({ checkIntervalDays: 5 });
    expect(withCheckInterval({ ...field, checkIntervalDays: 5 }, null)).not.toHaveProperty("checkIntervalDays");
    expect(intervalText(field, undefined)).toBe("every 7 days (default)");
    expect(intervalText(field, 10)).toBe("every 10 days (the farm's)");
    expect(intervalText({ ...field, checkIntervalDays: 4 }, 10)).toBe("every 4 days (your setting for this field)");
  });

  it("the Fields panel shows each field's interval and the farm-wide setting when it can be saved", () => {
    const panel = (over: Partial<Parameters<typeof FieldsPanel>[0]> = {}) =>
      text(
        html(() => (
          <FieldsPanel fields={FIELDS} farmBoundary={null} cycles={[]} plans={[]} cropName={(id) => id} saving={false} onSave={async () => undefined} drawing={false} drawn={null} onStartDraw={noop} onEndDraw={noop} todayHref={() => "#"} {...over} />
        )),
      );
    expect(panel()).toContain("Your check interval: every 7 days (default)");
    expect(panel()).not.toContain("Farm check interval");
    expect(panel({ farmCheckIntervalDays: 10, onSaveFarmInterval: async () => undefined })).toContain("Farm check interval (fields without their own): every 10 days");
  });
});
