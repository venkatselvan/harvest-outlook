import { describe, expect, it, vi } from "vitest";
import { renderToString } from "solid-js/web";
import { ApplyYearPlan, ApplyYearPlanResult, YearPlanReview } from "@harvest/contracts";

// The sheet frame renders in a portal, which server rendering skips; show its parts inline so the sheet can be read.
vi.mock("../ui/Sheet", () => ({
  Sheet: (props: { title: string; subtitle?: unknown; children?: unknown; footer?: unknown }) => (
    <section data-sheet={props.title}>
      {props.subtitle as never}
      {props.children as never}
      {props.footer as never}
    </section>
  ),
}));
vi.mock("../farm/CropFitPicker", () => ({ CropFitPicker: () => <p>picker</p> }));

import { FIXTURE_FARM_ID, FIXTURE_SAVED_SEASON_ID, fullYearReview, savedSeasonOccupant, workspaceWithSavedSeason } from "./fixtures";
import {
  ALT_BLACK_GRAM,
  ALT_MAIZE,
  CMP_OPTION,
  COMPARISON_ALTERNATIVES,
  OVERDUE_MAIZE,
  PLANNED_PIGEON_PEA,
  REPLACE_ALTERNATIVES,
  SOWN_COTTON,
  comparisonReview,
  replaceReview,
} from "./alternatives-fixtures";
import { AlternativesSection } from "./AlternativesSection";
import { ApplyConfirm } from "./ApplyConfirm";
import { OccupantDetail, OptionSheet } from "./OptionSheet";
import { PlanCalendar, occupantLabel } from "./PlanCalendar";
import { ScenarioLine } from "./ScenarioLine";
import {
  alternativeBasisText,
  alternativeOccupants,
  alternativesChip,
  applyBody,
  joinNames,
  realisationTag,
  replacedByOption,
  selectionStatus,
  slotProfitLine,
  useInsteadText,
} from "./model";
import { apply } from "./yearPlanApi";

const plain = (html: string) =>
  html
    .replace(/<!--[^>]*-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

const section = (review: typeof replaceReview) =>
  renderToString(() => (
    <AlternativesSection
      alternatives={review.alternatives!}
      occupied={review.scenario.occupied ?? []}
      appliedOptionIds={review.appliedOptionIds}
      growingCropName="Paddy"
      onOpen={() => {}}
      onUse={() => {}}
    />
  ));
const scenario = (review: typeof replaceReview) =>
  renderToString(() => (
    <ScenarioLine
      text="Sep 2026 to Sep 2027 · Paddy growing until mid-Mar"
      pending={false}
      model={null}
      stale={false}
      selection={selectionStatus(review)}
      refreshing={false}
      onRefresh={() => {}}
    />
  ));

describe("alternatives fixtures", () => {
  it("parse with the shared contract", () => {
    for (const r of [replaceReview, comparisonReview]) expect(() => YearPlanReview.parse(r)).not.toThrow();
    expect(replaceReview.alternatives!.options.map((o) => o.optionId)).toEqual(["alt-1", "alt-2"]);
    // Option ids of the alternatives never collide with the review's own.
    for (const o of replaceReview.alternatives!.options) expect(replaceReview.options.map((x) => x.optionId)).not.toContain(o.optionId);
  });
});

describe("status chip", () => {
  it("says the planned seasons fill the year, with the alternative count, and uses the server's summary as the line", () => {
    const status = selectionStatus(replaceReview)!;
    expect(status.chip).toBe("Planned seasons fill the year · 2 alternatives");
    expect(status.line).toBe(REPLACE_ALTERNATIVES.summary);
    const html = plain(scenario(replaceReview));
    expect(html).toContain("Planned seasons fill the year · 2 alternatives");
    expect(html).not.toContain("No space for another crop");
  });
  it("says Sown with the number of comparison plans, singular for one", () => {
    expect(selectionStatus(comparisonReview)!.chip).toBe("Sown · 1 comparison plan");
    expect(alternativesChip({ basis: "sown_comparison", options: [CMP_OPTION, CMP_OPTION] })).toBe("Sown · 2 comparison plans");
    expect(alternativesChip({ basis: "replace_planned", options: [ALT_MAIZE] })).toBe("Planned seasons fill the year · 1 alternative");
  });
  it("keeps the old text and line when alternatives are absent, null or empty", () => {
    for (const alternatives of [undefined, null, { ...REPLACE_ALTERNATIVES, options: [] }]) {
      const review = { ...fullYearReview, ...(alternatives === undefined ? {} : { alternatives }) };
      const status = selectionStatus(review)!;
      expect(status.chip).toBe("No space for another crop");
      expect(status.line).toContain("Your saved seasons fill the months after the growing crop, so no new crop fits.");
    }
  });
});

describe("Alternatives section", () => {
  it("shows one card per option with the basis chip, crops, dates, profit for the field and a use button (replace_planned)", () => {
    const text = plain(section(replaceReview));
    expect(text).toContain("Alternatives");
    expect(text).toContain("Maize in kharif");
    expect(text).toContain("Black gram in kharif");
    expect(text).toContain("Instead of Pigeon pea");
    expect(text).toContain("Sow 20 May 2027");
    expect(text).toContain("for your field");
    expect(text).toContain("Use instead of Pigeon pea");
    expect((section(replaceReview).match(/Use instead of Pigeon pea/g) ?? []).length).toBe(2);
    expect(text).toContain("growing now");
  });
  it("is for comparison only on a sown_comparison card: the chip names the growing crop and there is no use button", () => {
    const html = section(comparisonReview);
    const text = plain(html);
    expect(text).toContain("For comparison only, Paddy stays");
    expect(text).not.toContain("Use instead of");
    expect(text).toContain("See details");
    expect(text).toContain("What could have fitted this field");
  });
  it("disables the button of an alternative already applied", () => {
    const html = renderToString(() => (
      <AlternativesSection alternatives={REPLACE_ALTERNATIVES} occupied={[PLANNED_PIGEON_PEA]} appliedOptionIds={["alt-1"]} onOpen={() => {}} onUse={() => {}} />
    ));
    expect(plain(html)).toContain("Already in saved seasons");
    expect(plain(html)).toContain("Use instead of Pigeon pea");
  });
  it("renders nothing for an alternatives block without options", () => {
    const html = renderToString(() => (
      <AlternativesSection alternatives={{ ...REPLACE_ALTERNATIVES, options: [] }} occupied={[]} appliedOptionIds={[]} onOpen={() => {}} onUse={() => {}} />
    ));
    expect(plain(html)).toBe("");
  });
});

describe("which planned seasons an alternative takes over", () => {
  const two = {
    ...REPLACE_ALTERNATIVES,
    replaces: [...REPLACE_ALTERNATIVES.replaces, { rotationPlanId: "season-overdue-maize", cropId: "maize", cropName: "Maize", plannedSowingDate: "2026-10-20" }],
  };
  const occupied = [PLANNED_PIGEON_PEA, OVERDUE_MAIZE];
  it("names only the seasons a suggested slot overlaps, and falls back to all when the occupants do not say", () => {
    expect(replacedByOption(two, ALT_MAIZE, occupied).map((r) => r.cropName)).toEqual(["Pigeon pea"]);
    expect(replacedByOption(two, ALT_MAIZE, undefined).map((r) => r.cropName)).toEqual(["Pigeon pea", "Maize"]);
    expect(alternativeBasisText(two, ALT_MAIZE, occupied)).toBe("Instead of Pigeon pea");
    expect(useInsteadText(replacedByOption(two, ALT_MAIZE, undefined))).toBe("Use instead of Pigeon pea and Maize");
    expect(replacedByOption(COMPARISON_ALTERNATIVES, CMP_OPTION, [SOWN_COTTON])).toEqual([]);
  });
  it("takes over no planned season when no suggested slot overlaps any of them (the server removes only overlapped seasons)", () => {
    const away = { ...ALT_MAIZE, slots: ALT_MAIZE.slots.map((sl) => (sl.fixed ? sl : { ...sl, occupancy: { from: "2030-01-01", to: "2030-06-01" } })) };
    expect(replacedByOption(two, away, occupied)).toEqual([]);
    expect(alternativeOccupants(two, away, occupied).map((o) => o.id)).toEqual(occupied.map((o) => o.id));
    expect(alternativeBasisText(two, away, occupied)).toBe("Fits beside your planned seasons");
  });
  it("draws an alternative against the seasons it leaves in place only", () => {
    expect(alternativeOccupants(two, ALT_MAIZE, occupied).map((o) => o.id)).toEqual(["season-overdue-maize"]);
    expect(alternativeOccupants(COMPARISON_ALTERNATIVES, CMP_OPTION, [SOWN_COTTON])).toEqual([]);
  });
  it("joins names plainly", () => {
    expect(joinNames(["A"])).toBe("A");
    expect(joinNames(["A", "B", "A", "C"])).toBe("A, B and C");
    expect(joinNames([])).toBe("");
  });
  it("gives a slot's profit for the field, else per hectare, else says it is not shown", () => {
    const slot = ALT_MAIZE.slots[1]!;
    expect(slotProfitLine(slot)).toMatch(/for your field$/);
    expect(slotProfitLine({ ...slot, profitForField: null })).toMatch(/per hectare$/);
    expect(slotProfitLine({ ...slot, profitForField: null, profitEstimate: null })).toBe("Profit not shown");
    expect(slotProfitLine(ALT_MAIZE.slots[0]!)).toBe("Already growing");
  });
});

describe("apply request", () => {
  const base = { workspaceVersion: 4 };
  it("sends alternative: true for a replace_planned option and never for the review's own or a comparison option", () => {
    const alt = applyBody({ review: replaceReview, option: ALT_MAIZE, ...base })!;
    expect(alt).toEqual({
      reviewId: replaceReview.reviewId,
      optionId: "alt-1",
      slotIds: ["alt-1-maize"], // the growing crop is not added again
      expectedWorkspaceVersion: 4,
      alternative: true,
    });
    expect(() => ApplyYearPlan.parse(alt)).not.toThrow();
    const own = applyBody({ review: replaceReview, option: replaceReview.options[0]!, ...base })!;
    expect("alternative" in own).toBe(false);
    expect(applyBody({ review: comparisonReview, option: CMP_OPTION, ...base })).toBeNull();
    expect(applyBody({ review: { ...replaceReview, reviewId: null }, option: ALT_MAIZE, ...base })).toBeNull();
  });
  it("posts the flag in the body of POST /year-plan/apply", async () => {
    const bodies: unknown[] = [];
    const envelope = (data: unknown) =>
      new Response(JSON.stringify({ requestId: "t", mode: "synthetic", asOf: "2026-11-04T00:00:00Z", data, warnings: [], error: null }), { status: 200, headers: { "content-type": "application/json" } });
    const result = {
      workspace: { ...workspaceWithSavedSeason, version: 5, rotationPlans: [] },
      review: { ...replaceReview, appliedOptionIds: ["alt-1"] },
    };
    expect(() => ApplyYearPlanResult.parse(result)).not.toThrow();
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/session") return envelope({ authenticated: true, csrfToken: "test" });
      if (url.endsWith("/year-plan/apply")) bodies.push(JSON.parse(String(init?.body)));
      return envelope(result);
    }) as typeof fetch;
    const body = applyBody({ review: replaceReview, option: ALT_MAIZE, workspaceVersion: 4 })!;
    await apply(FIXTURE_FARM_ID, body, { fetchImpl, idempotencyKey: "k1" });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ optionId: "alt-1", alternative: true, expectedWorkspaceVersion: 4 });
  });
});

describe("planned, not sown tags", () => {
  it("tags planned and overdue seasons and leaves a sown one and an older row without realisation untagged", () => {
    expect(realisationTag(PLANNED_PIGEON_PEA)).toBe("Planned, not sown");
    expect(realisationTag(OVERDUE_MAIZE)).toBe("Overdue, not sown");
    expect(realisationTag(SOWN_COTTON)).toBeNull();
    expect(realisationTag(savedSeasonOccupant)).toBeNull();
  });
  const calendar = (occupied: typeof replaceReview.scenario.occupied) =>
    plain(
      renderToString(() => (
        <PlanCalendar horizonFrom="2026-09-01" todayIso="2026-11-04" options={[]} appliedOptionIds={[]} occupied={occupied ?? []} onOpen={() => {}} />
      )),
    );
  it("draws the tag on the strip in place of 'Saved season'", () => {
    expect(calendar([PLANNED_PIGEON_PEA])).toContain("Planned, not sown ·");
    expect(calendar([OVERDUE_MAIZE])).toContain("Overdue, not sown ·");
    const sown = calendar([SOWN_COTTON]);
    expect(sown).not.toContain("not sown");
    expect(sown).toContain("Saved season ·");
    expect(calendar([savedSeasonOccupant])).toContain("Saved season ·");
  });
  it("starts the strip's accessible name with the visible words", () => {
    expect(occupantLabel(PLANNED_PIGEON_PEA)).toMatch(/^Pigeon pea, planned, not sown, saved season,/);
    expect(occupantLabel(SOWN_COTTON)).toMatch(/^Cotton, saved season,/);
  });
  it("shows the tag as a chip on the saved season's detail", () => {
    const html = plain(renderToString(() => <OccupantDetail occupant={OVERDUE_MAIZE} />));
    expect(html).toContain("Overdue, not sown");
    expect(plain(renderToString(() => <OccupantDetail occupant={SOWN_COTTON} />))).not.toContain("not sown");
  });
});

describe("option sheet in alternative mode", () => {
  const sheet = (review: typeof replaceReview, optionId: string, kind: "replace" | "comparison", applied = false) => {
    const alt = review.alternatives!;
    const option = alt.options.find((o) => o.optionId === optionId)!;
    return plain(
      renderToString(() => (
        <OptionSheet
          farmId={FIXTURE_FARM_ID}
          review={review}
          option={option}
          alternative={{ kind, replaces: replacedByOption(alt, option, review.scenario.occupied), occupied: alternativeOccupants(alt, option, review.scenario.occupied) }}
          slotId={null}
          occupantId={null}
          applied={applied}
          editing={false}
          choices={[]}
          rescoreBusy={false}
          rescoreError=""
          trend={() => undefined}
          onSelectSlot={() => {}}
          onSelectOccupant={() => {}}
          onSwapOccupant={() => {}}
          onSwapReset={() => {}}
          swapBusy={false}
          swapError=""
          onEdit={() => {}}
          onCancelEdit={() => {}}
          onRescore={() => {}}
          onUse={() => {}}
          onClose={() => {}}
        />
      )),
    );
  };
  it("offers no edit and no swap, and the footer says what the plan is used instead of", () => {
    const text = sheet(replaceReview, "alt-1", "replace");
    expect(text).toContain("Use instead of Pigeon pea");
    expect(text).toContain("Alternative to your planned seasons");
    expect(text).not.toMatch(/\bEdit\b/);
    expect(text).not.toContain("Swap crop");
    expect(text).not.toContain("Use this plan");
    expect(sheet(replaceReview, "alt-1", "replace", true)).toContain("Already in saved seasons");
  });
  it("has no use button on a comparison plan", () => {
    const text = sheet(comparisonReview, "alt-1", "comparison");
    expect(text).toContain("For comparison only");
    expect(text).not.toContain("Use instead");
    expect(text).not.toContain("Use this plan");
    expect(text).not.toContain("Swap crop");
  });
});

describe("apply confirmation for an alternative", () => {
  const confirm = (replaces: typeof REPLACE_ALTERNATIVES.replaces | undefined, added: number | null = null) => {
    const html = renderToString(() => (
      <ApplyConfirm option={ALT_BLACK_GRAM} applied={false} busy={false} error="" added={added} replaces={replaces} onConfirm={() => {}} onClose={() => {}} />
    ));
    // The mocked sheet frame keeps the title in an attribute.
    return `${/data-sheet="([^"]*)"/.exec(html)?.[1] ?? ""} ${plain(html)}`;
  };
  it("names the planned season that is removed in the same write", () => {
    const text = confirm(REPLACE_ALTERNATIVES.replaces);
    expect(text).toContain("Use these seasons instead?");
    expect(text).toContain("Removed: Pigeon pea (planned 16 May 2027)");
    expect(text).toContain("Replace with 1 season");
    expect(confirm(REPLACE_ALTERNATIVES.replaces, 1)).toContain("Removed: Pigeon pea.");
  });
  it("says no planned season is removed when the option overlaps none", () => {
    const html = renderToString(() => (
      <ApplyConfirm option={ALT_BLACK_GRAM} alternative applied={false} busy={false} error="" added={null} replaces={[]} onConfirm={() => {}} onClose={() => {}} />
    ));
    const text = plain(html);
    expect(text).toContain("No planned season is removed");
    expect(text).not.toContain("Removed:");
    expect(text).toContain("Add 1 season");
  });
  it("is unchanged for the review's own plans", () => {
    const text = confirm(undefined);
    expect(text).toContain("Add these seasons?");
    expect(text).toContain("Add 1 season");
    expect(text).not.toContain("Removed");
  });
});
