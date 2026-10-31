/**
 * Weather along the Today slider (Stream B): per calendar day one of `observed`, `forecast`, `typical`, `unavailable`.
 * TODAY_VIEW_SPEC section 6: the stored forecast up to its horizon, climatology beyond it, and nothing beyond the
 * forecast horizon is ever labelled a forecast. Read-only against stored rows; the only side effect is the weather
 * source's own bounded ingest and archive-year queueing, which `autoIngest` enables and only live mode honours.
 *
 * Classification is `composeWeather` (plans/weather.ts) so the plan engine and this track agree on horizons. Two
 * deliberate differences, both stated in `limitations` when they apply:
 *  - composeWeather names beyond-horizon climatology `scenario` because the plan engine treats it as a named assumption;
 *    at this boundary `scenario` becomes `typical` (the Today view's word for the same thing).
 *  - a past day with no archive row yet (the archive lags a few days) is shown from the stored forecast when that forecast
 *    has a row for the date, labelled `forecast` with its issue time, instead of `unavailable`.
 */
import {z} from 'zod';
import type {Mode} from '@harvest/contracts';
import {addDays} from '@harvest/domain';
import type {Pool} from '../../db/pool';
import type {FetchLike} from '../../ingest/http';
import {createWeatherSource} from '../../plans/adapters/weather-source';
import type {WeatherScope, WeatherSource} from '../../plans/sources';
import {composeWeather, daysBetween, eachDate, regionDate, type ComposedWeatherDay} from '../../plans/weather';
import type {ProviderConfig} from '../../providers/config';

export const MAX_TRACK_DAYS = 800;

export const WeatherTrackDay = z.object({
  date: z.iso.date(),
  kind: z.enum(['observed', 'forecast', 'typical', 'unavailable']),
  rainMm: z.number().nullable(),
  tMinC: z.number().nullable(),
  tMaxC: z.number().nullable(),
  basis: z.object({
    source: z.string().nullable(),
    /** Forecast issue time; set on forecast days only. */
    issuedAt: z.iso.datetime({offset: true}).nullable(),
    /** Calendar years behind a typical day; set on typical days only. */
    years: z.array(z.number().int()).nullable(),
  }).strict(),
}).strict();
export const WeatherTrack = z.object({
  days: z.array(WeatherTrackDay),
  /** Last day covered by the stored forecast; null when there is none. Days after it are never `forecast`. */
  forecastHorizonEnd: z.iso.date().nullable(),
  limitations: z.array(z.string()),
}).strict();
export type WeatherTrackDay = z.infer<typeof WeatherTrackDay>;
export type WeatherTrack = z.infer<typeof WeatherTrack>;

export interface WeatherTrackDeps {
  /** Needed unless `source` is injected. */
  pool?: Pool | undefined;
  /** Injected source (tests, or a caller that already built one). Otherwise `createWeatherSource` over `pool`. */
  source?: WeatherSource | undefined;
  /** Live mode only: let the source fetch missing data (bounded) and queue missing archive years. Default false. */
  autoIngest?: boolean | undefined;
  fetchImpl?: FetchLike | undefined;
  providerConfig?: ProviderConfig | undefined;
  now?: (() => Date) | undefined;
  climatologyYears?: number | undefined;
  climatologyEndYear?: number | undefined;
}

export interface WeatherTrackArgs {
  point: {lat: number; lon: number};
  /** Inclusive calendar dates (YYYY-MM-DD). */
  from: string;
  to: string;
  /** Instant (ISO) or a date (taken as the end of that day in India). Decides observed versus forecast versus typical. */
  asOf: string;
  mode: Mode;
  farmId?: string | undefined;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function checkRange(from: string, to: string): void {
  if (!DATE_ONLY.test(from) || !DATE_ONLY.test(to) || Number.isNaN(Date.parse(`${from}T00:00:00Z`)) || Number.isNaN(Date.parse(`${to}T00:00:00Z`))) throw new RangeError('from and to must be YYYY-MM-DD dates');
  if (from > to) throw new RangeError('from must be on or before to');
  if (daysBetween(from, to) + 1 > MAX_TRACK_DAYS) throw new RangeError(`the weather track covers at most ${MAX_TRACK_DAYS} days`);
}

function asOfInstant(asOf: string): string {
  const instant = DATE_ONLY.test(asOf) ? `${asOf}T23:59:59+05:30` : asOf;
  const t = Date.parse(instant);
  if (Number.isNaN(t)) throw new RangeError('asOf must be an ISO date or instant');
  return new Date(t).toISOString();
}

/** A track where nothing is known (no field location): every day `unavailable`, never filled. */
export function unavailableTrack(from: string, to: string, reason: string): WeatherTrack {
  checkRange(from, to);
  return WeatherTrack.parse({
    days: eachDate(from, to).map((date) => ({date, kind: 'unavailable', rainMm: null, tMinC: null, tMaxC: null, basis: {source: null, issuedAt: null, years: null}})),
    forecastHorizonEnd: null,
    limitations: [reason],
  });
}

export async function weatherTrack(deps: WeatherTrackDeps, args: WeatherTrackArgs): Promise<WeatherTrack> {
  const {point, from, to, mode} = args;
  checkRange(from, to);
  const asOf = asOfInstant(args.asOf);
  const asOfDate = regionDate(asOf);
  const source = deps.source ?? (() => {
    if (!deps.pool) throw new Error('weatherTrack needs a pool or an injected weather source');
    return createWeatherSource({
      pool: deps.pool, mode,
      // Opt-in: an unset flag never reaches the network (the adapter's own default would).
      autoIngest: deps.autoIngest ?? false,
      ...(deps.fetchImpl ? {fetchImpl: deps.fetchImpl} : {}),
      ...(deps.providerConfig ? {providerConfig: deps.providerConfig} : {}),
      ...(deps.now ? {now: deps.now} : {}),
      ...(deps.climatologyYears !== undefined ? {climatologyYears: deps.climatologyYears} : {}),
      ...(deps.climatologyEndYear !== undefined ? {climatologyEndYear: deps.climatologyEndYear} : {}),
    });
  })();
  const scope: WeatherScope = {farmId: args.farmId ?? 'today-weather-track', districtId: null, stateId: null, point: {lon: point.lon, lat: point.lat}};

  const lastPast = addDays(asOfDate, -1);
  const observations = from <= lastPast
    ? await source.getDailyObservations(scope, {start: from, end: to < lastPast ? to : lastPast}, {availableBy: asOf})
    : [];
  // A forecast older than 20 days is never returned by the source; only ask when the window can use one.
  const forecast = to >= addDays(asOfDate, -20) ? await source.getForecast(scope, {issuedAtOrBefore: asOf}) : null;
  const climatology = to >= asOfDate
    ? await source.getClimatology(scope, {start: from > asOfDate ? from : asOfDate, end: to}, mode === 'replay' ? {availableBy: asOf} : undefined)
    : null;

  const composed = composeWeather({from, to, asOfDate, mode, cutoff: mode === 'replay' ? asOf : null, observations, forecast, climatology});
  const years = composed.climatology ? (composed.climatology.qualifyingYears ?? Array.from({length: composed.climatology.years.to - composed.climatology.years.from + 1}, (_, i) => composed.climatology!.years.from + i)) : null;
  const forecastByDate = new Map((forecast?.days ?? []).map((d) => [d.date, d]));

  let filledFromForecast = 0;
  const days: WeatherTrackDay[] = composed.days.map((d: ComposedWeatherDay): WeatherTrackDay => {
    if (d.state === 'unavailable' && d.date < asOfDate && forecast && forecastByDate.has(d.date)) {
      const f = forecastByDate.get(d.date)!;
      filledFromForecast += 1;
      return {date: d.date, kind: 'forecast', rainMm: f.rainMm, tMinC: f.tMinC, tMaxC: f.tMaxC, basis: {source: forecast.sourceId, issuedAt: forecast.issuedAt, years: null}};
    }
    // composeWeather's `scenario` (climatology beyond the forecast horizon) is the Today view's `typical`.
    const kind = d.state === 'scenario' ? 'typical' : d.state;
    return {
      date: d.date, kind, rainMm: d.rainMm, tMinC: d.tMinC, tMaxC: d.tMaxC,
      basis: {source: d.sourceId, issuedAt: kind === 'forecast' ? d.issuedAt : null, years: kind === 'typical' ? years : null},
    };
  });

  const count = (k: WeatherTrackDay['kind']) => days.filter((d) => d.kind === k).length;
  const limitations: string[] = [];
  if (forecast && composed.forecastHorizonEnd) {
    limitations.push(`Forecast days come from the stored Open-Meteo forecast issued ${forecast.issuedAt}; it covers up to ${composed.forecastHorizonEnd}. Nothing after that date is labelled a forecast.`);
  } else {
    limitations.push('No stored forecast is available for this location; days from today on are typical values where normals exist, never a forecast.');
  }
  if (count('observed') > 0) limitations.push('Observed days are Open-Meteo archive reanalysis (a gridded model estimate), not station measurements.');
  if (filledFromForecast > 0) limitations.push(`${filledFromForecast} recent past day${filledFromForecast > 1 ? 's are' : ' is'} not in the archive yet and shown from the stored forecast issued ${forecast!.issuedAt}.`);
  if (count('typical') > 0 && years && years.length) limitations.push(`Typical days are the mean of a 7-day window around each calendar date over ${years.length} years (${years[0]} to ${years.at(-1)}); they describe a normal year, not a forecast.`);
  const missingFuture = days.filter((d) => d.kind === 'unavailable' && d.date >= asOfDate).length;
  if (missingFuture > 0 && !climatology) {
    limitations.push(`${missingFuture} future day${missingFuture > 1 ? 's have' : ' has'} no typical values: fewer than 5 complete archive years are stored near this field.${deps.autoIngest && mode === 'live' ? ' An archive download is requested when none is stored.' : ''}`);
  }
  const missingPast = days.filter((d) => d.kind === 'unavailable' && d.date < asOfDate).length;
  if (missingPast > 0) limitations.push(`${missingPast} past day${missingPast > 1 ? 's have' : ' has'} no archive value and are left blank.`);

  return WeatherTrack.parse({days, forecastHorizonEnd: composed.forecastHorizonEnd, limitations});
}
