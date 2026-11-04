import { beforeEach } from "vitest";
import { clearSharedMarketReads, clearSharedWeatherReads } from "../src/ingest/scope";
import { clearSentinel2Memo } from "../src/providers/sentinel2";

// The shared in-process read memos (ingest/scope.ts, providers/sentinel2.ts) live for minutes. Production writes clear
// them (insertVintage); tests also write fixtures with plain SQL, so every test starts with empty memos.
beforeEach(() => {
  clearSharedMarketReads();
  clearSharedWeatherReads();
  clearSentinel2Memo();
});
