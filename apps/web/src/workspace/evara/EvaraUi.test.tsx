import { describe, expect, it, vi } from "vitest";
import { renderToString } from "solid-js/web";
import { EvaraUi as evaraUiSchema, type EvaraAction, type EvaraNode } from "@harvest/contracts";
import { ctxStub, evaraTreeFixture, journeyWith } from "./fixtures";
import { stageNotice, stageViews, journeyNotice, predictControl } from "./GrowthJourney";

// The schematic is a canvas that needs a browser; the strip only has to place one per illustrated stage.
vi.mock("../FieldGrowthScene", () => ({ FieldGrowthScene: (p: { cropId?: string; progress?: number }) => <div data-scene={p.cropId} data-progress={p.progress?.toFixed(2)} /> }));
const { EvaraUiView, hasProse, slotHarvestText, walkNodes, withOverrides } = await import("./EvaraUi");

/** SSR output without the hydration comment markers between text nodes and the hydration keys on elements. */
const strip = (html: string) => html.replace(/<!--[^>]*-->/g, "").replace(/ data-hk="[^"]*"/g, "");
const render = (ui = evaraTreeFixture(), over?: Parameters<typeof ctxStub>[0]) => strip(renderToString(() => <EvaraUiView ui={ui} ctx={ctxStub(over).ctx} />));

describe("the fixture tree", () => {
  it("is a valid EvaraUi (the kit renders what the server contract allows) and holds every node type", () => {
    const ui = evaraTreeFixture();
    expect(evaraUiSchema.safeParse(ui).success).toBe(true);
    const types = new Set<string>();
    walkNodes(ui.root, (n) => types.add(n.type));
    expect([...types].sort()).toEqual(["actions", "callout", "choice", "crop_compare", "farm_snapshot", "growth_journey", "plan_options", "stack", "text"]);
  });
});

describe("EvaraUiView renders every node type", () => {
  const html = render();
  it("text keeps paragraph breaks and its kind; a warning says Warning to screen readers, not by colour alone", () => {
    expect(html).toContain('class="ev-text kind-text"');
    expect(html).toContain("Three crops could follow it.");
    expect(html).toMatch(/kind-warning[^>]*>.*Warning: .*Pigeon pea is planned but not sown\./);
    expect(html).toContain("kind-limitation");
  });
  it("callout and snapshot show their code-filled values, and skip a null value instead of printing it", () => {
    expect(html).toContain("Ranked as replacements for Pigeon pea.");
    expect(html).toContain("Hassan field A");
    expect(html).toContain("Drain the field · 6 to 9 Nov");
    expect(html).toContain("Open alerts");
    const sparse = render({ version: "1", origin: "fallback", dropped: [], root: { type: "farm_snapshot", fieldName: null, crop: null, stage: null, dayOfSeason: null, rainNext7Days: null, nextAction: null, nextActionWindow: null, openAlerts: 0 } });
    expect(sparse).not.toContain("null");
    expect(sparse).toContain("Open alerts");
  });
  it("crop compare is a real table: scoped headers, a sticky first column per row, a keyboard-reachable scroll region, unknown cells as a dash with the reason", () => {
    expect(html).toContain("<table");
    expect((html.match(/<th scope="col"/g) ?? []).length).toBe(8); // the Crop column and the seven data columns
    expect(html).toMatch(/role="region"[^>]*tabindex="0"|tabindex="0"[^>]*role="region"/);
    expect((html.match(/<th scope="row" class="ev-sticky">/g) ?? []).length).toBe(2);
    expect(html).toContain("Fresh rhizome");
    expect(html).toContain("Typical rain covers about half");
    // The turmeric row has no cells beyond fit and sowing: the rest read as a dash, never as empty or "undefined".
    expect(html).toContain('<span class="ev-cell-empty">—</span>');
    expect(html).not.toContain("undefined");
    // Tone is a word as well as a colour.
    expect(html).toContain("Good: ");
    expect(html).toContain("Short: ");
  });
  it("each compare row has its own action strip spanning the table, named for the crop", () => {
    expect((html.match(/class="ev-row-actions"/g) ?? []).length).toBe(2);
    expect(html).toContain('colspan="8"');
    expect(html).toContain("Actions for Ginger");
    expect(html).toContain("Plan Ginger");
    expect(html).toContain("See how it could grow");
    expect(html).toContain("Plan Turmeric");
  });
  it("plan options show chips, every slot with its dates and profit, the replaced season and the action", () => {
    expect(html).toContain("Alternatives");
    expect(html).toContain("Replaces a planned season");
    expect(html).toContain("12 Feb 2027");
    expect(html).toContain("INR 1.2 lakh");
    expect(html).toContain("Replaces: Pigeon pea");
    expect(html).toContain("green manure");
    expect(html).toContain("Use instead of Pigeon pea");
  });
  it("growth journey shows the stage strip with a schematic per illustrated stage and the predict button", () => {
    expect(html).toContain("How Ginger could grow");
    expect(html).toContain("Establishment");
    expect(html).toContain("Rhizome bulking");
    expect(html).toContain('data-scene="ginger"');
    expect(html).toContain("Predict how it could look on this field");
    // Nothing claims an image exists before the farmer asks for one.
    expect(html).not.toContain("<img");
  });
  it("choice and actions render buttons the farmer can reach: a labelled group, type=button, one per action", () => {
    expect(html).toContain("Which crop should I put in the plan?");
    expect(html).toMatch(/role="group" aria-labelledby=/);
    expect(html).toContain("Add Ginger for 12 Feb 2027");
    expect(html).toContain("Replace Pigeon pea with Ginger");
    expect(html).toContain("Compare these crops");
    expect(html).toContain("Open the plan");
    const buttons = html.match(/<button/g) ?? [];
    const typed = html.match(/<button type="button"/g) ?? [];
    expect(typed.length).toBe(buttons.length);
  });
  it("keeps the tree's reading order: sentences, then data, then the choices", () => {
    const order = ["Your standing paddy", "Hassan field A", "<table", "Alternative A", "How Ginger could grow", "Which crop should I put in the plan?", "Compare these crops"].map((needle) => html.indexOf(needle));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe("tree helpers", () => {
  it("hasProse tells the panel whether to add the plain answer text: a tree of data nodes only has none", () => {
    expect(hasProse(evaraTreeFixture())).toBe(true);
    const dataOnly: EvaraNode = { type: "actions", items: [{ kind: "open", label: "Open the plan", target: "plan" }] };
    expect(hasProse({ version: "1", origin: "fallback", dropped: [], root: dataOnly })).toBe(false);
  });
  it("withOverrides replaces members but keeps the panel's live getters (a stale farm id would write to the wrong farm)", () => {
    let farm = "farm-a";
    const base = ctxStub().ctx;
    const live = Object.create(base, { farmId: { get: () => farm } }) as typeof base;
    const local = withOverrides(live, { language: "hi" });
    expect(local.language).toBe("hi");
    expect(local.farmId).toBe("farm-a");
    farm = "farm-b";
    expect(local.farmId).toBe("farm-b");
  });
  it("a Hindi panel language labels the kit chrome in Hindi and falls back to English where there is no translation", () => {
    const hi = strip(renderToString(() => <EvaraUiView ui={evaraTreeFixture()} ctx={ctxStub().ctx} language="hi" />));
    expect(hi).toContain("फसल");
    expect(hi).toContain("देखें कि यह इस खेत में कैसी दिख सकती है");
    expect(hi).toContain("Drain the field"); // server-written text is never translated here
  });
});

describe("growth journey stage views", () => {
  const calendar = ["a", "b", "c", "d", "e", "f", "g"].map((id, i) => ({ stageId: id, name: id, from: `2027-0${i + 1}-01`, to: `2027-0${i + 1}-28` }));
  it("marks at most five stages for an image before a journey exists: the first, the last and three between", () => {
    const views = stageViews(calendar, null);
    const picked = views.filter((v) => v.illustrated).map((v) => v.stageId);
    expect(picked.length).toBe(5);
    expect(picked[0]).toBe("a");
    expect(picked[picked.length - 1]).toBe("g");
    expect(views.every((v) => v.status === "schematic" && v.imagePath === null)).toBe(true);
  });
  it("uses the journey's own stages once it exists and only a ready stage carries an image path", () => {
    const views = stageViews(calendar, journeyWith("running", ["ready", "failed", "running"]));
    expect(views.map((v) => v.status)).toEqual(["ready", "failed", "running"]);
    expect(views[0]!.imagePath).toContain("/future-look/");
    expect(views[1]!.imagePath).toBeNull();
  });
  it("explains an unavailable journey and a failed stage in plain words, and nothing for a healthy one", () => {
    for (const reason of ["runtime_mode", "no_source_image", "budget", "daily_cap"]) {
      const text = journeyNotice({ status: "unavailable", reason }, "en");
      expect(text).toBeTruthy();
      expect(text).not.toContain("_");
    }
    expect(journeyNotice({ status: "unavailable", reason: "something_new" }, "en")).toBe("Images could not be made this time.");
    expect(journeyNotice({ status: "running", reason: null }, "en")).toBeNull();
    expect(stageNotice({ status: "failed", reason: "outside_field_changed" }, "en")).toContain("not used");
    expect(stageNotice({ status: "failed", reason: null }, "en")).toBe("This image could not be made.");
    expect(stageNotice({ status: "ready", reason: null }, "en")).toBeNull();
  });
});

describe("action kinds present in the fixture match the contract", () => {
  it("covers all eight action kinds across the tree", () => {
    const kinds = new Set<EvaraAction["kind"]>();
    const grab = (a: EvaraAction) => kinds.add(a.kind);
    walkNodes(evaraTreeFixture().root, (n) => {
      if (n.type === "actions") n.items.forEach(grab);
      if (n.type === "choice") n.options.forEach(grab);
      if (n.type === "crop_compare") n.rows.forEach((r) => r.actions.forEach(grab));
      if (n.type === "plan_options") n.options.forEach((o) => o.actions.forEach(grab));
    });
    expect([...kinds].sort()).toEqual(["add_season", "ask", "compare", "open", "pick_crop", "replace_season", "show_journey", "use_plan"]);
  });
});

describe("the predict button follows the journey (review nit)", () => {
  it("is disabled, with the progress text, while a request is in flight or the journey is queued or running, even when the local phase is idle", () => {
    expect(predictControl("requesting", null, 3)).toMatchObject({ show: true, disabled: true, progress: true });
    expect(predictControl("polling", journeyWith("running", ["ready", "queued", "queued"]), 3)).toMatchObject({ show: true, disabled: true, progress: true });
    // A journey resumed from a stored message: phase idle, status queued.
    expect(predictControl("idle", journeyWith("queued", ["queued", "queued", "queued"]), 3)).toMatchObject({ show: true, disabled: true, progress: true });
  });
  it("is gone once the journey is ready or partial, and while a timed-out journey offers Check again", () => {
    expect(predictControl("idle", journeyWith("ready", ["ready", "ready", "ready"]), 3).show).toBe(false);
    expect(predictControl("idle", journeyWith("partial", ["ready", "failed", "ready"]), 3).show).toBe(false);
    expect(predictControl("timeout", journeyWith("running", ["queued", "queued", "queued"]), 3)).toMatchObject({ show: false, progress: false });
  });
  it("stays, enabled and as a retry, for a failed or unavailable journey; plain before any journey; absent without stages", () => {
    expect(predictControl("idle", journeyWith("failed", ["failed", "failed", "failed"], { reason: "provider_error" }), 3)).toEqual({ show: true, disabled: false, retry: true, progress: false });
    expect(predictControl("idle", journeyWith("unavailable", ["unavailable", "unavailable", "unavailable"]), 3)).toMatchObject({ show: true, disabled: false, retry: true });
    expect(predictControl("idle", null, 3)).toEqual({ show: true, disabled: false, retry: false, progress: false });
    expect(predictControl("error", null, 3)).toMatchObject({ disabled: false, retry: true });
    expect(predictControl("idle", null, 0).show).toBe(false);
  });
});

describe("a plan slot without a harvest window", () => {
  it("shows the sowing only and says the harvest is not known; never a date", () => {
    const ui = evaraTreeFixture();
    const plan = [...(function* () {
      const found: EvaraNode[] = [];
      walkNodes(ui.root, (n) => n.type === "plan_options" && found.push(n));
      yield* found;
    })()][0] as Extract<EvaraNode, { type: "plan_options" }>;
    plan.options[0]!.slots[1]!.harvest = null;
    expect(evaraUiSchema.safeParse(ui).success).toBe(true);
    const html = render(ui);
    expect(html).toContain("Sow 1 Nov 2027 · Harvest not known");
    expect(html).toContain("Sow 12 Feb 2027 · Harvest 20 Sep 2027 – 15 Oct 2027");
    expect(slotHarvestText(null, "Harvest", "not known", (d) => d)).toBe("Harvest not known");
  });
});
