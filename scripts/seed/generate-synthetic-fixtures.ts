/**
 * Deterministic generator for the SYNTHETIC fixtures in data/fixtures/synthetic.
 * Every number is invented (seeded PRNG + simple curves). Nothing here reflects real prices or weather.
 * Run: pnpm --filter @harvest/api exec tsx ../../scripts/seed/generate-synthetic-fixtures.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateSyntheticWeather } from "../../apps/api/src/ingest/fixtures";

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

// ---- weather TEMPLATE: the seed (apps/api/src/ingest/fixtures.ts generateSyntheticWeather) regenerates every row relative to the
// seed date, so the committed JSON is only a template (label, location, seed) plus a sample rendered for TEMPLATE_DATE.
{
  const seed = 20260102;
  const TEMPLATE_DATE = "2026-10-30";
  const records = generateSyntheticWeather(TEMPLATE_DATE, seed);
  writeFileSync(resolve(out, "weather_synthetic_hassan_like.json"), JSON.stringify({ synthetic: true, sourceId: SOURCE, fixture: "weather_synthetic_hassan_like", label: LABEL, generatedAtSeed: `Dates below are a sample rendered for ${TEMPLATE_DATE}. loadSyntheticFixtures ignores them and regenerates the rows relative to the seed date (today-120..today-1 with a gap at today-60..today-51, plus 3 forecast days from today) and adds 5 prior calendar years of synthetic daily observations (climatology scenario support).`, seed, location: { key: "synthetic:hassan-like", lat: 13.0033, lon: 76.1004 }, generator: "scripts/seed/generate-synthetic-fixtures.ts", records }, null, 1) + "\n");
}
console.log("wrote synthetic fixtures to", out);
