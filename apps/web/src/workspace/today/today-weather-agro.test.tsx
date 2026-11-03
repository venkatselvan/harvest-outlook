import { describe, expect, it } from "vitest";
import { renderToString } from "solid-js/web";
import { WeatherPoint, type WeatherAgro } from "@harvest/contracts";
import { AGRO_LABEL, WeatherCard, weatherAgroFacts } from "./TodayCards";
import { TodaySheetBody } from "./TodaySheet";
import { FIXTURE_TODAY, todayFixture } from "./fixtures";

const text = (html: string) => html.replace(/<!--[^>]*-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const agro = (over: Partial<WeatherAgro> = {}): WeatherAgro => ({
  et0Mm: 4.04, rhMeanPct: 78.4, rhMinPct: 52, rhMaxPct: 95, dewPointC: 19.4, vpdMaxKpa: 1.21, windMaxKmh: 14.8, gustMaxKmh: 31.3,
  soilMoisture0to7: 0.318, soilTemp0to7C: 23.6, leafWetnessPct: 61, sunshineHours: 7.1, rainHours: 3, rainProbabilityPct: 16, basis: "grid_model_estimate", ...over,
});
const point = (over: Partial<WeatherPoint> = {}): WeatherPoint => ({
  date: FIXTURE_TODAY, kind: "forecast", rainMm: 1.2, tMinC: 18, tMaxC: 27,
  basis: { source: "Open-Meteo forecast", issuedAt: "2026-10-31T02:00:00.000Z", years: null }, agro: agro(), ...over,
});
const card = (p: WeatherPoint | null) => renderToString(() => <WeatherCard date={FIXTURE_TODAY} weather={p} onDetails={() => undefined} />);

describe("weather card: deeper values (Open-Meteo model estimates for the grid cell)", () => {
  it("shows water demand, humidity, gusts and rain chance, each carrying the grid-cell estimate wording for screen readers and hover", () => {
    expect(WeatherPoint.safeParse(point()).success).toBe(true);
    const html = card(point());
    const t = text(html);
    expect(t).toContain("water demand 4.0 mm");
    expect(t).toContain("humidity 78%");
    expect(t).toContain("gusts 31 km/h");
    expect(t).toContain("16% rain chance");
    expect(t).toContain(`${AGRO_LABEL}; forecast issued`);
    expect(html).toContain(`title="Average humidity 78 percent. ${AGRO_LABEL} (forecast issued`);
    expect(html).toContain("Weather data by Open-Meteo.com");
  });

  it("typical days say so instead of implying a forecast; null values are left out, never drawn as zero", () => {
    const t = text(card(point({ kind: "typical", basis: { source: "Open-Meteo archive", issuedAt: null, years: [2021, 2022, 2023] }, agro: agro({ gustMaxKmh: null, rainProbabilityPct: null, et0Mm: null }) })));
    expect(t).toContain("typical (climatology), not a forecast");
    expect(t).toContain("humidity 78%");
    expect(t).not.toMatch(/gusts|rain chance|water demand/);
  });

  it("draws nothing when agro is absent or the day is unavailable", () => {
    const { agro: _omit, ...plain } = point();
    expect(card(plain)).not.toContain("today-agro");
    expect(weatherAgroFacts(plain)).toEqual([]);
    expect(card(point({ kind: "unavailable" }))).not.toContain("today-agro");
    expect(card(null)).not.toContain("today-agro");
    expect(weatherAgroFacts(point({ agro: agro({ et0Mm: null, rhMeanPct: null, gustMaxKmh: null, rainProbabilityPct: null }) }))).toEqual([]);
  });

  it("the detail sheet repeats the values with the same label and attribution", () => {
    const view = todayFixture();
    const html = renderToString(() => <TodaySheetBody kind="weather" view={view} date={FIXTURE_TODAY} price={null} weather={point()} />);
    const t = text(html);
    expect(t).toContain("Water demand (reference evapotranspiration) 4.0 millimetres");
    expect(t).toContain("Strongest gusts 31 kilometres per hour");
    expect(t).toContain(AGRO_LABEL);
    expect(t).toContain("Weather data by Open-Meteo.com");
    const bare = text(renderToString(() => <TodaySheetBody kind="weather" view={view} date={FIXTURE_TODAY} price={null} weather={{ ...point(), agro: undefined }} />));
    expect(bare).not.toContain(AGRO_LABEL);
  });
});
