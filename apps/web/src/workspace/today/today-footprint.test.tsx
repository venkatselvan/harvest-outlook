import { describe, expect, it } from "vitest";
import { renderToString } from "solid-js/web";
import { CarbonFootprint as carbonSchema, EnergyFootprint as energySchema, type CarbonFootprint, type CarbonTerm, type EnergyFootprint } from "@harvest/contracts";
import { CarbonCard, EnergyCard } from "./TodayCards";
import { CarbonSheetBody } from "./TodaySheet";
import { carbonTermLine, carbonTermNote, largestCarbonTerm } from "./model";

// Synthetic fixtures built here (not the shared fixtures.ts): invented numbers, for the footprint wording and rules only.

const noop = () => undefined;
const text = (html: string) => html.replace(/<!--[^>]*-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const term = (over: Partial<CarbonTerm> & Pick<CarbonTerm, "source" | "label">): CarbonTerm => ({
  tCO2eForField: { low: 1, high: 2 },
  tCO2ePerHa: { low: 1, high: 2 },
  method: "synthetic test term",
  kind: "baseline",
  sourceIds: [],
  ...over,
});

const RESIDUE_NOTE = "carbon the residue holds; not a removal and not counted (most of it returns to the air as the residue decays)";

function carbon(over: Partial<CarbonFootprint> = {}): CarbonFootprint {
  return {
    status: "available",
    reason: null,
    fieldAreaHa: 1,
    seasonDays: 120,
    emissionsForField: { low: 1.2, high: 2.1 },
    emissionsPerHa: { low: 1.2, high: 2.1 },
    terms: [
      term({ source: "fertiliser_n2o", label: "Nitrous oxide from fertiliser", tCO2eForField: { low: 1.2, high: 2.1 }, tCO2ePerHa: { low: 1.2, high: 2.1 } }),
      term({
        source: "residue_carbon",
        label: "Carbon held in the straw",
        kind: "scenario",
        tCO2eForField: { low: -4.2, high: -3.1 },
        tCO2ePerHa: { low: -4.2, high: -3.1 },
        method: "minus 2,000 kg dry straw x carbon fraction 0.4 x 44/12 x retained share 0.2 / 1000 = t CO₂e.",
      }),
    ],
    residueScenarios: [],
    comparison: { rank: 3, of: 8, lowest: { cropId: "ragi", cropName: "Test millet", tCO2eForField: { low: 0.03, high: 0.23 } }, highest: { cropId: "rice", cropName: "Test rice", tCO2eForField: { low: 0.03, high: 0.23 } } },
    gwp: null,
    summary: "Synthetic summary.",
    basis: [],
    limitations: [],
    ...over,
  };
}

function energy(over: Partial<EnergyFootprint> = {}): EnergyFootprint {
  return {
    status: "partial",
    reason: null,
    inputEnergyGJPerHa: { low: 14.2, high: 18.6 },
    inputEnergyGJForField: null,
    inputEnergyBasis: null,
    inputBreakdown: [],
    calorificValueMJPerKg: null,
    residueEnergyGJForField: null,
    equivalents: [],
    basis: [],
    limitations: [],
    ...over,
  };
}

describe("synthetic footprint fixtures", () => {
  it("validate against the contract", () => {
    expect(carbonSchema.safeParse(carbon()).success).toBe(true);
    expect(energySchema.safeParse(energy()).success).toBe(true);
  });
});

describe("carbon sheet wording for negative terms", () => {
  it("the residue-carbon term says it is not a removal and never claims carbon kept out of the air, even with a retained share in its method", () => {
    const html = text(renderToString(() => <CarbonSheetBody carbon={carbon({ terms: [carbon().terms[0]!, { ...carbon().terms[1]!, kind: "baseline" }] })} />));
    expect(html).toContain(RESIDUE_NOTE);
    expect(html).not.toContain("kept out of the air");
    expect(html).toContain("−4.2 to −3.1 t CO₂e");
  });
  it("the same holds when the term is listed as a scenario term", () => {
    const html = text(renderToString(() => <CarbonSheetBody carbon={carbon({ residueScenarios: [{ id: "incorporate", label: "Work the straw in", netForField: { low: 1.2, high: 2.1 }, note: "No credit claimed." }] })} />));
    expect(carbon().terms[1]!.kind).toBe("scenario");
    expect(html).not.toContain("kept out of the air");
  });
  it("a negative term with a retained share in its method, from another source, keeps the suffix", () => {
    const other = term({ source: "other", label: "Carbon stored in biochar", tCO2eForField: { low: -0.8, high: -0.3 }, tCO2ePerHa: { low: -0.8, high: -0.3 }, method: "biochar made x carbon fraction x retained share 0.8 = t CO₂e." });
    const html = text(renderToString(() => <CarbonSheetBody carbon={carbon({ terms: [carbon().terms[0]!, other] })} />));
    expect(html).toContain("−800 to −300 kg CO₂e (carbon kept out of the air)");
    expect(html).not.toContain(RESIDUE_NOTE);
  });
  it("a negative term with no retained share gets no suffix and no note", () => {
    const plain = term({ source: "other", label: "A credit", tCO2eForField: { low: -0.8, high: -0.3 }, tCO2ePerHa: { low: -0.8, high: -0.3 }, method: "synthetic credit" });
    expect(carbonTermNote(plain)).toBeNull();
    expect(text(renderToString(() => <CarbonSheetBody carbon={carbon({ terms: [carbon().terms[0]!, plain] })} />))).not.toContain("kept out of the air");
  });
  it("the card never shows the residue-carbon value", () => {
    const html = text(renderToString(() => <CarbonCard carbon={carbon()} onDetails={noop} />));
    expect(html).not.toContain("4.2");
    expect(html).not.toContain("−");
    expect(html).not.toContain("residue holds");
  });
});

describe("carbon card: lowest here", () => {
  it("a sub-tonne range is in kilograms like the main value, not rounded outward to 0.0–0.3 t", () => {
    const html = text(renderToString(() => <CarbonCard carbon={carbon()} onDetails={noop} />));
    expect(html).toContain("lowest here: Test millet 30–230 kg CO₂e");
    expect(html).toContain("Lowest here: Test millet, 30 to 230 kilograms of carbon dioxide equivalent");
    expect(html).not.toContain("0.0–0.3");
  });
  it("a range of a tonne or more stays in tonnes", () => {
    const c = carbon({ comparison: { rank: 2, of: 5, lowest: { cropId: "x", cropName: "Test pulse", tCO2eForField: { low: 1.1, high: 1.9 } }, highest: null } });
    expect(text(renderToString(() => <CarbonCard carbon={c} onDetails={noop} />))).toContain("lowest here: Test pulse 1.1–1.9 t CO₂e");
  });
  it("the sheet's comparison rows use the same formatting", () => {
    const html = text(renderToString(() => <CarbonSheetBody carbon={carbon()} />));
    expect(html).toContain("Test millet, 30–230 kg CO₂e");
    expect(html).not.toContain("0.0–0.3");
  });
});

describe("energy card without a field area", () => {
  it("shows the per-hectare figure with /ha and a spoken form that says per hectare", () => {
    const html = text(renderToString(() => <EnergyCard energy={energy()} residueName={null} onDetails={noop} />));
    expect(html).toContain("14.2–18.6 GJ /ha");
    expect(html).toContain("14.2 to 18.6 gigajoules per hectare used to grow this crop");
    expect(html).toContain("used to grow this crop");
    expect(html).not.toContain("not sourced");
  });
  it("prefers the field figure, without /ha, when the area is known", () => {
    const html = text(renderToString(() => <EnergyCard energy={energy({ inputEnergyGJForField: { low: 28, high: 37 } })} residueName={null} onDetails={noop} />));
    expect(html).toContain("28.0–37.0 GJ");
    expect(html).not.toContain("/ha");
  });
  it("with neither figure and no residue energy it shows no figure", () => {
    const html = text(renderToString(() => <EnergyCard energy={energy({ inputEnergyGJPerHa: null })} residueName={null} onDetails={noop} />));
    expect(html).not.toContain("GJ /ha");
  });
});

describe("largest carbon term: judged on high values", () => {
  // Highs: A 4 (share 4/10 = 0.4), B 6 (0.6). Midpoints: A (3.5+4)/2 = 3.75, B (0+6)/2 = 3, so midpoints would pick A.
  const a = term({ source: "rice_methane", label: "Methane from the flooded field", tCO2eForField: { low: 3.5, high: 4 }, tCO2ePerHa: { low: 3.5, high: 4 } });
  const b = term({ source: "fertiliser_n2o", label: "Nitrous oxide from fertiliser", tCO2eForField: { low: 0, high: 6 }, tCO2ePerHa: { low: 0, high: 6 } });
  it("picks the term with the largest high even when another has the larger midpoint", () => {
    expect(largestCarbonTerm([a, b])?.source).toBe("fertiliser_n2o");
  });
  it("says Mostly only when the high share is at least 0.5 of the baseline highs", () => {
    expect(carbonTermLine([a, b])).toBe("Mostly nitrous oxide from fertiliser");
    const c = term({ source: "fuel_and_machinery", label: "Diesel", tCO2eForField: { low: 0, high: 6 }, tCO2ePerHa: { low: 0, high: 6 } });
    expect(carbonTermLine([a, b, c])).toBe("Largest part: nitrous oxide from fertiliser");
  });
  it("ignores scenario terms and returns null without baseline terms", () => {
    const scenario = term({ source: "residue_burning", label: "Burning", kind: "scenario", tCO2eForField: { low: 50, high: 90 }, tCO2ePerHa: { low: 50, high: 90 } });
    expect(largestCarbonTerm([a, scenario])?.source).toBe("rice_methane");
    expect(carbonTermLine([scenario])).toBeNull();
  });
});
