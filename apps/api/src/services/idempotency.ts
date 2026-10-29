import type { Pool } from "../db/pool";
import { ApiError } from "./errors";
import { payloadHash } from "./hash";

const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const STALE_IN_FLIGHT = "5 minutes";

export interface StoredResponse {
  status: number;
  body: unknown;
}

export function parseIdempotencyKey(header: unknown): string | undefined {
  if (header === undefined) return undefined;
  if (typeof header !== "string" || !KEY_RE.test(header)) {
    throw new ApiError(400, "invalid_idempotency_key", "Idempotency-Key must be 8-128 characters of A-Z a-z 0-9 . _ : -");
  }
  return header;
}

/**
 * Runs `exec` at most once per (owner, key, route). Same key + same payload replays the stored
 * success response; same key + different payload is 422. Only 2xx results are stored; a failed
 * execution releases the key so the client can retry. A concurrent duplicate gets 409.
 */
export async function runIdempotent(
  pool: Pool,
  opts: { ownerId: string; key: string | undefined; route: string; hashInput: unknown },
  exec: () => Promise<StoredResponse>,
): Promise<StoredResponse & { replay: boolean }> {
  if (!opts.key) return { ...(await exec()), replay: false };
  const hash = payloadHash(opts.hashInput);
  for (let attempt = 0; attempt < 2; attempt++) {
    const ins = await pool.query<{ id: string }>(
      `INSERT INTO idempotency_keys (owner_id, key, route, payload_hash) VALUES ($1,$2,$3,$4)
       ON CONFLICT (owner_id, key, route) DO NOTHING RETURNING id`,
      [opts.ownerId, opts.key, opts.route, hash],
    );
    const id = ins.rows[0]?.id;
    if (id) {
      try {
        const out = await exec();
        if (out.status >= 200 && out.status < 300) {
          await pool.query("UPDATE idempotency_keys SET status_code=$2, response=$3::jsonb WHERE id=$1", [id, out.status, JSON.stringify(out.body)]);
        } else {
          await pool.query("DELETE FROM idempotency_keys WHERE id=$1", [id]);
        }
        return { ...out, replay: false };
      } catch (e) {
        await pool.query("DELETE FROM idempotency_keys WHERE id=$1", [id]).catch(() => undefined);
        throw e;
      }
    }
    const ex = await pool.query<{ id: string; payload_hash: string; status_code: number | null; response: unknown }>(
      "SELECT id, payload_hash, status_code, response FROM idempotency_keys WHERE owner_id=$1 AND key=$2 AND route=$3",
      [opts.ownerId, opts.key, opts.route],
    );
    const row = ex.rows[0];
    if (!row) continue; // released between insert and select: try again
    if (row.payload_hash !== hash) throw new ApiError(422, "idempotency_payload_mismatch", "Idempotency-Key was already used with a different payload");
    if (row.status_code !== null) return { status: row.status_code, body: row.response, replay: true };
    // In flight. Take over only if the first attempt looks abandoned (e.g. process crash).
    const del = await pool.query(
      `DELETE FROM idempotency_keys WHERE id=$1 AND status_code IS NULL AND created_at < now() - $2::interval`,
      [row.id, STALE_IN_FLIGHT],
    );
    if (!del.rowCount) throw new ApiError(409, "idempotency_in_progress", "A request with this Idempotency-Key is still being processed");
  }
  throw new ApiError(409, "idempotency_in_progress", "A request with this Idempotency-Key is still being processed");
}
