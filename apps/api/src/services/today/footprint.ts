import type {BasisRef, CarbonFootprint, CarbonTerm, EnergyEquivalent, EnergyFootprint, NumberRange, PoolComparison, ResidueIncome, ResidueOption, ResidueScenario} from '@harvest/contracts';
import * as data from '../year-plan/data';
import {irrigationClass} from '../year-plan/scoring';
import {factValue, type ScenarioFarm} from '../year-plan/scenario';
import {footprintConstants, footprintCrop, footprintCrops, footprintSource, type FactorRange, type FootprintConstants, type FootprintCrop, type FootprintResidue} from './footprint-data';

/**
 * Residue income, energy footprint and carbon footprint of the growing crop on this field
 * (TODAY_ECONOMICS_FOOTPRINT_SPEC.md sections 2 to 4). Pure functions over the footprint data file
 * (footprint-data.ts), the year-plan durations and plain inputs: no database, network or model call. Every number is code
 * arithmetic on cited figures times the field area; nothing is a measurement of this field, a forecast or a guaranteed sale.
 *
 * Ranges: every figure carries low and high. A product of ranges multiplies the lows together and the highs together, so
 * the band is the span of the cited factor ranges (wide by construction), not a statistical interval.
 *
 * Rounding (display precision, applied once at the end): kilograms to 1 kg; rupees to Rs 10; GJ to 0.01 GJ; LPG cylinders to
 * 0.1; diesel litres and methane kg to 1; tCO2e to 0.01 t (10 kg). Sums are taken of the unrounded values.
 *
 * Residue options are alternatives for the same residue and are never added together anywhere in this module.
 *
 * Moisture basis (review 2026-11-02): the residue-to-product ratios come from an atlas whose moisture basis is not stated
 * (its paper speaks of sun-dry residue), so every residue quantity here is AIR_DRY ("approximately air-dry (moisture basis not
 * stated in the source)"), never "dry matter". Factors a source defines per kg dry matter (IPCC burning factors, the biomass
 * carbon fraction, a biogas yield per tonne dry matter) keep their source definition and are applied to that air-dry quantity,
 * which overstates the figure somewhat; the notes say so.
 *
 * The largest-term rule of the carbon summary and the term order is documented once, at `LARGEST_TERM_RULE` below.
 */

// ------------------------------------------------------------------ engine assumptions (not sourced; flagged where used)

export const FOOTPRINT_ASSUMPTIONS = {
  riceWaterRegime: {
    value: {
      aggregated: {irrigated: 'aggregatedIrrigated', rainfed: 'aggregatedRainfed', unknown: ['aggregatedRainfed.low', 'aggregatedIrrigated.high']},
      fallback: {irrigated: ['singleDrainage', 'continuouslyFlooded'], rainfed: ['rainfedDroughtProne', 'rainfedRegular'], unknown: ['singleDrainage', 'continuouslyFlooded']},
    },
    text: 'The water regime of the rice field (drainage practice) is not recorded. With the IPCC 2019 Table 5.12 aggregated defaults in the data file: irrigated uses the irrigated aggregated range, rainfed the rainfed aggregated range, and supplemental or unrecorded irrigation the span from the rainfed aggregated low to the irrigated aggregated high (this span is the engine assumption). Without the aggregated values (fallback): irrigated and unrecorded run from the single-drainage low to the continuously-flooded high, rainfed from the drought-prone low to the regular-rainfed high (orchestrator rule, not sourced).',
  },
  ricePreSeasonStraw: {
    value: ['none', 'strawShortBefore'],
    text: 'Whether straw was put into the field before this rice season is not recorded. When the data file gives fixed straw factors, the straw scaling runs from the "no straw" low to the "straw incorporated shortly before" high (spec section 4). When it gives only IPCC Equation 5.3 (the factor depends on the tonnes of straw ploughed in, which is not recorded), no straw amendment is applied (factor 1, the IPCC no-amendment case) and the high end may be understated.',
  },
  indiaSurplusFallback: {
    value: 'IN',
    text: 'No surplus share of the residue is published for this state, so the all-India share is used (spec section 2 item 3).',
  },
  wholeResidueFallback: {
    value: 1,
    text: 'No surplus share is published for this crop; the whole residue is shown, but part of it is used on the farm (spec section 2 item 3).',
  },
  comparisonRank: {
    value: 'midpoint',
    text: 'Pool crops are ranked by the midpoint of their low and high baseline emissions per hectare on this field (ties by crop id); a crop with fewer sourced terms can rank lower.',
  },
} as const;
export type FootprintAssumptionKey = keyof typeof FOOTPRINT_ASSUMPTIONS;
export function footprintAssumptionBasis(key: FootprintAssumptionKey): BasisRef {
  return {kind: 'model', label: `Engine assumption: ${key}`, sourceId: `today-footprint-assumption:${key}`, url: null, scope: null, note: FOOTPRINT_ASSUMPTIONS[key].text};
}

// ------------------------------------------------------------------ inputs

export interface FootprintInput {
  cropId: string;
  /** Display name of the crop ("Paddy"); the summary sentence starts with it. */
  cropName: string;
  productId: string | null;
  stateId: string | null;
  districtId: string | null;
  areaHa: number | null;
  /** Regional yield of the product's own form for the field, kg (the harvest economics yieldForFieldKg); null without yield or area. */
  yieldForFieldKg: NumberRange | null;
  /** The farm's irrigation category as the year plan reads it (rainfed, supplemental, irrigated), else null. */
  irrigationCategory: string | null;
  /** Establishment (else sowing) date to the earliest harvest date, days; null without a harvest window. */
  seasonDays: number | null;
  establishmentMethod?: string | null | undefined;
}

// ------------------------------------------------------------------ small helpers

const cap = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
const roundTo = (x: number, step: number) => {
  const v = Math.round(x / step) * step;
  const digits = step < 1 ? Math.round(-Math.log10(step)) : 0;
  return Number(v.toFixed(digits)) + 0;
};
const kg = (r: NumberRange): NumberRange => ({low: roundTo(r.low, 1), high: roundTo(r.high, 1)});
const inr = (r: NumberRange): NumberRange => ({low: roundTo(r.low, 10), high: roundTo(r.high, 10)});
const gj = (r: NumberRange): NumberRange => ({low: roundTo(r.low, 0.01), high: roundTo(r.high, 0.01)});
const t2 = (r: NumberRange): NumberRange => ({low: roundTo(r.low, 0.01), high: roundTo(r.high, 0.01)});
const mul = (a: NumberRange, b: NumberRange): NumberRange => ({low: a.low * b.low, high: a.high * b.high});
const scale = (a: NumberRange, k: number): NumberRange => ({low: a.low * k, high: a.high * k});
const add = (a: NumberRange, b: NumberRange): NumberRange => ({low: a.low + b.low, high: a.high + b.high});
const mid = (r: NumberRange) => (r.low + r.high) / 2;
const span = (r: NumberRange) => (r.low === r.high ? `${r.low}` : `${r.low} to ${r.high}`);
const validArea = (a: number | null) => (a !== null && Number.isFinite(a) && a > 0 ? a : null);
const dedupe = (xs: readonly string[], n = 12) => [...new Set(xs.map((s) => cap(s, 1000)))].slice(0, n);
const N_TO_N2O = 44 / 28;
const C_TO_CO2 = 44 / 12;

/**
 * BasisRef for a cited figure of the footprint file (kind chosen by the caller; see the report on BasisRef kinds). BasisRef has
 * one sourceId, so a figure's `additionalSourceIds` are named at the end of the note ("Additional sources: ..."), and they are
 * listed in the `sourceIds` arrays of the terms, options and equivalents that use the figure.
 */
function citedBasis(kind: BasisRef['kind'], label: string, sourceId: string | null | undefined, locator: string | null | undefined, note: string | null = null, additional: readonly string[] = []): BasisRef {
  const s = footprintSource(sourceId);
  const more = additional.filter((x) => x && x !== sourceId);
  const fullNote = [note, more.length ? `Additional sources: ${more.map((x) => { const t = footprintSource(x)?.title; return t ? `${x} (${t})` : x; }).join('; ')}.` : null].filter(Boolean).join(' ');
  return {kind, label: cap(`${label}${s?.title ? `: ${s.title}` : ''}`, 200), sourceId: sourceId ? cap(sourceId, 200) : null, url: s?.url ?? null, scope: locator ? cap(locator, 120) : null, note: fullNote ? cap(fullNote, 1000) : null};
}
const uniqBasis = (xs: BasisRef[]) => {
  const seen = new Set<string>();
  return xs.filter((b) => { const k = `${b.kind}|${b.label}|${b.sourceId}|${b.scope}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 14);
};
const ids = (...xs: (string | null | undefined | readonly string[])[]) => [...new Set(xs.flat().filter((x): x is string => !!x).map((x) => cap(x, 80)))].slice(0, 8);
/** The additional source ids of a cited figure (empty when none or no figure). */
const more = (f: {additionalSourceIds?: readonly string[]} | null | undefined): readonly string[] => f?.additionalSourceIds ?? [];

/** Wording of every residue quantity (see the moisture note at the top). */
export const AIR_DRY = 'approximately air-dry (moisture basis not stated in the source)';
/** Said of a residue-to-product ratio whose note records that it was derived (generation / production of the atlas tables). */
export const RPR_DERIVED = 'derived from the atlas\'s generation and production figures';
const rprDerived = (note: string | null | undefined) => /\bderived\b/i.test(note ?? '');

/**
 * District rows, else state rows, else (when allowed) the India rows. Several rows for the same region (for example one per
 * season) are spanned: low = the lowest low, high = the highest high; the first row's source is cited and the note says so.
 */
function regional<T extends {region: string; low: number; high: number}>(rows: readonly T[], i: Pick<FootprintInput, 'stateId' | 'districtId'>, india: boolean): {row: T; rows: T[]; range: NumberRange; count: number; level: 'district' | 'state' | 'india'} | null {
  const levels: ['district' | 'state' | 'india', string | null][] = [['district', i.districtId], ['state', i.stateId], ['india', india ? 'IN' : null]];
  for (const [level, region] of levels) {
    const hit = region ? rows.filter((r) => r.region === region) : [];
    if (hit.length) return {row: hit[0]!, rows: hit, range: {low: Math.min(...hit.map((r) => r.low)), high: Math.max(...hit.map((r) => r.high))}, count: hit.length, level};
  }
  return null;
}
const spannedNote = (count: number, region: string) => (count > 1 ? `${count} rows are published for ${region} (for example by season); the range spans them.` : null);

// ------------------------------------------------------------------ residue quantities (shared by the three blocks)

export const FOOTPRINT_REASONS = {
  crop_not_in_footprint_data: 'No residue, energy or emission figure is sourced for this crop.',
  residue_not_sourced: 'No residue-to-product ratio is sourced for this crop.',
  no_product_recorded: 'No product is recorded for this crop, so the residue cannot be computed from its yield.',
  residue_basis_mismatch: 'The residue ratio is published for another product form than the one recorded, and no sourced conversion exists.',
  yield_or_area_missing: 'The residue is computed from the regional yield times the field area, and one of them is missing.',
  residue_not_traded: 'No use with a reported quantity or price is sourced for this residue; it is usually not sold.',
  energy_study_not_sourced: 'No cited energy-use study and no residue energy figure exist for this crop.',
  calorific_value_not_sourced: 'No calorific value is sourced for this residue.',
  gwp_not_sourced: 'The global warming potentials are not in the data file, so no carbon footprint is computed.',
  field_area_missing: 'No field area is recorded, so only the per-hectare figure is shown.',
  emission_inputs_not_sourced: 'No emission term can be computed: neither a nitrogen rate for this state nor a methane factor applies.',
  nitrogen_rate_not_sourced: 'No recommended nitrogen rate for this state is sourced, so the fertiliser terms are missing.',
  methane_inputs_missing: 'The rice methane term could not be computed (season length or factors missing).',
} as const;
export type FootprintReason = keyof typeof FOOTPRINT_REASONS;

interface ResidueCalc {
  row: FootprintCrop;
  residue: FootprintResidue;
  residueForFieldKg: NumberRange;
  surplusFraction: NumberRange | null;
  surplusForFieldKg: NumberRange | null;
  /** The surplus, or the whole residue when no surplus share is published (flagged). */
  availableKg: NumberRange;
  basis: BasisRef[];
  limitations: string[];
}
type Calc<T> = {ok: true; value: T} | {ok: false; reason: FootprintReason; row: FootprintCrop | null};

function residueCalc(i: FootprintInput): Calc<ResidueCalc> {
  const row = footprintCrop(i.cropId);
  if (!row) return {ok: false, reason: 'crop_not_in_footprint_data', row: null};
  const residue = row.residue;
  if (!residue) return {ok: false, reason: 'residue_not_sourced', row};
  if (!i.productId) return {ok: false, reason: 'no_product_recorded', row};
  if (residue.productBasis.trim().toLowerCase() !== i.productId.trim().toLowerCase()) return {ok: false, reason: 'residue_basis_mismatch', row};
  if (!i.yieldForFieldKg || validArea(i.areaHa) === null) return {ok: false, reason: 'yield_or_area_missing', row};
  const rpr = {low: residue.rpr.low, high: residue.rpr.high};
  const residueForFieldKg = mul(i.yieldForFieldKg, rpr);
  const derived = rprDerived(residue.rpr.note);
  const rprNote = [derived ? `Ratio ${RPR_DERIVED}.` : null, residue.rpr.note].filter(Boolean).join(' ') || null;
  const basis: BasisRef[] = [citedBasis('residue_reference', `Residue-to-product ratio ${span(rpr)} (kg ${residue.name} per kg ${residue.productBasis}), ${AIR_DRY}`, residue.rpr.sourceId, residue.rpr.locator, rprNote, more(residue.rpr))];
  const limitations: string[] = [];
  if (derived) limitations.push(`The residue-to-product ratio is ${RPR_DERIVED}; residue quantities are ${AIR_DRY}.`);
  const pick = regional(residue.surplusFraction, i, true);
  let surplusFraction: NumberRange | null = null;
  let surplusForFieldKg: NumberRange | null = null;
  if (pick) {
    surplusFraction = pick.range;
    surplusForFieldKg = mul(residueForFieldKg, surplusFraction);
    basis.push(citedBasis('residue_reference', `Surplus share ${span(surplusFraction)} (${pick.row.region})`, pick.row.sourceId, pick.row.locator, [spannedNote(pick.count, pick.row.region), pick.row.note].filter(Boolean).join(' ') || null, more(pick.row)));
    if (pick.level === 'india') { limitations.push(FOOTPRINT_ASSUMPTIONS.indiaSurplusFallback.text); basis.push(footprintAssumptionBasis('indiaSurplusFallback')); }
  } else {
    limitations.push(FOOTPRINT_ASSUMPTIONS.wholeResidueFallback.text);
    basis.push(footprintAssumptionBasis('wholeResidueFallback'));
  }
  return {ok: true, value: {row, residue, residueForFieldKg, surplusFraction, surplusForFieldKg, availableKg: surplusForFieldKg ?? residueForFieldKg, basis, limitations}};
}

// ------------------------------------------------------------------ residue income (section 2)

/** Review 2026-11-02: the CBG and biomass-plant prices are paid to balers or aggregators at the plant, not at the farm gate. */
export const PLANT_PRICE_LIMITATION = 'Plant prices are paid to balers or aggregators; baling, loading and haulage are not deducted, so the farmer\'s share is lower.';
/** Prefix of an option's note when its price basis names balers, aggregators or a plant. */
export const PLANT_PRICE_NOTE = 'Price paid at the plant to balers; not a farm-gate price.';
const PLANT_PRICE_BASIS = /\bbalers?\b|\baggregators?\b|\bplants?\b/i;
const RESIDUE_ALWAYS = [
  'Options are alternatives for the same residue and do not add up.',
  'Prices are reported figures from the named place and date, not local quotes; transport to a plant is not deducted.',
  PLANT_PRICE_LIMITATION,
  `Quantities are ${AIR_DRY}; traded straw may be wetter or drier, so sold tonnages can differ from the quantities shown.`,
];

function emptyResidue(reason: FootprintReason, residueName: string | null, extra: string[] = []): ResidueIncome {
  return {
    status: 'unavailable', reason, residueName, residueToProductRatio: null, residueForFieldKg: null, surplusFraction: null, surplusForFieldKg: null,
    options: [], basis: [], limitations: dedupe([FOOTPRINT_REASONS[reason], ...extra]),
  };
}

/** An option's note: PLANT_PRICE_NOTE first when the price basis names balers, aggregators or a plant, then the row's note. */
function optionNote(priceBasis: string | null, note: string | null): string | null {
  const text = [priceBasis && PLANT_PRICE_BASIS.test(priceBasis) ? PLANT_PRICE_NOTE : null, note].filter(Boolean).join(' ');
  return text ? cap(text, 1000) : null;
}

/** Residue of the field, its surplus and what each use could earn (alternatives, never summed). */
export function residueIncome(i: FootprintInput): ResidueIncome {
  const c = residueCalc(i);
  if (!c.ok) return emptyResidue(c.reason, c.row?.residue?.name ?? null);
  const r = c.value;
  const options: ResidueOption[] = r.residue.uses.slice(0, 6).map((u): ResidueOption => {
    const quantity = u.share ? mul(r.availableKg, u.share) : r.availableKg;
    const price = u.priceInrPerTonne ? {low: u.priceInrPerTonne.low, high: u.priceInrPerTonne.high} : null;
    return {
      use: u.use, label: cap(u.label, 80), quantityKg: kg(quantity), priceInrPerTonne: price,
      priceBasis: u.priceBasis ? cap(u.priceBasis, 240) : null,
      // Income of this one use: tonnes (approximately air-dry) x reported price (low x low, high x high). Never added to another option.
      incomeForField: price ? inr(mul(scale(quantity, 1 / 1000), price)) : null,
      note: optionNote(u.priceBasis, u.note),
      sourceIds: ids(u.sourceId, u.priceInrPerTonne?.sourceId, more(u.priceInrPerTonne)),
    };
  });
  const basis = [...r.basis];
  for (const u of r.residue.uses) if (u.priceInrPerTonne) basis.push(citedBasis('price_history', `Reported ${r.residue.name} price for ${u.label}`, u.priceInrPerTonne.sourceId ?? u.sourceId, u.priceInrPerTonne.locator ?? u.locator, u.priceBasis ?? null, more(u.priceInrPerTonne)));
  const priced = options.filter((o) => o.incomeForField);
  const extra: string[] = [];
  if (options.length && !priced.length) extra.push('No reported price is sourced for these uses, so no income is shown.');
  if (options.length > 1) extra.push(`The ${options.length} uses listed are alternatives for the same ${r.residue.name}; each income is for that use alone and they are never added together.`);
  const base = {
    residueName: cap(r.residue.name, 80), residueToProductRatio: {low: r.residue.rpr.low, high: r.residue.rpr.high},
    residueForFieldKg: kg(r.residueForFieldKg), surplusFraction: r.surplusFraction, surplusForFieldKg: r.surplusForFieldKg ? kg(r.surplusForFieldKg) : null,
  };
  if (!options.length) return {...base, status: 'unavailable', reason: 'residue_not_traded', options: [], basis: uniqBasis(basis), limitations: dedupe([FOOTPRINT_REASONS.residue_not_traded, ...r.limitations])};
  return {...base, status: 'available', reason: null, options, basis: uniqBasis(basis), limitations: dedupe([...RESIDUE_ALWAYS, ...r.limitations, ...extra])};
}

// ------------------------------------------------------------------ energy footprint (section 3)

const ENERGY_ALWAYS = [
  'Input energy is a published study average for the crop and region, not this field\'s use.',
  'The residue energy is what the straw holds, not what a plant recovers; conversion losses are not deducted.',
  'The two figures answer different questions (energy used to grow the crop, energy held in its residue); they are not netted against each other.',
];

function emptyEnergy(reason: FootprintReason, extra: string[] = []): EnergyFootprint {
  return {
    status: 'unavailable', reason, inputEnergyGJPerHa: null, inputEnergyGJForField: null, inputEnergyBasis: null, inputBreakdown: [],
    calorificValueMJPerKg: null, residueEnergyGJForField: null, equivalents: [], basis: [], limitations: dedupe([FOOTPRINT_REASONS[reason], ...extra]),
  };
}

/** Energy used to grow the crop (cited study) and energy held in the residue (surplus x calorific value), with equivalents. */
export function energyFootprint(i: FootprintInput): EnergyFootprint {
  const row = footprintCrop(i.cropId);
  if (!row) return emptyEnergy('crop_not_in_footprint_data');
  const k = footprintConstants();
  const area = validArea(i.areaHa);
  const basis: BasisRef[] = [];
  const limitations: string[] = [];

  // Input energy: GJ/ha from the study (a single printed value is low = high), times the area.
  const e = row.energyInput;
  const lo = e?.gjPerHa?.low ?? e?.gjPerHa?.high ?? null;
  const hi = e?.gjPerHa?.high ?? e?.gjPerHa?.low ?? null;
  const perHa = e && lo !== null && hi !== null && lo >= 0 && lo <= hi ? {low: lo, high: hi} : null;
  let inputBasis: string | null = null;
  let breakdown: EnergyFootprint['inputBreakdown'] = [];
  if (perHa && e) {
    inputBasis = cap([e.sourceId ? footprintSource(e.sourceId)?.title ?? e.sourceId : 'energy-use study', e.region, e.year].filter(Boolean).join(', '), 240);
    basis.push(citedBasis('energy_reference', `Energy-use study ${span(perHa)} GJ/ha`, e.sourceId, e.locator, e.note ?? null, more(e)));
    const total = e.breakdown.reduce((s, b) => s + b.share, 0);
    if (total <= 1 + 1e-6) breakdown = e.breakdown.slice(0, 10).map((b) => ({item: cap(b.item, 60), share: b.share}));
    else limitations.push('The printed input-energy shares add up to more than 1 and are not shown.');
  }

  // Residue energy: available residue (surplus, else whole residue, flagged) x gross calorific value / 1000.
  const rc = residueCalc(i);
  const cv = row.residue?.calorificValueMJPerKg ?? null;
  let residueGJ: NumberRange | null = null;
  const equivalents: EnergyEquivalent[] = [];
  let residueReason: FootprintReason | null = null;
  if (!rc.ok) residueReason = rc.reason;
  else if (!cv) residueReason = 'calorific_value_not_sourced';
  else {
    const r = rc.value;
    const mj = mul(r.availableKg, {low: cv.low, high: cv.high});
    residueGJ = scale(mj, 1 / 1000);
    basis.push(...r.basis);
    basis.push(citedBasis('residue_reference', `Gross calorific value ${span(cv)} MJ/kg (${r.residue.name})`, cv.sourceId, cv.locator, cv.note ?? null, more(cv)));
    limitations.push(...r.limitations);
    // Equivalents: the same energy as household LPG cylinders and diesel litres (cited calorific values).
    if (k.lpgMjPerKg && k.lpgCylinderKg) {
      const perCylinder = k.lpgCylinderKg.value * k.lpgMjPerKg.value;
      equivalents.push({label: `Household LPG cylinders (${k.lpgCylinderKg.value} kg)`, amount: {low: roundTo(mj.low / perCylinder, 0.1), high: roundTo(mj.high / perCylinder, 0.1)}, unit: 'cylinders', sourceIds: ids(k.lpgCylinderKg.sourceId, k.lpgMjPerKg.sourceId, cv.sourceId, more(k.lpgCylinderKg), more(k.lpgMjPerKg), more(cv))});
      // The LPG constant's note says whether its calorific value is net or gross (the straw value is gross); it goes into the
      // basis note and, since the equivalent is shown, into the limitations.
      const lpgNote = k.lpgMjPerKg.note ?? null;
      basis.push(citedBasis('energy_reference', `LPG ${k.lpgMjPerKg.value} MJ/kg, cylinder ${k.lpgCylinderKg.value} kg`, k.lpgMjPerKg.sourceId, k.lpgMjPerKg.locator, lpgNote, [...more(k.lpgMjPerKg), ...more(k.lpgCylinderKg)]));
      if (lpgNote) limitations.push(`LPG equivalent: ${lpgNote}`);
    }
    if (k.dieselMjPerLitre) {
      equivalents.push({label: 'Diesel', amount: {low: roundTo(mj.low / k.dieselMjPerLitre.value, 1), high: roundTo(mj.high / k.dieselMjPerLitre.value, 1)}, unit: 'litres', sourceIds: ids(k.dieselMjPerLitre.sourceId, cv.sourceId, more(k.dieselMjPerLitre), more(cv))});
      basis.push(citedBasis('energy_reference', `Diesel ${k.dieselMjPerLitre.value} MJ/litre`, k.dieselMjPerLitre.sourceId, k.dieselMjPerLitre.locator, null, more(k.dieselMjPerLitre)));
    }
    // Methane in the biogas the residue could give: tonnes (approximately air-dry) x m3 biogas per tonne (the source's dry-matter
    // basis) x methane share x methane density.
    const bg = r.residue.biogasM3PerTonneDm;
    if (bg && bg.methaneShare && k.methaneKgPerM3) {
      const ch4 = scale(mul(mul(scale(r.availableKg, 1 / 1000), {low: bg.low, high: bg.high}), bg.methaneShare), k.methaneKgPerM3.value);
      equivalents.push({label: 'Methane in biogas (the energy carrier of compressed biogas)', amount: {low: roundTo(ch4.low, 1), high: roundTo(ch4.high, 1)}, unit: 'kg CH₄', sourceIds: ids(bg.sourceId, k.methaneKgPerM3.sourceId, more(bg), more(k.methaneKgPerM3))});
      basis.push(citedBasis('residue_reference', `Biogas ${span({low: bg.low, high: bg.high})} m3 per tonne ${r.residue.name} (the source's dry-matter basis), methane share ${span(bg.methaneShare)}`, bg.sourceId, bg.locator,
        [bg.note, `Applied to residue that is ${AIR_DRY}, so the methane is somewhat overstated.`].filter(Boolean).join(' '), more(bg)));
      basis.push(citedBasis('energy_reference', `Methane density ${k.methaneKgPerM3.value} kg/m3`, k.methaneKgPerM3.sourceId, k.methaneKgPerM3.locator, null, more(k.methaneKgPerM3)));
      limitations.push(k.cbgMethaneShare
        ? `Compressed biogas is sold at ${span({low: k.cbgMethaneShare.low, high: k.cbgMethaneShare.high})} methane purity, so the CBG mass is somewhat higher than the methane shown; plant yields vary.`
        : 'The methane in biogas is shown, not the compressed biogas mass; plant yields vary.');
    }
  }

  const residueEnergyGJForField = residueGJ ? gj(residueGJ) : null;
  if (!perHa && !residueEnergyGJForField) return emptyEnergy('energy_study_not_sourced', residueReason && residueReason !== 'crop_not_in_footprint_data' ? [FOOTPRINT_REASONS[residueReason]] : []);
  const status: EnergyFootprint['status'] = perHa && residueEnergyGJForField ? 'available' : 'partial';
  const reason: FootprintReason | null = status === 'available' ? null : !perHa ? 'energy_study_not_sourced' : residueReason;
  if (perHa && area === null) limitations.push('No field area is recorded, so the input energy is per hectare only.');
  return {
    status, reason, inputEnergyGJPerHa: perHa ? gj(perHa) : null, inputEnergyGJForField: perHa && area !== null ? gj(scale(perHa, area)) : null,
    inputEnergyBasis: inputBasis, inputBreakdown: breakdown, calorificValueMJPerKg: residueEnergyGJForField && cv ? {low: cv.low, high: cv.high} : null,
    residueEnergyGJForField, equivalents: equivalents.slice(0, 4), basis: uniqBasis(basis), limitations: dedupe([...(reason ? [FOOTPRINT_REASONS[reason]] : []), ...ENERGY_ALWAYS, ...limitations]),
  };
}

// ------------------------------------------------------------------ carbon footprint (section 4)

const CARBON_ALWAYS = [
  'Emission factors are IPCC and published Indian references applied to the recommended inputs for the state, not measurements on this field.',
  'Residue scenarios are alternatives; only one happens.',
];

/** Added whenever a fertiliser_n2o term exists (review 2026-11-02; spec gap: no urea-hydrolysis CO2 term is computed). */
export const UREA_CO2_LIMITATION = 'CO2 released when urea is applied (IPCC 2006 Vol 4 Ch 11 Eq 11.13) is not included.';

/**
 * Whether a nitrogen-rate row is a contingency or part dose rather than the full recommendation. The row's `doseKind` decides
 * when it is "contingency_partial" (partial) or "recommended" (full). Without one of those values, the note is matched
 * (case-insensitive) on "contingency", "50%", "half" or "not the full"; "contingency plan(s)" is not matched, because the CRIDA
 * district contingency plans print full recommended doses too (the Hassan paddy row's note names its "contingency plan" and its
 * 100:50:50 is the full dose).
 */
const PARTIAL_DOSE_NOTE = /contingency(?!\s+plans?\b)|50\s*%|\bhalf\b|not the full/i;
export function isPartialDose(row: {doseKind?: string | null | undefined; note?: string | null | undefined}): boolean {
  const kind = row.doseKind?.trim().toLowerCase();
  if (kind === 'contingency_partial') return true;
  if (kind === 'recommended') return false;
  return PARTIAL_DOSE_NOTE.test(row.note ?? '');
}

/**
 * IPCC 2006 Table 2.6 names residues by crop ("rice", "maize", "wheat", "sugarcane"); a crop id whose name differs is looked up
 * under these keys as well (naming only, no number). Used for the per-residue combustion factor of the burning scenario.
 */
const COMBUSTION_KEYS: Record<string, readonly string[]> = {paddy: ['rice']};
function combustionFactorFor(b: NonNullable<FootprintConstants['residueBurning']>, cropId: string): {range: NumberRange; key: string | null} {
  const byResidue = b.combustionFactorByResidue ?? {};
  for (const key of [cropId.toLowerCase(), ...(COMBUSTION_KEYS[cropId] ?? [])]) {
    const v = byResidue[key];
    if (typeof v === 'number') return {range: {low: v, high: v}, key};
  }
  return {range: {low: b.combustionFactor.low, high: b.combustionFactor.high}, key: null};
}

/**
 * LARGEST_TERM_RULE (the one place it is written; the web uses the same rule in apps/web/src/workspace/today/model.ts
 * largestCarbonTerm and carbonTermLine): baseline terms are compared on their HIGH value, in one unit (the rounded tCO2e for
 * the field when every baseline term has one, else the rounded tCO2e per hectare). Baseline terms are ordered by that high
 * value, descending, ties keeping their computed order, so the first baseline term is the largest the card names. The summary
 * says "mostly <term>" when that high is at least 0.5 of the sum of the baseline highs (negative highs count as 0), else "the
 * largest part from <term>". Midpoints are never used for this.
 */
function termHigh(t: CarbonTerm, useField: boolean): number { return (useField ? t.tCO2eForField! : t.tCO2ePerHa).high; }
function orderBaseline(terms: CarbonTerm[]): CarbonTerm[] {
  const useField = terms.every((t) => t.tCO2eForField !== null);
  return terms.map((t, i) => ({t, i})).sort((a, b) => termHigh(b.t, useField) - termHigh(a.t, useField) || a.i - b.i).map((x) => x.t);
}
function leadPhrase(ordered: readonly CarbonTerm[]): string {
  const useField = ordered.every((t) => t.tCO2eForField !== null);
  const largest = ordered[0]!;
  const total = ordered.reduce((sum, t) => sum + Math.max(0, termHigh(t, useField)), 0);
  const mostly = total > 0 && termHigh(largest, useField) / total >= 0.5;
  return `${mostly ? 'mostly' : 'the largest part from'} ${SOURCE_PHRASE[largest.source]}`;
}

interface RawTerm { source: CarbonTerm['source']; label: string; perHa: NumberRange; method: string; sourceIds: string[] }
interface Baseline {
  terms: RawTerm[]; basis: BasisRef[]; limitations: string[]; missing: FootprintReason[]; seasonDays: number | null; methane: boolean;
  /** The nitrogen rate used includes a contingency or part-dose row (isPartialDose). */
  partialDose: boolean;
  /** With excludePartialDose: the crop has a rate for this state, but every such row is a part dose, so none was used. */
  onlyPartialDose: boolean;
  /** No nitrogen-rate row at all for the farm's district or state (the fertiliser terms are missing). */
  noNitrogenRate: boolean;
}

const factor = (f: FactorRange | null | undefined): NumberRange | null => (f ? {low: f.low, high: f.high} : null);
function spanOf(fs: readonly (FactorRange | null | undefined)[]): NumberRange | null {
  const xs = fs.filter((f): f is FactorRange => !!f);
  return xs.length ? {low: Math.min(...xs.map((f) => f.low)), high: Math.max(...xs.map((f) => f.high))} : null;
}

/**
 * IPCC water-regime scaling for the farm's irrigation category (FOOTPRINT_ASSUMPTIONS.riceWaterRegime): the IPCC aggregated
 * defaults when the file carries them (flagged only for supplemental or unrecorded irrigation), else the fallback rule (flagged).
 */
function waterRegime(k: FootprintConstants, irrigationCategory: string | null): {range: NumberRange | null; label: string; flagged: boolean} {
  const w = k.riceWaterRegimeScaling;
  const cls = irrigationClass(irrigationCategory);
  if (!w) return {range: null, label: 'not sourced', flagged: false};
  const irr = w.aggregatedIrrigated, rain = w.aggregatedRainfed;
  if (cls === 'assured' && irr) return {range: factor(irr), label: 'irrigated, IPCC aggregated default', flagged: false};
  if (cls === 'none' && rain) return {range: factor(rain), label: 'rainfed, IPCC aggregated default', flagged: false};
  if (cls !== 'assured' && cls !== 'none' && irr && rain) {
    return {range: {low: rain.low, high: irr.high}, label: `${cls === 'protective' ? 'supplemental irrigation' : 'irrigation not recorded'} (rainfed to irrigated aggregated defaults)`, flagged: true};
  }
  if (cls === 'none') return {range: spanOf([w.rainfedDroughtProne, w.rainfedRegular]), label: 'rainfed (drought-prone to regular)', flagged: true};
  const lo = w.singleDrainage, hi = w.continuouslyFlooded;
  const r = lo && hi ? {low: Math.min(lo.low, hi.low), high: Math.max(lo.high, hi.high)} : null;
  return {range: r, label: cls === 'assured' ? 'irrigated (single drainage to continuously flooded)' : 'irrigation not recorded (single drainage to continuously flooded)', flagged: true};
}

/** Shortest sourced duration (days) of the crop for the state; the comparison's season length and the no-timeline fallback. */
export function durationLowDays(cropId: string, stateId: string | null, method: string | null = null): number | null {
  const classes = data.durationFor(cropId, method, stateId);
  return classes.length ? Math.min(...classes.map((c) => c.min)) : null;
}

/** Baseline terms per hectare for one crop on this field (the same arithmetic for the growing crop and the comparison). */
function baselineFor(row: FootprintCrop, k: FootprintConstants, gwp: {ch4: number; n2o: number}, ctx: {stateId: string | null; districtId: string | null; irrigationCategory: string | null; seasonDays: number | null; excludePartialDose?: boolean}): Baseline {
  const terms: RawTerm[] = [];
  const basis: BasisRef[] = [];
  const limitations: string[] = [];
  const missing: FootprintReason[] = [];
  const methane = row.methane?.applies === true;
  let seasonDays: number | null = null;

  // Rice methane: EF_c x SF_w x SF_p x season days (kg CH4/ha) x GWP CH4 / 1000 -> tCO2e/ha.
  if (methane) {
    const ef = k.riceMethaneBaselineKgPerHaDay;
    const sfw = waterRegime(k, ctx.irrigationCategory);
    // Straw (IPCC SF_o): fixed factors -> "no straw" to "straw shortly before"; only Equation 5.3 -> the no-amendment case (1).
    const straw = k.ricePreSeasonStrawScaling;
    const strawFixed = !!(straw?.none && straw.strawShortBefore);
    const sfo = straw?.none ? (straw.strawShortBefore ? {low: Math.min(straw.none.low, straw.strawShortBefore.low), high: Math.max(straw.none.high, straw.strawShortBefore.high)} : {low: straw.none.low, high: straw.none.high}) : null;
    // Pre-season water regime (IPCC SF_p, Table 5.13): not recorded, so the IPCC aggregated default for an unknown regime.
    const pre = k.ricePreSeasonWaterScaling?.aggregated ?? null;
    const sfp = pre ? {low: pre.low, high: pre.high} : {low: 1, high: 1};
    seasonDays = ctx.seasonDays !== null && ctx.seasonDays > 0 ? ctx.seasonDays : null;
    if (ef && sfw.range && sfo && seasonDays !== null) {
      const efR = {low: ef.low, high: ef.high};
      const kgCh4 = scale(mul(mul(mul(efR, sfw.range), sfp), sfo), seasonDays);
      terms.push({
        source: 'rice_methane', label: 'Methane from the flooded rice field', perHa: scale(kgCh4, gwp.ch4 / 1000),
        method: `IPCC baseline ${span(efR)} kg CH₄/ha/day x water regime ${span(sfw.range)} (${sfw.label})${pre ? ` x pre-season water ${span(sfp)} (aggregated, not recorded)` : ''} x straw ${span(sfo)} x ${seasonDays} days x GWP ${gwp.ch4} / 1000 = t CO₂e/ha, x field area.`,
        sourceIds: ids(ef.sourceId, k.riceWaterRegimeScaling?.sourceId, pre ? k.ricePreSeasonWaterScaling?.sourceId : null, straw?.sourceId, k.gwp100?.sourceId),
      });
      basis.push(citedBasis('emission_factor', `Rice methane baseline factor ${span(efR)} kg CH₄/ha/day`, ef.sourceId, ef.locator, ef.note ?? null));
      basis.push(citedBasis('emission_factor', `Water-regime scaling ${span(sfw.range)}`, k.riceWaterRegimeScaling?.sourceId, k.riceWaterRegimeScaling?.locator));
      if (pre) basis.push(citedBasis('emission_factor', `Pre-season water scaling ${span(sfp)} (aggregated case)`, k.ricePreSeasonWaterScaling?.sourceId, k.ricePreSeasonWaterScaling?.locator));
      basis.push(citedBasis('emission_factor', `Straw amendment scaling ${span(sfo)}`, straw?.sourceId, straw?.locator));
      if (sfw.flagged) basis.push(footprintAssumptionBasis('riceWaterRegime'));
      basis.push(footprintAssumptionBasis('ricePreSeasonStraw'));
      limitations.push(`Rice methane assumes the water regime "${sfw.label}" and an unknown pre-season straw history; the drainage practice of this field is not recorded.${sfw.flagged ? ` ${FOOTPRINT_ASSUMPTIONS.riceWaterRegime.text}` : ''}`);
      if (!pre) limitations.push('No pre-season water-regime factor is in the data file, so none is applied to the rice methane.');
      if (!strawFixed) limitations.push('Straw ploughed in shortly before the season raises rice methane (IPCC Equation 5.3), but the straw amount is not recorded, so no straw amendment is included and the high end may be understated.');
    } else {
      missing.push('methane_inputs_missing');
      limitations.push(seasonDays === null ? 'The rice methane term is omitted: no harvest window or sourced duration gives the season length.' : 'The rice methane term is omitted: an IPCC methane factor is missing from the data file.');
    }
  }

  // Fertiliser nitrogen: the recommended rate of the state (district first), as printed. The pool comparison leaves out part
  // doses (isPartialDose) so that no crop is understated against the others.
  const nRows = ctx.excludePartialDose ? row.nitrogenRateKgPerHa.filter((r) => !isPartialDose(r)) : row.nitrogenRateKgPerHa;
  const n = regional(nRows, ctx, false);
  const anyRate = regional(row.nitrogenRateKgPerHa, ctx, false) !== null;
  const onlyPartialDose = !!ctx.excludePartialDose && !n && anyRate;
  const noNitrogenRate = !anyRate;
  const partialDose = !!n && n.rows.some((r) => isPartialDose(r));
  if (n) {
    const rate = n.range;
    basis.push(citedBasis('emission_factor', `Recommended nitrogen ${span(rate)} kg N/ha (${n.row.region})`, n.row.sourceId, n.row.locator, [spannedNote(n.count, n.row.region), n.row.note].filter(Boolean).join(' ') || null, more(n.row)));
    if (partialDose) limitations.push(`The nitrogen rate for ${n.row.region} is a contingency figure (a part dose, not the full recommended dose), so the fertiliser emissions of this crop are understated, here and in the comparison.`);
    // Direct N2O: N x EF1 (flooded rice factor for rice) x 44/28 x GWP N2O / 1000.
    const efSet = k.n2oEf1;
    const ef1 = methane ? efSet?.floodedRice : efSet?.default;
    if (ef1) {
      const conv = k.n2oNToN2o?.value ?? N_TO_N2O;
      const efR = factor(ef1)!;
      terms.push({
        source: 'fertiliser_n2o', label: 'Nitrous oxide from fertiliser nitrogen', perHa: scale(mul(rate, efR), conv * gwp.n2o / 1000),
        method: `${span(rate)} kg N/ha x EF1 ${span(efR)} (${methane ? 'flooded rice' : 'default'}) x ${conv} (N to N₂O) x GWP ${gwp.n2o} / 1000 = t CO₂e/ha, x field area.`,
        sourceIds: ids(n.row.sourceId, efSet?.sourceId, k.gwp100?.sourceId, more(n.row)),
      });
      basis.push(citedBasis('emission_factor', `N₂O emission factor EF1 ${span(efR)}`, efSet?.sourceId, efSet?.locator));
      limitations.push(UREA_CO2_LIMITATION);
    } else limitations.push('The fertiliser nitrous oxide term is omitted: the IPCC EF1 factor is missing from the data file.');
    // Fertiliser manufacture: only with a sourced embodied factor.
    const u = k.ureaManufactureKgCo2ePerKgN;
    if (u && u.low !== null && u.high !== null && u.sourceId && u.low <= u.high) {
      const f = {low: u.low, high: u.high};
      terms.push({
        source: 'fertiliser_manufacture', label: 'Making the nitrogen fertiliser', perHa: scale(mul(rate, f), 1 / 1000),
        method: `${span(rate)} kg N/ha x ${span(f)} kg CO₂e per kg N (manufacture) / 1000 = t CO₂e/ha, x field area.`, sourceIds: ids(u.sourceId, n.row.sourceId),
      });
      basis.push(citedBasis('emission_factor', `Fertiliser manufacture ${span(f)} kg CO₂e/kg N`, u.sourceId, u.locator, u.note ?? null));
    } else limitations.push('Emissions from making the fertiliser are not included: no cited factor for urea nitrogen is in the data file.');
  } else {
    missing.push('nitrogen_rate_not_sourced');
    limitations.push('No recommended nitrogen rate for this state is sourced, so the fertiliser emissions are not included.');
  }

  // Fuel and machinery: only when the energy study prints diesel litres.
  const d = row.energyInput?.dieselLitresPerHa;
  const dLo = d?.low ?? d?.high ?? null, dHi = d?.high ?? d?.low ?? null;
  if (dLo !== null && dHi !== null && dLo <= dHi && k.dieselKgCo2PerLitre) {
    const litres = {low: dLo, high: dHi};
    terms.push({
      source: 'fuel_and_machinery', label: 'Diesel for machinery', perHa: scale(litres, k.dieselKgCo2PerLitre.value / 1000),
      method: `${span(litres)} litres diesel/ha (energy study) x ${k.dieselKgCo2PerLitre.value} kg CO₂/litre / 1000 = t CO₂e/ha, x field area.`, sourceIds: ids(row.energyInput?.sourceId, k.dieselKgCo2PerLitre.sourceId, more(row.energyInput), more(k.dieselKgCo2PerLitre)),
    });
    basis.push(citedBasis('emission_factor', `Diesel ${k.dieselKgCo2PerLitre.value} kg CO₂/litre`, k.dieselKgCo2PerLitre.sourceId, k.dieselKgCo2PerLitre.locator, null, more(k.dieselKgCo2PerLitre)));
  } else limitations.push('Fuel and machinery emissions are not included: the energy study for this crop prints no diesel use.');
  return {terms, basis, limitations, missing, seasonDays, methane, partialDose, onlyPartialDose, noNitrogenRate};
}

const SOURCE_PHRASE: Record<CarbonTerm['source'], string> = {
  rice_methane: 'methane from the flooded field', fertiliser_n2o: 'nitrous oxide from fertiliser nitrogen', fertiliser_manufacture: 'making the fertiliser',
  fuel_and_machinery: 'diesel for machinery', residue_burning: 'burning the residue', residue_carbon: 'residue carbon', other: 'other sources',
};

function emptyCarbon(reason: FootprintReason, area: number | null, extra: string[] = []): CarbonFootprint {
  return {
    status: 'unavailable', reason, fieldAreaHa: area, seasonDays: null, emissionsForField: null, emissionsPerHa: null, terms: [], residueScenarios: [],
    comparison: null, gwp: null, summary: cap(`No carbon footprint is shown: ${FOOTPRINT_REASONS[reason].replace(/\.$/, '').replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase())}.`, 300), basis: [], limitations: dedupe([FOOTPRINT_REASONS[reason], ...extra]),
  };
}

/** Season emissions of the growing crop on this field (baseline terms), the residue scenarios and the pool comparison. */
export function carbonFootprint(i: FootprintInput): CarbonFootprint {
  const area = validArea(i.areaHa);
  const row = footprintCrop(i.cropId);
  if (!row) return emptyCarbon('crop_not_in_footprint_data', area);
  const k = footprintConstants();
  const g = k.gwp100;
  if (!g) return emptyCarbon('gwp_not_sourced', area);
  const gwp = {ch4: g.ch4, n2o: g.n2o};
  const gwpBlock = {ch4: g.ch4, n2o: g.n2o, basis: cap(`${footprintSource(g.sourceId)?.title ?? g.sourceId ?? 'GWP source not named'}${g.locator ? `, ${g.locator}` : ''}: GWP100${g.note ? ` (${g.note})` : ''}`, 160)};
  const ctx = {stateId: i.stateId, districtId: i.districtId, irrigationCategory: i.irrigationCategory};
  const ownDays = i.seasonDays ?? durationLowDays(i.cropId, i.stateId, i.establishmentMethod ?? null);
  const own = baselineFor(row, k, gwp, {...ctx, seasonDays: ownDays});
  const basis: BasisRef[] = [citedBasis('emission_factor', `GWP100 CH₄ ${g.ch4}, N₂O ${g.n2o}`, g.sourceId, g.locator, g.note ?? null), ...own.basis];
  const limitations: string[] = [...CARBON_ALWAYS, ...own.limitations];
  if (own.methane && i.seasonDays === null && ownDays !== null) limitations.push(`No harvest window is known; the season length is the shortest sourced duration (${ownDays} days).`);
  if (own.methane && i.seasonDays !== null) limitations.push('The season runs from the recorded establishment date to the earliest harvest date; nursery days are not included.');
  if (!own.terms.length) return emptyCarbon('emission_inputs_not_sourced', area, own.limitations);
  const perHa = own.terms.reduce((s, t) => add(s, t.perHa), {low: 0, high: 0});
  const name = i.cropName.trim() || data.cropDisplayName(i.cropId);
  const partial = own.missing.length > 0;

  if (area === null) {
    // No area: the baseline terms per hectare with a null field figure; residue scenarios and the comparison need the area.
    const ph = t2(perHa);
    const perHaTerms = orderBaseline(own.terms.map((t): CarbonTerm => ({source: t.source, label: cap(t.label, 80), tCO2eForField: null, tCO2ePerHa: t2(t.perHa), method: cap(t.method, 400), kind: 'baseline', sourceIds: t.sourceIds})));
    const lead = leadPhrase(perHaTerms);
    return {
      status: 'partial', reason: 'field_area_missing', fieldAreaHa: null, seasonDays: own.seasonDays, emissionsForField: null, emissionsPerHa: ph, terms: perHaTerms.slice(0, 10), residueScenarios: [], comparison: null, gwp: gwpBlock,
      summary: cap(`${name}: about ${span(ph)} t CO₂e per hectare this season, ${lead}; no field area is recorded.`, 300),
      basis: uniqBasis(basis), limitations: dedupe([FOOTPRINT_REASONS.field_area_missing, ...limitations]),
    };
  }

  const terms: CarbonTerm[] = orderBaseline(own.terms.map((t): CarbonTerm => ({source: t.source, label: cap(t.label, 80), tCO2eForField: t2(scale(t.perHa, area)), tCO2ePerHa: t2(t.perHa), method: cap(t.method, 400), kind: 'baseline', sourceIds: t.sourceIds})));
  const lead = leadPhrase(terms);
  const emissions = scale(perHa, area);
  const emissionsForField = t2(emissions);

  // Residue scenarios on top of the baseline; the whole residue of the field (burning happens in the field).
  const scenarios: ResidueScenario[] = [];
  const rc = residueCalc(i);
  if (rc.ok) {
    const res = rc.value.residueForFieldKg;
    const rname = rc.value.residue.name;
    const b = k.residueBurning;
    if (b) {
      // Combustion factor: the residue's own Table 2.6 entry when the file has one (rice 0.80), else the envelope.
      const cf = combustionFactorFor(b, i.cropId);
      const cfText = `${span(cf.range)}${cf.key ? ` (${cf.key} residue)` : ' (range; no factor for this residue)'}`;
      const burnt = mul(res, cf.range);
      const t = scale(burnt, (b.ch4GPerKgDm * gwp.ch4 + b.n2oGPerKgDm * gwp.n2o) / 1e6);
      terms.push({
        source: 'residue_burning', label: cap(`Burning the ${rname}`, 80), tCO2eForField: t2(t), tCO2ePerHa: t2(scale(t, 1 / area)), kind: 'scenario', sourceIds: ids(b.sourceId, rc.value.residue.rpr.sourceId, more(rc.value.residue.rpr)),
        method: cap(`${span(kg(res))} kg ${rname}, ${AIR_DRY}, x combustion factor ${cfText} x (${b.ch4GPerKgDm} g CH₄ x ${gwp.ch4} + ${b.n2oGPerKgDm} g N₂O x ${gwp.n2o}) per kg / 1,000,000 = t CO₂e.`, 400),
      });
      scenarios.push({id: 'burn', label: cap(`Burn the ${rname}`, 80), netForField: t2(add(emissions, t)), note: `Adds the methane and nitrous oxide of burning; the carbon dioxide of burning is counted as biogenic by IPCC convention and is not in the figure. The IPCC factors are per kg dry matter and are applied to residue that is ${AIR_DRY}, so the figure is somewhat overstated. Burning also releases smoke and particles that harm health.`});
      basis.push(citedBasis('emission_factor', `Residue burning: ${b.ch4GPerKgDm} g CH₄ and ${b.n2oGPerKgDm} g N₂O per kg dry matter (IPCC basis), combustion factor ${cfText}`, b.sourceId, b.locator));
    } else limitations.push('The burning scenario is not shown: the IPCC residue-burning factors are missing from the data file.');
    const cf = k.biomassCarbonFraction;
    if (cf) {
      const ret = k.residueCarbonRetentionFraction;
      const conv = k.cToCo2?.value ?? C_TO_CO2;
      const held = scale(mul(res, {low: cf.low, high: cf.high}), conv / 1000);
      const kept = ret ? mul(held, {low: ret.low, high: ret.high}) : held;
      const t = {low: -kept.high, high: -kept.low};
      terms.push({
        source: 'residue_carbon', label: cap(`Carbon held in the ${rname}`, 80), tCO2eForField: t2(t), tCO2ePerHa: t2(scale(t, 1 / area)), kind: 'scenario', sourceIds: ids(cf.sourceId, ret?.sourceId, rc.value.residue.rpr.sourceId, more(cf), more(ret), more(rc.value.residue.rpr)),
        method: cap(`minus ${span(kg(res))} kg ${rname}, ${AIR_DRY}, x carbon fraction ${span({low: cf.low, high: cf.high})} x ${conv} (C to CO₂)${ret ? ` x retained share ${span({low: ret.low, high: ret.high})}` : ''} / 1000 = t CO₂e.`, 400),
      });
      // Orchestrator decision 2026-11-02: the residue carbon is shown as its own (negative) term but never netted against the
      // baseline; the net equals the baseline (burning avoided, nothing credited).
      scenarios.push({
        id: 'incorporate', label: cap(`Plough the ${rname} in`, 80), netForField: emissionsForField,
        note: 'Carbon the straw holds; not counted in the net because the share that stays in the soil is not estimated, and straw ploughed in raises next season\'s rice methane. Burning is avoided; nothing is credited.',
      });
      basis.push(citedBasis('emission_factor', `Carbon fraction of dry biomass ${span({low: cf.low, high: cf.high})} (applied to residue that is ${AIR_DRY})`, cf.sourceId, cf.locator, null, more(cf)));
    } else limitations.push('The ploughing-in scenario is not shown: no biomass carbon fraction is in the data file.');
    const uses = new Set(rc.value.residue.uses.map((u) => u.use));
    const sold = 'Avoids burning; the fuel or feed it replaces is not credited here.';
    if (uses.has('cbg_feedstock')) scenarios.push({id: 'sell_cbg', label: 'Sell for compressed biogas', netForField: emissionsForField, note: sold});
    if (uses.has('dry_fodder')) scenarios.push({id: 'sell_fodder', label: 'Sell or use as dry fodder', netForField: emissionsForField, note: sold});
    basis.push(...rc.value.basis.filter((x) => x.label.startsWith('Residue')));
  } else limitations.push(`Residue scenarios are not shown: ${FOOTPRINT_REASONS[rc.reason].replace(/\.$/, '').toLowerCase()}.`);

  // Pool comparison: every pool crop with a footprint row, the same field, state and regime assumptions.
  const {comparison, excludedPartial, excludedNoRate, keptNoRate} = poolComparison(i, k, gwp, area, perHa);
  if (comparison) { limitations.push(FOOTPRINT_ASSUMPTIONS.comparisonRank.text); basis.push(footprintAssumptionBasis('comparisonRank')); }
  const listOf = (xs: readonly string[]) => (xs.length === 1 ? xs[0]! : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
  const stateName = i.stateId ?? 'the farm\'s state';
  if (excludedPartial.length) {
    const one = excludedPartial.length === 1;
    limitations.push(`${listOf(excludedPartial)} ${one ? 'is' : 'are'} left out of the crop comparison: the only nitrogen rate sourced for ${one ? 'it' : 'them'} in this state is a contingency or part dose, which would understate ${one ? 'it' : 'them'}, so fewer crops are compared.`);
  }
  if (excludedNoRate.length) {
    const one = excludedNoRate.length === 1;
    limitations.push(`${listOf(excludedNoRate)} ${one ? 'is' : 'are'} left out of the crop comparison: no nitrogen rate is sourced for ${stateName}, so ${one ? 'its' : 'their'} emissions would be understated.`);
  }
  if (keptNoRate.length) {
    const one = keptNoRate.length === 1;
    limitations.push(`${listOf(keptNoRate)} ${one ? 'is' : 'are'} kept in the crop comparison although no nitrogen rate is sourced for ${stateName}, because no other crop could be compared; ${one ? 'its' : 'their'} emissions are understated.`);
  }

  const other = comparison?.lowest && comparison.lowest.cropId !== i.cropId ? comparison.lowest : null;
  const tail = other
    ? `; ${other.cropName.toLowerCase()} on the same area would be about ${span(other.tCO2eForField)}`
    : comparison && comparison.of > 1 ? `; the lowest of the ${comparison.of} crops compared on this field` : '';
  const summary = `${name} on ${area} ha: about ${span(emissionsForField)} t CO₂e this season, ${lead}${tail}.`;
  return {
    status: partial ? 'partial' : 'available', reason: partial ? own.missing[0]! : null, fieldAreaHa: area, seasonDays: own.seasonDays,
    emissionsForField, emissionsPerHa: t2(perHa), terms: terms.slice(0, 10), residueScenarios: scenarios.slice(0, 4), comparison, gwp: gwpBlock,
    summary: cap(summary, 300), basis: uniqBasis(basis), limitations: dedupe(limitations),
  };
}

/**
 * Rank of the growing crop among the pool crops with a footprint row and at least one baseline term (1 = lowest per hectare).
 * The growing crop's own figure is its baseline above (same arithmetic, its own season length); every other crop uses its
 * shortest sourced duration for the methane season. Another crop's part-dose nitrogen rows (isPartialDose) are not used; a
 * crop whose only rate for the state is a part dose is left out (named in `excludedPartial`) rather than understated. A crop
 * with no nitrogen rate at all for the farm's district or state, but some other term (methane, diesel), is left out the same
 * way (`excludedNoRate`), unless every other crop would then be gone: then those crops are kept and named (`keptNoRate`). A
 * crop with no term at all has no figure and is skipped silently, as before. The growing crop is always kept (its own
 * limitations say when its rate is a part dose or missing). Null when fewer than two crops have a figure.
 */
function poolComparison(i: FootprintInput, k: FootprintConstants, gwp: {ch4: number; n2o: number}, area: number, ownPerHa: NumberRange): {comparison: PoolComparison | null; excludedPartial: string[]; excludedNoRate: string[]; keptNoRate: string[]} {
  const ctx = {stateId: i.stateId, districtId: i.districtId, irrigationCategory: i.irrigationCategory};
  const pool = new Set(data.poolEntries().map((p) => p.cropId));
  const figures: {cropId: string; cropName: string; perHa: NumberRange}[] = [{cropId: i.cropId, cropName: i.cropName.trim() || data.cropDisplayName(i.cropId), perHa: ownPerHa}];
  const excludedPartial: string[] = [];
  const noRate: typeof figures = [];
  for (const row of footprintCrops()) {
    if (row.cropId === i.cropId || !pool.has(row.cropId)) continue;
    const b = baselineFor(row, k, gwp, {...ctx, seasonDays: durationLowDays(row.cropId, i.stateId), excludePartialDose: true});
    if (b.onlyPartialDose) { excludedPartial.push(data.cropDisplayName(row.cropId)); continue; }
    if (!b.terms.length) continue;
    const f = {cropId: row.cropId, cropName: data.cropDisplayName(row.cropId), perHa: b.terms.reduce((s, t) => add(s, t.perHa), {low: 0, high: 0})};
    (b.noNitrogenRate ? noRate : figures).push(f);
  }
  // Leaving out the crops without a rate would leave nothing to compare against: keep them and say so.
  const keep = figures.length < 2 && noRate.length > 0;
  if (keep) figures.push(...noRate);
  const excludedNoRate = keep ? [] : noRate.map((f) => f.cropName);
  const keptNoRate = keep ? noRate.map((f) => f.cropName) : [];
  if (figures.length < 2) return {comparison: null, excludedPartial, excludedNoRate, keptNoRate};
  figures.sort((a, b) => mid(a.perHa) - mid(b.perHa) || a.cropId.localeCompare(b.cropId));
  const out = (f: typeof figures[number]) => ({cropId: cap(f.cropId, 120), cropName: cap(f.cropName, 120), tCO2eForField: t2(scale(f.perHa, area))});
  return {comparison: {rank: figures.findIndex((f) => f.cropId === i.cropId) + 1, of: figures.length, lowest: out(figures[0]!), highest: out(figures.at(-1)!)}, excludedPartial, excludedNoRate, keptNoRate};
}

// ------------------------------------------------------------------ farm facts

/** The irrigation category the year plan reads (year-plan/scenario.ts buildScenario lines 202 to 203, through its factValue). */
export function irrigationCategoryOf(facts: ScenarioFarm['facts']): string | null {
  const farm: ScenarioFarm = {location: {stateCode: null, districtId: null}, areaHectares: null, facts};
  const v = factValue(farm, facts?.irrigation_category ? 'irrigation_category' : 'irrigation');
  return typeof v === 'string' ? v.slice(0, 80) : null;
}
