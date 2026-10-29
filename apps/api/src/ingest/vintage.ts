import type { Pool } from "../db/pool";

/**
 * Vintage-preserving insert (docs/DATA_PIPELINE.md). Per identity, rows form vintages 1..n:
 * - no prior row                -> insert vintage 1 ("inserted")
 * - latest vintage has the same compared values -> no new row ("unchanged")
 * - values differ               -> insert vintage n+1 with revision_of = latest row id, its own
 *   available_at and revised_at = that available_at ("revision")
 * Values of an existing vintage are never overwritten, so a replay read with a cutoff can always
 * reconstruct what was known at that time. Concurrent writers for the same identity collide on the
 * (identity..., vintage_seq) unique index and fail loudly instead of losing a revision.
 */
export type VintageOutcome = "inserted" | "revision" | "unchanged";

export interface VintageSpec {
  /** Table name from code constants only (never user input). */
  table: "weather_observations" | "weather_forecasts" | "market_observations";
  identity: Record<string, unknown>;
  /** Source values compared to decide whether this is a new vintage. */
  values: Record<string, unknown>;
  /** Other stored columns (not compared). Must include available_at. */
  other: Record<string, unknown> & { available_at: unknown };
  /** Table has a revised_at column to stamp on revision rows. */
  hasRevisedAt?: boolean;
  /**
   * Identity-level curation columns (e.g. validation_status of the commodity mapping). They describe our
   * knowledge of the identity, not source values, so after every call they are set on ALL vintages of the
   * identity. Never put source values here.
   */
  curation?: Record<string, unknown>;
}

const typeCache = new WeakMap<Pool, Map<string, Record<string, string>>>();

/** Every parameter is cast to its column's declared type, so INSERT ... SELECT and comparisons are typed. */
async function columnTypes(pool: Pool, table: string): Promise<Record<string, string>> {
  let perPool = typeCache.get(pool);
  if (!perPool) typeCache.set(pool, (perPool = new Map()));
  const hit = perPool.get(table);
  if (hit) return hit;
  const r = await pool.query<{ attname: string; t: string }>(
    "SELECT attname, format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped",
    [table],
  );
  const m = Object.fromEntries(r.rows.map((x) => [x.attname, x.t]));
  perPool.set(table, m);
  return m;
}

export async function insertVintage(pool: Pool, s: VintageSpec): Promise<VintageOutcome> {
  const casts = await columnTypes(pool, s.table);
  for (const c of [...Object.keys(s.identity), ...Object.keys(s.values), ...Object.keys(s.other), ...Object.keys(s.curation ?? {})]) {
    if (!casts[c]) throw new Error(`insertVintage: unknown column ${s.table}.${c}`);
  }
  const params: unknown[] = [];
  const p = (v: unknown, c?: string) => {
    params.push(v);
    return `$${params.length}${c ? `::${c}` : ""}`;
  };
  // `=` keeps the identity lookup indexable; NULL identity parts (e.g. weather source_id) use IS NULL.
  const idWhere = Object.entries(s.identity)
    .map(([c, v]) => (v === null || v === undefined ? `${c} IS NULL` : `${c} = ${p(v, casts[c])}`))
    .join(" AND ");
  const same = Object.entries(s.values)
    .map(([c, v]) => `cur.${c} IS NOT DISTINCT FROM ${p(v, casts[c])}`)
    .join(" AND ");
  const all: Record<string, unknown> = { ...s.identity, ...s.values, ...s.other };
  const cols = Object.keys(all);
  const exprs = cols.map((c) => p(all[c], casts[c]));
  const availParam = exprs[cols.indexOf("available_at")]!;
  const extraCols = ["vintage_seq", "revision_of", ...(s.hasRevisedAt ? ["revised_at"] : [])];
  const extraExprs = [
    "COALESCE((SELECT vintage_seq FROM cur), 0) + 1",
    "(SELECT id FROM cur)",
    ...(s.hasRevisedAt ? [`CASE WHEN EXISTS (SELECT 1 FROM cur) THEN ${availParam} END`] : []),
  ];
  const sql = `
    WITH cur AS (
      SELECT * FROM ${s.table} WHERE ${idWhere} ORDER BY vintage_seq DESC LIMIT 1
    ), ins AS (
      INSERT INTO ${s.table} (${[...cols, ...extraCols].join(", ")})
      SELECT ${[...exprs, ...extraExprs].join(", ")}
      WHERE NOT EXISTS (SELECT 1 FROM cur WHERE ${same})
      RETURNING revision_of
    )
    SELECT (SELECT id FROM cur) AS cur_id,
           EXISTS (SELECT 1 FROM ins) AS wrote,
           (SELECT revision_of FROM ins) AS revision_of`;
  const r = await pool.query<{ cur_id: string | null; wrote: boolean; revision_of: string | null }>(sql, params);
  const row = r.rows[0]!;
  if (s.curation) {
    const up: unknown[] = [];
    const q = (v: unknown, c: string) => (up.push(v), `$${up.length}::${casts[c]}`);
    const sets = Object.entries(s.curation).map(([c, v]) => `${c} = ${q(v, c)}`);
    const differs = Object.entries(s.curation).map(([c, v]) => `${c} IS DISTINCT FROM ${q(v, c)}`);
    const idw = Object.entries(s.identity).map(([c, v]) => (v === null || v === undefined ? `${c} IS NULL` : `${c} = ${q(v, c)}`));
    await pool.query(`UPDATE ${s.table} SET ${sets.join(", ")} WHERE ${idw.join(" AND ")} AND (${differs.join(" OR ")})`, up);
  }
  if (row.wrote) return row.revision_of ? "revision" : "inserted";
  return "unchanged";
}

export interface VintageCounts {
  inserted: number;
  revisions: number;
  unchanged: number;
}

export const emptyVintageCounts = (): VintageCounts => ({ inserted: 0, revisions: 0, unchanged: 0 });

export function tally(c: VintageCounts, o: VintageOutcome): void {
  if (o === "inserted") c.inserted++;
  else if (o === "revision") c.revisions++;
  else c.unchanged++;
}
