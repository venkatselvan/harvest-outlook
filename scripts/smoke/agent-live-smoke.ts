// Opt-in live smoke of the full assistant loop (task L4; L5 adds server-initiated tools, product resolution,
// tool-result summaries and provider response cleanup to the report): interpretation -> tools -> synthesis -> gate, against the
// real Meta Responses API and the dev database. Run: pnpm smoke:agent
// Spends real credit when MODEL_API_KEY is set: never run it in CI. Hard cap: the Budget instance used here has a
// per-session limit of AGENT_SMOKE_CAP_USD (default $1.50), so the loop's own reservation logic refuses any call whose
// worst case would cross it. Seeds one new guest owner + session + a Hassan farm (district only, no coordinates)
// in the configured DATABASE_URL; RUNTIME_MODE must be "live". Writes a sanitized trace (no farmer text beyond the
// two fixed smoke prompts, no ids, no keys) to evals/results/live-smoke/.
import "../../apps/api/src/env";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../apps/api/src/config";
import { createPool } from "../../apps/api/src/db/pool";
import { Budget } from "../../apps/api/src/services/budget";
import { loadPriceTable } from "../../apps/api/src/services/pricing";
import { createFarm } from "../../apps/api/src/services/farms";
import { createFarmBody } from "../../apps/api/src/routes/schemas/farms";
import { allBindings } from "../../apps/api/src/agent/bindings";
import { ToolRegistry } from "../../apps/api/src/agent/tools/registry";
import { loadAgentLimits } from "../../apps/api/src/agent/limits";
import { runAgentTurn, type AgentRunResult } from "../../apps/api/src/agent/loop";
import { selectProvider } from "../../apps/api/src/agent/provider";
import { FixtureProvider } from "../../apps/api/src/agent/fixture-provider";
import { agentEnvFromConfig } from "../../apps/api/src/config";
import { createWeatherSource } from "../../apps/api/src/plans/adapters/weather-source";
import { defaultSources, PlanService } from "../../apps/api/src/plans";
import { PgMarketOutlookSource } from "../../apps/api/src/plans/adapters/market-outlook";
import { PgVisualAssetSource } from "../../apps/api/src/visuals";
import { JournalService, journalTaskCompletionSource } from "../../apps/api/src/journal";
import { CatalogueStore } from "../../apps/api/src/catalogue/snapshot";
import { redactSecrets } from "../../apps/api/src/providers/meta/client";

const config = loadConfig();
const key = config.MODEL_API_KEY;
if (!key) {
  console.log("MODEL_API_KEY not set; skipping live agent smoke");
  process.exit(0);
}
if (config.RUNTIME_MODE !== "live") {
  console.log(`RUNTIME_MODE is ${config.RUNTIME_MODE}; the agent smoke only runs in live mode`);
  process.exit(1);
}
const TASK = process.env.AGENT_SMOKE_TASK ?? "L5";
const CAP_USD = Number(process.env.AGENT_SMOKE_CAP_USD ?? "1.5");
const pool = createPool(config.DATABASE_URL);
const budget = new Budget(
  pool,
  { totalUsd: config.BUDGET_TOTAL_USD, devAllocationUsd: config.BUDGET_DEV_ALLOCATION_USD, demoReserveUsd: config.BUDGET_DEMO_RESERVE_USD, perSessionUsd: CAP_USD, perOwnerDayUsd: CAP_USD, perIpDayUsd: config.BUDGET_PER_IP_DAY_USD },
  loadPriceTable(config.PRICE_TABLE_JSON),
);
await budget.init();

// Same wiring as buildServer (read-only copy; server.ts is not modified).
const weather = createWeatherSource({ pool, mode: config.RUNTIME_MODE, climatologyYears: config.WEATHER_CLIMATOLOGY_YEARS, climatologyEndYear: config.WEATHER_CLIMATOLOGY_END_YEAR });
const keyConfigured = !!process.env.DATA_GOV_IN_API_KEY;
const outlook = new PgMarketOutlookSource({ pool, mode: config.RUNTIME_MODE, keyConfigured });
const plans = new PlanService({ pool, mode: config.RUNTIME_MODE, sources: { ...defaultSources(), weather, visuals: new PgVisualAssetSource(pool), completions: journalTaskCompletionSource(pool), outlook } });
const journal = new JournalService({ pool, mode: config.RUNTIME_MODE, plans });
const catalogue = new CatalogueStore(pool);
const registry = new ToolRegistry(allBindings({ pool, plans, budget, segmentModel: config.META_SEGMENT_MODEL, int2: { config, catalogue, prices: { source: outlook, keyConfigured } }, journal }));
const limits = loadAgentLimits(agentEnvFromConfig(config));
const provider = selectProvider({ mode: "live", apiKey: key, baseUrl: config.META_BASE_URL, fixture: () => new FixtureProvider("default"), timeoutMs: 90_000 });

const owner = (await pool.query<{ id: string }>("INSERT INTO owners DEFAULT VALUES RETURNING id")).rows[0]!.id;
const session = (await pool.query<{ id: string }>("INSERT INTO sessions (owner_id, token_hash, expires_at) VALUES ($1, md5(random()::text), now() + interval '1 day') RETURNING id", [owner])).rows[0]!.id;
const farm = await createFarm(pool, owner, createFarmBody.parse({ name: `${TASK} smoke farm (synthetic)`, location: { stateId: "IN-KA", districtName: "Hassan" }, areaHectares: 0.81, facts: { water_source: { value: "rain-fed", basis: "farmer_reported", confirmed: true } } }));

const TURNS = [
  { label: "en_profile_crops", language: "en", text: "I have 2 acres near Hassan, rain-fed, want to plant in May; which crops?" },
  { label: "hi_ginger_water", language: "hi", text: "अदरक को कितना पानी चाहिए? मेरा खेत हासन में है, बारिश पर निर्भर।" },
];

/** L5: what each stored tool result contained, summarised (counts, levels, reasons; no excerpts or farm values). */
async function toolResultSummaries(runId: string) {
  const rows = (await pool.query<{ tool_name: string; status: string; redacted_args: unknown; result: Record<string, unknown> | null; error: unknown }>("SELECT tool_name, status, redacted_args, result, error FROM tool_results WHERE agent_run_id=$1 ORDER BY ordinal", [runId])).rows;
  return rows.map((t) => {
    const res = t.result ?? {};
    const summary =
      t.tool_name === "retrieve_evidence" ? { passages: (res.passages as { scope: { level: string }; validationStatus: string }[] | undefined)?.map((p) => `${p.scope.level}/${p.validationStatus}`) ?? [] }
        : t.tool_name === "resolve_crop_identity" ? { unresolvedReason: res.unresolvedReason ?? null, candidates: (res.candidates as { matchedAlias: string; matchKind: string; productId: string | null }[] | undefined)?.map((c) => ({ matchedAlias: c.matchedAlias, matchKind: c.matchKind, productResolved: c.productId !== null })) ?? [] }
        : t.tool_name === "screen_crops" ? { results: (res.results as unknown[] | undefined)?.length ?? 0, outcomes: Object.entries(((res.results as Record<string, unknown>[] | undefined) ?? []).reduce<Record<string, number>>((m, x) => { const k = String(x.outcome ?? "unknown"); m[k] = (m[k] ?? 0) + 1; return m; }, {})) }
        : {};
    return { tool: t.tool_name, status: t.status, args: t.redacted_args, summary, error: t.error };
  });
}

const summarise = (label: string, text: string, r: AgentRunResult, wallMs: number) => {
  const steps = r.trace.toJSON().steps as unknown as Record<string, unknown>[];
  const calls = steps.filter((s) => s.kind === "provider_call");
  const toolSteps = steps.filter((s) => s.kind === "tool_call");
  const gateSteps = steps.filter((s) => s.kind === "gate");
  return {
    label,
    language: r.language,
    prompt: text,
    status: r.status,
    intent: r.intent,
    gateStatus: r.gateStatus,
    gateSteps: gateSteps.map((g) => ({ pass: g.pass, detail: g.detail })),
    removed: r.gateReport?.removed ?? [],
    templated: r.gateReport?.templated ?? [],
    groundedEvidenceCount: r.gateReport?.groundedEvidenceIds.length ?? 0,
    toolRounds: r.toolRounds,
    toolCalls: r.toolCalls,
    tools: toolSteps.map((s) => ({ tool: (s.detail as Record<string, unknown> | undefined)?.tool ?? s.pass, status: (s.detail as Record<string, unknown> | undefined)?.status ?? null, detail: s.detail })),
    providerCalls: calls.map((c) => ({ pass: c.pass, model: c.model, usage: c.usage, latencyMs: c.latencyMs, retries: c.retries })),
    repairs: calls.filter((c) => c.pass === "repair").length,
    usage: r.usage,
    cost: r.cost,
    wallMs,
    approvedBlocks: r.approved.answerBlocks,
    approvedNumericRefs: r.approved.numericRefs,
    approvedClaimEvidenceRefs: r.approved.claimEvidenceRefs.length,
    limitations: r.limitations,
    spokenNotices: r.spokenNotices,
    clarifications: r.clarifications,
    proposedFacts: r.proposedFacts,
    incomplete: r.incomplete ?? null,
    error: r.error ?? null,
    providerErrors: steps.filter((s) => s.kind === "provider_error").map((s) => ({ pass: s.pass, detail: s.detail })),
    ceilings: steps.filter((s) => s.kind === "ceiling_refused").map((s) => s.detail),
    stepKinds: steps.map((s) => `${s.kind}${s.pass ? `:${s.pass}` : ""}`),
    serverInitiatedTools: r.serverInitiatedTools ?? [],
    productResolutions: steps.filter((s) => s.kind === "product_resolution").map((s) => s.detail),
    providerCleanup: r.providerCleanup ?? null,
  };
};

const results: unknown[] = [];
let spent = 0;
for (const t of TURNS) {
  if (spent >= CAP_USD) {
    results.push({ label: t.label, skipped: `cap $${CAP_USD} reached` });
    continue;
  }
  const started = Date.now();
  const r = await runAgentTurn(
    { pool, budget, provider, registry, limits, models: { text: config.META_TEXT_MODEL, escalation: config.META_ESCALATION_MODEL } },
    { ownerId: owner, sessionId: session, mode: "live", requestId: `${TASK.toLowerCase()}-smoke-${t.label}`, language: t.language, text: t.text, farmId: farm.id, farmGeography: { districtId: farm.location.districtId, stateCode: farm.location.stateCode } },
  );
  spent += r.cost.estimatedUsd;
  const s = summarise(t.label, t.text, r, Date.now() - started);
  results.push({ ...s, toolResults: await toolResultSummaries(r.runId) });
  console.log(`${t.label}: status=${r.status} gate=${r.gateStatus} server=${JSON.stringify(r.serverInitiatedTools ?? [])} cleanup=${JSON.stringify(r.providerCleanup ?? null)} tools=${r.toolCalls} rounds=${r.toolRounds} est=$${r.cost.estimatedUsd.toFixed(4)} removed=${JSON.stringify((r.gateReport?.removed ?? []).map((x) => x.codes))}`);
}

// Sanitize: drop uuids, response/request ids, coordinates; keep structure.
const sanitize = (s: string) =>
  redactSecrets(s, key)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "[uuid]")
    .replace(/(resp|rs|fc|msg)_[A-Za-z0-9_:-]+/g, "$1_[id]")
    .replace(/call_[A-Za-z0-9-]+/g, "call_[id]");
const report = {
  kind: "agent_live_smoke",
  task: TASK,
  generatedAt: new Date().toISOString(),
  model: config.META_TEXT_MODEL,
  limits,
  capUsd: CAP_USD,
  totalEstimatedUsd: Math.round(spent * 1e6) / 1e6,
  costBasis: "estimated_from_reported_usage_not_billed",
  farm: { district: farm.location.districtId, state: farm.location.stateCode, areaHectares: farm.areaHectares, note: "synthetic smoke farm; owner and farm are new rows in the dev database" },
  notes: ["Account integration and gate behaviour only; nothing here establishes agronomic accuracy.", "Approved blocks are reproduced verbatim from the live model after the gate."],
  turns: results,
};
const outDir = fileURLToPath(new URL("../../evals/results/live-smoke", import.meta.url));
await mkdir(outDir, { recursive: true });
const file = `${outDir}/agent-${new Date().toISOString().slice(0, 10)}${process.env.AGENT_SMOKE_SUFFIX ?? ""}.json`;
await writeFile(file, sanitize(JSON.stringify(report, null, 2)) + "\n");
console.log(`total estimated $${spent.toFixed(4)}; trace ${file}`);
await pool.end();
