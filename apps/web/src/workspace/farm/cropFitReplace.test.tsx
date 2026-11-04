import { describe, expect, it, vi } from "vitest";
vi.mock("../ui/Sheet", () => ({
  Sheet: (props: { title: string; subtitle?: unknown; children?: unknown; footer?: unknown }) => (
    <section data-sheet={props.title}>
      {props.subtitle as never}
      {props.children as never}
      {props.footer as never}
    </section>
  ),
}));
import { renderToString } from "solid-js/web";
import { CropFitReview } from "@harvest/contracts";
import type { CropFitCandidate, YearPlanOccupant } from "@harvest/contracts";
import { FIXTURE_SAVED_SEASON_ID, workspaceWithSavedSeason } from "../year/fixtures";
import { PLANNED_PIGEON_PEA } from "../year/alternatives-fixtures";
import { SWAP_CONFLICT, SWAP_MISSING } from "../year/model";
import type { Cycle, Rotation } from "../state";
import { CANDIDATES, REPLACED_SEASON, fixtureCandidate, planReview, rankedWithoutPicksReview, readyModelReview, replaceEmptyReview, replacePassReview } from "./cropFitFixtures";
import { REPLACE_NOT_PLANNED, REPLACE_NOW_SOWN, occupantFromRotation, replacePlannedSeason, resolveReplacement } from "./cropFitReplace";
import { REPLACE_PASS_NOTE, replaceButtonText, replaceConfirmText, replaceConfirmTitle, replacesText } from "./cropFitModel";
import { ReplaceConfirm } from "./ReplaceConfirm";
import { CropFitPickerView } from "./CropFitPicker";
import { CropFitResults } from "./CropFitView";

const text = (html: string) => html.replace(/<!--[^>]*-->/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
const noop = () => undefined;
const TODAY = "2026-11-04";
const plans = workspaceWithSavedSeason.rotationPlans as unknown as Rotation[];
const maize = replacePassReview.candidates.find((c) => c.cropId === "maize")!;
const onion = replacePassReview.candidates.find((c) => c.cropId === "onion")!;

const results = (review: CropFitReview, replace?: Parameters<typeof CropFitResults>[0]["replace"], showAll = false) =>
  renderToString(() => <CropFitResults review={review} showAll={showAll} onToggleAll={noop} onOpen={noop} onRetry={noop} retrying={false} replace={replace} />);
const controls = { onReplace: noop, busy: false, error: "", notice: "" };

describe("replace-pass fixtures", () => {
  it("parse with the shared contract", () => {
    for (const r of [replacePassReview, replaceEmptyReview, rankedWithoutPicksReview]) expect(() => CropFitReview.parse(r)).not.toThrow();
  });
});

describe("what a replace-pass candidate says", () => {
  it("names the season and its planned date, joins several, and says nothing on an ordinary candidate", () => {
    expect(replacesText(maize)).toBe("Replaces Pigeon pea (planned 16 May 2027)");
    expect(replacesText({ replaces: [{ ...REPLACED_SEASON }, { rotationPlanId: "b", cropId: "onion", cropName: "Onion", plannedSowingDate: null }] })).toBe(
      "Replaces Pigeon pea (planned 16 May 2027) and Onion",
    );
    expect(replacesText(onion)).toBeNull();
    expect(replacesText({ replaces: [] })).toBeNull();
    expect(replaceButtonText(maize)).toBe("Replace with Maize");
  });
});

describe("crop fit results on a replace pass", () => {
  it("shows the one-line note, the chip and the Replace button on each pick that replaces a season", () => {
    const html = results(replacePassReview, controls);
    const t = text(html);
    expect(t).toContain(REPLACE_PASS_NOTE);
    expect((t.match(/Replaces Pigeon pea \(planned 16 May 2027\)/g) ?? []).length).toBe(2); // Maize and Sorghum cards
    expect(t).toContain("Replace with Maize");
    expect(t).toContain("Replace with Sorghum");
    expect(t).not.toContain("Replace with Onion"); // no `replaces` on Onion
    expect(t).not.toContain("No crop fits this sowing date");
  });
  it("shows the chip in the ranked list too, without a button inside a row that already opens the detail", () => {
    const t = text(results(replacePassReview, controls, true));
    expect((t.match(/Replaces Pigeon pea/g) ?? []).length).toBe(4); // two cards and two rows
    expect((t.match(/Replace with Maize/g) ?? []).length).toBe(1);
  });
  it("shows no Replace button when no handler is given", () => {
    expect(text(results(replacePassReview))).not.toContain("Replace with");
    expect(text(results(replacePassReview))).toContain("Replaces Pigeon pea");
  });
  it("disables the buttons while a replace is saved and shows the refusal and the notice", () => {
    const busy = results(replacePassReview, { ...controls, busy: true });
    expect(busy).toMatch(/<button[^>]*disabled[^>]*>\s*Replacing/);
    const refused = results(replacePassReview, { ...controls, error: "The sowing date 20 May 2027 has passed; pick a crop that can still be sown." });
    expect(refused).toContain('role="alert"');
    expect(text(refused)).toContain("has passed");
    expect(text(results(replacePassReview, { ...controls, notice: "Replaced Pigeon pea with Maize in your saved seasons." }))).toContain("Replaced Pigeon pea with Maize");
  });
  it("leaves the old states unchanged when the new fields are absent", () => {
    const html = results(readyModelReview, controls);
    const t = text(html);
    expect(t).not.toContain(REPLACE_PASS_NOTE);
    expect(t).not.toContain("Replaces ");
    expect(t).not.toContain("Replace with");
    expect(t).toContain("Same candidates, dates and scoring as the year plan");
    expect(t).toContain("See all 5 crops");
    expect(CANDIDATES.some((c) => c.replaces)).toBe(false);
  });
});

describe("empty state", () => {
  it("shows only when no candidate was ranked at all, with the server's summary", () => {
    const t = text(results(replaceEmptyReview, controls));
    expect(t).toContain("No crop fits this sowing date");
    expect(t).toContain(replaceEmptyReview.summary);
    expect(t).not.toContain("See all");
  });
  it("is not claimed when crops were ranked but no pick was chosen", () => {
    const t = text(results(rankedWithoutPicksReview, controls));
    expect(t).not.toContain("No crop fits this sowing date");
    expect(t).toContain("No top picks were chosen for this date");
    expect(t).toContain("See all 5 crops");
  });
});

describe("picker rows", () => {
  it("show the Replaces chip on a candidate that replaces a season, and keep 'Use this crop' as the only action", () => {
    const html = renderToString(() => (
      <CropFitPickerView sowing="2027-05-20" after="paddy" review={{ ...planReview, candidates: replacePassReview.candidates, picks: replacePassReview.picks, replacePass: true }} failure={undefined} current={null} retrying={false} onPick={noop} onKeep={noop} onRetry={noop} onClose={noop} />
    ));
    const t = text(html);
    expect(t).toContain("Replaces Pigeon pea (planned 16 May 2027)");
    expect(t).toContain("Use this crop");
    expect(t).not.toContain("Replace with");
    expect(text(renderToString(() => <CropFitPickerView sowing="2027-05-16" after="paddy" review={planReview} failure={undefined} current={null} retrying={false} onPick={noop} onKeep={noop} onRetry={noop} onClose={noop} />))).not.toContain("Replaces ");
  });
});

describe("resolving the season a candidate replaces", () => {
  it("builds a minimal saved-season occupant from the workspace's rotation plan when the review carries none", () => {
    const resolved = resolveReplacement({ candidate: maize, rotationPlans: plans });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.occupant).toMatchObject({ id: FIXTURE_SAVED_SEASON_ID, source: "saved_season", cropId: "pigeon-pea", productId: "pigeon-pea-whole", sowing: "2027-05-16", harvestDate: "2027-08-29", realisation: "planned" });
    expect(resolved.occupant.occupancy).toEqual({ from: "2027-05-16", to: "2027-09-08" }); // harvest plus the ten-day preparation gap
  });
  it("takes the occupant from the year plan's occupants when they are given", () => {
    const given: YearPlanOccupant = { ...PLANNED_PIGEON_PEA, note: "from the year plan" };
    const resolved = resolveReplacement({ candidate: maize, rotationPlans: plans, occupants: [given] });
    expect(resolved.ok && resolved.occupant.note).toBe("from the year plan");
  });
  it("refuses a candidate with no planned season, a season no longer on the field and a season without a sowing date", () => {
    expect(resolveReplacement({ candidate: onion, rotationPlans: plans })).toEqual({ ok: false, message: REPLACE_NOT_PLANNED });
    expect(resolveReplacement({ candidate: maize, rotationPlans: [] })).toEqual({ ok: false, message: SWAP_MISSING });
    const undated = plans.map(({ plannedSowingDate: _dropped, ...rest }) => rest);
    expect(occupantFromRotation(undated[0]!)).toBeNull();
    const r = resolveReplacement({ candidate: maize, rotationPlans: undated });
    expect(r.ok).toBe(false);
  });
});

describe("Replace with <crop>", () => {
  const run = (over: Partial<Parameters<typeof replacePlannedSeason>[0]> = {}) => {
    const order: string[] = [];
    const save = vi.fn(async (_patch: { rotationPlans: Rotation[] }) => {
      order.push("save");
    });
    const refresh = vi.fn(async () => {
      order.push("refresh");
    });
    const reload = vi.fn(() => {
      order.push("reload");
    });
    const args = { candidate: maize, rotationPlans: plans, cycles: [] as Cycle[], todayIso: TODAY, save, refresh, reload, ...over };
    return { order, save, refresh, reload, done: replacePlannedSeason(args) };
  };

  it("swaps the planned season for the candidate (same id, new crop and dates), then refreshes the workspace and reloads the review, in that order", async () => {
    const { order, save, refresh, reload, done } = run();
    const outcome = await done;
    expect(outcome).toEqual({ kind: "replaced", from: "Pigeon pea", to: "Maize" });
    expect(order).toEqual(["save", "refresh", "reload"]);
    expect(save).toHaveBeenCalledTimes(1);
    const saved = save.mock.calls[0]![0].rotationPlans;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ id: FIXTURE_SAVED_SEASON_ID, cropId: "maize", productId: "maize-grain", plannedSowingDate: "2027-05-20", plannedHarvestDate: "2027-09-25" });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("changes nothing and says why when the sowing date has passed", async () => {
    const past: CropFitCandidate = fixtureCandidate({ ...maize, sowing: "2026-10-01", harvest: { earliest: "2027-01-01", latest: "2027-01-15" }, occupancy: undefined });
    const { save, refresh, reload, done } = run({ candidate: { ...past, replaces: [{ ...REPLACED_SEASON }] } });
    const outcome = await done;
    expect(outcome).toMatchObject({ kind: "refused" });
    expect((outcome as { message: string }).message).toContain("has passed");
    expect(save).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("refuses a candidate that also overlaps another saved season of the field, naming it", async () => {
    const other: Rotation = { id: "other-season", year: 2027, season: "Kharif", cropId: "onion", cropName: "Onion", plannedSowingDate: "2027-07-01", plannedHarvestDate: "2027-10-20", fieldId: "f1" };
    const { save, done } = run({ rotationPlans: [...plans, other], fieldId: "f1" });
    const outcome = await done;
    expect(outcome).toMatchObject({ kind: "refused" });
    expect((outcome as { message: string }).message).toContain("would overlap Onion");
    expect(save).not.toHaveBeenCalled();
  });

  it("ignores another field's season in the overlap check", async () => {
    const other: Rotation = { id: "other-season", year: 2027, season: "Kharif", cropId: "onion", cropName: "Onion", plannedSowingDate: "2027-07-01", plannedHarvestDate: "2027-10-20", fieldId: "f2" };
    const { save, done } = run({ rotationPlans: [...plans, other], fieldId: "f1" });
    expect(await done).toMatchObject({ kind: "replaced" });
    expect(save.mock.calls[0]![0].rotationPlans.find((p) => p.id === "other-season")).toBe(other);
  });

  it("refuses without saving when the saved season is gone", async () => {
    const { save, done } = run({ rotationPlans: [] });
    expect(await done).toEqual({ kind: "refused", message: SWAP_MISSING });
    expect(save).not.toHaveBeenCalled();
  });

  it("does not refresh or reload when the save fails, and reports a version conflict plainly", async () => {
    const save = vi.fn(async () => {
      throw Object.assign(new Error("conflict"), { status: 409 });
    });
    const refresh = vi.fn();
    const reload = vi.fn();
    const outcome = await replacePlannedSeason({ candidate: maize, rotationPlans: plans, cycles: [], todayIso: TODAY, save, refresh, reload });
    expect(outcome).toEqual({ kind: "failed", message: SWAP_CONFLICT });
    expect(refresh).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("does nothing for a candidate that is already what the season is", async () => {
    const same: CropFitCandidate = { ...maize, cropId: "pigeon-pea", productId: "pigeon-pea-whole", cropName: "Pigeon pea", sowing: "2027-05-16" };
    const { save, done } = run({ candidate: same });
    expect(await done).toEqual({ kind: "unchanged" });
    expect(save).not.toHaveBeenCalled();
  });
});

describe("Replace with <crop> re-checks the season when it writes (review finding 2)", () => {
  const sownCycle: Cycle = { id: "c-maize", cropId: "pigeon-pea", sowingDate: "2027-05-18", stage: "sowed", fieldId: "f1" };
  const base = { candidate: maize, rotationPlans: plans, todayIso: TODAY, fieldId: "f1" };
  it("refuses a season a recorded cycle has realised since the ranking was made, and saves nothing", async () => {
    const save = vi.fn();
    const refresh = vi.fn();
    const outcome = await replacePlannedSeason({ ...base, cycles: [sownCycle], save, refresh, reload: vi.fn() });
    expect(outcome).toEqual({ kind: "refused", message: REPLACE_NOW_SOWN });
    expect(save).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
  it("a cycle of the same crop on another field does not realise this field's season", async () => {
    const save = vi.fn(async () => undefined);
    const outcome = await replacePlannedSeason({ ...base, cycles: [{ ...sownCycle, fieldId: "f2" }], save, refresh: vi.fn(), reload: vi.fn() });
    expect(outcome.kind).toBe("replaced");
    expect(save).toHaveBeenCalledTimes(1);
  });
  it("builds the occupant with the realisation it finds: an overdue season is overdue, not planned", async () => {
    const overdue = plans.map((p) => ({ ...p, plannedSowingDate: "2026-09-01", plannedHarvestDate: "2026-12-01" }));
    const save = vi.fn(async (_p: { rotationPlans: Rotation[] }) => undefined);
    const outcome = await replacePlannedSeason({ ...base, rotationPlans: overdue, candidate: { ...maize, sowing: "2026-11-10", harvest: { earliest: "2027-03-01", latest: "2027-03-20" }, occupancy: undefined }, cycles: [], save, refresh: vi.fn(), reload: vi.fn() });
    expect(outcome.kind).toBe("replaced");
  });
});

describe("the confirm step and the same-crop wording", () => {
  const sameMaize: CropFitCandidate = { ...maize, sowing: "2027-02-12", replaces: [{ rotationPlanId: "r1", cropId: "maize", cropName: "Maize", plannedSowingDate: "2027-02-05" }] };
  it("writes out old crop (planned date) to new crop, sow date and harvest window", () => {
    expect(replaceConfirmText(maize)).toBe("Pigeon pea (planned 16 May 2027) → Maize, sow 20 May 2027, harvest 10 Sep 2027 – 25 Sep 2027");
    expect(replaceConfirmTitle(maize)).toBe("Replace with Maize?");
  });
  it("the sheet shows that line with Confirm and Cancel, and the refusal when there is one", () => {
    const html = renderToString(() => <ReplaceConfirm candidate={maize} busy={false} error="That planned season has been sown since this ranking was made, so it cannot be replaced." onConfirm={noop} onClose={noop} />);
    const t = text(html);
    expect(t).toContain("Pigeon pea (planned 16 May 2027) → Maize, sow 20 May 2027");
    expect(t).toContain("Confirm");
    expect(t).toContain("Cancel");
    expect(t).toContain("has been sown since");
  });
  it("says it moves the sowing when the candidate is the crop it replaces", () => {
    expect(replacesText(sameMaize)).toBe("Same crop: moves the sowing from 5 Feb to 12 Feb 2027");
    expect(replaceButtonText(sameMaize)).toBe("Move Maize to 12 Feb");
    expect(replaceConfirmTitle(sameMaize)).toBe("Move Maize to 12 Feb?");
    // A different crop, or two seasons replaced at once, keeps the ordinary wording.
    expect(replaceButtonText(maize)).toBe("Replace with Maize");
    expect(replacesText({ ...sameMaize, replaces: [...sameMaize.replaces!, { ...REPLACED_SEASON }] })).toContain("Replaces Maize (planned 5 Feb 2027) and Pigeon pea");
  });
  it("the card chip and button use it", () => {
    const review = { ...replacePassReview, candidates: [sameMaize, ...replacePassReview.candidates.slice(1)], picks: replacePassReview.picks };
    const t = text(results(review, controls));
    expect(t).toContain("Same crop: moves the sowing from 5 Feb to 12 Feb 2027");
    expect(t).toContain("Move Maize to 12 Feb");
  });
});
