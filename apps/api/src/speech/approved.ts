import type { Pool } from "../db/pool";
import { sha256Hex } from "../services/hash";

/** How long an issued hash stays usable for speech (the answer is spoken soon after it is shown). */
export const APPROVED_TTL_MINUTES = 60;

export const approvedTextHash = (text: string): string => sha256Hex(text);

/**
 * Called by the assistant route when it issues a validated answer: records the sha256 of the exact
 * text the farmer sees. Returns the hash, which the client echoes as approvedTextHash. Only the
 * hash is stored. Text that was never recorded (or belongs to another owner) cannot be synthesised.
 */
export async function recordApprovedText(pool: Pool, ownerId: string, text: string): Promise<string> {
  const hash = approvedTextHash(text);
  await pool.query(
    "INSERT INTO speech_approved_texts (owner_id, hash) VALUES ($1,$2) ON CONFLICT (owner_id, hash) DO UPDATE SET created_at = now()",
    [ownerId, hash],
  );
  // Opportunistic pruning keeps the table small without a scheduler.
  await pool.query("DELETE FROM speech_approved_texts WHERE created_at < now() - ($1 || ' minutes')::interval", [String(APPROVED_TTL_MINUTES * 4)]);
  return hash;
}

export async function isApprovedText(pool: Pool, ownerId: string, text: string, claimedHash: string): Promise<boolean> {
  const actual = approvedTextHash(text);
  if (actual !== claimedHash.toLowerCase()) return false;
  const r = await pool.query(
    "SELECT 1 FROM speech_approved_texts WHERE owner_id = $1 AND hash = $2 AND created_at > now() - ($3 || ' minutes')::interval",
    [ownerId, actual, String(APPROVED_TTL_MINUTES)],
  );
  return (r.rowCount ?? 0) > 0;
}
