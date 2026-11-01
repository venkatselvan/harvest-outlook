import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/catalogue/files';
import { SOIL_RATINGS_FILE, SOIL_RATINGS_VERSION, loadSoilRatings, parseSoilRatings, rateMarker, rateMarkerAssumed, rateMarkerAssumedWith, rateMarkerWith, soilRatingSources, type RatableMarker } from '../src/services/soil-ratings';

/** Rating boundaries are asserted as the cited sources print them, so a changed band fails here before it reaches a farmer. */
function marker(parameter: string, value: number | null, unit: string | null, extra: Partial<RatableMarker> = {}): RatableMarker {
  return {
    id: `m-${parameter}`, parameter: parameter as RatableMarker['parameter'], rawLabel: parameter, rawValue: String(value), rawUnit: unit,
    numericValue: value, qualifier: 'exact', range: null, analyteForm: null, method: null, extractant: null, soilWaterRatio: null, temperatureC: null,
    matrix: 'soil', massBasis: null, reportedRating: null, reportedReference: null,
    evidence: { page: 1, quote: 'x', nativeTextCheck: 'matched' }, extractionConfidence: 'high', warnings: [],
    canonical: { value, unit, conversion: null, missingReason: null },
    reviewStatus: 'confirmed', confirmedAt: '2026-11-01T00:00:00.000Z', ...extra,
  } as RatableMarker;
}
const rating = (m: RatableMarker) => rateMarker(m).rating;

describe('soil rating boundaries exactly as the sources state them', () => {
  // [parameter, unit, value, expected rating]
  const cases: [string, string, number, string][] = [
    ['organic_carbon', '%', 0.49, 'low'], ['organic_carbon', '%', 0.5, 'medium'], ['organic_carbon', '%', 0.75, 'medium'], ['organic_carbon', '%', 0.7501, 'high'],
    ['nitrogen_available', 'kg/ha', 279.9, 'low'], ['nitrogen_available', 'kg/ha', 280, 'medium'], ['nitrogen_available', 'kg/ha', 560, 'medium'], ['nitrogen_available', 'kg/ha', 560.1, 'high'],
    ['phosphorus_available', 'kg/ha', 9.99, 'low'], ['phosphorus_available', 'kg/ha', 10, 'medium'], ['phosphorus_available', 'kg/ha', 24.6, 'medium'], ['phosphorus_available', 'kg/ha', 24.61, 'high'],
    ['potassium_available', 'kg/ha', 107.9, 'low'], ['potassium_available', 'kg/ha', 108, 'medium'], ['potassium_available', 'kg/ha', 280, 'medium'], ['potassium_available', 'kg/ha', 280.1, 'high'],
    ['ph', 'pH', 5.59, 'strongly_acidic'], ['ph', 'pH', 5.6, 'acidic'], ['ph', 'pH', 6.59, 'acidic'], ['ph', 'pH', 6.6, 'neutral'], ['ph', 'pH', 7.2, 'neutral'], ['ph', 'pH', 7.39, 'neutral'],
    ['ph', 'pH', 7.4, 'alkaline'], ['ph', 'pH', 8.49, 'alkaline'], ['ph', 'pH', 8.5, 'strongly_alkaline'],
    ['electrical_conductivity', 'dS/m', 0.86, 'normal'], ['electrical_conductivity', 'dS/m', 0.99, 'normal'], ['electrical_conductivity', 'dS/m', 1, 'critical'], ['electrical_conductivity', 'dS/m', 2, 'critical'], ['electrical_conductivity', 'dS/m', 4, 'critical'], ['electrical_conductivity', 'dS/m', 4.01, 'injurious'],
    ['zinc_available', 'mg/kg', 0.59, 'deficient'], ['zinc_available', 'mg/kg', 0.6, 'sufficient'],
    ['manganese_available', 'mg/kg', 1.99, 'deficient'], ['manganese_available', 'mg/kg', 2, 'sufficient'],
    ['copper_available', 'mg/kg', 0.19, 'deficient'], ['copper_available', 'mg/kg', 0.2, 'sufficient'],
    ['iron_available', 'mg/kg', 2.49, 'deficient'], ['iron_available', 'mg/kg', 2.5, 'critical'], ['iron_available', 'mg/kg', 4.5, 'critical'], ['iron_available', 'mg/kg', 4.51, 'sufficient'],
    ['boron_available', 'mg/kg', 0.49, 'deficient'], ['boron_available', 'mg/kg', 0.5, 'sufficient'],
    ['sulphur_available', 'mg/kg', 9.99, 'deficient'], ['sulphur_available', 'mg/kg', 10, 'sufficient'],
  ];
  it.each(cases)('%s %s at %s rates %s', (parameter, unit, value, expected) => {
    expect(rating(marker(parameter, value, unit))).toBe(expected);
  });

  it('returns the cited source, bands, axis and the rated value for a rated marker', () => {
    const r = rateMarker(marker('ph', 7.2, 'pH'));
    expect(r.status).toBe('rated');
    expect(r.ratedValue).toBe(7.2);
    expect(r.ratedUnit).toBe('pH');
    expect(r.source).toMatchObject({ id: 'nrcs-ssm-2017-table-3-15', verified: true });
    expect(r.bands.map(b => b.label)).toEqual(['strongly_acidic', 'acidic', 'neutral', 'alkaline', 'strongly_alkaline']);
    expect(r.axis).toEqual({ min: 4, max: 10 });
  });

  it('bands are contiguous, open at both ends, and the axis covers every finite limit', () => {
    for (const profile of loadSoilRatings().profiles) {
      const bands = profile.bands;
      expect(bands[0]!.from, profile.id).toBeNull();
      expect(bands.at(-1)!.to, profile.id).toBeNull();
      for (let i = 0; i < bands.length - 1; i++) expect(bands[i]!.to, `${profile.id} band ${i}`).toBe(bands[i + 1]!.from);
      for (const b of bands) for (const limit of [b.from, b.to]) if (limit !== null) { expect(limit).toBeGreaterThan(profile.axis.min); expect(limit).toBeLessThan(profile.axis.max); }
    }
  });
});

describe('forms and conversions', () => {
  it('rates phosphorus and potassium named as P2O5 and K2O on the oxide bands', () => {
    const p = (v: number) => rateMarker(marker('phosphorus_available', v, 'kg/ha', { rawLabel: 'Available Phosphorus (P2O5)' }));
    expect(p(22.8).rating).toBe('low');
    expect(p(22.9).rating).toBe('medium');
    expect(p(56.334).rating).toBe('medium');
    expect(p(56.34).rating).toBe('high');
    expect(p(30).ratedUnit).toBe('kg P2O5/ha');
    const k = (v: number) => rateMarker(marker('potassium_available', v, 'kg/ha', { analyteForm: 'K2O' }));
    expect(k(129.5).rating).toBe('low');
    expect(k(129.6).rating).toBe('medium');
    expect(k(336).rating).toBe('medium');
    expect(k(336.1).rating).toBe('high');
    expect(k(200).ratedUnit).toBe('kg K2O/ha');
  });

  it('oxide bands equal the element bands times the verified conversion factor', () => {
    const data = loadSoilRatings();
    for (const oxide of data.profiles.filter(p => p.derivedFrom)) {
      const parent = data.profiles.find(p => p.id === oxide.derivedFrom!.profile)!;
      const conversion = data.conversions.find(c => c.id === oxide.derivedFrom!.conversionId)!;
      expect(conversion.verified).toBe(true);
      expect(oxide.derivedFrom!.factor).toBe(conversion.factor);
      expect(oxide.bands.length).toBe(parent.bands.length);
      oxide.bands.forEach((b, i) => {
        const e = parent.bands[i]!;
        if (e.to === null) expect(b.to).toBeNull(); else expect(b.to).toBeCloseTo(e.to * conversion.factor, 6);
        if (e.from === null) expect(b.from).toBeNull(); else expect(b.from).toBeCloseTo(e.from * conversion.factor, 6);
      });
    }
    expect(data.conversions.find(c => c.id === 'p_to_p2o5')!.factor).toBe(2.29);
    expect(data.conversions.find(c => c.id === 'k_to_k2o')!.factor).toBe(1.2);
  });

  it('rates elemental P without a named form and says so', () => {
    const r = rateMarker(marker('phosphorus_available', 12, 'kg/ha'));
    expect(r.rating).toBe('medium');
    expect(r.ratedUnit).toBe('kg P/ha');
    expect(r.note).toMatch(/elemental P/);
  });

  it('does not convert mg/kg macronutrients to kg/ha because the 2.24 factor is unverified', () => {
    for (const parameter of ['nitrogen_available', 'phosphorus_available', 'potassium_available']) {
      const r = rateMarker(marker(parameter, 12, 'mg/kg'));
      expect(r.status, parameter).toBe('unit_mismatch');
      expect(r.rating).toBe('unrated');
      expect(r.note).toMatch(/2\.24/);
    }
    const conv = loadSoilRatings().conversions.find(c => c.id === 'ppm_to_kg_ha')!;
    expect(conv.verified).toBe(false);
  });

  it('treats a micronutrient in kg/ha, or an exact ppm result with no canonical value, as unit_mismatch', () => {
    expect(rateMarker(marker('zinc_available', 1.2, 'kg/ha')).status).toBe('unit_mismatch');
    const ppm = marker('zinc_available', 0.8, 'ppm', { canonical: { value: null, unit: null, conversion: null, missingReason: 'ppm matrix and measurement basis require review; no concentration conversion was inferred.' } });
    const r = rateMarker(ppm);
    expect(r.status).toBe('unit_mismatch');
    expect(r.note).toMatch(/ppm/);
  });
});

describe('markers that are never rated', () => {
  it('excludes unconfirmed markers and non-soil matrices', () => {
    expect(rateMarker(marker('ph', 7, 'pH', { reviewStatus: 'pending', confirmedAt: null })).status).toBe('unrated');
    expect(rateMarker(marker('ph', 7, 'pH', { matrix: 'water' })).status).toBe('unrated');
    expect(rateMarker(marker('ph', 7, 'pH', { matrix: 'unknown' })).rating).toBe('unrated');
  });

  it('marks ranges, limits and below-detection results as qualifier even when a canonical value exists', () => {
    for (const qualifier of ['less_than', 'greater_or_equal', 'range', 'below_detection', 'text', 'unreadable'] as const) {
      const r = rateMarker(marker('organic_carbon', 0.4, '%', { qualifier }));
      expect(r.status, qualifier).toBe('qualifier');
      expect(r.rating).toBe('unrated');
      expect(r.bands).toEqual([]);
    }
    expect(rateMarker(marker('ph', null, null, { qualifier: 'exact', numericValue: null, canonical: { value: null, unit: null, conversion: null, missingReason: 'x' } })).status).toBe('qualifier');
  });

  it('never rates organic matter, unspecified or total nutrients, or parameters without a cited band', () => {
    for (const parameter of ['organic_matter', 'nitrogen_unspecified', 'nitrogen_total', 'phosphorus_total', 'potassium_total', 'cec', 'unknown_other']) {
      const r = rateMarker(marker(parameter, 10, '%'));
      expect(r.status, parameter).toBe('unrated');
      expect(r.source).toBeNull();
    }
  });

  it('does not rate a marker with unresolved warnings or low extraction confidence, but accepts the routine scan notice', () => {
    expect(rateMarker(marker('ph', 7, 'pH', { warnings: ['Two different readings were printed for pH.'] })).status).toBe('unrated');
    expect(rateMarker(marker('ph', 7, 'pH', { extractionConfidence: 'low' })).status).toBe('unrated');
    expect(rateMarker(marker('ph', 7, 'pH', { warnings: ['Verify this result and sample assignment against the original page before confirming.'] })).status).toBe('rated');
  });

  it('does not rate when the stated method is not the one the band is defined for', () => {
    expect(rateMarker(marker('phosphorus_available', 12, 'kg/ha', { method: 'Bray No. 1' })).status).toBe('unrated');
    expect(rateMarker(marker('phosphorus_available', 12, 'kg/ha', { method: 'Olsen (0.5 M NaHCO3)' })).rating).toBe('medium');
    expect(rateMarker(marker('ph', 6.1, 'pH', { method: 'pH in 0.01 M CaCl2' })).status).toBe('unrated');
    expect(rateMarker(marker('zinc_available', 0.3, 'mg/kg', { extractant: '0.1 N HCl' })).status).toBe('unrated');
    expect(rateMarker(marker('zinc_available', 0.3, 'mg/kg', { extractant: 'DTPA' })).rating).toBe('deficient');
    expect(rateMarker(marker('zinc_available', 0.3, 'mg/kg')).note).toMatch(/does not state the extractant/);
  });
});

describe('verification gate and the ratings file', () => {
  const raw = () => JSON.parse(readFileSync(resolve(REPO_ROOT, SOIL_RATINGS_FILE), 'utf8'));

  it('an unverified source or conversion rates nothing', () => {
    const data = raw();
    data.sources.find((s: { id: string }) => s.id === 'dac-2011-table-1').verified = false;
    const unverified = parseSoilRatings(data);
    for (const [parameter, unit] of [['organic_carbon', '%'], ['nitrogen_available', 'kg/ha'], ['potassium_available', 'kg/ha']] as const) {
      const r = rateMarkerWith(marker(parameter, 100, unit), unverified);
      expect(r.status, parameter).toBe('unrated');
      expect(r.rating).toBe('unrated');
      expect(r.note).toMatch(/not verified/);
    }
    expect(rateMarkerWith(marker('ph', 7, 'pH'), unverified).rating).toBe('neutral');

    const data2 = raw();
    data2.conversions.find((c: { id: string }) => c.id === 'p_to_p2o5').verified = false;
    const r2 = rateMarkerWith(marker('phosphorus_available', 30, 'kg/ha', { analyteForm: 'P2O5' }), parseSoilRatings(data2));
    expect(r2.status).toBe('unrated');
    expect(r2.note).toMatch(/conversion/);
  });

  it('SOIL_RATINGS_VERSION matches the file and every profile cites a source that exists', () => {
    const data = loadSoilRatings();
    expect(SOIL_RATINGS_VERSION).toBe(data.version);
    for (const p of data.profiles) expect(data.sources.some(s => s.id === p.sourceId), p.id).toBe(true);
  });

  it('soilRatingSources lists every source with a locator and keeps the unverified one flagged', () => {
    const sources = soilRatingSources();
    expect(sources.length).toBeGreaterThanOrEqual(5);
    for (const s of sources) { expect(s.title.length).toBeGreaterThan(0); expect(s.locator).toBeTruthy(); }
    expect(sources.find(s => s.id === 'convention-ppm-kg-ha-2.24')!.verified).toBe(false);
    expect(sources.filter(s => s.verified).map(s => s.id)).toEqual(expect.arrayContaining(['dac-2011-table-1', 'dac-2011-table-6', 'nrcs-ssm-2017-table-3-15', 'tnau-soil-rating-chart']));
  });
});

describe('rateMarkerAssumed: flagged inferences for forms the report does not print (Hassan-like markers)', () => {
  const hassan = {
    ph: marker('ph', 7.2, 'pH'),
    ec: marker('electrical_conductivity', 0.86, 'dS/m', { rawUnit: 'ds/m' }),
    nUnspecified: marker('nitrogen_unspecified', 278, 'kg/ha', { rawLabel: 'Nitrogen' }),
    om: marker('organic_matter', 2.4, '%', { rawLabel: 'Total organic matter' }),
    totalP: marker('phosphorus_total', 16, 'kg/ha', { rawLabel: 'Total Phosphorus' }),
    totalK: marker('potassium_total', 186, 'kg/ha', { rawLabel: 'Total potassium' }),
  };

  it('strict rateMarker still refuses the three inferred forms; assumed rates them with a non-null assumption', () => {
    for (const m of [hassan.nUnspecified, hassan.om, hassan.totalP, hassan.totalK]) {
      expect(rateMarker(m).status, m.parameter).toBe('unrated');
      expect(rateMarkerAssumed(m).status, m.parameter).toBe('rated');
      expect(rateMarkerAssumed(m).assumption, m.parameter).toBeTruthy();
    }
  });

  it('pH and EC rate exactly as before and carry no assumption', () => {
    for (const [m, expected] of [[hassan.ph, 'neutral'], [hassan.ec, 'normal']] as const) {
      const r = rateMarkerAssumed(m);
      expect(r).toMatchObject({ status: 'rated', rating: expected, assumption: null });
      expect(r.rating).toBe(rateMarker(m).rating);
    }
  });

  it('unspecified nitrogen in kg/ha rates as available N on the alkaline-permanganate bands (278 is low, below 280)', () => {
    const r = rateMarkerAssumed(hassan.nUnspecified);
    expect(r).toMatchObject({ status: 'rated', rating: 'low', ratedValue: 278, ratedUnit: 'kg/ha', profileId: 'n' });
    expect(r.assumption).toMatch(/available N \(alkaline permanganate\)/);
    expect(r.source?.id).toBe('dac-2011-table-1');
    expect(rateMarkerAssumed({ ...hassan.nUnspecified, canonical: { ...hassan.nUnspecified.canonical, value: 280 } }).rating).toBe('medium');
  });

  it('total P and total K in kg/ha rate as available P (Olsen) and K (ammonium acetate) and say the label was total', () => {
    const p = rateMarkerAssumed(hassan.totalP);
    expect(p).toMatchObject({ status: 'rated', rating: 'medium', ratedUnit: 'kg P/ha', profileId: 'p' });
    expect(p.assumption).toMatch(/Total Phosphorus/);
    expect(p.assumption).toMatch(/available P \(Olsen\)/);
    const k = rateMarkerAssumed(hassan.totalK);
    expect(k).toMatchObject({ status: 'rated', rating: 'medium', ratedUnit: 'kg K/ha', profileId: 'k' });
    expect(k.assumption).toMatch(/available K \(ammonium acetate\)/);
    expect(rateMarkerAssumed({ ...hassan.totalP, canonical: { ...hassan.totalP.canonical, value: 9.9 } }).rating).toBe('low');
    expect(rateMarkerAssumed({ ...hassan.totalK, canonical: { ...hassan.totalK.canonical, value: 281 } }).rating).toBe('high');
  });

  it('organic matter converts to organic carbon at 0.58 (DAC table) and rates on the organic carbon bands', () => {
    const r = rateMarkerAssumed(hassan.om);
    expect(r).toMatchObject({ status: 'rated', rating: 'high', ratedUnit: '%', profileId: 'oc' });
    expect(r.ratedValue).toBeCloseTo(1.392, 6);
    expect(r.assumption).toMatch(/0\.58/);
    // 1.2 % OM is 0.696 % OC (medium); 1.3 % OM is 0.754 % OC (high): the boundary is applied after the conversion.
    expect(rateMarkerAssumed(marker('organic_matter', 1.2, '%')).rating).toBe('medium');
    expect(rateMarkerAssumed(marker('organic_matter', 1.3, '%')).rating).toBe('high');
    expect(rateMarkerAssumed(marker('organic_matter', 0.8, '%')).rating).toBe('low');
    const conv = loadSoilRatings().conversions.find(c => c.id === 'om_to_oc')!;
    expect(conv).toMatchObject({ factor: 0.58, verified: true });
  });

  it('never infers beyond the three cases: mg/kg, qualifiers, unconfirmed, other pools and a failed verification stay unrated', () => {
    for (const m of [marker('nitrogen_unspecified', 278, 'mg/kg'), marker('potassium_total', 186, 'mg/kg')]) {
      const r = rateMarkerAssumed(m);
      expect(r.status, m.parameter).toBe('unrated');
      expect(r.rating).toBe('unrated');
      expect(r.assumption).toBeNull();
    }
    expect(rateMarkerAssumed(marker('phosphorus_total', 16, 'kg/ha', { qualifier: 'less_than' })).status).toBe('qualifier');
    expect(rateMarkerAssumed(marker('phosphorus_total', 16, 'kg/ha', { reviewStatus: 'pending', confirmedAt: null })).status).toBe('unrated');
    expect(rateMarkerAssumed(marker('nitrogen_total', 278, 'kg/ha')).status).toBe('unrated');
    expect(rateMarkerAssumed(marker('nitrogen_unspecified', 278, 'kg/ha', { matrix: 'water' })).status).toBe('unrated');
    expect(rateMarkerAssumed(marker('unknown_other', 5, 'kg/ha', { rawLabel: 'Exchangeable potassium' })).status).toBe('unrated');
    expect(rateMarkerAssumed(marker('nitrogen_unspecified', 278, 'kg/ha', { method: 'Kjeldahl (total N)' })).status).toBe('unrated');
    const data = JSON.parse(readFileSync(resolve(REPO_ROOT, SOIL_RATINGS_FILE), 'utf8'));
    data.conversions.find((c: { id: string }) => c.id === 'om_to_oc').verified = false;
    const om = rateMarkerAssumedWith(hassan.om, parseSoilRatings(data));
    expect(om.status).toBe('unrated');
    expect(om.assumption).toBeNull();
  });
});
