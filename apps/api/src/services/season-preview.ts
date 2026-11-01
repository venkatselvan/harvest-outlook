import type {BasisRef, Mode, SeasonPreview, SeasonPreviewQuery, SoilCheck, StageTimeline} from '@harvest/contracts';
import type {Config} from '../config';
import type {Pool} from '../db/pool';
import type {FetchLike} from '../ingest/http';
import {isoWeek} from '../plans/adapters/market-outlook';
import {createWeatherSource} from '../plans/adapters/weather-source';
import type {ClimatologyBundle, WeatherScope, WeatherSource} from '../plans/sources';
import {careSchedule} from './command-center';
import {defaultRateMarker, phRanges} from './crop-fit/service';
import {marketNow as readMarketNow, type MarketNowArgs} from './crop-fit/market-now';
import {compareSoil, soilFacts, type RateMarkerFn} from './crop-fit/soil-compare';
import {ApiError, notFound} from './errors';
import {getFarm} from './farms';
import {focusedResearch, type FocusedResearch} from './focused-crops';
import {harvestPriceOutlook, isoWeekMonday, seasonalReferenceByWeek, type HarvestPriceOutlook, type HarvestPriceOutlookArgs, type SeasonalReferenceByWeek, type SeasonalReferenceByWeekArgs} from './price-series';
import {farmSoilMarkers} from './soil-reports';
import {geographyNames} from './today/view';
import {stageTimeline} from './today/stage-timeline';
import {boundaryMetrics, getWorkspace} from './workspace';
import * as candidates from './year-plan/candidates';
import {evaluateSlot, slotCompanion, type EvaluatedSlot, type ScoringNorm} from './year-plan/assemble';
import * as data from './year-plan/data';
import {addDays, daysBetween, monthOf} from './year-plan/dates';
import {priceHarvestDate, priceKey, slotPriceKey, type Inputs} from './year-plan/inputs';
import {clip, reasonCodes, slotDisplayScore, soilRotationScore, type ReasonCode} from './year-plan/scoring';
import {storedEngineInputs, todayIst, type YearPlanDeps} from './year-plan/service';
import type {EngineContext, SlotPlan} from './year-plan/types';
import {placeWindows, windowForDate} from './year-plan/windows';

/**
 * Season preview (ROUND3_SPEC.md section 7): what a planned season would look like on this field, assembled synchronously
 * from code-computed references. No job and no model call. Sources, in order:
 *  - stage calendar: today/stage-timeline.ts anchored on the planned sowing date (the Today view's model);
 *  - typical weather: the weather source's climatology (daily normals of past years) aggregated per calendar month inside
 *    the season: rain = mean daily normal x days in season, temperatures = mean of the daily normals. Not a forecast;
 *  - price: harvestPriceOutlook at the harvest midpoint and the weekly seasonalReferenceByWeek path (same method), and the
 *    14-trading-day "price now" from stored mandi quotes (crop-fit/market-now.ts);
 *  - yield, cost, profit, score, components, reason codes, water fit: the year-plan slot scoring (evaluateSlot) against the
 *    stored engine inputs of the farm's current ready review, with only this slot's harvest-week price looked up. Without
 *    a ready review these stay null (we do not re-run the engine's climatology and price prefetch here);
 *  - soil checks: crop-fit/soil-compare.ts against the confirmed soil markers;
 *  - steps: the focused care schedule dated on the sowing date, the stage starts and the harvest window.
 *
 * Assumption (documented where it applies): a saved season without an establishment method (seasons saved before round 3,
 * or added by hand) uses the first establishment method the focused catalogue lists for the crop for its care steps and
 * says so in limitations. The year-plan scoring uses the stored review of the plan year the season is sown in.
 */
export interface SeasonPreviewDeps {
  config: Config;
  pool: Pool;
  weatherFetch?: FetchLike | undefined;
  now?: (() => Date) | undefined;
  /** Test injection points; production reads the stores and files. */
  weatherSource?: Pick<WeatherSource, 'getClimatology'> | undefined;
  sources?: {
    priceOutlook?: ((args: HarvestPriceOutlookArgs) => Promise<HarvestPriceOutlook>) | undefined;
    seasonal?: ((args: SeasonalReferenceByWeekArgs) => Promise<SeasonalReferenceByWeek>) | undefined;
    marketNow?: ((args: MarketNowArgs) => Promise<SeasonPreview['marketNow']>) | undefined;
    /** Test stub for storedEngineInputs; `sowing` is the season's sowing date (it selects the plan horizon). */
    engine?: ((ownerId: string, farmId: string, sowing: string) => Promise<StoredEngine | null>) | undefined;
    focused?: (() => Promise<FocusedResearch>) | undefined;
  } | undefined;
  rateMarker?: RateMarkerFn | null | undefined;
}
export interface StoredEngine { ctx: EngineContext; inputs: Inputs; norm: ScoringNorm | null; reviewId?: string; asOf?: string }

export const PATH_MAX_POINTS = 60;
export const MAX_MONTHS = 14;
export const MAX_STEPS = 40;
export const WEATHER_NOTE = "Typical conditions from past years' normals; not a forecast.";
export const NO_REVIEW_LIMITATION = 'Generate the year plan to see yield, profit and score here.';
export const REFERENCE_LIMITATION = 'Planned season: a calculated reference from the stage calendar, typical weather of past years and historical prices. Nothing here is a forecast or an observation.';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const round4 = (x: number) => Math.round(x * 10000) / 10000;
const minDate = (a: string, b: string) => (a < b ? a : b);
const lastDayOfMonth = (d: string) => { const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7)); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
const nextMonth = (d: string) => addDays(lastDayOfMonth(d), 1);
const validationError = (message: string) => new ApiError(400, 'validation_error', message);
/** ISO Monday of the week containing `d`. */
const mondayOf = (d: string) => { const w = isoWeek(d); return isoWeekMonday(w.year, w.week); };

type Farm = NonNullable<Awaited<ReturnType<typeof getFarm>>>;
interface Slot {
  planId: string | null; origin: SeasonPreview['origin']; cropId: string; cropName: string | null; productId: string | null; productName: string | null;
  sowing: string; harvestLatest: string | null; method: string | null; kind: SeasonPreview['kind']; systemId: string | null; companionName: string | null;
}

/** Saved season from the workspace, or the query's slot. */
async function resolveSlot(pool: Pool, ownerId: string, farmId: string, q: SeasonPreviewQuery): Promise<Slot> {
  if (q.planId) {
    const ws = await getWorkspace(pool, ownerId, farmId);
    const p = ws.rotationPlans.find((r) => r.id === q.planId);
    if (!p) throw notFound('Saved season');
    if (!p.plannedSowingDate) throw validationError('This saved season has no planned sowing date; add one to preview it.');
    const kind = p.kind ?? (data.isGreenManure(p.cropId) ? 'green_manure' : 'crop');
    return {
      planId: p.id, origin: 'saved_season', cropId: p.cropId, cropName: p.cropName ?? null, productId: p.productId ?? (kind === 'green_manure' ? p.cropId : null), productName: p.productName ?? null,
      sowing: p.plannedSowingDate, harvestLatest: p.plannedHarvestDate ?? null, method: q.establishmentMethod ?? p.establishmentMethod ?? null, kind,
      systemId: p.companion?.systemId ?? null, companionName: p.companion ? `${p.companion.cropName ?? data.cropDisplayName(p.companion.cropId)} (${p.companion.rowRatio})` : null,
    };
  }
  if (!q.cropId || !q.sowing) throw validationError('Name a saved season (planId) or a crop and sowing date (cropId, sowing).');
  if (q.harvestLatest && q.harvestLatest < q.sowing) throw validationError('harvestLatest must be on or after sowing.');
  const gm = data.isGreenManure(q.cropId);
  return {
    planId: null, origin: 'custom', cropId: q.cropId, cropName: null, productId: q.productId ?? (gm ? q.cropId : null), productName: null, sowing: q.sowing,
    harvestLatest: q.harvestLatest ?? null, method: q.establishmentMethod ?? null, kind: q.systemId ? 'intercrop' : gm ? 'green_manure' : 'crop', systemId: q.systemId ?? null, companionName: null,
  };
}

/** Slot plan for the engine (same rules as a farmer edit: sourced window hit, sourced duration class, land-prep gap). */
function slotPlan(ctx: EngineContext, inputs: Inputs, s: Slot, productId: string, harvest: {earliest: string; latest: string}): {plan: SlotPlan; parts: candidates.PlanParts} {
  const gm = s.kind === 'green_manure';
  const classes = data.durationFor(s.cropId, s.method, ctx.stateId, productId);
  const days = daysBetween(s.sowing, harvest.latest);
  const cls = classes.find((c) => days >= c.min && days <= c.max) ?? classes[0] ?? null;
  const placed = placeWindows(data.windowsFor(s.cropId, {stateId: ctx.stateId, districtId: ctx.districtId}), {from: addDays(s.sowing, -400), to: addDays(s.sowing, 400)});
  const irrigation = ctx.irrigation;
  void inputs;
  const hit = windowForDate(s.sowing, placed, irrigation);
  const parts: candidates.PlanParts = {
    key: `preview:${s.cropId}|${productId}|${s.method ?? 'any'}|${s.sowing}|${harvest.latest}`, kind: gm ? 'green_manure' : 'crop', cropId: s.cropId, productId: gm ? s.cropId : productId,
    method: gm ? null : s.method ?? cls?.method ?? null, sowing: s.sowing, harvest, season: hit?.window.season ?? data.seasonOfMonth(monthOf(s.sowing)),
    durationDays: {low: daysBetween(s.sowing, harvest.earliest), high: days}, duration: cls, hit,
  };
  const plan = candidates.makeSlotPlan(ctx, parts);
  if (cls && (days < cls.min || days > cls.max)) plan.flags.harvestAssumed = true;
  return {plan, parts};
}

/** Intercrop facts P1 attaches to a slot (read defensively: the engine module is owned by another packet). */
interface IntercropFacts { systemId: string; companionHarvest: {earliest: string; latest: string}; system: {companionProductId: string; rowRatio: string; arrangement: 'row' | 'paired_row' | 'strip' | 'mixed' | null; shareBasis: 'sourced' | 'assumed'; yieldShare: {main: {min: number; max: number}; companion: {min: number; max: number}}; nitrogenCredit?: {min: number; max: number} | null; source?: {id: string; title?: string | null; url: string | null; locator?: string | null} | null} }
const intercropOf = (plan: SlotPlan): IntercropFacts | null => ((plan as unknown as {intercrop?: IntercropFacts}).intercrop ?? null);

/** Intercrop slot through P1's makeIntercropSlotPlan(ctx, parts & {system}); null (main crop alone) when unavailable. */
function intercropPlan(ctx: EngineContext, parts: candidates.PlanParts, systemId: string): {plan: SlotPlan | null; reason: string | null} {
  const fn = (candidates as Record<string, unknown>).makeIntercropSlotPlan;
  const lookup = (data as Record<string, unknown>).intercropSystem;
  if (typeof fn !== 'function' || typeof lookup !== 'function') return {plan: null, reason: 'Intercrop scoring is not available yet'};
  const system = (lookup as (id: string) => unknown)(systemId);
  if (!system) return {plan: null, reason: `The intercrop system ${systemId} is not in the intercropping research file`};
  try {
    const out = (fn as (c: EngineContext, p: Record<string, unknown>) => SlotPlan)(ctx, {...parts, key: `${parts.key}|${systemId}`, system});
    return out && intercropOf(out) ? {plan: out, reason: null} : {plan: null, reason: 'Intercrop scoring returned no intercrop slot'};
  } catch (e) { return {plan: null, reason: cap(`Intercrop scoring failed (${(e as Error).message})`, 300)}; }
}

/** Typical months: climatology daily normals grouped by calendar month inside [sowing, end]. */
export function typicalMonths(days: ClimatologyBundle['days'], sowing: string, end: string): SeasonPreview['weather']['months'] {
  const out: SeasonPreview['weather']['months'] = [];
  for (let m = monthStart(sowing); m <= end && out.length < MAX_MONTHS; m = nextMonth(m)) {
    const from = m < sowing ? sowing : m, to = minDate(lastDayOfMonth(m), end);
    const inMonth = days.filter((d) => d.date >= from && d.date <= to);
    const span = daysBetween(from, to) + 1;
    const mean = (xs: (number | null)[]) => { const v = xs.filter((x): x is number => x !== null && Number.isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    const rain = mean(inMonth.map((d) => d.rainMm)), tMax = mean(inMonth.map((d) => d.tMaxC)), tMin = mean(inMonth.map((d) => d.tMinC));
    out.push({month: m, label: `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`, rainMm: rain === null ? null : r1(rain * span), tMaxC: tMax === null ? null : r1(tMax), tMinC: tMin === null ? null : r1(tMin), days: span});
  }
  return out;
}

/** Weekly seasonal reference from the sowing week to four weeks after the latest harvest, thinned to at most 60 points. */
export function pricePath(ref: SeasonalReferenceByWeek | null, sowing: string, harvestLatest: string): NonNullable<SeasonPreview['price']>['path'] {
  if (!ref) return [];
  const starts: string[] = [];
  for (let d = mondayOf(sowing); d <= addDays(harvestLatest, 28); d = addDays(d, 7)) starts.push(d);
  const step = Math.max(1, Math.ceil(starts.length / PATH_MAX_POINTS));
  return starts.filter((_, i) => i % step === 0).slice(0, PATH_MAX_POINTS).map((weekStart) => {
    const w = Math.min(52, isoWeek(weekStart).week);
    const x = ref.weeks[w - 1];
    const ok = x && x.status === 'available';
    return {weekStart, p50: ok && x.p50 !== null ? x.p50 : null, likely: ok && x.p25 !== null && x.p75 !== null ? {low: x.p25, high: x.p75} : null};
  });
}

function waterVerdict(ev: EvaluatedSlot): string {
  const w = ev.water;
  if (!w.known) return 'Rain normals or the crop water need are not available; water fit is neutral.';
  if (w.value >= 0.8) return 'Typical rain and the field water cover the crop need.';
  if (w.value >= 0.5) return 'Typical rain covers part of the need; plan water for dry spells.';
  return 'Typical rain falls well short of the crop need; irrigation is needed.';
}

function dedupeBasis(xs: readonly BasisRef[]): BasisRef[] {
  const seen = new Set<string>();
  const out: BasisRef[] = [];
  for (const b of xs) { const k = `${b.kind}|${b.label}|${b.sourceId ?? ''}`; if (!seen.has(k)) { seen.add(k); out.push(b); } }
  return out.slice(0, 30);
}

function farmPoint(farm: Farm, boundary: Parameters<typeof boundaryMetrics>[0] | null | undefined): {lat: number; lon: number} | null {
  if (boundary) { const m = boundaryMetrics(boundary); return {lat: m.lat, lon: m.lon}; }
  return farm.location.lat !== null && farm.location.lon !== null ? {lat: farm.location.lat, lon: farm.location.lon} : null;
}

/** Steps: dated care actions (region-matched first, other-region guidance as reference), stage starts, the harvest window. */
function steps(args: {research: FocusedResearch | null; slot: Slot; productId: string | null; method: string | null; timeline: StageTimeline | null; harvest: {earliest: string; latest: string} | null; farm: Farm; today: string; limitations: string[]}): SeasonPreview['steps'] {
  const {research, slot, timeline, harvest, farm} = args;
  const fixed: SeasonPreview['steps'] = [];
  for (const st of timeline?.stages ?? []) fixed.push({kind: 'stage', title: cap(st.name, 160), from: st.from, to: st.to, detail: st.basis === 'sourced' ? 'Stage dates from the sourced stage calendar.' : st.basis === 'fao_generic' ? 'Stage dates from generic FAO stage shares.' : 'Estimated stage dates.', source: null});
  if (harvest) fixed.push({kind: 'harvest', title: 'Harvest window', from: harvest.earliest, to: harvest.latest, detail: slot.harvestLatest ? 'Latest harvest from the saved or entered date; earliest from the stage calendar.' : 'From the stage calendar for this crop and method.', source: null});
  const crop = research?.crops.find((c) => c.cropId === slot.cropId);
  const care: SeasonPreview['steps'] = [];
  if (!crop) args.limitations.push('This crop has no reviewed care schedule in the focused catalogue; only stages and harvest are listed.');
  else {
    const method = args.method ?? crop.establishmentMethods[0] ?? null;
    if (!args.method && method) args.limitations.push(`No establishment method is recorded for this season; care steps assume ${method.replace(/_/g, ' ')} (the first method the care catalogue lists).`);
    const publisher = (id: string) => research?.sources.find((s) => s.id === id)?.publisher ?? id;
    const cycle = {id: `preview-${slot.planId ?? 'custom'}`, cropId: slot.cropId, cropName: crop.displayName, productId: args.productId ?? undefined, establishmentMethod: method ?? undefined, sowingDate: slot.sowing, stage: 'planned'} as unknown as Parameters<typeof careSchedule>[0];
    const sched = careSchedule(cycle, crop, args.today, [], {stateId: farm.location.stateCode, districtId: farm.location.districtId});
    for (const t of sched.careTasks) {
      const ref = t.sourceRefs[0];
      care.push({kind: 'care', title: cap(t.title, 160), from: t.dueFrom, to: t.dueTo, detail: cap([t.action, ...t.conditions].join(' '), 1000), source: ref ? {id: cap(ref.sourceId, 80), publisher: cap(publisher(ref.sourceId), 200)} : null});
    }
    if (!sched.careTasks.length) {
      for (const g of sched.referenceGuidance ?? []) {
        const item = crop.care.find((c) => c.id === g.actionId);
        if (!item || item.anchor === 'observed_stage' || item.endDay < item.startDay) continue;
        const ref = g.sourceRefs[0];
        care.push({kind: 'care', title: cap(item.title, 160), from: addDays(slot.sowing, item.startDay), to: addDays(slot.sowing, item.endDay), detail: cap(`Guidance from ${geographyNames(item.geographyIds)} sources; check it locally. ${item.action}`, 1000), source: ref ? {id: cap(ref.sourceId, 80), publisher: cap(publisher(ref.sourceId), 200)} : null});
      }
      if (care.length) args.limitations.push('Care steps come from sources for another region; they are dated for reference only.');
    }
  }
  care.sort((a, b) => a.from.localeCompare(b.from));
  const room = Math.max(0, MAX_STEPS - fixed.length);
  if (care.length > room) args.limitations.push(`${care.length - room} later care steps are not listed (at most ${MAX_STEPS} steps).`);
  return [...fixed.slice(0, MAX_STEPS), ...care.slice(0, room)].sort((a, b) => a.from.localeCompare(b.from) || a.kind.localeCompare(b.kind));
}

export async function seasonPreview(deps: SeasonPreviewDeps, ownerId: string, farmId: string, q: SeasonPreviewQuery): Promise<SeasonPreview> {
  const farm = await getFarm(deps.pool, ownerId, farmId);
  if (!farm) throw notFound('Farm');
  const mode: Mode = deps.config.RUNTIME_MODE;
  const now = (deps.now ?? (() => new Date()))();
  const today = todayIst(now);
  const slot = await resolveSlot(deps.pool, ownerId, farmId, q);
  const workspace = await getWorkspace(deps.pool, ownerId, farmId);
  const limitations: string[] = [REFERENCE_LIMITATION];
  const basis: BasisRef[] = [];
  const stateName = farm.location.stateCode;
  const districtName = farm.location.districtName?.trim() || null;
  const productId = slot.productId;
  const isGm = slot.kind === 'green_manure';
  const cropName = cap(slot.cropName ?? data.cropDisplayName(slot.cropId), 120);
  const productName = productId && !isGm ? cap(slot.productName ?? data.productDisplayName(slot.cropId, productId), 120) : null;

  // ---- 1 timeline and harvest
  let timeline: StageTimeline | null = null;
  try { timeline = stageTimeline({cropId: slot.cropId, productId: isGm ? null : productId, establishmentMethod: slot.method, anchorDate: slot.sowing, stateId: farm.location.stateCode, districtId: farm.location.districtId}); }
  catch { limitations.push('The stage calendar could not be built for this crop.'); }
  if (timeline && !timeline.stages.length) limitations.push('No sourced stage data for this crop; the stage strip is empty.');
  if (timeline) basis.push(timeline.basis);
  let harvest: {earliest: string; latest: string} | null = null;
  if (slot.harvestLatest) {
    const e = timeline?.harvest?.earliest;
    harvest = {earliest: e && e <= slot.harvestLatest && e >= slot.sowing ? e : slot.harvestLatest, latest: slot.harvestLatest};
  } else if (timeline?.harvest) harvest = {...timeline.harvest};
  else {
    const cls = data.durationFor(slot.cropId, slot.method, farm.location.stateCode, productId)[0];
    if (cls) harvest = {earliest: addDays(slot.sowing, cls.min), latest: addDays(slot.sowing, cls.max)};
    else limitations.push('No sourced duration and no harvest date: the harvest window, typical months and price path are not shown. Enter a harvest date.');
  }

  // ---- 2 typical weather
  let weather: SeasonPreview['weather'] = {status: 'unavailable', months: [], source: null, note: WEATHER_NOTE};
  const point = farmPoint(farm, workspace.boundary);
  if (!harvest) weather = {...weather, note: `${WEATHER_NOTE} Unavailable: the season has no harvest window.`};
  else if (!point) weather = {...weather, note: `${WEATHER_NOTE} Unavailable: the farm has no map point, so normals cannot be read.`};
  else {
    let end = harvest.latest;
    const monthsCap = lastDayOfMonth(addDays(nextMonth(monthStart(slot.sowing)), 31 * (MAX_MONTHS - 2)));
    if (end > monthsCap) { end = monthsCap; limitations.push(`Typical weather is shown for the first ${MAX_MONTHS} months of the season.`); }
    try {
      const source = deps.weatherSource ?? createWeatherSource({
        pool: deps.pool, mode, autoIngest: mode === 'live', now: () => now,
        ...(deps.weatherFetch ? {fetchImpl: deps.weatherFetch} : {}),
        ...(deps.config.WEATHER_CLIMATOLOGY_YEARS !== undefined ? {climatologyYears: deps.config.WEATHER_CLIMATOLOGY_YEARS} : {}),
        ...(deps.config.WEATHER_CLIMATOLOGY_END_YEAR !== undefined ? {climatologyEndYear: deps.config.WEATHER_CLIMATOLOGY_END_YEAR} : {}),
      });
      const scope: WeatherScope = {farmId, districtId: farm.location.districtId, stateId: farm.location.stateCode, point: {lon: point.lon, lat: point.lat}};
      const clim = await source.getClimatology(scope, {start: slot.sowing, end});
      const months = clim ? typicalMonths(clim.days, slot.sowing, end) : [];
      if (clim && months.some((m) => m.rainMm !== null || m.tMaxC !== null)) {
        weather = {status: 'typical', months, source: {sourceId: cap(clim.sourceId, 120), years: clim.years}, note: WEATHER_NOTE};
        basis.push({kind: 'climatology', label: 'Typical weather: daily normals of past years at the field point', sourceId: cap(clim.sourceId, 200), url: null, scope: 'Field point', note: `Reference years ${clim.years.from} to ${clim.years.to}.`});
      } else weather = {...weather, note: `${WEATHER_NOTE} Unavailable: past years' normals for the field point are not stored yet.`};
    } catch { weather = {...weather, note: `${WEATHER_NOTE} Unavailable: the weather normals could not be read.`}; }
  }
  if (weather.status === 'unavailable') limitations.push('Typical weather by month is not available for this season.');

  // ---- 4 price (harvest outlook, weekly path, price now)
  const getOutlook = deps.sources?.priceOutlook ?? (async (a: HarvestPriceOutlookArgs) => harvestPriceOutlook(deps.pool, mode, a));
  let price: SeasonPreview['price'] = null;
  let outlook: HarvestPriceOutlook | null = null;
  let marketNowV: SeasonPreview['marketNow'] = null;
  if (isGm) limitations.push('A green manure is ploughed in: it has no product, price or revenue.');
  else if (!productId) limitations.push('No product is chosen for this season, so prices, yield and profit are not shown.');
  else if (!stateName) limitations.push('The farm has no state, so mandi prices cannot be read.');
  else {
    const getSeasonal = deps.sources?.seasonal ?? (async (a: SeasonalReferenceByWeekArgs) => seasonalReferenceByWeek(deps.pool, mode, a));
    const getNow = deps.sources?.marketNow ?? ((a: MarketNowArgs) => readMarketNow(deps.pool, mode, a));
    const [o, ref, mn] = await Promise.all([
      harvest ? getOutlook({productId, stateName, districtName, harvestDate: priceHarvestDate(harvest), asOf: today}).catch(() => null) : Promise.resolve(null),
      harvest ? getSeasonal({productId, stateName, districtName, asOf: today}).catch(() => null) : Promise.resolve(null),
      getNow({productId, stateCode: farm.location.stateCode, districtName, asOf: today}).catch(() => null),
    ]);
    outlook = o;
    marketNowV = mn ?? null;
    const path = harvest ? pricePath(ref, slot.sowing, harvest.latest) : [];
    const ok = o?.status === 'available';
    const scopeLabel = o ? `${o.scope.level === 'district' ? `${o.scope.districtName ?? districtName} district` : o.scope.stateName ?? stateName} mandis, ${o.basisLabel}` : 'No price history read';
    price = {
      status: ok ? 'available' : 'insufficient', unit: 'INR/kg', harvestWeek: o ? `${o.harvestWeek.year}-W${String(o.harvestWeek.week).padStart(2, '0')}` : null,
      p50: ok && o!.p50 !== null ? o!.p50 : null, likely: ok && o!.p25 !== null && o!.p75 !== null ? {low: o!.p25, high: o!.p75} : null,
      scopeLabel: cap(scopeLabel, 160), yearsUsed: o?.yearsUsed ?? [], path, reason: ok ? null : cap(o?.missingReason ?? (harvest ? 'price_lookup_failed' : 'no_harvest_window'), 80),
    };
    if (o) basis.push({kind: 'price_history', label: cap(`Harvest-week price: ${o.basisLabel}`, 200), sourceId: null, url: null, scope: cap(scopeLabel, 120), note: `Seasonal reference of past years ${o.yearsUsed.join(', ') || 'none usable'}; not a forecast.`});
    if (!ok) limitations.push('Not enough mandi history for a harvest-week price range.');
    if (!path.some((p) => p.p50 !== null)) limitations.push('No weekly seasonal price path: the mandi history is too thin for these weeks.');
    if (!marketNowV) limitations.push('No recent mandi quotes are stored for this product.');
  }

  // ---- 5 engine scoring on the stored inputs of the ready review of the plan year the season is sown in (review MEDIUM-4:
  // a season sown in a later year is scored in that year's horizon, with that year's previous crop)
  let engine: StoredEngine | null = null;
  try { engine = deps.sources?.engine ? await deps.sources.engine(ownerId, farmId, slot.sowing) : await storedEngineInputs({pool: deps.pool, config: deps.config, now: () => now} as unknown as YearPlanDeps, ownerId, farmId, null, {forDate: slot.sowing}); }
  catch { engine = null; }
  let ev: EvaluatedSlot | null = null;
  let companion: SeasonPreview['companion'] = null;
  let components: SeasonPreview['components'] = null;
  let score: number | null = null;
  let codes: ReasonCode[] = [];
  let mainShare: {min: number; max: number} | null = null;
  if (!engine) limitations.push(NO_REVIEW_LIMITATION);
  else if (!harvest) limitations.push('Without a harvest window the year-plan scoring cannot place this season.');
  else if (!productId) { /* stated above */ }
  else {
    const built = slotPlan(engine.ctx, engine.inputs, slot, productId, harvest);
    let plan = built.plan;
    const inputs: Inputs = {...engine.inputs, priceOutlooks: new Map(engine.inputs.priceOutlooks)};
    if (slot.kind === 'intercrop' && slot.systemId) {
      const ic = intercropPlan(engine.ctx, built.parts, slot.systemId);
      if (ic.plan) {
        plan = ic.plan;
        // The companion's harvest-week price is the only other lookup this slot needs.
        const f = intercropOf(plan)!;
        const date = priceHarvestDate(f.companionHarvest);
        if (stateName) {
          const co = await getOutlook({productId: f.system.companionProductId, stateName, districtName, harvestDate: date, asOf: today}).catch(() => null);
          if (co) inputs.priceOutlooks.set(priceKey(f.system.companionProductId, date), co as unknown as Parameters<Inputs['priceOutlooks']['set']>[1]);
        }
      } else limitations.push(`${ic.reason}; this preview scores ${cropName} as the sole crop${slot.companionName ? ` (companion ${slot.companionName} not counted)` : ''}.`);
    } else if (slot.kind === 'intercrop') limitations.push(`This intercrop season names no system; ${cropName} is previewed as the sole crop.`);
    const key = slotPriceKey(plan);
    if (outlook && priceHarvestDate(plan.harvest) === priceHarvestDate(harvest)) inputs.priceOutlooks.set(key, outlook as unknown as Parameters<Inputs['priceOutlooks']['set']>[1]);
    try {
      ev = evaluateSlot(engine.ctx, inputs, plan, engine.norm ?? {maxMarginRate: null});
      const prev = candidates.predecessorOf(engine.ctx, [], plan.sowing);
      const t = soilRotationScore(prev ? data.rotationFacts(prev) : null, data.rotationFacts(plan.cropId), data.legumeCredit, inputs.soilPh);
      const c = {price: ev.price.value, yield: ev.yield.value, soilRotation: t.value, water: ev.water.value, confidence: ev.confidence.value};
      components = {price: round4(clip(c.price, 0, 1)), yield: round4(clip(c.yield, 0, 1)), soilRotation: round4(clip(c.soilRotation, 0, 1)), water: round4(clip(c.water, 0, 1)), confidence: round4(clip(c.confidence, 0, 1))};
      score = Math.round(clip(slotDisplayScore(c), 0, 1) * 10000) / 100;
      codes = reasonCodes({codes: [...ev.codes, ...t.reasonCodes], flags: plan.flags, windowScope: plan.window?.scope ?? null, fixed: false}, c).slice(0, 10);
      // The year plan's own companion block (assemble.ts slotCompanion): companion yield, price and share-scaled cost.
      companion = slotCompanion(engine.ctx, plan, ev);
      if (companion && plan.intercrop) {
        mainShare = plan.intercrop.system.yieldShare.main;
        // The cost block is the main crop's A2+FL (as on the year-plan slot); the profit counts both crops.
        limitations.push(companion.costPerHa != null
          ? `Cost shown is ${cropName}'s A2+FL; the ${companion.cropName.toLowerCase()} companion adds ${companion.costPerHa} INR/ha (its A2+FL scaled by its ${plan.intercrop.system.seedRateShare?.sourced ? 'sourced seed-rate share' : 'row or unsourced seed-rate share, assumed'}), and the profit counts both crops.`
          : `The ${companion.cropName.toLowerCase()} companion cost is not sourced, so the intercrop cost and profit are not complete.`);
      }
      basis.push(...ev.basis);
      limitations.push(...ev.uncertainties.slice(0, 4).map((u) => cap(u, 600)));
      if (!engine.norm) limitations.push('The year plan stored no price scale; the price part is scored without one.');
    } catch (e) { limitations.push(cap(`The year-plan scoring could not evaluate this season: ${(e as Error).message}`, 600)); ev = null; }
  }

  // ---- soil checks (confirmed markers against the crop's need)
  let soil: SeasonPreview['soil'] = null;
  try {
    const markers = await farmSoilMarkers(deps, ownerId, farmId);
    const rate = deps.rateMarker === undefined ? defaultRateMarker() : deps.rateMarker;
    const ph = (await phRanges([slot.cropId])).get(slot.cropId) ?? null;
    const r = compareSoil(soilFacts(markers, rate), markers, {cropId: slot.cropId, cropName, yieldKgPerHa: ev?.yield.localKgPerHa ?? ev?.yieldRef?.p50 ?? null, phRange: ph});
    soil = {status: r.status, checks: r.checks.slice(0, 12) as SoilCheck[]};
  } catch { limitations.push('Soil checks could not be read.'); }

  // ---- 6 steps
  let research: FocusedResearch | null = null;
  try { research = await (deps.sources?.focused ?? focusedResearch)(); } catch { research = null; }
  const stepList = steps({research, slot, productId, method: slot.method, timeline, harvest, farm, today, limitations});

  const area = farm.areaHectares !== null && Number.isFinite(farm.areaHectares) && farm.areaHectares > 0 ? farm.areaHectares : null;
  const yieldRange = ev?.yieldRange ?? null;
  const water: SeasonPreview['water'] = ev ? {fit: round4(clip(ev.water.value, 0, 1)), needMm: ev.water.needMm === null ? null : Math.round(ev.water.needMm), rainMm: ev.water.rainMm === null ? null : Math.round(ev.water.rainMm), verdict: cap(waterVerdict(ev), 160)} : null;
  return {
    farmId, planId: slot.planId, origin: slot.origin, cropId: slot.cropId, cropName, productId: isGm ? null : productId, productName, establishmentMethod: slot.method,
    kind: slot.kind, companion, today, sowing: slot.sowing, harvest, fieldAreaHa: area, timeline, weather, water, price, marketNow: marketNowV ? {...marketNowV, p50: r2(marketNowV.p50)} : null,
    yieldKgPerHa: yieldRange, yieldBasis: ev?.yieldBasis ?? null, yieldForFieldKg: yieldRange && area !== null ? {low: Math.round(yieldRange.low * (mainShare?.min ?? 1) * area), high: Math.round(yieldRange.high * (mainShare?.max ?? 1) * area)} : null,
    cost: ev?.cost?.estimate ?? null, profitPerHa: ev?.estimate.profitPerHa ?? null, profitForField: ev?.estimate.profitForField ?? null,
    score, components, reasonCodes: codes, steps: stepList, soil, basis: dedupeBasis(basis),
    limitations: [...new Set(limitations)].map((l) => cap(l, 600)),
  };
}

