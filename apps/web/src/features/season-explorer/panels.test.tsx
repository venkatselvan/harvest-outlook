import { renderToString } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshCapabilities } from "../../lib/capabilities";
import { makeTimeline } from "./fixtures";
import { indexTimeline, modeQualifier, recordAt, sceneChoice } from "./model";
import { OutlookPanel, WeatherPanel } from "./panels";
import { ScenePanel } from "./ScenePanel";

const textOf = (html: string): string =>
  html
    .replace(/<!--[^>]*-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
afterEach(() => vi.unstubAllGlobals());

describe("past date without a photo (M3)", () => {
  it("renders no picture at all, even when a base farm photo exists, and says so", () => {
    const tl = makeTimeline({ asOf: "2026-07-10" });
    const ix = indexTimeline(tl, "2026-06-01");
    const day = recordAt(ix, "2026-06-10")!;
    const choice = sceneChoice(ix, day);
    expect(choice.kind).toBe("absent");
    const state = {
      media: { id: "media-base-1", region: { polygon: [] } },
      visuals: null,
      generate: { status: "idle", message: "", reasons: [] },
      mode: "synthetic",
    } as never;
    const html = renderToString(() => (
      <ScenePanel state={state} choice={choice} onGenerate={() => undefined} />
    ));
    expect(html).not.toContain("<img");
    expect(html).not.toContain("media-base-1");
    expect(textOf(html)).toContain("No photo recorded for this date");
  });
});

describe("field photos use observation assets only", () => {
  it("suppresses generated future-stage imagery and generation controls even when cached visuals exist", () => {
    const state = {
      media: { id: "other-date-base-photo" },
      visuals: {
        stages: [{ state: "ready", asset: { assetId: "generated-asset" } }],
      },
    } as never;
    const html = renderToString(() => (
      <ScenePanel
        state={state}
        choice={{ kind: "illustration", progress: {} } as never}
      />
    ));
    expect(html).not.toContain("<canvas");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("generated-asset");
    expect(html).not.toContain("other-date-base-photo");
    expect(html).not.toContain("Generate illustrations");
    expect(textOf(html)).toContain("No photo recorded for this date");
  });
  it("shows the actual selected date's uploaded photo and its date label", () => {
    const html = renderToString(() => (
      <ScenePanel
        state={{} as never}
        choice={{
          kind: "photo",
          assetId: "observed-photo",
          date: "2026-10-30",
          label: "Your photo · 30 Oct 2026",
        }}
      />
    ));
    expect(html).toContain(
      "/api/v1/media/observed-photo/content?variant=normalized",
    );
    expect(textOf(html)).toContain("Your photo · 30 Oct 2026");
    expect(html).not.toContain("<canvas");
  });
});

describe("mode qualifier on value panels (M4)", () => {
  const tl = makeTimeline({ asOf: "2026-07-10" });
  const ix = indexTimeline(tl, "2026-06-01");
  const observedDay = () => {
    const d = tl.days.find((x) => x.weather.state === "observed");
    if (!d) throw new Error("fixture has no observed day");
    return d;
  };
  it("modeQualifier: none for live, labelled for synthetic and replay, unconfirmed when unknown", () => {
    expect(modeQualifier("live")).toBeNull();
    expect(modeQualifier("synthetic")).toBe(
      "Synthetic fixture (observed-shaped)",
    );
    expect(modeQualifier("replay")).toBe("Replay");
    expect(modeQualifier(null)).toMatch(/not confirmed/);
  });
  it("an Observed-shaped weather row is qualified as a synthetic fixture when capabilities say synthetic", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            requestId: "r",
            mode: "synthetic",
            asOf: "2026-07-10T00:00:00Z",
            data: {},
            warnings: [],
            error: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    await refreshCapabilities();
    const t = textOf(
      renderToString(() => <WeatherPanel day={observedDay()} />),
    );
    expect(t).toContain("Observed");
    expect(t).toContain("Synthetic fixture (observed-shaped)");
  });
  it("is absent in live mode", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            requestId: "r",
            mode: "live",
            asOf: "2026-07-10T00:00:00Z",
            data: {},
            warnings: [],
            error: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    await refreshCapabilities();
    const t = textOf(
      renderToString(() => <WeatherPanel day={observedDay()} />),
    );
    expect(t).not.toContain("Synthetic fixture");
    expect(ix).toBeTruthy();
  });
  it("the price panel carries the qualifier too", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            requestId: "r",
            mode: "replay",
            asOf: "2026-07-10T00:00:00Z",
            data: {},
            warnings: [],
            error: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    await refreshCapabilities();
    const t = textOf(
      renderToString(() => (
        <OutlookPanel
          day={tl.days[0]!}
          outputs={{} as never}
          assumedPrice={null}
        />
      )),
    );
    expect(t).toContain("Replay");
  });
});
