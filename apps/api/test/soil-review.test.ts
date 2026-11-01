import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SoilReading, SoilReview } from '@harvest/contracts';
import { loadCatalogueIntoDb } from '../src/catalogue/load';
import { Budget } from '../src/services/budget';
import { getWorkspace, putWorkspace } from '../src/services/workspace';
import { createSoilReviewHandler, SOIL_REVIEW_JOB_TYPE } from '../src/worker/handlers/soil-review';
import type { RatableMarker } from '../src/services/soil-ratings';
import { SOIL_RATINGS_VERSION } from '../src/services/soil-ratings';
import {
  buildFacts, buildReadings, cropNeeds, deterministicNarrative, ensureSoilReview, gateNarrative, generateSoilReview, numbersIn, readSoilReview,
  type CropNeeds, type SoilReviewContext, type SoilReviewDeps,
} from '../src/services/soil-review';
import type { TextModelProvider } from '../src/agent/provider';
import { farmBody, login, ORIGIN, setupHarness, type Client, type Harness } from './helpers';

/**
 * Soil review tests. The soil values here are SYNTHETIC fixtures shaped like the Hassan farm's confirmed report (pH 7.2,
 * EC 0.86, unspecified N 278 kg/ha, organic matter 2.4 %, total P 16 and total K 186 kg/ha); the Meta transport is a
 * fake provider, so nothing here is a live model result.
 */
let h: Harness, a: Client, b: Client, app: FastifyInstance, ac: Client, bc: Client;
const NOW = () => new Date('2026-11-01T06:00:00Z');
const deps = (over: Partial<SoilReviewDeps> = {}): SoilReviewDeps => ({ pool: h.pool, config: h.config, budget: Budget.fromConfig(h.pool, h.config), now: NOW, ...over });
beforeAll(async () => {
  h = await setupHarness();
  await loadCatalogueIntoDb(h.pool);
  a = await login(h.app); b = await login(h.app);
  app = h.app; // soilReviewRoutes is registered by routes/index.ts
  ac = a; bc = b;
});
afterAll(async () => h?.close());

// ------------------------------------------------------------------ pure fixtures
function mk(parameter: string, value: number, unit: string, label: string, rawUnit: string | null = unit): RatableMarker {
  return {
    id: `m-${parameter}`, parameter, rawLabel: label, rawValue: String(value), rawUnit, numericValue: value, qualifier: 'exact', range: null, analyteForm: null, method: null, extractant: null,
    soilWaterRatio: null, temperatureC: null, matrix: 'soil', massBasis: null, reportedRating: null, reportedReference: null, evidence: { page: 1, quote: 'q', nativeTextCheck: 'matched' },
    extractionConfidence: 'high', warnings: [], canonical: { value, unit, conversion: null, missingReason: null }, reviewStatus: 'confirmed', confirmedAt: '2026-11-01T00:00:00.000Z',
  } as unknown as RatableMarker;
}
const HASSAN = () => [
  mk('ph', 7.2, 'pH', 'pH', '-'), mk('electrical_conductivity', 0.86, 'dS/m', 'EC', 'ds/m'), mk('nitrogen_unspecified', 278, 'kg/ha', 'Nitrogen'),
  mk('organic_matter', 2.4, '%', 'Total organic matter'), mk('phosphorus_total', 16, 'kg/ha', 'Total Phosphorus'), mk('potassium_total', 186, 'kg/ha', 'Total potassium'),
];
const sampleOf = { id: randomUUID(), reportId: randomUUID(), collectionDate: '2026-09-15' } as unknown as SoilReviewContext['markers'][number]['sample'];
const asMarkers = (ms: RatableMarker[]): SoilReviewContext['markers'] => ms.map((marker) => ({ sample: sampleOf, marker }));
const paddy: CropNeeds = { cropId: 'paddy', cropName: 'Paddy', productId: 'paddy-grain', yieldKgPerHa: 5000, needs: { N: { need: 'high', kgPerHa: 130 }, P2O5: { need: 'medium', kgPerHa: 40 }, K2O: { need: 'medium', kgPerHa: 80 } }, legume: null, phRange: { min: 5.5, max: 7.5 }, note: null };
const groundnut: CropNeeds = { cropId: 'groundnut', cropName: 'Groundnut', productId: null, yieldKgPerHa: 1500, needs: { N: { need: 'medium', kgPerHa: 87 }, P2O5: { need: 'low', kgPerHa: 29 }, K2O: { need: 'low', kgPerHa: 45 } }, legume: { min: 54, max: 58 }, phRange: null, note: null };

describe('readings (code): ratings, flagged assumptions and need classes', () => {
  const rows = buildReadings(asMarkers(HASSAN()), paddy, groundnut);
  const by = (p: string) => rows.find((r) => r.reading.parameter === p)!.reading;

  it('rates every Hassan-like marker; pH and EC without an assumption, the four inferred forms with one', () => {
    expect(by('ph')).toMatchObject({ status: 'rated', rating: 'neutral', assumption: null, cropNeed: null });
    expect(by('electrical_conductivity')).toMatchObject({ status: 'rated', rating: 'normal', assumption: null });
    expect(by('nitrogen_unspecified')).toMatchObject({ status: 'rated', rating: 'low', ratedValue: 278, ratedUnit: 'kg/ha' });
    expect(by('nitrogen_unspecified').assumption).toMatch(/available N/);
    expect(by('organic_matter')).toMatchObject({ status: 'rated', rating: 'high', ratedUnit: '%' });
    expect(by('organic_matter').ratedValue).toBeCloseTo(1.392, 6);
    expect(by('organic_matter').assumption).toMatch(/0\.58/);
    expect(by('phosphorus_total')).toMatchObject({ rating: 'medium', ratedUnit: 'kg P/ha' });
    expect(by('potassium_total')).toMatchObject({ rating: 'medium', ratedUnit: 'kg K/ha' });
    for (const p of ['phosphorus_total', 'potassium_total']) expect(by(p).assumption).toBeTruthy();
  });

  it('gives every reading a per-marker note: a caveat when rated on an unstated method or extract, none for a clean pH', () => {
    expect(by('ph').note).toBeNull();
    expect(by('electrical_conductivity').note).toMatch(/does not state the extract/);
    expect(by('nitrogen_unspecified').note).toMatch(/does not state the nitrogen method/);
    expect(by('phosphorus_total').note).toMatch(/does not state the phosphorus method/);
    expect(by('phosphorus_total').note).not.toMatch(/elemental/); // the form sentence is the assumption, not repeated in the note
    expect(by('phosphorus_total').assumption).toMatch(/available P/);
  });

  it('keeps the printed label and value, and every reading satisfies the SoilReading contract', () => {
    expect(by('nitrogen_unspecified')).toMatchObject({ label: 'Nitrogen', value: 278, unit: 'kg/ha' });
    for (const r of rows) expect(SoilReading.safeParse(r.reading).success, r.reading.parameter).toBe(true);
  });

  it('attaches the current and next crop need class to rated N, P and K only', () => {
    expect(by('nitrogen_unspecified').cropNeed).toMatchObject({ cropId: 'paddy', need: 'high' });
    expect(by('nitrogen_unspecified').nextCropNeed).toMatchObject({ cropId: 'groundnut', need: 'medium' });
    expect(by('phosphorus_total').cropNeed).toMatchObject({ need: 'medium' });
    expect(by('phosphorus_total').nextCropNeed).toMatchObject({ need: 'low' });
    expect(by('potassium_total').nextCropNeed).toMatchObject({ need: 'low' });
    for (const p of ['ph', 'electrical_conductivity', 'organic_matter']) expect(by(p).cropNeed).toBeNull();
  });

  it('refused markers carry no rating, bands or assumption and are never given a crop need', () => {
    const odd = buildReadings(asMarkers([mk('nitrogen_unspecified', 5, 'mg/kg', 'Nitrogen'), { ...mk('zinc_available', 0.4, 'mg/kg', 'Zn'), qualifier: 'less_than' } as RatableMarker, { ...mk('ph', 7, 'pH', 'pH'), matrix: 'water' } as RatableMarker]), paddy, groundnut);
    for (const r of odd) expect(r.reading).toMatchObject({ rating: 'unrated', bands: [], source: null, assumption: null, cropNeed: null, nextCropNeed: null, ratedValue: null });
    expect(odd.map((r) => r.reading.status)).toEqual(['unrated', 'qualifier', 'unrated']);
    expect(odd[0]!.reading.note).toMatch(/mg\/kg/);
    expect(odd[1]!.reading.note).toMatch(/exact value/);
    expect(odd[2]!.reading.note).toMatch(/soil/);
  });

  it('cropNeeds scales uptake by the regional state yield with the spec thresholds (real research data, Karnataka paddy)', () => {
    const n = cropNeeds({ cropId: 'paddy', cropName: 'Paddy', productId: null, sowing: '2026-07-01' }, 'IN-KA', '2026-11-01');
    expect(n.yieldKgPerHa).toBeGreaterThan(1000);
    const expectedN = Math.round((20 * n.yieldKgPerHa!) / 1000);
    expect(n.needs.N).toEqual({ kgPerHa: expectedN, need: expectedN < 60 ? 'low' : expectedN > 120 ? 'high' : 'medium' });
    expect(cropNeeds({ cropId: 'ginger', cropName: 'Ginger', productId: null, sowing: null }, 'IN-KA', '2026-11-01')).toMatchObject({ needs: { N: null, P2O5: null, K2O: null } });
  });
});

describe('facts (code)', () => {
  const rows = buildReadings(asMarkers(HASSAN()), paddy, groundnut);
  const { facts, limiting } = buildFacts(rows, paddy, groundnut);

  it('counts the ratings, states the pH and EC verdicts and the limiting nutrient for the current crop', () => {
    expect(facts[0]).toBe('6 confirmed soil values: 6 rated against cited bands, 0 shown as printed.');
    expect(facts).toContain('Nutrient ratings: 1 low, 2 medium, 1 high.');
    expect(facts).toContain('Soil pH 7.2 rates neutral.');
    expect(facts).toContain('Paddy is usually grown at pH 5.5 to 7.5; the field pH 7.2 is inside that range.');
    expect(facts).toContain('Salinity (EC) 0.86 dS/m rates normal.');
    expect(limiting).toEqual([{ nutrient: 'N', soil: 'low', need: 'high', verdict: 'short' }]);
    expect(facts).toContain('Limiting for Paddy: nitrogen (soil low, crop need high).');
  });

  it('states the expected N drawdown, the next crop need, the legume credit and the inferred-form count', () => {
    expect(facts).toContain('Paddy is expected to take up about 130 kg N/ha at the regional median yield of 5000 kg/ha.');
    expect(facts.some((f) => f.startsWith('Next crop Groundnut: nutrient need') && f.includes('nitrogen medium') && f.includes('phosphorus low'))).toBe(true);
    expect(facts).toContain('Groundnut can leave about 54 to 58 kg N/ha for the crop after it.');
    expect(facts).toContain('4 rated values rest on an inferred form and are flagged in the list.');
    expect(facts.length).toBeLessThanOrEqual(12);
    for (const f of facts) expect(f.length).toBeLessThanOrEqual(200);
  });

  it('flags a pH outside the crop range, and says nothing about limiting nutrients without a current crop', () => {
    const high = buildFacts(buildReadings(asMarkers([mk('ph', 8, 'pH', 'pH')]), paddy, null), paddy, null).facts;
    expect(high).toContain('Paddy is usually grown at pH 5.5 to 7.5; the field pH 8 is outside that range.');
    const none = buildFacts(rows, null, groundnut).facts;
    expect(none.some((f) => f.startsWith('Limiting') || f.includes('expected to take up'))).toBe(false);
  });
});

describe('narrative gate and the code-written fallback', () => {
  const rows = buildReadings(asMarkers(HASSAN()), paddy, groundnut);
  const { facts, limiting } = buildFacts(rows, paddy, groundnut);
  const good = { lines: ['Soil pH 7.2 rates neutral.', 'Nitrogen rates low and was rated on an assumed form.'], afterHarvest: ['Paddy takes up about 130 kg N/ha.'], nextCrop: ['Groundnut can leave 54 to 58 kg N/ha.'] };

  it('accepts a narrative whose numbers all come from the facts, and ignores chemical formulas', () => {
    const r = gateNarrative({ ...good, lines: [...good.lines, 'Phosphorus (P2O5) and potassium (K2O) rate medium.'] }, facts);
    expect(r.ok).toBe(true);
    expect(numbersIn('P2O5 and K2O and 7.2 and 54')).toEqual([7.2, 54]);
  });

  it.each([
    ['a number that is not in the facts', { ...good, lines: ['Nitrogen is 300 kg/ha.'] }, 'number_not_in_facts'],
    ['a number written as a different value', { ...good, lines: ['Soil pH 7.3 rates neutral.'] }, 'number_not_in_facts'],
    ['more than 18 words', { ...good, lines: ['One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen.'] }, 'line_length'],
    ['more than 5 lines', { ...good, lines: ['a', 'b', 'c', 'd', 'e', 'f'] }, 'line_count'],
    ['more than 3 afterHarvest lines', { ...good, afterHarvest: ['a', 'b', 'c', 'd'] }, 'line_count'],
    ['no lines at all', { ...good, lines: [] }, 'line_count'],
    ['an empty line', { ...good, lines: ['  '] }, 'empty_line'],
    ['a fertilizer product', { ...good, lines: ['Add urea to fix the low nitrogen.'] }, 'product_or_dose_term'],
    ['a dose verb', { ...good, nextCrop: ['Apply more phosphorus.'] }, 'product_or_dose_term'],
    ['a link', { ...good, lines: ['See https://example.com for details.'] }, 'link_in_line'],
    ['a missing field', { lines: ['ok'], afterHarvest: [] }, 'schema_mismatch'],
    ['an extra field', { ...good, extra: [] }, 'schema_mismatch'],
  ])('rejects %s', (_name, raw, reason) => {
    expect(gateNarrative(raw, facts)).toEqual({ ok: false, reason });
  });

  it('the deterministic narrative passes its own gate: short lines, numbers only from the facts, and states each code verdict', () => {
    const n = deterministicNarrative(rows, paddy, groundnut, limiting);
    expect(gateNarrative(n, facts).ok).toBe(true);
    expect(n.lines.length).toBeGreaterThanOrEqual(1);
    expect(n.lines.length).toBeLessThanOrEqual(5);
    for (const line of [...n.lines, ...n.afterHarvest, ...n.nextCrop]) expect(line.split(' ').length).toBeLessThanOrEqual(18);
    expect(n.lines).toContain('Soil pH 7.2 rates neutral.');
    expect(n.lines.some((l) => /nitrogen needs attention/.test(l))).toBe(true);
    expect(n.afterHarvest.join(' ')).toMatch(/130 kg N\/ha/);
    expect(n.nextCrop.join(' ')).toMatch(/Groundnut needs/);
    const bare = deterministicNarrative(buildReadings(asMarkers([{ ...mk('zinc_available', 0.4, 'mg/kg', 'Zn'), qualifier: 'less_than' } as RatableMarker]), null, null), null, null, []);
    expect(bare.lines).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ database: hash, enqueue once, generation, route
const hassan = { stateId: 'IN-KA', districtId: 'IN-KA-hassan', precision: 'precise', lat: 13.0, lon: 76.1 };
async function farm(client: Client = a) {
  const f = (await client.call('POST', '/api/v1/farms', { payload: farmBody({ name: `Soil review ${randomUUID()}`, location: hassan, facts: {} }) })).json().data as { id: string };
  const s = (await h.pool.query<{ owner_id: string; id: string }>('SELECT s.owner_id,s.id FROM sessions s JOIN farms f ON f.owner_id=s.owner_id WHERE f.id=$1 ORDER BY s.created_at DESC LIMIT 1', [f.id])).rows[0]!;
  return { id: f.id, auth: { ownerId: s.owner_id, sessionId: s.id } };
}
interface Fixture { id: string; parameter: string; label: string; raw: string; unit: string | null; value: number; canonicalUnit: string }
const HASSAN_DB: Fixture[] = [
  { id: 'ph', parameter: 'ph', label: 'pH', raw: '7.2', unit: '-', value: 7.2, canonicalUnit: 'pH' },
  { id: 'ec', parameter: 'electrical_conductivity', label: 'EC', raw: '0.86', unit: 'ds/m', value: 0.86, canonicalUnit: 'dS/m' },
  { id: 'n', parameter: 'nitrogen_unspecified', label: 'Nitrogen', raw: '278', unit: 'kg/ha', value: 278, canonicalUnit: 'kg/ha' },
  { id: 'om', parameter: 'organic_matter', label: 'Total organic matter', raw: '2.4', unit: '%', value: 2.4, canonicalUnit: '%' },
  { id: 'p', parameter: 'phosphorus_total', label: 'Total Phosphorus', raw: '16', unit: 'kg/ha', value: 16, canonicalUnit: 'kg/ha' },
  { id: 'k', parameter: 'potassium_total', label: 'Total potassium', raw: '186', unit: 'kg/ha', value: 186, canonicalUnit: 'kg/ha' },
];
/** A confirmed field report with one sample, inserted the way confirmation stores it (mode follows the test config). */
async function confirm(farmId: string, ownerId: string, markers: Fixture[], collection = '2026-09-15') {
  const reportId = randomUUID();
  await h.pool.query("INSERT INTO soil_reports(id,owner_id,farm_id,kind,mode,status,filename,content_type,byte_size,sha256,original_key) VALUES($1,$2,$3,'field_report',$4,'confirmed','r.pdf','application/pdf',10,$5,$6)", [reportId, ownerId, farmId, h.config.RUNTIME_MODE, randomUUID(), `k/${reportId}`]);
  const sampleId = (await h.pool.query<{ id: string }>("INSERT INTO soil_samples(owner_id,farm_id,report_id,source_sample_id,review_revision,sample_label,collection_date) VALUES($1,$2,$3,'S1',1,'Field',$4) RETURNING id", [ownerId, farmId, reportId, collection])).rows[0]!.id;
  for (const m of markers)
    await h.pool.query("INSERT INTO soil_markers(sample_id,source_marker_id,parameter,raw_label,raw_value,raw_unit,numeric_value,qualifier,matrix,evidence_page,evidence_quote,native_text_check,extraction_confidence,warnings,canonical_value,canonical_unit) VALUES($1,$2,$3,$4,$5,$6,$7,'exact','soil',1,'q','matched','high','[]'::jsonb,$7,$8)", [sampleId, m.id, m.parameter, m.label, m.raw, m.unit, m.value, m.canonicalUnit]);
  return sampleId;
}
const jobs = async (farmId: string) => Number((await h.pool.query("SELECT count(*) FROM jobs WHERE type=$2 AND payload->>'farmId'=$1", [farmId, SOIL_REVIEW_JOB_TYPE])).rows[0].count);
const rowsOf = async (farmId: string) => (await h.pool.query<{ id: string; context_hash: string; archived_at: Date | null; status: string }>('SELECT id,context_hash,archived_at,status FROM soil_reviews WHERE farm_id=$1 ORDER BY created_at', [farmId])).rows;
async function setSeasons(f: { id: string; auth: { ownerId: string } }) {
  const ws = await getWorkspace(h.pool, f.auth.ownerId, f.id);
  await putWorkspace(h.pool, f.auth.ownerId, f.id, { boundary: ws.boundary, previousHarvest: ws.previousHarvest, rotationPlans: [{ id: 'yearplan:r1:o1:s1', year: 2027, season: 'Rabi', cropId: 'groundnut', cropName: 'Groundnut', plannedSowingDate: '2027-01-10' }],
    cycles: [{ id: 'cycle-1', cropId: 'paddy', cropName: 'Paddy', productId: 'paddy-grain', sowingDate: '2026-07-01', stage: 'growing' }], expectedVersion: ws.version });
}

function fakeMeta(answer: (input: { facts: string[] }) => unknown) {
  const calls: { input: string; instructions: string; store: unknown; effort: unknown }[] = [];
  const provider: TextModelProvider & { deleteResponse: ReturnType<typeof vi.fn> } = {
    kind: 'meta', provenance: 'meta_live', billable: false,
    call: vi.fn(async (req) => {
      calls.push({ input: String(req.input), instructions: String(req.instructions), store: req.store, effort: req.reasoningEffort });
      return { ok: true as const, result: { provenance: 'meta_live' as const, responseId: 'resp-soil', requestId: 'req', model: 'fixture-received-model', outputText: JSON.stringify(answer(JSON.parse(String(req.input)))), functionCalls: [], usage: { inputTokens: 800, outputTokens: 120, cachedInputTokens: 0 }, latencyMs: 1, retries: 0 } };
    }),
    deleteResponse: vi.fn(async () => ({ ok: true, code: null })),
  };
  return { provider, calls };
}
async function reviewed(provider?: TextModelProvider) {
  const f = await farm();
  await confirm(f.id, f.auth.ownerId, HASSAN_DB);
  await setSeasons(f);
  const d = deps(provider ? { provider } : {});
  const pending = await ensureSoilReview(d, f.auth, f.id);
  await generateSoilReview(d, pending.reviewId!, f.auth.ownerId);
  return { f, d, review: await readSoilReview(d, f.auth.ownerId, f.id), pending };
}

describe('soil review service (test DB)', () => {
  it('a farm without confirmed values returns no_report and creates no row and no job', async () => {
    const f = await farm();
    const r = await ensureSoilReview(deps(), f.auth, f.id);
    expect(SoilReview.parse(r)).toMatchObject({ status: 'no_report', reviewId: null, readings: [], narrative: null, ratingsVersion: SOIL_RATINGS_VERSION });
    expect((await rowsOf(f.id)).length).toBe(0);
    expect(await jobs(f.id)).toBe(0);
  });

  it('GET inserts one pending review with the code readings at once and enqueues exactly one job, even when requested concurrently', async () => {
    const f = await farm();
    await confirm(f.id, f.auth.ownerId, HASSAN_DB);
    await setSeasons(f);
    const all = await Promise.all([1, 2, 3].map(() => ensureSoilReview(deps(), f.auth, f.id)));
    expect(new Set(all.map((r) => r.reviewId)).size).toBe(1);
    const r = SoilReview.parse(all[0]);
    expect(r).toMatchObject({ status: 'pending', narrative: null, narrativeOrigin: null, ratingsVersion: SOIL_RATINGS_VERSION });
    expect(r.readings).toHaveLength(6);
    expect(r.currentCrop).toMatchObject({ cropId: 'paddy' });
    expect(r.nextCrop).toMatchObject({ cropId: 'groundnut', source: 'year_plan_applied' });
    expect(r.readings.find((x) => x.parameter === 'nitrogen_unspecified')).toMatchObject({ rating: 'low', status: 'rated' });
    expect(r.readings.find((x) => x.parameter === 'nitrogen_unspecified')!.assumption).toBeTruthy();
    expect(r.readings.find((x) => x.parameter === 'nitrogen_unspecified')!.cropNeed).toMatchObject({ cropId: 'paddy' });
    await ensureSoilReview(deps(), f.auth, f.id);
    expect(await jobs(f.id)).toBe(1);
    expect((await rowsOf(f.id)).filter((x) => !x.archived_at)).toHaveLength(1);
    const key = (await h.pool.query<{ idempotency_key: string }>("SELECT idempotency_key FROM jobs WHERE type=$2 AND payload->>'farmId'=$1", [f.id, SOIL_REVIEW_JOB_TYPE])).rows[0]!.idempotency_key;
    expect(key).toBe(`soilreview:${f.id}:${r.contextHash}`);
  });

  it('a new confirmation changes the hash, archives the old review and builds a new one', async () => {
    const f = await farm();
    await confirm(f.id, f.auth.ownerId, HASSAN_DB);
    const first = await ensureSoilReview(deps(), f.auth, f.id);
    expect((await ensureSoilReview(deps(), f.auth, f.id)).contextHash).toBe(first.contextHash);
    await confirm(f.id, f.auth.ownerId, [{ id: 'zn', parameter: 'zinc_available', label: 'Zinc', raw: '0.4', unit: 'mg/kg', value: 0.4, canonicalUnit: 'mg/kg' }], '2026-10-20');
    const second = await ensureSoilReview(deps(), f.auth, f.id);
    expect(second.contextHash).not.toBe(first.contextHash);
    expect(second.reviewId).not.toBe(first.reviewId);
    expect(second.readings).toHaveLength(7);
    const rows = await rowsOf(f.id);
    expect(rows.filter((x) => !x.archived_at).map((x) => x.id)).toEqual([second.reviewId]);
    expect(rows.find((x) => x.id === first.reviewId)!.archived_at).not.toBeNull();
    expect(await jobs(f.id)).toBe(2);
    // The same values with a changed season also change the hash.
    await setSeasons(f);
    expect((await ensureSoilReview(deps(), f.auth, f.id)).contextHash).not.toBe(second.contextHash);
  });

  it('a Meta narrative that passes the gate is kept (origin model); store is false, reasoning low and the response is deleted', async () => {
    const meta = fakeMeta(() => ({ lines: ['Soil pH 7.2 rates neutral.', 'Salinity (EC) 0.86 dS/m rates normal.'], afterHarvest: ['Paddy is expected to take up nitrogen.'], nextCrop: ['Groundnut can leave nitrogen for the crop after it.'] }));
    const { review } = await reviewed(meta.provider);
    expect(review.status).toBe('ready');
    expect(review.narrativeOrigin).toBe('model');
    expect(review.narrative).toEqual({ lines: ['Soil pH 7.2 rates neutral.', 'Salinity (EC) 0.86 dS/m rates normal.'], afterHarvest: ['Paddy is expected to take up nitrogen.'], nextCrop: ['Groundnut can leave nitrogen for the crop after it.'] });
    expect(meta.calls).toHaveLength(1);
    expect(meta.calls[0]).toMatchObject({ store: false, effort: 'low' });
    expect(meta.calls[0]!.instructions).toMatch(/untrusted DATA/);
    expect(JSON.parse(meta.calls[0]!.input).facts).toEqual(review.facts);
    expect(meta.provider.deleteResponse).toHaveBeenCalledWith('resp-soil');
    expect(review.generatedAt).not.toBeNull();
  });

  it.each([
    ['a number that is not in the facts', { lines: ['Nitrogen is 300 kg/ha.'], afterHarvest: [], nextCrop: [] }, 'gate_number_not_in_facts'],
    ['a fertilizer product', { lines: ['Add urea to the field.'], afterHarvest: [], nextCrop: [] }, 'gate_product_or_dose_term'],
    ['too many lines', { lines: ['a', 'b', 'c', 'd', 'e', 'f'], afterHarvest: [], nextCrop: [] }, 'gate_schema_mismatch'],
  ])('a Meta narrative with %s falls back to the code narrative (origin deterministic) and says so', async (_name, answer, failure) => {
    const meta = fakeMeta(() => answer);
    const { review } = await reviewed(meta.provider);
    expect(review.status).toBe('ready');
    expect(review.narrativeOrigin).toBe('deterministic');
    expect(review.narrative!.lines.length).toBeGreaterThanOrEqual(1);
    expect(review.narrative!.lines.join(' ')).not.toMatch(/300|urea/);
    expect(review.narrative!.lines).toContain('Soil pH 7.2 rates neutral.');
    expect(review.limitations.some((l) => l.includes(failure) || (failure === 'gate_schema_mismatch' && /gate_/.test(l)))).toBe(true);
    expect(meta.provider.deleteResponse).toHaveBeenCalled();
  });

  it('a provider failure also falls back to the code narrative and releases the budget reservation', async () => {
    const provider: TextModelProvider = { kind: 'meta', provenance: 'meta_live', billable: false, call: vi.fn(async () => ({ ok: false as const, error: { code: 'timeout', message: 'x', retryable: true, outcomeUncertain: false } }) as never) };
    const { review } = await reviewed(provider);
    expect(review).toMatchObject({ status: 'ready', narrativeOrigin: 'deterministic' });
    expect(review.limitations.some((l) => l.includes('provider_timeout'))).toBe(true);
  });

  it('without a provider in a non-live runtime Meta is not called and the review is code-written from the same facts', async () => {
    const { review } = await reviewed();
    expect(review).toMatchObject({ status: 'ready', narrativeOrigin: 'deterministic' });
    expect(review.limitations.some((l) => /Meta was not available in this runtime/.test(l))).toBe(true);
    expect(gateNarrative(review.narrative, review.facts).ok).toBe(true);
  });

  it('a job that finds the values changed under it ends in error with a note, and the next request builds a fresh review', async () => {
    const f = await farm();
    await confirm(f.id, f.auth.ownerId, HASSAN_DB);
    const d = deps();
    const pending = await ensureSoilReview(d, f.auth, f.id);
    await confirm(f.id, f.auth.ownerId, [{ id: 'zn', parameter: 'zinc_available', label: 'Zinc', raw: '0.4', unit: 'mg/kg', value: 0.4, canonicalUnit: 'mg/kg' }], '2026-10-20');
    const out = await generateSoilReview(d, pending.reviewId!, f.auth.ownerId);
    expect(out.status).toBe('error');
    const fresh = await ensureSoilReview(d, f.auth, f.id);
    expect(fresh.reviewId).not.toBe(pending.reviewId);
    expect(fresh.status).toBe('pending');
  });
});

describe('soil review route and handler', () => {
  const url = (id: string) => `/api/v1/farms/${id}/soil-review`;

  it('401 without a session, 404 for another owner, and no_report 200 without confirmed values', async () => {
    const f = await farm(ac);
    for (const method of ['GET', 'POST'] as const) expect((await app.inject({ method, url: url(f.id), headers: { origin: ORIGIN } })).statusCode).toBe(401);
    expect((await bc.call('GET', url(f.id))).statusCode).toBe(404);
    expect((await bc.call('POST', url(f.id), { payload: {} })).statusCode).toBe(404);
    const res = await ac.call('GET', url(f.id));
    expect(res.statusCode, res.body).toBe(200);
    expect(SoilReview.parse(res.json().data)).toMatchObject({ status: 'no_report', readings: [] });
    expect(await jobs(f.id)).toBe(0);
  });

  it('GET returns the parsed review, a repeat GET the same one; POST keeps a review being built, then rebuilds a finished one', async () => {
    const f = await farm(ac);
    await confirm(f.id, f.auth.ownerId, HASSAN_DB);
    const first = await ac.call('GET', url(f.id));
    expect(first.statusCode, first.body).toBe(200);
    const r1 = SoilReview.parse(first.json().data);
    expect(r1).toMatchObject({ status: 'pending', farmId: f.id });
    expect(r1.readings).toHaveLength(6);
    expect(SoilReview.parse((await ac.call('GET', url(f.id))).json().data).reviewId).toBe(r1.reviewId);
    const during = SoilReview.parse((await ac.call('POST', url(f.id), { payload: {} })).json().data);
    expect(during.reviewId).toBe(r1.reviewId);
    expect(await jobs(f.id)).toBe(1);
    // Run the queued job through the registered handler contract.
    const handler = createSoilReviewHandler(deps());
    const job = (await h.pool.query<{ id: string; owner_id: string; type: string; attempt: number; max_attempts: number; payload: unknown }>("SELECT id,owner_id,type,attempt,max_attempts,payload FROM jobs WHERE type=$2 AND payload->>'farmId'=$1", [f.id, SOIL_REVIEW_JOB_TYPE])).rows[0]!;
    expect(job.max_attempts).toBe(1);
    expect(await handler(job, { heartbeat: async () => undefined, pool: h.pool, isCancelled: async () => false })).toMatchObject({ status: 'ready', reviewId: r1.reviewId });
    expect(await handler({ ...job, owner_id: null as never }, { heartbeat: async () => undefined, pool: h.pool, isCancelled: async () => false })).toMatchObject({ status: 'cancelled' });
    const ready = SoilReview.parse((await ac.call('GET', url(f.id))).json().data);
    expect(ready).toMatchObject({ status: 'ready', reviewId: r1.reviewId, narrativeOrigin: 'deterministic' });
    const forced = SoilReview.parse((await ac.call('POST', url(f.id), { payload: {} })).json().data);
    expect(forced.reviewId).not.toBe(r1.reviewId);
    expect(forced.status).toBe('pending');
    expect(await jobs(f.id)).toBe(2);
    expect((await rowsOf(f.id)).filter((x) => !x.archived_at)).toHaveLength(1);
    expect((await ac.call('POST', url(f.id), { payload: { force: true } })).statusCode).toBe(400);
  });

  it('exports the job type the worker registry expects', () => {
    expect(SOIL_REVIEW_JOB_TYPE).toBe('farm.soil-review');
  });
});
