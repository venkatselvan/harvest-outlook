import { describe, it, expect } from "vitest";
import { renderToString } from "solid-js/web";
import { Evara } from "./Evara";
import { Logo } from "./Logo";

describe("supplied brand artwork", () => {
  it("uses distinct supplied assets and keeps decorative instances out of accessible names", () => {
    const logo = renderToString(() => <Logo size={38} />),
      mascot = renderToString(() => <Evara size={32} />);
    expect(logo).toContain("/brand/harvest-logo.png");
    expect(mascot).toContain("/brand/evara-mascot.png");
    for (const html of [logo, mascot]) {
      expect(html).toContain('alt=""');
      expect(html).toContain('aria-hidden="true"');
      expect(html).not.toContain("<svg");
    }
  });
  it("preserves the public size/class/title contract for labelled character instances", () => {
    const html = renderToString(() => (
      <Evara size={42} class="example" title="Evara, your farm assistant" />
    ));
    expect(html).toContain('width="42"');
    expect(html).toContain('height="42"');
    expect(html).toContain("evara-mascot example");
    expect(html).toContain('alt="Evara, your farm assistant"');
    expect(html).not.toContain('aria-hidden="true"');
  });
});
