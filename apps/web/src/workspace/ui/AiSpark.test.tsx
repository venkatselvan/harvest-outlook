import { describe, expect, it } from "vitest";
import { renderToString } from "solid-js/web";
import { AiSpark, AiSparkInline, AiUseBody, AiUsesButton, AiUsesList } from "./AiSpark";
import { AI_PRIVACY_NOTE, AI_PROVIDER_NOTE, AI_USES, AI_USE_KEYS, type AiUseKey } from "./ai-uses";

/**
 * The repo's component tests run in the node environment (Solid SSR transform, `renderToString`); there is no DOM or
 * click simulation available without a new dependency. These tests cover the registry and the rendered markup of every
 * piece the click reveals. The click-through (open, switch to the full list, Escape, focus) is covered in
 * `e2e/ai-spark.spec.ts` in a real browser.
 */
const text = (html: string) =>
  html
    .replace(/<!--[^>]*-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

const EXPECTED_KEYS: AiUseKey[] = [
  "year_plan_select",
  "news_review",
  "future_look",
  "soil_extraction",
  "soil_review",
  "crop_fit_picks",
  "harvest_outlook_note",
  "today_overview",
  "assistant",
  "speech",
  "journal_observation",
];
const MODELS = ["Meta Muse Spark 1.3 (text)", "Meta Muse Image 1.0", "Meta speech recognition"];
/** Every use is live as of 2026-11-01 (soil review, crop fit picks and the outlook note shipped in round 2). */
const PLANNED: AiUseKey[] = [];

describe("AI use registry", () => {
  it("holds exactly the eleven agreed uses, keyed consistently", () => {
    expect([...AI_USE_KEYS].sort()).toEqual([...EXPECTED_KEYS].sort());
    for (const key of EXPECTED_KEYS) expect(AI_USES[key].key).toBe(key);
  });

  it("has non-empty copy and a valid model for every entry", () => {
    for (const use of Object.values(AI_USES)) {
      for (const field of [use.title, use.where, use.does, use.code, use.benefit]) {
        expect(field.trim().length).toBeGreaterThanOrEqual(8);
      }
      expect(MODELS).toContain(use.model);
      expect(["live", "planned"]).toContain(use.status);
    }
  });

  it("marks no use as planned once every use has shipped, so no planned use reads as live", () => {
    const planned = Object.values(AI_USES)
      .filter((use) => use.status === "planned")
      .map((use) => use.key)
      .sort();
    expect(planned).toEqual([...PLANNED].sort());
  });

  it("assigns image and speech models to the right uses and never claims speech synthesis", () => {
    expect(AI_USES.future_look.model).toBe("Meta Muse Image 1.0");
    expect(AI_USES.speech.model).toBe("Meta speech recognition");
    expect(AI_USES.speech.does).toMatch(/does not synthesise speech/);
    expect(Object.values(AI_USES).every((use) => !/elevenlabs/i.test(JSON.stringify(use)))).toBe(true);
  });

  it("mentions Claude only in the provider note", () => {
    expect(JSON.stringify(AI_USES)).not.toMatch(/claude/i);
    expect(AI_PRIVACY_NOTE).not.toMatch(/claude/i);
    expect(AI_PROVIDER_NOTE).toMatch(/Meta is the only runtime AI provider/);
    expect(AI_PROVIDER_NOTE).toMatch(/Claude was used to build the app, not to run it/);
  });

  it("keeps the scoring weights in the year-plan copy aligned with the engine (40/30/15/10/5)", () => {
    expect(AI_USES.year_plan_select.code).toContain("price 40, yield 30, soil and rotation 15, water 10, confidence 5");
  });
});

describe("AiSpark markup", () => {
  it("renders a labelled, focusable button and no dialog until it is activated", () => {
    const html = renderToString(() => <AiSpark use="year_plan_select" />);
    expect(html).toContain('aria-label="AI used: Choosing your three year plans"');
    expect(html).toContain('title="AI used: Choosing your three year plans.');
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain("--ai-size:16px");
    expect(html).not.toContain("tabindex");
    expect(html).not.toContain('role="dialog"');
  });

  it("honours the size prop", () => {
    const html = renderToString(() => <AiSpark use="speech" size={20} />);
    expect(html).toContain("--ai-size:20px");
    expect(html).toContain('width="20"');
  });

  it("keeps the visible label inside the accessible name for the inline variant", () => {
    const html = renderToString(() => <AiSparkInline use="crop_fit_picks" label="Picked by AI" />);
    expect(text(html)).toContain("Picked by AI");
    expect(html).toContain('aria-label="Picked by AI (AI used: Top crop picks for your field)"');
    expect(html).toContain("ai-spark-labelled");
  });

  it("renders the header entry point with its own name", () => {
    const html = renderToString(() => <AiUsesButton />);
    expect(html).toContain('aria-label="AI in this app"');
    expect(html).not.toContain('role="dialog"');
  });
});

describe("AiSpark sheet content", () => {
  it("shows the three labelled blocks with the registry copy for a live use", () => {
    const html = renderToString(() => <AiUseBody use={AI_USES.news_review} />);
    const copy = text(html);
    expect(copy).toContain("What the AI does");
    expect(copy).toContain("What the code does");
    expect(copy).toContain("Why it helps");
    expect(copy).toContain(AI_USES.news_review.does);
    expect(copy).toContain(AI_USES.news_review.code);
    expect(copy).toContain(AI_USES.news_review.benefit);
    expect(copy).toContain("Live");
    expect(copy).not.toContain("Planned");
    expect(copy).not.toContain("Not running in the app yet");
  });

  it("says plainly that a planned use is not running yet", () => {
    const copy = text(renderToString(() => <AiUseBody use={{ ...AI_USES.soil_review, status: "planned" }} />));
    expect(copy).toContain("Planned");
    expect(copy).toContain("Not running in the app yet");
    expect(copy).not.toMatch(/\bLive\b/);
  });

  it("lists all eleven uses with a status chip each when the full list is shown", () => {
    const html = renderToString(() => <AiUsesList />);
    expect(html.match(/data-ai-use="/g)).toHaveLength(11);
    for (const use of Object.values(AI_USES)) {
      expect(html).toContain(`data-ai-use="${use.key}"`);
      expect(text(html)).toContain(use.title);
      expect(text(html)).toContain(`${use.model} · ${use.where}`);
    }
    expect(text(html).match(/\bLive\b/g)).toHaveLength(11);
    expect(text(html).match(/\bPlanned\b/g)).toBeNull();
  });
});
