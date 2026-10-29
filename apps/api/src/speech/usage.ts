import type { Pool } from "../db/pool";

export interface SpeechUsage {
  ownerId: string;
  requestId: string;
  kind: "stt" | "tts";
  model: string;
  units: "seconds" | "characters";
  /** null when the amount is unknown (e.g. STT of an undecodable container). */
  amount: number | null;
  providerRequestId: string | null;
  language: string;
}

/**
 * Writes a usage_ledger row. ElevenLabs bills in credits, not USD, so settled_usd stays NULL and the
 * Meta USD budget is untouched. Never stores audio, transcripts or text. Failures are swallowed
 * (returns false) so a ledger problem cannot lose a result the farmer already paid for.
 */
export async function logSpeechUsage(pool: Pool, u: SpeechUsage): Promise<boolean> {
  try {
    await pool.query(
      `INSERT INTO usage_ledger (owner_id, request_id, provider_request_id, provider, model, estimated_usd, settled_usd, cost_basis, usage)
       VALUES ($1,$2,$3,'elevenlabs',$4,0,NULL,'estimated',$5::jsonb)`,
      [u.ownerId, u.requestId, u.providerRequestId, u.model, JSON.stringify({ kind: u.kind, units: u.units, amount: u.amount, language: u.language, usd: null })],
    );
    return true;
  } catch {
    return false;
  }
}
