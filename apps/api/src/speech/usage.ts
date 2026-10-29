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
  /** TTS only: sha256 of the approved text (a hash, never the text); counts repeated synthesis of one answer. */
  approvedTextHash?: string;
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
      [u.ownerId, u.requestId, u.providerRequestId, u.model, JSON.stringify({ kind: u.kind, units: u.units, amount: u.amount, language: u.language, usd: null, ...(u.approvedTextHash ? { approvedTextHash: u.approvedTextHash } : {}) })],
    );
    return true;
  } catch {
    return false;
  }
}

export const DEFAULT_TTS_DAILY_CHARS = 20_000;
export const DEFAULT_TTS_SAME_TEXT_PER_HOUR = 5;

export interface TtsLimits {
  /** Characters per owner per UTC day (SPEECH_TTS_DAILY_CHARS). */
  dailyChars: number;
  /** Syntheses of one approvedTextHash per owner per rolling hour. */
  sameTextPerHour: number;
}

export function ttsLimitsFromEnv(env: Record<string, string | undefined> = process.env): TtsLimits {
  const n = (v: string | undefined, d: number) => (v !== undefined && /^\d+$/.test(v) && Number(v) > 0 ? Number(v) : d);
  return { dailyChars: n(env.SPEECH_TTS_DAILY_CHARS, DEFAULT_TTS_DAILY_CHARS), sameTextPerHour: n(env.SPEECH_TTS_SAME_TEXT_PER_HOUR, DEFAULT_TTS_SAME_TEXT_PER_HOUR) };
}

/** Returns which cap a new synthesis would exceed, from usage_ledger (billed ElevenLabs TTS rows only), or null. */
export async function ttsCapExceeded(pool: Pool, ownerId: string, hash: string, characters: number, limits: TtsLimits): Promise<"daily_chars" | "same_text" | null> {
  const r = await pool.query<{ chars: string; same: string }>(
    `SELECT COALESCE(SUM(CASE WHEN created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') THEN COALESCE((usage->>'amount')::numeric, 0) ELSE 0 END), 0) AS chars,
            COUNT(*) FILTER (WHERE usage->>'approvedTextHash' = $2 AND created_at > now() - interval '1 hour') AS same
     FROM usage_ledger WHERE owner_id = $1 AND provider = 'elevenlabs' AND usage->>'kind' = 'tts' AND created_at > now() - interval '1 day' - interval '1 hour'`,
    [ownerId, hash],
  );
  if (Number(r.rows[0]!.same) >= limits.sameTextPerHour) return "same_text";
  if (Number(r.rows[0]!.chars) + characters > limits.dailyChars) return "daily_chars";
  return null;
}
