import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CropFitReview, SeasonPreview, SoilReview, type HarvestPriceOutlook, type SeasonPreviewQuery } from '@harvest/contracts';
import { loadCatalogueIntoDb } from '../src/catalogue/load';
import { Budget } from '../src/services/budget';
import { generateCropFit, type CropFitDeps } from '../src/services/crop-fit/service';
import { seasonPreviewRoutes } from '../src/routes/season-preview';
import { yearPlanContext } from '../src/services/year-plan/service';
import { emptyInputs } from '../src/services/year-plan/inputs';
import { ensureSoilReview, readSoilReview, type SoilReviewDeps } from '../src/services/soil-review';
import type { SeasonalReferenceByWeek } from '../src/services/price-series';
import type { DailyWeather, WeatherSource } from '../src/plans/sources';
import { eachDate } from '../src/plans/weather';
import { seasonPreview, type SeasonPreviewDeps } from '../src/services/season-preview';
import { boundaryMetrics, getWorkspace, putWorkspace } from '../src/services/workspace';
import { farmBody, login, ORIGIN, setupHarness, type Client, type Harness } from './helpers';

/**
 * Crop fit, season preview and soil review per field (FIELDS_MULTICROP_SOIL_SPEC.md 12.3). Farms, fields, prices, rain and soil
 * values are SYNTHETIC test data; prices and weather come from injected fakes, the model is never called.
 */
const rect = (x0: number, y0: number, x1: number, y1: number) => ({ type: 'Polygon' as const, coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] as [number, number][][] });
const FARM = rect(76.249, 13.2495, 76.251, 13.2505);
const WEST = rect(76.249, 13.2495, 76.2498, 13.2505);
const EAST = rect(76.2498, 13.2495, 76.251, 13.2505);
const FIELDS = [{ id: 'west', name: 'West strip', boundary: WEST }, { id: 'east', name: 'East strip', boundary: EAST }];
const HASSAN = { stateId: 'IN-KA', districtId: 'IN-KA-hassan', precision: 'precise', lat: 13.25, lon: 76.25 };
const NOW = new Date('2026-11-01T06:00:00Z');
const areaOf = (b: ReturnType<typeof rect>) => boundaryMetrics(b).areaHectares;

let h: Harness, a: Client, b: Client, app: FastifyInstance;
beforeAll(async () => { h = await setupHarness(); await loadCatalogueIntoDb(h.pool); a = await login(h.app); b = await login(h.app); app = h.app; }, 120_000);
afterAll(async () => h?.close());

const ownerOf = async (farmId: string) => (await h.pool.query<{ owner_id: string }>('SELECT owner_id FROM farms WHERE id=$1', [farmId])).rows[0]!.owner_id;
async function farmWith(over: { cycles?: unknown[]; rotationPlans?: unknown[]; fields?: unknown[] } = {}, client: Client = a) {
  const id = (await client.call('POST', '/api/v1/farms', { payload: farmBody({ name: `Fields ${randomUUID()}`, location: HASSAN, facts: {} }) })).json().data.id as string;
  const put = await client.call('PUT', `/api/v1/farms/${id}/workspace`, { payload: { expectedVersion: 0, boundary: FARM, previousHarvest: { status: 'unknown' }, cycles: over.cycles ?? [], rotationPlans: over.rotationPlans ?? [], fields: over.fields ?? FIELDS } });
  expect(put.statusCode, put.body).toBe(200);
  return id;
}
const cycle = (id: string, cropId: string, productId: string, sowingDate: string, fieldId?: string) => ({ id, cropId, productId, sowingDate, establishmentDate: sowingDate, stage: 'growing' as const, ...(fieldId ? { fieldId } : {}) });

// ------------------------------------------------------------------ crop fit
describe('crop fit per field', () => {
  const outlook = (x: { productId: string; harvestDate: string; asOf: string }) => ({
    productId: x.productId, status: 'available', missingReason: null, scope: { level: 'state', requestedLevel: 'district', stateName: 'Karnataka', districtName: null, marketCount: 2, marketIds: [], fallbackNote: null },
    unit: 'INR/kg', priceBasis: 'wholesale_mandi_modal', basisLabel: 'Synthetic test price', limitations: [], method: 'B_seasonal_reference/pooled-v1', harvestDate: x.harvestDate, harvestWeek: { year: 2027, week: 30 }, asOf: x.asOf,
    weekWindow: 2, yearsRequested: 3, yearsConsidered: [2023, 2024, 2025], yearsUsed: [2023, 2024, 2025], perYear: [], p10: 15, p25: 18, p50: 21, p75: 24, p90: 27, annualMean: 20, annualWeeks: 150, weeksUsed: 15, observations: 90, marketsUsed: 2, residualCount: 140,
  }) as unknown as HarvestPriceOutlook;
  const deps = (): CropFitDeps => ({ pool: h.pool, config: h.config, budget: Budget.fromConfig(h.pool, h.config), sources: { priceOutlook: async (x) => outlook(x) } }); // real clock: the registered route resolves asOf with it
  const url = (id: string, q: string) => `/api/v1/farms/${id}/crop-fit?mode=season&season=kharif${q}`;
  const get = async (id: string, q: string) => CropFitReview.parse((await a.call('GET', url(id, q))).json().data);
  const keys = async (id: string) => (await h.pool.query<{ request_key: string; archived: boolean }>('SELECT request_key, archived_at IS NOT NULL AS archived FROM crop_fit_reviews WHERE farm_id=$1 ORDER BY created_at', [id])).rows;

  it('each field has its own review row and request key, with its own area; without a fieldId the first field with a growing crop is ranked (EVARA_ACTIONS_SPEC 1.2 item 5)', async () => {
    const id = await farmWith({ cycles: [cycle('c-west', 'paddy', 'paddy-grain', '2026-08-15', 'west')] });
    const west = await get(id, '&fieldId=west');
    const east = await get(id, '&fieldId=east');
    const whole = await get(id, '');
    // 2026-11-04: no fieldId on a farm with fields = the first field with a current cycle (west), the same row as naming it.
    expect(new Set([west.reviewId, east.reviewId, whole.reviewId]).size).toBe(2);
    expect(whole.reviewId).toBe(west.reviewId);
    expect([west.fieldId, east.fieldId, whole.fieldId]).toEqual(['west', 'east', 'west']);
    expect(west.fieldAreaHa).toBeCloseTo(areaOf(WEST), 9);
    expect(east.fieldAreaHa).toBeCloseTo(areaOf(EAST), 9);
    expect(west.fieldAreaHa).not.toBe(east.fieldAreaHa);
    expect(west.contextHash).not.toBe(east.contextHash);
    // The same query returns the same review per field.
    expect((await get(id, '&fieldId=west')).reviewId).toBe(west.reviewId);
    expect((await keys(id)).map((k) => k.request_key).sort()).toEqual(['season:kharif::field=east', 'season:kharif::field=west'].sort());
    // Generated with the field's own context: west scores after its growing paddy, east is a fresh field.
    const owner = await ownerOf(id);
    await generateCropFit(deps(), west.reviewId!, owner);
    await generateCropFit(deps(), east.reviewId!, owner);
    const readyWest = await get(id, '&fieldId=west'), readyEast = await get(id, '&fieldId=east');
    expect([readyWest.status, readyEast.status]).toEqual(['ready', 'ready']);
    expect(readyWest).toMatchObject({ fieldId: 'west', currentCycleId: 'c-west' });
    expect(readyEast).toMatchObject({ fieldId: 'east', currentCycleId: null });
    expect(readyWest.fieldAreaHa).toBeCloseTo(areaOf(WEST), 9);
    expect(readyEast.fieldAreaHa).toBeCloseTo(areaOf(EAST), 9);
    // Refreshing one field replaces only that field's row.
    const forced = CropFitReview.parse((await a.call('POST', url(id, '&fieldId=west'), { payload: {} })).json().data);
    expect(forced.reviewId).not.toBe(west.reviewId);
    expect(forced.fieldId).toBe('west');
    const rows = await keys(id);
    expect(rows.filter((k) => k.archived).map((k) => k.request_key)).toEqual(['season:kharif::field=west']);
    expect((await get(id, '&fieldId=east')).reviewId).toBe(east.reviewId);
    expect((await get(id, '')).reviewId).toBe(forced.reviewId);
    expect(readyWest.limitations).toContain('Ranked for the field West strip; each of the farm\'s 2 fields has its own review (without a field named, the first field with a growing crop is ranked, else the first field).');
  });

  it('2026-11-04: without a growing crop on any field, no fieldId ranks the first field', async () => {
    const id = await farmWith();
    const whole = await get(id, '');
    expect(whole.fieldId).toBe('west');
    expect(whole.reviewId).toBe((await get(id, '&fieldId=west')).reviewId);
    expect(whole.fieldAreaHa).toBeCloseTo(areaOf(WEST), 9);
  });

  it('an unknown field is 404 field_not_found on GET and POST, a malformed id is 400, a stranger gets 404', async () => {
    const id = await farmWith();
    for (const method of ['GET', 'POST'] as const) {
      const r = await a.call(method, url(id, '&fieldId=north'), method === 'POST' ? { payload: {} } : {});
      expect(r.statusCode, `${method} ${r.body}`).toBe(404);
      expect(r.json().error.code).toBe('field_not_found');
    }
    expect((await a.call('GET', url(id, '&fieldId=a%20b'))).statusCode).toBe(400);
    expect((await b.call('GET', url(id, '&fieldId=west'))).statusCode).toBe(404);
    expect((await keys(id)).length).toBe(0);
  });

  it('known limitation: the context hash holds the whole workspace version, so an edit on one field makes every field\'s review stale', async () => {
    const id = await farmWith({ cycles: [cycle('c-west', 'paddy', 'paddy-grain', '2026-08-15', 'west')] });
    const west = await get(id, '&fieldId=west');
    const owner = await ownerOf(id);
    await generateCropFit(deps(), west.reviewId!, owner);
    expect((await get(id, '&fieldId=west')).status).toBe('ready');
    const ws = await getWorkspace(h.pool, owner, id);
    await putWorkspace(h.pool, owner, id, { boundary: ws.boundary, previousHarvest: ws.previousHarvest, rotationPlans: ws.rotationPlans, cycles: [...ws.cycles, cycle('c-east', 'maize', 'maize-grain', '2026-09-10', 'east')], expectedVersion: ws.version });
    const after = await get(id, '&fieldId=west'); // west itself did not change
    expect(after.reviewId).not.toBe(west.reviewId);
    expect(after.status).toBe('pending');
  });
});

// ------------------------------------------------------------------ season preview
describe('season preview per field', () => {
  const dw = (date: string): DailyWeather => ({ date, rainMm: 4, et0Mm: null, tMinC: 18, tMaxC: 29, sourceId: 'open-meteo-archive' });
  const weather: Pick<WeatherSource, 'getClimatology'> = { getClimatology: async (_s, range) => ({ years: { from: 2016, to: 2025 }, sourceId: 'open-meteo-archive', days: eachDate(range.start, range.end).map(dw) }) };
  const outlook = (productId: string, harvestDate: string): HarvestPriceOutlook => ({
    productId, status: 'available', missingReason: null, unit: 'INR/kg', priceBasis: 'wholesale_mandi_modal', basisLabel: 'wholesale mandi modal price', limitations: [],
    scope: { level: 'district', requestedLevel: 'district', stateName: 'Karnataka', districtName: 'Hassan', marketCount: 2, marketIds: [], fallbackNote: null },
    method: 'B_seasonal_reference/pooled-v1', harvestDate, harvestWeek: { year: Number(harvestDate.slice(0, 4)), week: 37 }, asOf: '2026-11-01', weekWindow: 2, yearsRequested: 3,
    yearsConsidered: [2023, 2024, 2025], yearsUsed: [2023, 2024, 2025], perYear: [], p10: 60, p25: 66, p50: 70, p75: 75, p90: 80, annualMean: 68, annualWeeks: 50, weeksUsed: 15, observations: 90, marketsUsed: 2, residualCount: 30,
  }) as HarvestPriceOutlook;
  const seasonal = (productId: string): SeasonalReferenceByWeek => ({
    productId, method: 'B_seasonal_reference/pooled-v1', asOf: '2026-11-01', weekWindow: 2, yearsRequested: 3, yearsConsidered: [2023, 2024, 2025], unit: 'INR/kg', priceBasis: 'wholesale_mandi_modal', basisLabel: 'x', limitations: [],
    weeks: Array.from({ length: 52 }, (_, i) => ({ ...outlook(productId, '2027-01-01'), week: i + 1, p25: 38 + i, p50: 40 + i, p75: 42 + i })) as unknown as SeasonalReferenceByWeek['weeks'], stateWeeks: [],
  });
  const engineCalls: { farmId: string; fieldId: string | null | undefined }[] = [];
  const routeDeps = (): Omit<SeasonPreviewDeps, 'config' | 'pool'> => ({
    now: () => NOW, weatherSource: weather, rateMarker: null,
    sources: {
      priceOutlook: async (x) => outlook(x.productId, x.harvestDate), seasonal: async (x) => seasonal(x.productId),
      marketNow: async () => ({ p50: 72.5, date: '2026-10-30', markets: 3, scopeLabel: 'Hassan district mandis, last 14 trading days' }),
      engine: async (ownerId, farmId, _sowing, fieldId) => {
        engineCalls.push({ farmId, fieldId });
        const c = await yearPlanContext({ pool: h.pool, config: h.config }, ownerId, farmId, '2026-11-01', null, { fieldId: fieldId ?? null });
        const inputs = emptyInputs(c.asOf, c.ctx.irrigation);
        inputs.climatologyRainByMonth = [5, 5, 10, 40, 90, 120, 160, 140, 120, 150, 60, 15];
        return { ctx: c.ctx, inputs, norm: { maxMarginRate: 400, maxRevenueRate: 800 } };
      },
    },
  });
  let preview: FastifyInstance, id: string;
  const west = { id: 'rot-west', year: 2027, season: 'Kharif', cropId: 'maize', cropName: 'Maize', productId: 'maize-grain', plannedSowingDate: '2027-06-10', plannedHarvestDate: '2027-10-20', fieldId: 'west' };
  const east = { id: 'rot-east', year: 2027, season: 'Kharif', cropId: 'maize', cropName: 'Maize', productId: 'maize-grain', plannedSowingDate: '2027-06-12', plannedHarvestDate: '2027-10-22', fieldId: 'east' };
  const legacy = { id: 'rot-farm', year: 2027, season: 'Kharif', cropId: 'maize', cropName: 'Maize', productId: 'maize-grain', plannedSowingDate: '2027-06-15', plannedHarvestDate: '2027-10-25' };
  beforeAll(async () => {
    id = await farmWith({ rotationPlans: [west, east, legacy] });
    preview = await h.make();
    await preview.register(async (child) => { await child.register(seasonPreviewRoutes, { config: h.config, pool: h.pool, ...routeDeps() }); }, { prefix: '/t' });
  }, 60_000);
  const get = (q: string, client: Client = a, farm = id) => preview.inject({ method: 'GET', url: `/t/api/v1/farms/${farm}/season-preview?${q}`, headers: { cookie: client.cookie, origin: ORIGIN } });

  it('previews on the field: its area, its fieldId, the field-scoped engine; a season saved on another field is not found, a farm-wide season is on every field', async () => {
    engineCalls.length = 0;
    const w = SeasonPreview.parse((await get('planId=rot-west&fieldId=west')).json().data);
    expect(w).toMatchObject({ fieldId: 'west', planId: 'rot-west', origin: 'saved_season' });
    expect(w.fieldAreaHa).toBeCloseTo(areaOf(WEST), 9);
    expect(w.score).not.toBeNull();
    expect(engineCalls).toEqual([{ farmId: id, fieldId: 'west' }]);
    // The same season id on the other field is not found: it was saved on west.
    expect((await get('planId=rot-west&fieldId=east')).statusCode).toBe(404);
    const e = SeasonPreview.parse((await get('planId=rot-east&fieldId=east')).json().data);
    expect(e.fieldAreaHa).toBeCloseTo(areaOf(EAST), 9);
    expect(e.fieldId).toBe('east');
    for (const f of ['west', 'east']) expect((await get(`planId=rot-farm&fieldId=${f}`)).statusCode, f).toBe(200);
    // Field yield totals use the field's area.
    expect(w.yieldKgPerHa).not.toBeNull();
    expect(w.yieldForFieldKg).toEqual({ low: Math.round(w.yieldKgPerHa!.low * w.fieldAreaHa!), high: Math.round(w.yieldKgPerHa!.high * w.fieldAreaHa!) });
    // A custom slot on a field uses its area too.
    const custom = SeasonPreview.parse((await get('cropId=maize&productId=maize-grain&sowing=2027-06-10&fieldId=east')).json().data);
    expect(custom).toMatchObject({ fieldId: 'east', origin: 'custom' });
    expect(custom.fieldAreaHa).toBeCloseTo(areaOf(EAST), 9);
  });

  it('without fieldId the whole farm is previewed as before (no fieldId on the response, the farm area, the farm-level engine)', async () => {
    engineCalls.length = 0;
    const p = SeasonPreview.parse((await get('planId=rot-farm')).json().data);
    expect(p.fieldId).toBeUndefined();
    expect(p.fieldAreaHa).toBeCloseTo(areaOf(FARM), 2);
    expect(engineCalls).toEqual([{ farmId: id, fieldId: null }]);
  });

  it('an unknown field is 404 field_not_found (also on a farm without fields), a malformed id is 400, a stranger is 404', async () => {
    const r = await get('planId=rot-west&fieldId=north');
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('field_not_found');
    const plain = (await a.call('POST', '/api/v1/farms', { payload: farmBody({ location: HASSAN, facts: {} }) })).json().data.id as string;
    const none = await get('cropId=maize&productId=maize-grain&sowing=2027-06-10&fieldId=west', a, plain);
    expect(none.statusCode).toBe(404);
    expect(none.json().error.code).toBe('field_not_found');
    expect((await get('planId=rot-west&fieldId=a%20b')).statusCode).toBe(400);
    expect((await get('planId=rot-west&fieldId=west', b)).statusCode).toBe(404);
  });

  it('the service rejects an unknown field before any provider read', async () => {
    const d: SeasonPreviewDeps = { config: h.config, pool: h.pool, ...routeDeps() };
    engineCalls.length = 0;
    await expect(seasonPreview(d, await ownerOf(id), id, { planId: 'rot-west', fieldId: 'north' } as unknown as SeasonPreviewQuery)).rejects.toMatchObject({ statusCode: 404, code: 'field_not_found' });
    expect(engineCalls).toEqual([]);
  });
});

// ------------------------------------------------------------------ soil review
describe('soil review per field', () => {
  const deps = (over: Partial<SoilReviewDeps> = {}): SoilReviewDeps => ({ pool: h.pool, config: h.config, budget: Budget.fromConfig(h.pool, h.config), now: () => NOW, ...over });
  const MARKERS = [
    { id: 'ph', parameter: 'ph', label: 'pH', raw: '7.2', unit: '-', value: 7.2, canonicalUnit: 'pH' },
    { id: 'n', parameter: 'nitrogen_unspecified', label: 'Nitrogen', raw: '278', unit: 'kg/ha', value: 278, canonicalUnit: 'kg/ha' },
    { id: 'p', parameter: 'phosphorus_total', label: 'Total Phosphorus', raw: '16', unit: 'kg/ha', value: 16, canonicalUnit: 'kg/ha' },
    { id: 'k', parameter: 'potassium_total', label: 'Total potassium', raw: '186', unit: 'kg/ha', value: 186, canonicalUnit: 'kg/ha' },
  ];
  async function confirm(farmId: string, ownerId: string, markers: typeof MARKERS, collection = '2026-09-15') {
    const reportId = randomUUID();
    await h.pool.query("INSERT INTO soil_reports(id,owner_id,farm_id,kind,mode,status,filename,content_type,byte_size,sha256,original_key) VALUES($1,$2,$3,'field_report',$4,'confirmed','r.pdf','application/pdf',10,$5,$6)", [reportId, ownerId, farmId, h.config.RUNTIME_MODE, randomUUID(), `k/${reportId}`]);
    const sampleId = (await h.pool.query<{ id: string }>("INSERT INTO soil_samples(owner_id,farm_id,report_id,source_sample_id,review_revision,sample_label,collection_date) VALUES($1,$2,$3,'S1',1,'Field',$4) RETURNING id", [ownerId, farmId, reportId, collection])).rows[0]!.id;
    for (const m of markers)
      await h.pool.query("INSERT INTO soil_markers(sample_id,source_marker_id,parameter,raw_label,raw_value,raw_unit,numeric_value,qualifier,matrix,evidence_page,evidence_quote,native_text_check,extraction_confidence,warnings,canonical_value,canonical_unit) VALUES($1,$2,$3,$4,$5,$6,$7,'exact','soil',1,'q','matched','high','[]'::jsonb,$7,$8)", [sampleId, m.id, m.parameter, m.label, m.raw, m.unit, m.value, m.canonicalUnit]);
  }
  const live = async (farmId: string) => (await h.pool.query<{ field: string | null; archived: boolean }>("SELECT input_context->>'fieldId' AS field, archived_at IS NOT NULL AS archived FROM soil_reviews WHERE farm_id=$1 ORDER BY created_at", [farmId])).rows;
  const jobs = async (farmId: string) => Number((await h.pool.query("SELECT count(*) FROM jobs WHERE type='farm.soil-review' AND payload->>'farmId'=$1", [farmId])).rows[0].count);
  const auth = async (farmId: string) => { const s = (await h.pool.query<{ owner_id: string; id: string }>('SELECT s.owner_id,s.id FROM sessions s JOIN farms f ON f.owner_id=s.owner_id WHERE f.id=$1 ORDER BY s.created_at DESC LIMIT 1', [farmId])).rows[0]!; return { ownerId: s.owner_id, sessionId: s.id }; };
  /** West grows paddy and has groundnut planned next; east grows maize and has paddy planned next (the planned season id marks it as from an applied year plan). */
  const seeded = async () => {
    const id = await farmWith({
      cycles: [cycle('c-west', 'paddy', 'paddy-grain', '2026-07-01', 'west'), cycle('c-east', 'maize', 'maize-grain', '2026-09-01', 'east')],
      rotationPlans: [{ id: 'yearplan:r1:o1:s1', year: 2027, season: 'Rabi', cropId: 'groundnut', cropName: 'Groundnut', plannedSowingDate: '2027-01-10', fieldId: 'west' }, { id: 'yearplan:r2:o1:s1', year: 2027, season: 'Rabi', cropId: 'paddy', cropName: 'Paddy', plannedSowingDate: '2027-01-20', fieldId: 'east' }],
    });
    const a1 = await auth(id);
    await confirm(id, a1.ownerId, MARKERS);
    return { id, auth: a1 };
  };

  it('currentCrop, nextCrop, the facts and the limitation line are the field\'s; the readings stay the farm\'s; each field has its own hash, row and job', async () => {
    const { id, auth: au } = await seeded();
    const west = SoilReview.parse(await ensureSoilReview(deps(), au, id, { fieldId: 'west' }));
    const east = SoilReview.parse(await ensureSoilReview(deps(), au, id, { fieldId: 'east' }));
    const whole = SoilReview.parse(await ensureSoilReview(deps(), au, id));
    expect(new Set([west.reviewId, east.reviewId, whole.reviewId]).size).toBe(3);
    expect(new Set([west.contextHash, east.contextHash, whole.contextHash]).size).toBe(3);
    expect(west).toMatchObject({ fieldId: 'west', currentCrop: { cropId: 'paddy' }, nextCrop: { cropId: 'groundnut', source: 'year_plan_applied' } });
    expect(east).toMatchObject({ fieldId: 'east', currentCrop: { cropId: 'maize' }, nextCrop: { cropId: 'paddy', source: 'year_plan_applied' } });
    expect(west.limitations).toContain('Soil values are for the whole farm; the crop context is West strip.');
    expect(east.limitations).toContain('Soil values are for the whole farm; the crop context is East strip.');
    expect(west.limitations).not.toContain('Soil values are for the whole farm; the crop context is East strip.');
    expect(whole.fieldId).toBeUndefined();
    expect(whole.limitations.some((l) => l.startsWith('Soil values are for the whole farm'))).toBe(false);
    // The soil readings are identical (farm-level); the crop need columns follow the field.
    const readingsOf = (r: SoilReview) => r.readings.map((x) => [x.parameter, x.value, x.rating]);
    expect(readingsOf(west)).toEqual(readingsOf(east));
    expect(west.readings.find((x) => x.parameter === 'nitrogen_unspecified')!.cropNeed).toMatchObject({ cropId: 'paddy' });
    expect(east.readings.find((x) => x.parameter === 'nitrogen_unspecified')!.cropNeed).toMatchObject({ cropId: 'maize' });
    // The code facts (which the Meta narrative may only restate) name the field's crops.
    expect(west.facts.join(' ')).toMatch(/Next crop Groundnut/);
    expect(west.facts.join(' ')).not.toMatch(/Maize/);
    expect(east.facts.join(' ')).toMatch(/Next crop Paddy/);
    expect(east.facts.join(' ')).toMatch(/Maize/);
    expect(await jobs(id)).toBe(3);
    // A repeat request returns the same review per field and starts no job.
    expect((await ensureSoilReview(deps(), au, id, { fieldId: 'west' })).reviewId).toBe(west.reviewId);
    expect((await readSoilReview(deps(), au.ownerId, id, 'east')).reviewId).toBe(east.reviewId);
    expect(await jobs(id)).toBe(3);
    expect((await live(id)).map((r) => r.field ?? 'farm').sort()).toEqual(['east', 'farm', 'west']);
  });

  it('renaming a field changes the review hash, so the limitation line never shows the old name', async () => {
    const { id, auth: au } = await seeded();
    const before = SoilReview.parse(await ensureSoilReview(deps(), au, id, { fieldId: 'west' }));
    expect(before.limitations).toContain('Soil values are for the whole farm; the crop context is West strip.');
    const ws = await getWorkspace(h.pool, au.ownerId, id);
    await putWorkspace(h.pool, au.ownerId, id, { boundary: ws.boundary, fields: ws.fields.map((f) => (f.id === 'west' ? { ...f, name: 'Home strip' } : f)), previousHarvest: ws.previousHarvest, cycles: ws.cycles, rotationPlans: ws.rotationPlans, expectedVersion: ws.version });
    const after = SoilReview.parse(await ensureSoilReview(deps(), au, id, { fieldId: 'west' }));
    expect(after.contextHash).not.toBe(before.contextHash);
    expect(after.reviewId).not.toBe(before.reviewId);
    expect(after.limitations).toContain('Soil values are for the whole farm; the crop context is Home strip.');
    expect(after.limitations.join(' ')).not.toContain('West strip');
  });

  it('archiving is per field: a new confirmation replaces only the field that asks; a change on one field leaves the other field\'s review current', async () => {
    const { id, auth: au } = await seeded();
    const west = await ensureSoilReview(deps(), au, id, { fieldId: 'west' });
    const east = await ensureSoilReview(deps(), au, id, { fieldId: 'east' });
    await confirm(id, au.ownerId, [{ id: 'zn', parameter: 'zinc_available', label: 'Zinc', raw: '0.4', unit: 'mg/kg', value: 0.4, canonicalUnit: 'mg/kg' }], '2026-10-20');
    const west2 = await ensureSoilReview(deps(), au, id, { fieldId: 'west' });
    expect(west2.reviewId).not.toBe(west.reviewId);
    expect(west2.readings).toHaveLength(5);
    // East's row was not touched by west's rebuild; it is archived only when east asks.
    let rows = await live(id);
    expect(rows.filter((r) => r.field === 'east').map((r) => r.archived)).toEqual([false]);
    expect(rows.filter((r) => r.field === 'west').map((r) => r.archived)).toEqual([true, false]);
    const east2 = await ensureSoilReview(deps(), au, id, { fieldId: 'east' });
    expect(east2.reviewId).not.toBe(east.reviewId);
    rows = await live(id);
    expect(rows.filter((r) => r.field === 'east').map((r) => r.archived)).toEqual([true, false]);
    expect(rows.filter((r) => r.field === 'west').map((r) => r.archived)).toEqual([true, false]);
    // Changing east's next season changes east's hash only; west's review is still the current one.
    const ws = await getWorkspace(h.pool, au.ownerId, id);
    await putWorkspace(h.pool, au.ownerId, id, { boundary: ws.boundary, previousHarvest: ws.previousHarvest, cycles: ws.cycles, rotationPlans: ws.rotationPlans.map((p) => (p.fieldId === 'east' ? { ...p, cropId: 'groundnut', cropName: 'Groundnut' } : p)), expectedVersion: ws.version });
    expect((await readSoilReview(deps(), au.ownerId, id, 'west')).contextHash).toBe(west2.contextHash);
    expect((await readSoilReview(deps(), au.ownerId, id, 'east')).contextHash).not.toBe(east2.contextHash);
  });

  it('an unknown field is 404 field_not_found on the service and the route (GET and POST), a malformed id is 400, a stranger gets 404', async () => {
    const { id, auth: au } = await seeded();
    await expect(ensureSoilReview(deps(), au, id, { fieldId: 'north' })).rejects.toMatchObject({ statusCode: 404, code: 'field_not_found' });
    await expect(readSoilReview(deps(), au.ownerId, id, 'north')).rejects.toMatchObject({ statusCode: 404, code: 'field_not_found' });
    for (const method of ['GET', 'POST'] as const) {
      const r = await a.call(method, `/api/v1/farms/${id}/soil-review?fieldId=north`, method === 'POST' ? { payload: {} } : {});
      expect(r.statusCode, `${method} ${r.body}`).toBe(404);
      expect(r.json().error.code).toBe('field_not_found');
    }
    expect((await a.call('GET', `/api/v1/farms/${id}/soil-review?fieldId=a%20b`)).statusCode).toBe(400);
    expect((await b.call('GET', `/api/v1/farms/${id}/soil-review?fieldId=west`)).statusCode).toBe(404);
    expect(await jobs(id)).toBe(0);
  });

  it('route: ?fieldId= returns that field\'s review and POST refreshes only that field', async () => {
    const { id } = await seeded();
    const url = (q = '') => `/api/v1/farms/${id}/soil-review${q}`;
    const west = SoilReview.parse((await a.call('GET', url('?fieldId=west'))).json().data);
    const east = SoilReview.parse((await a.call('GET', url('?fieldId=east'))).json().data);
    expect([west.fieldId, east.fieldId]).toEqual(['west', 'east']);
    expect(west.currentCrop?.cropId).toBe('paddy');
    expect(east.currentCrop?.cropId).toBe('maize');
    const forced = SoilReview.parse((await a.call('POST', url('?fieldId=west'), { payload: {} })).json().data);
    expect(forced.reviewId).toBe(west.reviewId); // still being built: returned, not replaced
    expect((await a.call('POST', url('?fieldId=west'), { payload: { force: true } })).statusCode).toBe(400);
    expect(SoilReview.parse((await a.call('GET', url('?fieldId=east'))).json().data).reviewId).toBe(east.reviewId);
  });
});
