import { describe, expect, it } from "vitest";
import { renderToString } from "solid-js/web";
import { hassanFixture } from "../features/comparison/fixtures";
import { CompareCards } from "./CompareCards";

const clean = (html: string) => html.replace(/<!--[^>]*-->/g, "");
const byName = (name: string) => hassanFixture.items.find((i) => i.cropName === name)!;
const render = (names: string[]) => clean(renderToString(() => <CompareCards items={names.map(byName)} onRemove={() => undefined} onDetail={() => undefined} />));

describe("compare cards markup", () => {
  it("heads the section 'Compare crops · N of 3' and renders one landmark article per crop, each with a remove control and View detail", () => {
    const html = render(["Turmeric", "Ginger"]);
    expect(html).toContain("Compare crops · 2 of 3");
    expect(html.match(/<article /g)).toHaveLength(2);
    expect(html).toContain('aria-label="Remove Turmeric from comparison"');
    expect(html.match(/View detail/g)).toHaveLength(2);
  });
  it("a sourced figure carries its chip and an unsourced one says so without a number or chip", () => {
    const html = render(["Turmeric", "Ginger"]);
    const [turmeric, ginger] = html.split("<article ").slice(1);
    expect(turmeric).toContain('data-chip="sourced"');
    expect(turmeric).toContain("Apr to May");
    // Ginger has no sourced context for this state: season, window and water say so; its duration is the sourced stage sum.
    expect(ginger!.match(/Not sourced for this state/g)).toHaveLength(3);
    expect(ginger).toContain("210 to 240 days");
  });
  it("renders nothing but the heading shell for no crops", () => {
    expect(render([])).toContain("Compare crops · 0 of 3");
  });
});
