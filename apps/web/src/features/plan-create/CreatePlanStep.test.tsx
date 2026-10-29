import { renderToString } from "solid-js/web";
import { describe, expect, it, vi } from "vitest";

// The router is client-only; SSR rendering needs only a link and a navigate stub.
vi.mock("@solidjs/router", () => ({ A: (p: { href: string; children?: unknown }) => <a href={p.href}>{p.children as never}</a>, useNavigate: () => () => undefined }));
import { CreatePlanStep } from "./CreatePlanStep";

const farm = { id: "f1", areaHectares: 1, facts: {} } as never;
const html = (productId: string | null) =>
  renderToString(() => <CreatePlanStep farm={farm} cropId="ginger" productId={productId} />);

describe("CreatePlanStep without a product form (M5)", () => {
  it("shows 'Choose a product form in Explore' with a link back and no submit button; no product id is guessed", () => {
    const h = html(null);
    expect(h).toContain("Choose a product form in Explore");
    expect(h).toContain('href="/explore"');
    expect(h).not.toContain("create-plan-submit");
    expect(h).not.toContain("ginger-fresh");
  });
  it("shows the form when a product was chosen", () => {
    const h = html("ginger-fresh");
    expect(h).toContain("create-plan-submit");
    expect(h).not.toContain("Choose a product form in Explore");
  });
});
