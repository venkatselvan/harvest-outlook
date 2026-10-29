/**
 * Deterministic generator for the SYNTHETIC fixtures in data/fixtures/synthetic.
 * Every number is invented (seeded PRNG + simple curves). Nothing here reflects real prices or weather.
 * Run: pnpm --filter @harvest/api exec tsx ../../scripts/seed/generate-synthetic-fixtures.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const out = resolve(dirname(fileURLToPath(import.meta.url)), "../../data/fixtures/synthetic");
mkdirSync(out, { recursive: true });

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const dayStr = (base: string, i: number) => new Date(Date.parse(`${base}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const SOURCE = "synthetic-fixture";
const LABEL = "SYNTHETIC FIXTURE: invented numbers for development and demos; not real data";

// ---- market: two synthetic markets, 120 days
{
  const seed = 20260101;
  const rnd = mulberry32(seed);
  const records: Record<string, unknown>[] = [];
  const markets = [
    { market: "Synthetic Market Alpha", state: "Synthetic State", district: "Synthetic District A", base: 7000, amp: 1200 },
    { market: "Synthetic Market Beta", state: "Synthetic State", district: "Synthetic District B", base: 6500, amp: 900 },
  ];
  for (const m of markets) {
    for (let i = 0; i < 120; i++) {
      const iso = dayStr("2026-01-01", i);
      const modal = Math.round(m.base + m.amp * Math.sin((i / 120) * Math.PI * 2) + (rnd() - 0.5) * 400);
      const spread = 250 + Math.round(rnd() * 250);
      records.push({
        synthetic: true,
        sourceId: SOURCE,
        state: m.state,
        district: m.district,
        market: m.market,
        commodity: "Synthetic Ginger Like",
        variety: "Synthetic",
        grade: "FAQ",
        arrival_date: ddmmyyyy(iso),
        min_price: String(modal - spread),
        max_price: String(modal + spread),
        modal_price: String(modal),
        arrivals_in_qtl: String(Math.round(20 + rnd() * 80)),
      });
    }
  }
  writeFileSync(resolve(out, "market_synthetic_ginger_like.json"), JSON.stringify({ synthetic: true, sourceId: SOURCE, fixture: "market_synthetic_ginger_like", label: LABEL, seed, priceUnit: "INR/quintal (synthetic)", generator: "scripts/seed/generate-synthetic-fixtures.ts", records }, null, 1) + "\n");
}

// ---- weather: 60 observed days + one 10-day forecast vintage
{
  const seed = 20260102;
  const rnd = mulberry32(seed);
  const units = { precipitation_sum: "mm", temperature_2m_max: "°C", temperature_2m_min: "°C", et0_fao_evapotranspiration: "mm", shortwave_radiation_sum: "MJ/m²" };
  const day = (i: number) => {
    const wet = rnd() < 0.3 + 0.2 * Math.sin((i / 60) * Math.PI);
    const rain = wet ? Math.round(rnd() * 180) / 10 : 0;
    const tmax = Math.round((27 + 3 * Math.sin(i / 9) - (rain > 5 ? 2 : 0) + (rnd() - 0.5) * 2) * 10) / 10;
    return {
      precipitation_sum: rain,
      temperature_2m_max: tmax,
      temperature_2m_min: Math.round((tmax - 8 + (rnd() - 0.5)) * 10) / 10,
      et0_fao_evapotranspiration: Math.round((4.2 - (rain > 5 ? 1.2 : 0) + (rnd() - 0.5)) * 100) / 100,
      shortwave_radiation_sum: Math.round((19 - (rain > 5 ? 5 : 0) + (rnd() - 0.5) * 3) * 100) / 100,
    };
  };
  const records: Record<string, unknown>[] = [];
  for (let i = 0; i < 60; i++) records.push({ synthetic: true, sourceId: SOURCE, kind: "observation", date: dayStr("2026-06-01", i), values: day(i), units });
  const issuedAt = "2026-07-31T00:00:00Z";
  for (let i = 0; i < 10; i++) records.push({ synthetic: true, sourceId: SOURCE, kind: "forecast", issuedAt, date: dayStr("2026-07-31", i), values: day(60 + i), units });
  writeFileSync(resolve(out, "weather_synthetic_hassan_like.json"), JSON.stringify({ synthetic: true, sourceId: SOURCE, fixture: "weather_synthetic_hassan_like", label: LABEL, seed, location: { key: "synthetic:hassan-like", lat: 13.0033, lon: 76.1004 }, generator: "scripts/seed/generate-synthetic-fixtures.ts", records }, null, 1) + "\n");
}
console.log("wrote synthetic fixtures to", out);
