import { renderToString } from "solid-js/web";
import { describe, expect, it } from "vitest";
import { CropCard } from "./CropCard";
import { ResultsList } from "./ResultsList";
import { hassanFixture, tnFixture } from "./fixtures";
import type { CompareItem } from "./types";

/** SSR output reduced to its text, so assertions cover what a reader would see. */
const textOf = (html: string): string =>
  html.replace(/<!--[^>]*-->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const card = (i: CompareItem, extra: { assumedPriceUsed?: boolean } = {}) => textOf(renderToString(() => <CropCard item={i} onChoose={() => undefined} {...extra} />));
const find = (items: CompareItem[], productId: string) => items.find((i) => i.productId === productId)!;

describe("CropCard with the synthetic Hassan fixture", () => {
  it("shows an unscreened crop honestly: unknown eligibility, no planting window, gated price, missing input", () => {
    const t = card(find(hassanFixture.items, "ginger-fresh"));
    expect(t).toContain("Ginger: ");
    expect(t).toContain("Eligibility: Unknown");
    expect(t).toContain("not a finding that the crop cannot grow here");
    expect(t).toContain("Planting window Not available for your region");
    expect(t).toContain("Unavailable — price access pending");
    expect(t).toContain("A sourced growing context for your region");
    expect(t).toContain("3/6 dimensions");
    expect(t).toContain("Choose this crop");
    // sourced elsewhere only: must not be presented as a Hassan window
    expect(t).toContain("Sourced elsewhere: Kharif");
  });
  it("shows an eligible crop with window, repeated-picking text, citations toggle and evidence-state badges", () => {
    const t = card(find(hassanFixture.items, "turmeric-dry"));
    expect(t).toContain("Eligibility: Eligible");
    expect(t).toContain("April to May");
    expect(t).toContain("Single harvest pattern");
    expect(t).toContain("Assumes planting on 2027-05-01");
    expect(t).toContain("Fits: Planting in sourced window");
    expect(t).toContain("Rule IDs and evidence (1 rule, ");
    for (const label of ["Source reference", "Derived", "Unavailable"]) expect(t).toContain(label);
    expect(t).toContain("Cost of cultivation: not sourced in the catalogue");
    expect(t).toContain("A downside scenario is not computable");
  });
  it("never renders a number for price or cost when the API says unavailable", () => {
    const t = card(find(hassanFixture.items, "turmeric-dry"));
    expect(t).not.toMatch(/INR \d/);
    expect(t).toContain("Most consequential missing input");
  });
});

describe("CropCard with an assumed price (synthetic TN fixture)", () => {
  const item = find(tnFixture.items, "finger-millet-grain");
  it("renders scenario values from the API with scenario and your-assumption labels, and the regional yield basis", () => {
    const t = card(item, { assumedPriceUsed: true });
    expect(t).toContain("INR 57500.00 per ha");
    expect(t).toContain("INR 111600.00 per ha");
    expect(t).toContain("Scenario");
    expect(t).toContain("Your assumption");
    expect(t).toContain("Basis: Regional reference");
    expect(t).toContain("Net return is not shown");
    expect(t).toContain("Low scenario: 2300 kg/ha at INR 25/kg");
    expect(t).toContain("Eligibility: Needs review");
  });
  it("does not label the price as the farmer's when no assumption was supplied", () => {
    expect(card(item, { assumedPriceUsed: false })).not.toContain("Your assumption");
  });
});

describe("ResultsList", () => {
  it("renders each row with eligibility text, coverage n/6 and a checkbox", () => {
    const items = hassanFixture.items.slice(0, 4);
    const html = renderToString(() => <ResultsList items={items} selected={[`${items[0]!.cropId}/${items[0]!.productId}`]} blockedNotice={false} onToggle={() => undefined} />);
    const t = textOf(html);
    expect(html.match(/type="checkbox"/g)?.length).toBe(4);
    expect(html).toContain("checked");
    expect(t).toContain("Eligibility: Eligible");
    expect(t).toContain("Evidence coverage 3/6 dimensions");
    expect(t).toContain("1 selected");
    expect(t).not.toContain("at most 3");
  });
  it("shows the limit notice when a fourth selection was refused", () => {
    const t = textOf(renderToString(() => <ResultsList items={hassanFixture.items.slice(0, 4)} selected={[]} blockedNotice={true} onToggle={() => undefined} />));
    expect(t).toContain("at most 3 crops");
  });
});

describe("CropCard yield row for another product's reference (L6)", () => {
  it("hides the numbers and says the reference exists for the other product, not applied", () => {
    const item = find(tnFixture.items, "chilli-green");
    expect(item.yieldReference?.appliesToProduct).toBe(false);
    const t = card(item);
    expect(t).toContain("Yield reference exists for chilli-dry, not applied");
    expect(t).not.toMatch(/2000 to 3000 kg\/ha/);
  });
});

describe("CropCard price reference (L3)", () => {
  const base = find(hassanFixture.items, "ginger-fresh");
  const withRef = (priceReference: CompareItem["priceReference"]): CompareItem => ({ ...base, priceReference });
  it("shows the last quote with date and market, the weekly-median range and the wholesale label, never as a forecast", () => {
    const t = card(withRef({
      state: "historical_reference", evidenceState: "observed", label: "Mandi reference (wholesale), not a farm-gate price", notForecast: true, marketId: "belur", marketName: "Belur", stateName: "Karnataka",
      lastQuote: { inrPerKg: "120", date: "2026-10-29", variety: "Local", grade: null, sourceUnit: "INR/quintal", evidenceState: "observed", evidenceIds: [] },
      weeklyRange: { lowInrPerKg: "70", highInrPerKg: "110", label: "r", weeks: 7, evidenceState: "derived" }, fallbackNote: "No quotes for this market; showing Karnataka markets", otherMarkets: 0,
    }));
    expect(t).toContain("Mandi reference (wholesale), not a farm-gate price");
    expect(t).toContain("Last quote INR 120.00/kg on 2026-10-29 at Belur (Local)");
    expect(t).toContain("Range of weekly medians, last 52 weeks (7 weeks): INR 70.00/kg to INR 110.00/kg. Not a prediction interval.");
    expect(t).toContain("No quotes for this market; showing Karnataka markets");
    expect(t).not.toMatch(/forecast price|predicted/i);
  });
  it.each([
    ["price_history_not_ingested", "Price history not ingested yet"],
    ["price_history_insufficient", "Too few recent quotes"],
    ["market_not_in_history", "No quotes for this market"],
    ["price_access_key_gated", "Unavailable — price access pending"],
  ])("renders the real cause for %s", (reason, text) => {
    const t = card(withRef({ state: "unavailable", label: "x", missingReason: reason }));
    expect(t).toContain(text);
    if (reason !== "price_access_key_gated") expect(t).not.toContain("price access pending");
  });
});

