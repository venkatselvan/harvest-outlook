import type { Mode } from "@harvest/contracts";
import { addDays } from "@harvest/domain";
import { ReplayLeakError } from "./errors";
import type { ClimatologyBundle, DailyWeather, ForecastBundle } from "./sources";

const DAY_MS = 86_400_000;
export const REGION_TIMEZONE = "Asia/Kolkata";

export function daysBetween(from: string, to: string): number {
  const p = (s: string) => {
    const [y, m, d] = s.split("-").map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((p(to) - p(from)) / DAY_MS);
}

export function eachDate(from: string, to: string): string[] {
  const n = daysBetween(from, to);
  const out: string[] = [];
  for (let i = 0; i <= n; i++) out.push(addDays(from, i));
  return out;
}

/** Calendar date of an instant in the region timezone (BUILD_SPEC 4). */
export function regionDate(instant: Date | string, timeZone = REGION_TIMEZONE): string {
  const d = typeof instant === "string" ? new Date(instant) : instant;
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export type WeatherDayState = "observed" | "forecast" | "scenario" | "unavailable";

export interface ComposedWeatherDay {
  date: string;
  state: WeatherDayState;
  rainMm: number | null;
  et0Mm: number | null;
  tMaxC: number | null;
  tMinC: number | null;
  sourceId: string | null;
  /** Forecast issue time (forecast days only). */
  issuedAt: string | null;
  /** Days between forecast issue date and this date (forecast days only). */
  horizonDays: number | null;
  /** Named assumption backing a scenario day (climatology). */
  assumptionId: string | null;
  missingReason: string | null;
}

export interface ComposedWeather {
  asOfDate: string;
  days: ComposedWeatherDay[];
  forecastIssuedAt: string | null;
  forecastHorizonEnd: string | null;
  climatology: { assumptionId: string; years: { from: number; to: number }; qualifyingYears?: number[]; sourceId: string } | null;
  counts: Record<WeatherDayState, number>;
}

/** `climatology_<from>-<to>` when the qualifying years are contiguous; else `climatology_<n>y_<first>-<last>`. */
export function climatologyAssumptionId(years: { from: number; to: number }, qualifyingYears?: number[]): string {
  if (qualifyingYears && qualifyingYears.length !== years.to - years.from + 1) return `climatology_${qualifyingYears.length}y_${years.from}-${years.to}`;
  return `climatology_${years.from}-${years.to}`;
}

/**
 * Horizon semantics (PRD 8.1, 9.1; BUILD_SPEC 8.2):
 * - date < asOfDate: observation if one exists, otherwise `unavailable` (gaps are never filled);
 * - asOfDate <= date <= last forecast day: forecast row (issuedAt, horizonDays), or `unavailable` if that day is missing;
 * - beyond the forecast horizon: climatology as a `scenario` with the named assumption `climatology_<years>`, else `unavailable`.
 * Replay: a forecast issued after the cutoff, or climatology whose reference years reach the cutoff year, throws.
 * Observations dated on/after asOfDate are ignored (they are future relative to the decision date).
 */
export function composeWeather(args: {
  from: string;
  to: string;
  asOfDate: string;
  mode: Mode;
  cutoff: string | null;
  observations: DailyWeather[];
  forecast: ForecastBundle | null;
  climatology: ClimatologyBundle | null;
}): ComposedWeather {
  const { from, to, asOfDate, mode, cutoff, observations, forecast, climatology } = args;
  if (mode === "replay") {
    if (!cutoff) throw new ReplayLeakError("replay requires a decision cutoff");
    if (forecast && Date.parse(forecast.issuedAt) > Date.parse(cutoff)) {
      throw new ReplayLeakError("forecast issued after the decision cutoff", { issuedAt: forecast.issuedAt, cutoff });
    }
    if (climatology && climatology.years.to >= Number(cutoff.slice(0, 4))) {
      throw new ReplayLeakError("climatology reference years reach the decision cutoff year", { years: climatology.years, cutoff });
    }
  }
  const obs = new Map(observations.filter((o) => o.date < asOfDate).map((o) => [o.date, o]));
  const fc = new Map((forecast?.days ?? []).filter((d) => d.date >= asOfDate).map((d) => [d.date, d]));
  const fcEnd = forecast && forecast.days.length ? forecast.days.map((d) => d.date).sort().at(-1)! : null;
  const clim = new Map((climatology?.days ?? []).map((d) => [d.date, d]));
  const climAssumption = climatology ? climatologyAssumptionId(climatology.years, climatology.qualifyingYears) : null;
  const issueDate = forecast ? regionDate(forecast.issuedAt) : null;
  const counts: Record<WeatherDayState, number> = { observed: 0, forecast: 0, scenario: 0, unavailable: 0 };
  const blank = { rainMm: null, et0Mm: null, tMaxC: null, tMinC: null, sourceId: null, issuedAt: null, horizonDays: null, assumptionId: null };
  const days = eachDate(from, to).map((date): ComposedWeatherDay => {
    let day: ComposedWeatherDay;
    if (date < asOfDate) {
      const o = obs.get(date);
      day = o
        ? { date, state: "observed", rainMm: o.rainMm, et0Mm: o.et0Mm, tMaxC: o.tMaxC, tMinC: o.tMinC, sourceId: o.sourceId, issuedAt: null, horizonDays: null, assumptionId: null, missingReason: null }
        : { date, state: "unavailable", ...blank, missingReason: "no_observation" };
    } else if (fcEnd !== null && date <= fcEnd) {
      const f = fc.get(date);
      day = f
        ? { date, state: "forecast", rainMm: f.rainMm, et0Mm: f.et0Mm, tMaxC: f.tMaxC, tMinC: f.tMinC, sourceId: forecast!.sourceId, issuedAt: forecast!.issuedAt, horizonDays: daysBetween(issueDate!, date), assumptionId: null, missingReason: null }
        : { date, state: "unavailable", ...blank, missingReason: "forecast_day_missing" };
    } else {
      const c = clim.get(date);
      day = c
        ? { date, state: "scenario", rainMm: c.rainMm, et0Mm: c.et0Mm, tMaxC: c.tMaxC, tMinC: c.tMinC, sourceId: climatology!.sourceId, issuedAt: null, horizonDays: null, assumptionId: climAssumption, missingReason: null }
        : { date, state: "unavailable", ...blank, missingReason: fcEnd === null ? "no_forecast_or_climatology" : "beyond_forecast_horizon_no_climatology" };
    }
    counts[day.state] += 1;
    return day;
  });
  return {
    asOfDate,
    days,
    forecastIssuedAt: forecast?.issuedAt ?? null,
    forecastHorizonEnd: fcEnd,
    climatology: climatology && climAssumption ? { assumptionId: climAssumption, years: climatology.years, ...(climatology.qualifyingYears ? { qualifyingYears: climatology.qualifyingYears } : {}), sourceId: climatology.sourceId } : null,
    counts,
  };
}
