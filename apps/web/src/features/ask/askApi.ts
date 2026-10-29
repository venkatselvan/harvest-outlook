import { apiRequest, jsonInit, newEntryId } from "../photo-region/http";
import type { TurnRequest, TurnResult } from "./model";

/** One assistant turn. The idempotency key is per user action, so a double tap or a retry cannot bill twice. */
export async function postTurn(body: TurnRequest, idempotencyKey: string = newEntryId("ask")): Promise<TurnResult> {
  const env = await apiRequest<TurnResult>("/api/v1/assistant/turns", jsonInit("POST", body, { "idempotency-key": idempotencyKey }));
  return env.data!;
}
