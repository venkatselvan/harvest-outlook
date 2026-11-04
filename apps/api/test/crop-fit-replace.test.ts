import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CropFitReview, type HarvestPriceOutlook } from '@harvest/contracts';
import { loadCatalogueIntoDb } from '../src/catalogue/load';
import { Budget } from '../src/services/budget';
import { getWorkspace, putWorkspace } from '../src/services/workspace';
import { data } from '../src/services/year-plan';
import { addDays } from '../src/services/year-plan/dates';
import { alreadyBestSentence, ensureCropFit, fitContext, generateCropFit, replaceSentence, type CropFitDeps } from '../src/services/crop-fit/service';
import { farmBody, login, setupHarness, type Client, type Harness } from './helpers';

/**
 * Crop fit pass 2 (docs/research/EVARA_ACTIONS_SPEC.md 1.2, packet E1): planned, unsown saved seasons set aside so crops that
 * could replace them are ranked; the long-summary parse error; the date-mode note. Test DB, real read-only research files
 * (Hassan, Karnataka), SYNTHETIC prices, rain and market quotes; no model call (synthetic mode). Not field observations.
 */
let h: Harness, a: Client;
beforeAll(async () => { data.invalidate(); h = await setupHarness(); await loadCatalogueIntoDb(h.pool); a = await login(h.app); }, 120_000);
afterAll(async () => h?.close());

const NOW = () => new Date('2026-11-01T06:00:00Z');
const outlook = (x: { productId: string; harvestDate: string; asOf: string }) => ({
  productId: x.productId, status: 'available', missingReason: null, scope: { level: 'state', requestedLevel: 'district', stateName: 'Karnataka', districtName: null, marketCount: 2, marketIds: [], fallbackNote: null },
  unit: 'INR/kg', priceBasis: 'wholesale_mandi_modal', basisLabel: 'Synthetic test price', limitations: [], method: 'B_seasonal_reference/pooled-v1', harvestDate: x.harvestDate, harvestWeek: { year: 2027, week: 30 }, asOf: x.asOf,
  weekWindow: 2, yearsRequested: 3, yearsConsidered: [2023, 2024, 2025], yearsUsed: [2023, 2024, 2025], perYear: [], p10: 15, p25: 18, p50: 21, p75: 24, p90: 27, annualMean: 20, annualWeeks: 150, weeksUsed: 15, observations: 90, marketsUsed: 2, residualCount: 140,
}) as unknown as HarvestPriceOutlook;
const deps = (): CropFitDeps => ({
  pool: h.pool, config: h.config, budget: Budget.fromConfig(h.pool, h.config), now: NOW,
  sources: { priceOutlook: async (x) => outlook(x), climatology: async () => null, neighbourhood: async () => { throw new Error('no ndvi'); }, marketNow: async () => null },
});
async function farm(cycles: unknown[], rotationPlans: unknown[]) {
  const f = (await a.call('POST', '/api/v1/farms', { payload: farmBody({ name: `Replace QA ${randomUUID()}`, location: { stateId: 'IN-KA', districtId: 'IN-KA-hassan', precision: 'precise', lat: 13.0, lon: 76.1 }, facts: {} }) })).json().data as { id: string };
  const s = (await h.pool.query<{ owner_id: string; id: string }>('SELECT s.owner_id,s.id FROM sessions s JOIN farms f ON f.owner_id=s.owner_id WHERE f.id=$1 ORDER BY s.created_at DESC LIMIT 1', [f.id])).rows[0]!;
  const cur = await getWorkspace(h.pool, s.owner_id, f.id);
  await putWorkspace(h.pool, s.owner_id, f.id, { expectedVersion: cur.version, boundary: null, previousHarvest: { status: 'none' }, cycles, rotationPlans } as never);
  return { id: f.id, auth: { ownerId: s.owner_id, sessionId: s.id } };
}
async function review(id: string, auth: { ownerId: string; sessionId: string }, raw: Parameters<typeof ensureCropFit>[3]) {
  const r = await ensureCropFit(deps(), auth, id, raw);
  await generateCropFit(deps(), r.reviewId!, auth.ownerId);
  return CropFitReview.parse(await ensureCropFit(deps(), auth, id, raw));
}
const PADDY = { id: 'cy-paddy', cropId: 'paddy', productId: 'paddy-grain', sowingDate: '2026-08-01', establishmentDate: '2026-08-01', stage: 'growing' };
const PIGEON_PEA = { id: 'sv-pp', year: 2027, season: 'Summer', cropId: 'pigeon-pea', cropName: 'Pigeon pea', plannedSowingDate: '2027-02-12' };
const PP_REPLACEMENT = { rotationPlanId: 'sv-pp', cropId: 'pigeon-pea', cropName: 'Pigeon pea', plannedSowingDate: '2027-02-12' };

describe('crop fit replace pass (test DB)', () => {
  it('Hassan, next: pigeon pea planned for Feb 2027 and not sown -> pass 2 ranks replacements naming pigeon pea; picks come from them; one-sentence lead', async () => {
    const { id, auth } = await farm([PADDY], [PIGEON_PEA]);
    const r = await review(id, auth, { mode: 'next' });
    expect(r.status).toBe('ready');
    expect(r.replacePass).toBe(true);
    const replacing = r.candidates.filter((c) => c.replaces?.length);
    expect(replacing.length).toBeGreaterThan(0);
    for (const c of replacing) expect(c.replaces).toEqual([PP_REPLACEMENT]);
    // Ranked before the field would be free after the pigeon pea (it would have ended in September 2027).
    expect(replacing.some((c) => c.sowing < '2027-09-01')).toBe(true);
    expect(r.picks.length).toBeGreaterThan(0);
    for (const p of r.picks) expect(r.candidates.some((c) => c.cropId === p.cropId && c.productId === p.productId)).toBe(true);
    expect(r.picks.some((p) => r.candidates.find((c) => c.cropId === p.cropId && c.productId === p.productId)!.replaces?.length)).toBe(true);
    expect(r.summary.startsWith('Pigeon pea is planned for 12 Feb 2027 but not sown, so these picks are ranked as replacements for it. ')).toBe(true);
    expect(r.summary.length).toBeLessThanOrEqual(600);
    expect(r.limitations.join(' ')).toContain('were set aside for this ranking');
  });

  it('Hassan, season kharif: the kharif weeks that overlap the planned pigeon pea are ranked as replacements', async () => {
    const { id, auth } = await farm([PADDY], [PIGEON_PEA]);
    const r = await review(id, auth, { mode: 'season', season: 'kharif' });
    expect(r.status).toBe('ready');
    expect(r.replacePass).toBe(true);
    expect(r.candidates.some((c) => c.replaces?.[0]?.rotationPlanId === 'sv-pp')).toBe(true);
  });

  it('no replaceable season: pass 1 stands (replacePass absent, no replaces)', async () => {
    const { id, auth } = await farm([PADDY], []);
    const r = await review(id, auth, { mode: 'next' });
    expect(r.status).toBe('ready');
    expect(r.replacePass).toBeUndefined();
    expect(r.candidates.every((c) => c.replaces === undefined)).toBe(true);
  });

  it('date mode: an overlap with a planned, unsown season says it could be replaced', async () => {
    const { id, auth } = await farm([PADDY], [PIGEON_PEA]);
    const r = await review(id, auth, { mode: 'date', sowing: '2027-05-17' });
    const notes = r.candidates.flatMap((c) => c.uncertainties).filter((u) => u.includes('pigeon pea'));
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0]).toContain('planned but not sown; this crop could replace it.');
  });

  it('a long list of recorded crops filling the year no longer throws on the 600-character summary: status unavailable, summary capped', async () => {
    // Forty recorded cycles (synthetic, sown before today) on one field: many occupants in the plan horizon.
    const crops = ['maize', 'sorghum', 'groundnut', 'green-gram', 'finger-millet', 'onion', 'cotton', 'soybean'];
    const cycles = Array.from({ length: 40 }, (_, i) => ({ id: `cy-${i}`, cropId: crops[i % crops.length], sowingDate: addDays('2026-08-02', i * 2), stage: 'growing' }));
    const { id, auth } = await farm([PADDY, ...cycles], []);
    const c = await fitContext(deps(), auth.ownerId, id, { mode: 'next' });
    // The pre-fix summary listed every occupant; that list alone is past the contract's 600 characters.
    expect(c.ctx.occupied.map((o) => `${data.cropDisplayName(o.cropId).toLowerCase()} 1 Jan 2027 to 1 Jan 2027`).join(', ').length).toBeGreaterThan(600);
    const r = await review(id, auth, { mode: 'next' });
    expect(['unavailable', 'ready']).toContain(r.status);
    expect(r.summary.length).toBeLessThanOrEqual(600);
    if (r.status === 'unavailable') expect(r.summary).toContain('more');
  });

  it('replaceSentence: one overdue season, several seasons', () => {
    expect(replaceSentence([{ ...PP_REPLACEMENT, plannedSowingDate: '2026-10-12' }], '2026-11-01')).toBe('Pigeon pea was planned for 12 Oct 2026 and is not sown, so these picks are ranked as replacements for it.');
    expect(replaceSentence([PP_REPLACEMENT, { rotationPlanId: 'm', cropId: 'maize', cropName: 'Maize', plannedSowingDate: '2027-06-10' }], '2026-11-01'))
      .toBe('Pigeon pea (planned 12 Feb 2027) and maize (planned 10 Jun 2027) are planned but not sown, so these picks are ranked as replacements for them.');
  });

  // Seen live on the demo farm (2026-11-04): the saved Maize came back as a "replacement" for itself. The engine's best Maize
  // week with the saved season set aside is 1 Jan 2027 (synthetic prices, Hassan); the saved Maize below is planned 3 days later.
  const MAIZE_TWIN = { id: 'sv-mz', year: 2027, season: 'Summer', cropId: 'maize', cropName: 'Maize', plannedSowingDate: '2027-01-04', plannedHarvestDate: '2027-05-26' };

  it('a candidate that is the saved season itself (same crop and product, sown within 7 days) carries no replaces, stays ranked and is kept out of the picks', async () => {
    const { id, auth } = await farm([PADDY], [MAIZE_TWIN]);
    const r = await review(id, auth, { mode: 'next' });
    expect(r.status).toBe('ready');
    const maize = r.candidates.filter((c) => c.cropId === 'maize');
    expect(maize).toHaveLength(1);
    expect(Math.abs((Date.parse(maize[0]!.sowing) - Date.parse(MAIZE_TWIN.plannedSowingDate)) / 86400_000)).toBeLessThanOrEqual(7);
    expect(maize[0]!.rank).toBe(1); // still in the ranked list, where its score puts it
    expect(maize[0]!.replaces).toBeUndefined();
    // The other crops overlap the saved Maize months and would replace it.
    const others = r.candidates.filter((c) => c.cropId !== 'maize' && c.replaces?.length);
    expect(others.length).toBeGreaterThan(0);
    for (const c of others) expect(c.replaces).toEqual([{ rotationPlanId: 'sv-mz', cropId: 'maize', cropName: 'Maize', plannedSowingDate: '2027-01-04' }]);
    expect(r.picks).toHaveLength(3);
    expect(r.picks.some((p) => p.cropId === 'maize')).toBe(false);
    expect(r.replacePass).toBe(true);
    expect(r.summary.startsWith('Maize is planned for 4 Jan 2027 but not sown, so these picks are ranked as replacements for it. ')).toBe(true);
  });

  it('the same crop sown a month from the saved date is a real replacement and keeps replaces', async () => {
    const { id, auth } = await farm([PADDY], [{ ...MAIZE_TWIN, plannedSowingDate: '2027-02-05' }]);
    const r = await review(id, auth, { mode: 'next' });
    const maize = r.candidates.find((c) => c.cropId === 'maize')!;
    expect(maize.replaces?.map((x) => x.rotationPlanId)).toEqual(['sv-mz']);
  });

  it('alreadyBestSentence: the saved season is already the best fit (used when every ranked crop is a saved season)', () => {
    expect(alreadyBestSentence([{ rotationPlanId: 'sv-mz', cropId: 'maize', cropName: 'Maize', plannedSowingDate: '2027-02-05' }])).toBe('Maize (planned 5 Feb 2027) is already the best fit, so nothing here would replace it.');
    expect(alreadyBestSentence([])).toContain('already the best fit');
  });
});
