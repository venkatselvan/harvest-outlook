import hassan from "./__fixtures__/hassan-kharif-may.json";
import tn from "./__fixtures__/tn-june-assumed-price.json";
import type { ComparisonResult } from "./types";

/** Captured from the real API in synthetic mode (both files carry `synthetic: true`). Test use only. */
export const hassanFixture = hassan.response.data as unknown as ComparisonResult;
export const tnFixture = tn.response.data as unknown as ComparisonResult;
export const fixtureFlags = { hassan: hassan.synthetic, tn: tn.synthetic };
