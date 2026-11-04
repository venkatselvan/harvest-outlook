import { describe, expect, it } from "vitest";
import { renderToString } from "solid-js/web";
import { healthAction, healthHeadline, HealthCard, ProfitCard, TodayCards } from "./TodayCards";
import { TodaySheetBody } from "./TodaySheet";
import { todayFixture, FIXTURE_TODAY, harvestEconomicsFixture } from "./fixtures";

const noop = () => undefined;
const plain = (html: string) => html.replace(/<!--[^>]*-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const base = todayFixture();
const health = base.health!;

describe("compact condition card meaning and existing actions", () => {
  it("uses nearby LAND comparison only when no actual stage reference exists", () => {
    expect(healthHeadline({ ...health, typicalRange: null, verdict: "below_typical" })).toBe("Less green than nearby land");
    expect(healthHeadline({ ...health, typicalRange: null, verdict: "near_typical" })).toBe("Similar greenness to nearby land");
    expect(healthHeadline({ ...health, typicalRange: null, verdict: "above_typical" })).toBe("Greener than nearby land");
    expect(healthHeadline({ ...health, typicalRange: null, neighbourhoodMean: null })).toBe("No comparison available");
    expect(healthHeadline({ ...health, verdict: "no_reference" })).toBe("No comparison available");
    expect(healthHeadline(health)).toBe("Within the stage greenness range");
  });
  it("keeps missing/small-field qualifiers and does not claim a disease diagnosis", () => {
    const missing = plain(renderToString(() => <HealthCard health={null} ndvi={null} onDetails={noop} />));
    expect(missing).toContain("No clear satellite reading yet");
    const small = plain(renderToString(() => <HealthCard health={health} ndvi={{ ...base.ndvi!, smallField: true }} onDetails={noop} />));
    expect(small).toContain("Small field: few satellite pixels");
    expect(small).toContain("Satellite signal, not a diagnosis");
    expect(small).toContain("image of 27 Oct");
  });
  it("links only a current satellite alert for the selected field to its incomplete existing step", () => {
    const alert = { ...base.alerts[0]!, type: "satellite" as const, fieldId: "field-a", suggestedStep: "Inspect the affected patch" };
    const step = { ...base.upcoming[0]!, alertId: alert.id, status: "due" as const };
    const view = { ...base, field: { id: "field-a", name: "East", areaHa: 1 }, alerts: [alert], upcoming: [step] };
    expect(healthAction(view)).toMatchObject({ label: "Review suggested field check", detail: "Inspect the affected patch", href: expect.stringContaining("#") });
    expect(healthAction({ ...view, field: { ...view.field, id: "other" } })).toBeNull();
    expect(healthAction({ ...view, alerts: [{ ...alert, type: "weather" }] })).toBeNull();
    expect(healthAction({ ...view, alerts: [{ ...alert, validTo: "2026-10-01" }] })).toBeNull();
    expect(healthAction({ ...view, upcoming: [{ ...step, status: "completed" }] })).toBeNull();
    expect(healthAction({ ...view, upcoming: [] })).toBeNull();
  });
});

describe("compact cards keep their full evidence reachable", () => {
  it("six primary cards retain two separate native planning disclosures and all Details actions", () => {
    const html = renderToString(() => <TodayCards view={base} date={base.today} price={null} weather={null} onDetails={noop} />);
    expect(html.match(/data-card=/g)).toHaveLength(8);
    expect(html).toMatch(/<details[^>]*class="today-planning-reference"/);
    expect(html).toContain("Planning references");
    expect(html).toContain('aria-label="Energy: details and sources"');
    expect(html).toContain('aria-label="Carbon: details and sources"');
    expect(html).toMatch(/<details[^>]*class="today-price-context"/);
  });
  it("preserves the actual provided profit if its revenue breakdown has a different scope", () => {
    const econ = { ...harvestEconomicsFixture(), revenueForField: null };
    const html = renderToString(() => <ProfitCard econ={econ} onDetails={noop} />);
    const text = plain(html);
    expect(text).toContain("Profit estimate ₹94.8k");
    expect(text).toContain("Revenue Not sourced for this scope");
    expect(text).toContain("Breakdown unavailable for this scope");
    expect(html).not.toContain('aria-label="Revenue minus costs equals profit"');
  });
  it("keeps long source and alternate-use information in existing sheets", () => {
    const body = (kind: "profit" | "residue" | "health") => plain(renderToString(() => <TodaySheetBody kind={kind} view={base} date={FIXTURE_TODAY} price={null} weather={null} />));
    expect(body("profit")).toContain("District maize yield");
    expect(body("residue")).toContain("The incomes do not add up");
    expect(body("residue")).toContain("Dry fodder");
    expect(body("health")).toContain("NDMI");
  });
});
