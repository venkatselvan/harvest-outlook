/**
 * L2: coverage and sanity audit of stored Karnataka ginger mandi prices (market_observations, live mode,
 * variety-wise resource). Prints a ranked table; writes docs/MARKET_AUDIT_GINGER.md and
 * data/manifests/market-coverage-ginger.json. Reads only; no network.
 *
 *   pnpm audit:ginger-prices [-- --state Karnataka --today 2026-10-30]
 *
 * Season = marketing year 1 Jul .. 30 Jun, labelled by its start year (e.g. 2024 = Jul 2024..Jun 2025).
 * The current season is partial and never counts toward "dense seasons".
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "../../apps/api/src/env";
import { createPool } from "../../apps/api/src/db/pool";
import { canonicalMarketKey } from "../../apps/api/src/providers/datagovin/market-alias";

const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
const STATE = arg("state", "Karnataka");
const TODAY = arg("today", new Date().toISOString().slice(0, 10));
const DENSE_MIN_WEEKS = 26; // >= half the weeks of the season have at least one trading day
const DENSE_MAX_GAP_DAYS = 28; // no in-season gap longer than four weeks
const RECENT_DAYS = 45; // "active" if last observation is within this many days of TODAY
// Names are merged across source renames by canonicalMarketKey (name-level only; see market-alias.ts).
const HASSAN_DISTRICT = /hassan/i;

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = createPool(process.env.DATABASE_URL);

interface Row { market_id: string; market_name: string; district_name: string | null; slug: string; observed_on: string; price_min: string | null; price_modal: string | null; price_max: string | null; variety: string | null; grade: string | null; flags: string[] }
const rows = (
  await pool.query<Row>(
    `SELECT m.market_id, m.market_name, m.district_name, p.slug, to_char(m.observed_on,'YYYY-MM-DD') AS observed_on,
            m.price_min::text, m.price_modal::text, m.price_max::text, m.variety, m.grade, m.flags
     FROM market_observations m JOIN crop_products p ON p.id = m.product_id
     JOIN source_documents s ON s.id = m.source_id
     WHERE m.mode='live' AND NOT m.is_synthetic AND s.manifest_id='MKT02-dgi-mandi-variety' AND m.state_name=$1 AND p.slug IN ('ginger-fresh','ginger-dry')
       AND m.vintage_seq = 1 AND m.validation_status='valid'`,
    [STATE],
  )
).rows;
await pool.end();

const dayNum = (iso: string) => Math.floor(Date.parse(iso + "T00:00:00Z") / 86400000);
function isoWeek(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0
  d.setUTCDate(d.getUTCDate() - dow + 3); // Thursday of this week
  const y = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const wk = 1 + Math.round(((d.getTime() - jan4.getTime()) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${y}-W${String(wk).padStart(2, "0")}`;
}
const season = (iso: string) => { const y = Number(iso.slice(0, 4)); return Number(iso.slice(5, 7)) >= 7 ? y : y - 1; };
const median = (a: number[]) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const count = <K extends string>(a: K[]) => { const m: Record<string, number> = {}; for (const k of a) m[k] = (m[k] ?? 0) + 1; return Object.fromEntries(Object.entries(m).sort((x, y) => y[1] - x[1])); };
const currentSeason = season(TODAY);

interface SeasonStat { season: number; days: number; weeks: number; longestGapDays: number; dense: boolean; partial: boolean; medianModalInrPerQuintal: number | null }
interface MarketStat {
  marketId: string; market: string; district: string | null; product: string; rows: number; firstDate: string; lastDate: string; tradingDays: number;
  medianDaysPerActiveIsoWeek: number | null; activeWeeks: number; longestGapDaysOverall: number; longestGapDaysSince2019: number;
  seasons: SeasonStat[]; denseSeasons: number; denseSeasonsSince2019: number; recentlyActive: boolean;
  orderViolations: number; belowQuintalFloor: number; weeklyJumps: number; maxWeeklyJumpRatio: number | null;
  varieties: Record<string, number>; grades: Record<string, number>;
}

const groups = new Map<string, Row[]>();
for (const r of rows) { const k = `${canonicalMarketKey(r.market_name)}#${r.slug}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(r); }

const stats: MarketStat[] = [];
for (const g of groups.values()) {
  const first = g[0]!;
  const byDay = new Map<string, Row[]>();
  for (const r of g) (byDay.get(r.observed_on) ?? byDay.set(r.observed_on, []).get(r.observed_on)!).push(r);
  const days = [...byDay.keys()].sort();
  const wkDays = new Map<string, number>();
  for (const d of days) wkDays.set(isoWeek(d), (wkDays.get(isoWeek(d)) ?? 0) + 1);
  const gaps = (ds: string[]) => { let mx = 0; for (let i = 1; i < ds.length; i++) mx = Math.max(mx, dayNum(ds[i]!) - dayNum(ds[i - 1]!)); return mx; };
  const modalOf = (rs: Row[]) => median(rs.map((r) => Number(r.price_modal)).filter((v) => Number.isFinite(v) && v > 0));
  const seasons: SeasonStat[] = [];
  for (const s of [...new Set(days.map(season))].sort()) {
    const ds = days.filter((d) => season(d) === s);
    const weeks = new Set(ds.map(isoWeek)).size;
    const gap = gaps(ds);
    const partial = s >= currentSeason;
    seasons.push({ season: s, days: ds.length, weeks, longestGapDays: gap, dense: !partial && weeks >= DENSE_MIN_WEEKS && gap <= DENSE_MAX_GAP_DAYS, partial, medianModalInrPerQuintal: modalOf(ds.flatMap((d) => byDay.get(d)!)) });
  }
  // weekly median modal series -> jumps
  const wkRows = new Map<string, number[]>();
  for (const r of g) { const v = Number(r.price_modal); if (v > 0) (wkRows.get(isoWeek(r.observed_on)) ?? wkRows.set(isoWeek(r.observed_on), []).get(isoWeek(r.observed_on))!).push(v); }
  const wk = [...wkRows.keys()].sort();
  let jumps = 0; let maxRatio: number | null = null;
  for (let i = 1; i < wk.length; i++) {
    const a = median(wkRows.get(wk[i - 1]!)!)!; const b = median(wkRows.get(wk[i]!)!)!;
    const ratio = Math.max(a, b) / Math.min(a, b);
    if (ratio > 1.5) jumps++;
    if (maxRatio === null || ratio > maxRatio) maxRatio = ratio;
  }
  stats.push({
    marketId: canonicalMarketKey(first.market_name), market: [...new Set(g.map((r) => r.market_name))].sort().join(" / "), district: [...new Set(g.map((r) => r.district_name ?? "-"))].sort().join(" / "), product: first.slug, rows: g.length,
    firstDate: days[0]!, lastDate: days[days.length - 1]!, tradingDays: days.length,
    medianDaysPerActiveIsoWeek: median([...wkDays.values()]), activeWeeks: wkDays.size,
    longestGapDaysOverall: gaps(days), longestGapDaysSince2019: gaps(days.filter((d) => d >= "2019-01-01")),
    seasons, denseSeasons: seasons.filter((s) => s.dense).length, denseSeasonsSince2019: seasons.filter((s) => s.dense && s.season >= 2019).length,
    recentlyActive: dayNum(TODAY) - dayNum(days[days.length - 1]!) <= RECENT_DAYS,
    orderViolations: g.filter((r) => { const a = Number(r.price_min), m = Number(r.price_modal), b = Number(r.price_max); return (r.price_min && r.price_max && a > b) || (r.price_min && r.price_modal && a > m) || (r.price_modal && r.price_max && m > b); }).length,
    belowQuintalFloor: g.filter((r) => Number(r.price_modal) > 0 && Number(r.price_modal) < 300).length, // ginger is never < INR 3/kg: looks per-kg or mis-scaled
    weeklyJumps: jumps, maxWeeklyJumpRatio: maxRatio === null ? null : Math.round(maxRatio * 100) / 100,
    varieties: count(g.map((r) => r.variety ?? "(none)")), grades: count(g.map((r) => r.grade ?? "(none)")),
  });
}
const rank = (a: MarketStat, b: MarketStat) => b.denseSeasonsSince2019 - a.denseSeasonsSince2019 || b.denseSeasons - a.denseSeasons || b.activeWeeks - a.activeWeeks || a.longestGapDaysSince2019 - b.longestGapDaysSince2019 || b.tradingDays - a.tradingDays;
const fresh = stats.filter((s) => s.product === "ginger-fresh").sort(rank);
const dry = stats.filter((s) => s.product === "ginger-dry").sort(rank);

// ---- recommendation (rule-based: needs >= 3 dense full seasons and recent activity; Hassan district preferred) ----
const eligible = (s: MarketStat) => s.denseSeasonsSince2019 >= 3 && s.recentlyActive;
const hassan = fresh.filter((s) => s.district && HASSAN_DISTRICT.test(s.district) && eligible(s));
const others = fresh.filter((s) => eligible(s));
const pick1 = hassan[0] ?? others[0] ?? null;
const pick2 = others.find((s) => s !== pick1 && s.district !== pick1?.district) ?? others.find((s) => s !== pick1) ?? null;
const recommendation = {
  rule: `>= 3 dense full seasons since the 2019/20 season (>= ${DENSE_MIN_WEEKS} ISO weeks with an observation and no in-season gap > ${DENSE_MAX_GAP_DAYS} days), last observation within ${RECENT_DAYS} days of ${TODAY}; Hassan district preferred for the first pick, a different district for the second`,
  picks: [pick1, pick2].filter((s): s is MarketStat => !!s).map((s) => s.marketId),
  replayWithThreeSeasonsSupported: !!(pick1 && pick2),
};

const fmt = (n: number | null, d = 1) => (n === null ? "-" : Number.isInteger(n) ? String(n) : n.toFixed(d));
const line = (s: MarketStat, i: number) => `| ${i + 1} | ${s.market} | ${s.district ?? "-"} | ${s.firstDate} | ${s.lastDate} | ${s.tradingDays} | ${s.activeWeeks} | ${fmt(s.medianDaysPerActiveIsoWeek)} | ${s.denseSeasonsSince2019} (${s.denseSeasons}) | ${s.longestGapDaysSince2019} | ${s.recentlyActive ? "yes" : "no"} | ${s.orderViolations}/${s.belowQuintalFloor}/${s.weeklyJumps} |`;
const head = "| # | Market | District | First | Last | Trading days | Active ISO weeks | Median days per active week | Dense seasons since 2019/20 (all) | Longest gap since 2019 (d) | Active | Order viol./< INR 300/qtl/weekly jumps >1.5x |\n|---|---|---|---|---|---|---|---|---|---|---|---|";
console.log(`Ginger rows audited: ${rows.length} (${groups.size} market-product groups), state ${STATE}`);
console.log(head);
fresh.slice(0, 20).forEach((s, i) => console.log(line(s, i)));
console.log("Recommendation:", JSON.stringify(recommendation));

const seasonTable = (s: MarketStat) =>
  `| Season | Trading days | Weeks | Longest gap (d) | Dense | Median modal (INR/qtl) |\n|---|---|---|---|---|---|\n` +
  s.seasons.map((x) => `| ${x.season}/${String(x.season + 1).slice(2)}${x.partial ? " (partial)" : ""} | ${x.days} | ${x.weeks} | ${x.longestGapDays} | ${x.partial ? "n/a" : x.dense ? "yes" : "no"} | ${fmt(x.medianModalInrPerQuintal, 0)} |`).join("\n");
const topN = (o: Record<string, number>, n = 4) => Object.entries(o).slice(0, n).map(([k, v]) => `${k} (${v})`).join(", ");
const totalViol = stats.reduce((a, s) => a + s.orderViolations, 0);
const totalLow = stats.reduce((a, s) => a + s.belowQuintalFloor, 0);

// ---- regime / anomaly scan (Ginger(Green) only): each row vs the Karnataka median of the same calendar month ----
const gRows = rows.filter((r) => r.slug === "ginger-fresh" && Number(r.price_modal) > 0);
const monthMed = new Map<string, number>();
{
  const by = new Map<string, number[]>();
  for (const r of gRows) (by.get(r.observed_on.slice(0, 7)) ?? by.set(r.observed_on.slice(0, 7), []).get(r.observed_on.slice(0, 7))!).push(Number(r.price_modal));
  for (const [k, v] of by) monthMed.set(k, median(v)!);
}
const outliers = gRows
  .map((r) => ({ r, ratio: Number(r.price_modal) / monthMed.get(r.observed_on.slice(0, 7))! }))
  .filter((x) => x.ratio > 3.5 || x.ratio < 0.25)
  .sort((a, b) => Math.abs(Math.log(b.ratio)) - Math.abs(Math.log(a.ratio)));
const yearly = new Map<number, number[]>();
for (const r of gRows) (yearly.get(Number(r.observed_on.slice(0, 4))) ?? yearly.set(Number(r.observed_on.slice(0, 4)), []).get(Number(r.observed_on.slice(0, 4)))!).push(Number(r.price_modal));
const regimeTable = "| Year | Rows | Median modal (INR/qtl) | P10 | P90 |\n|---|---|---|---|---|\n" +
  [...yearly.keys()].sort().map((y) => { const v = yearly.get(y)!.sort((a, b) => a - b); const q = (f: number) => v[Math.min(v.length - 1, Math.floor(f * v.length))]!; return `| ${y} | ${v.length} | ${fmt(median(v), 0)} | ${q(0.1)} | ${q(0.9)} |`; }).join("\n");
const outlierLines = outliers.slice(0, 15).map((x) => `- ${x.r.observed_on} ${x.r.market_name} (${x.r.grade ?? "-"}): modal ${x.r.price_modal} = ${x.ratio.toFixed(2)}x the Karnataka month median`);

const md = [
  "# Karnataka ginger mandi price audit (data.gov.in variety-wise resource)",
  "",
  `Generated by \`pnpm audit:ginger-prices\` on ${TODAY} from stored rows (mode live, source MKT02-dgi-mandi-variety, vintage 1). Real observed data; not synthetic.`,
  "",
  "## Scope and limits",
  "",
  `- Rows audited: ${rows.length} across ${groups.size} market-product groups (state ${STATE}). Only the rows ingested by \`pnpm ingest:ginger-ka\` are audited; the ingest was capped at 60 pages of 1,000 rows and the API order is not chronological, so a market can have missing days that exist upstream. See the run summary in docs/DATA_AUDIT.md section 13.`,
  `- Unit: field metadata states none. Prices are treated as INR per quintal by the Agmarknet convention (magnitudes consistent) and converted to INR/kg (divide by 100); this is an assumption flagged on every row, not a confirmed unit.`,
  `- Season: marketing year 1 Jul to 30 Jun labelled by start year. Dense season: at least ${DENSE_MIN_WEEKS} ISO weeks with an observation and no in-season gap above ${DENSE_MAX_GAP_DAYS} days. The current season (${currentSeason}) is partial and never counted.`,
  `- Replay availability: observation dates are market dates; stored available_at is the fetch time (conservative upper bound), so a replay cutoff before ${TODAY} sees none of these rows under the vintage rules unless the replay loader assigns availability from the observed date (a documented decision, not made here).`,
  "",
  "## Ranked markets: Ginger(Green) (ginger-fresh)",
  "",
  head,
  ...fresh.slice(0, 30).map(line),
  "",
  `Shown: top ${Math.min(30, fresh.length)} of ${fresh.length} markets. Full per-market data, including every season, is in data/manifests/market-coverage-ginger.json.`,
  "",
  "## Ranked markets: Ginger(Dry) (ginger-dry)",
  "",
  dry.length ? [head, ...dry.slice(0, 10).map(line)].join("\n") : "No Ginger(Dry) rows were ingested in this run (deferred by the page cap).",
  "",
  "## Recommendation (rule-based, reproducible)",
  "",
  `Rule: ${recommendation.rule}.`,
  "",
  ...[pick1, pick2].map((s, i) => (s ? [`### Pick ${i + 1}: ${s.market} (${s.district ?? "district unknown"})`, "", `${s.tradingDays} trading days from ${s.firstDate} to ${s.lastDate}; ${s.denseSeasonsSince2019} dense full seasons since 2019/20 (${s.denseSeasons} since 2002); ${s.activeWeeks} active ISO weeks; longest gap since 2019 ${s.longestGapDaysSince2019} days. Varieties: ${topN(s.varieties)}. Grades: ${topN(s.grades)}.`, "", seasonTable(s), ""].join("\n") : `### Pick ${i + 1}: none qualifies\n`)),
  `Replay with at least three seasons supported for both picks: ${recommendation.replayWithThreeSeasonsSupported ? "yes by this rule" : "no"}.`,
  "",
  "## Sanity",
  "",
  `- Stored rows with min > modal or modal > max or min > max: ${totalViol}. Rows with modal below INR 300/quintal (suspect per-kg or mis-scaled): ${totalLow}. Zero or negative prices are rejected at ingest (see run summary) and never stored.`,
  "",
  "## Regime and outlier scan (Ginger(Green), all Karnataka markets)",
  "",
  regimeTable,
  "",
  `Rows more than 3.5x above or 0.25x below the Karnataka median of the same month: ${outliers.length} of ${gRows.length}. The most extreme (candidates for per-kg or 10x scaling errors; flagged, not removed):`,
  "",
  ...outlierLines,
  "",
  "Price spikes that are present in many markets at once (for example mid-2023) are treated as market regimes, not errors.",
  "",
  "## Product identity",
  "",
  "- Ginger(Green) is mapped to ginger-fresh and Ginger(Dry) to ginger-dry (names observed). Dry and green prices must not be mixed. An unqualified Commodity \"Ginger\" exists in the current-daily snapshot but returned 0 Karnataka rows in the variety-wise resource; it maps to an unresolved placeholder and is hidden from default reads.",
  "- Variety and grade labels are source free text (for Green: " + topN(count(rows.filter((r) => r.slug === "ginger-fresh").map((r) => r.variety ?? "(none)")), 6) + "). The store keeps variety and grade in the identity; per-market daily series should aggregate them with a stated rule (median of modal across variety/grade rows is used here).",
  "",
].join("\n");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
mkdirSync(resolve(root, "data/manifests"), { recursive: true });
writeFileSync(resolve(root, "docs/MARKET_AUDIT_GINGER.md"), md);
writeFileSync(
  resolve(root, "data/manifests/market-coverage-ginger.json"),
  JSON.stringify({ generatedFor: TODAY, state: STATE, source: "data.gov.in variety-wise resource 35985678-0d79-46b4-9ed6-6f13308a1d24", unitBasis: "agmarknet_convention_inr_per_quintal (assumed, not confirmed)", season: "1 Jul - 30 Jun, labelled by start year", thresholds: { DENSE_MIN_WEEKS, DENSE_MAX_GAP_DAYS, RECENT_DAYS }, rowsAudited: rows.length, recommendation, markets: [...fresh, ...dry] }, null, 1) + "\n",
);
console.log("wrote docs/MARKET_AUDIT_GINGER.md and data/manifests/market-coverage-ginger.json");
