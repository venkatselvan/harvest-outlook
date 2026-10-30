// Opt-in live smoke for the Meta Responses adapter (T09). Run: pnpm smoke:meta
// Only runs when MODEL_API_KEY is set; hard cap $0.25; writes a sanitized trace to evals/results/live-smoke/.
// Spends real credit when a key is present: never run it in CI.
import "../../apps/api/src/env";
import { fileURLToPath } from "node:url";
import { runLiveSmoke } from "../../apps/api/src/providers/meta/smoke";

const { exitCode } = await runLiveSmoke(
  {
    MODEL_API_KEY: process.env.MODEL_API_KEY,
    META_BASE_URL: process.env.META_BASE_URL,
    META_TEXT_MODEL: process.env.META_TEXT_MODEL,
    PRICE_TABLE_JSON: process.env.PRICE_TABLE_JSON,
    META_SMOKE_REASONING_EFFORT: process.env.META_SMOKE_REASONING_EFFORT,
  },
  { outDir: fileURLToPath(new URL("../../evals/results/live-smoke", import.meta.url)) },
);
process.exit(exitCode);
