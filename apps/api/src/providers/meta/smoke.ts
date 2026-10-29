import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { ToolSchemas } from "@harvest/contracts";
import { resolveCropIdentity } from "@harvest/domain";
import { ProposedProfile } from "../../agent/schemas";
import { DEFAULT_PRICE_TABLE, estimateCost, loadPriceTable } from "../../services/pricing";
import { MetaClient, imageUserMessage, redactSecrets } from "./client";
import { restoreOptionals, toRawJsonSchema, toStrictJsonSchema } from "./strict-schema";
import type { InputItem, MetaResponse, ParsedUsage } from "./types";
import { MetaError } from "./types";

/** Opt-in live smoke (BUILD_SPEC 10.3). Only the account integration is confirmed here; nothing about agronomic accuracy. */
export const SMOKE_CAP_USD = 0.25;
export const SKIP_MESSAGE = "MODEL_API_KEY not set; skipping live smoke";

export interface SmokeEnv {
  MODEL_API_KEY?: string | undefined;
  META_BASE_URL?: string | undefined;
  META_TEXT_MODEL?: string | undefined;
  PRICE_TABLE_JSON?: string | undefined;
}

interface StepRecord {
  step: string;
  ok: boolean;
  requestIds: (string | null)[];
  usage: ParsedUsage[];
  estimatedUsd: number;
  latencyMs: number;
  retries: number;
  observations: Record<string, unknown>;
  error?: string;
}

export interface SmokeReport {
  kind: "meta_live_smoke";
  generatedAt: string;
  baseUrl: string;
  model: string;
  capUsd: number;
  totalEstimatedUsd: number;
  costBasis: "estimated_from_reported_usage_not_billed";
  allPassed: boolean;
  steps: StepRecord[];
  notes: string[];
}

export async function runLiveSmoke(env: SmokeEnv, opts: { fetchImpl?: typeof fetch; log?: (m: string) => void; outDir?: string; now?: Date } = {}): Promise<{ skipped: boolean; report?: SmokeReport; file?: string; exitCode: number }> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const key = env.MODEL_API_KEY?.trim();
  if (!key) {
    log(SKIP_MESSAGE);
    return { skipped: true, exitCode: 0 };
  }
  const model = env.META_TEXT_MODEL ?? "muse-spark-1.3";
  const baseUrl = env.META_BASE_URL ?? "https://api.meta.ai/v1";
  const prices = loadPriceTable(env.PRICE_TABLE_JSON);
  const client = new MetaClient({ apiKey: key, baseUrl, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}), timeoutMs: 60_000 });
  let spent = 0;
  const steps: StepRecord[] = [];
  const maxOut = 400;

  const price = (u: ParsedUsage) => estimateCost(prices, "meta", model, { inputTokens: u.inputTokens, outputTokens: u.outputTokens }).usd ?? 0;
  /** Refuses any call whose worst case could cross the hard cap. */
  const guard = (inputChars: number) => {
    const worst = estimateCost(prices, "meta", model, { inputTokens: Math.ceil(inputChars / 2) + 3000, outputTokens: maxOut }).usd ?? 0;
    if (spent + worst > SMOKE_CAP_USD) throw new Error(`hard cap $${SMOKE_CAP_USD} would be exceeded; stopping before the call`);
  };
  const run = async (step: string, fn: (rec: StepRecord) => Promise<void>): Promise<void> => {
    const rec: StepRecord = { step, ok: false, requestIds: [], usage: [], estimatedUsd: 0, latencyMs: 0, retries: 0, observations: {} };
    try {
      await fn(rec);
      rec.ok = true;
    } catch (e) {
      rec.error = redactSecrets(e instanceof MetaError ? `${e.kind}: ${e.message}` : String((e as Error).message ?? e), key).slice(0, 300);
    }
    steps.push(rec);
    log(`${rec.ok ? "PASS" : "FAIL"} ${step}${rec.error ? `: ${rec.error}` : ""}`);
  };
  const record = (rec: StepRecord, r: MetaResponse) => {
    const cost = price(r.usage);
    spent += cost;
    rec.requestIds.push(r.requestId ?? r.responseId);
    rec.usage.push(r.usage);
    rec.estimatedUsd = Math.round((rec.estimatedUsd + cost) * 1e6) / 1e6;
    rec.latencyMs += r.latencyMs;
    rec.retries += r.retries;
  };

  // 1. Structured profile extraction (strict json_schema via text.format).
  await run("structured_profile_extraction", async (rec) => {
    const text = "என்கிட்ட 2 acre நிலம் இருக்கு, தண்ணீர் கம்மி, Hassan district";
    guard(text.length + 2000);
    const r = await client.createResponse({
      model,
      instructions: "Extract the farmer's stated facts as proposals. Copy crop names as spoken. Do not answer the question.",
      input: text,
      textFormat: { name: "proposed_profile", schema: toStrictJsonSchema(ProposedProfile) },
      maxOutputTokens: maxOut,
    });
    record(rec, r);
    rec.observations = { responseHasOutputText: r.outputText !== null, status: r.status, incompleteReason: r.incompleteReason };
    const parsed = ProposedProfile.safeParse(restoreOptionals(toRawJsonSchema(ProposedProfile), JSON.parse(r.outputText ?? "null")));
    rec.observations.schemaValid = parsed.success;
    if (!parsed.success) throw new Error("structured output did not validate against ProposedProfile");
    rec.observations.factFields = parsed.data.facts.map((f) => f.field);
  });

  // 2. One function-tool cycle with resolve_crop_identity (in-memory synthetic catalogue; no database).
  await run("function_tool_cycle_resolve_crop_identity", async (rec) => {
    const tool = { type: "function" as const, name: "resolve_crop_identity", description: "Resolve a crop name or alias to catalogue candidates.", parameters: toStrictJsonSchema(ToolSchemas.resolve_crop_identity.input), strict: true };
    const prompt = "Which catalogue crop is 'ginger'? Use the tool resolve_crop_identity with text 'ginger' and language 'en'.";
    guard(prompt.length + JSON.stringify(tool).length);
    const first = await client.createResponse({ model, instructions: "Call tools when needed, then answer in one sentence.", input: prompt, tools: [tool], maxOutputTokens: maxOut });
    record(rec, first);
    const fc = first.functionCalls[0];
    rec.observations = { functionCallCount: first.functionCalls.length, callIdLength: fc?.callId.length ?? null };
    if (!fc || fc.name !== "resolve_crop_identity") throw new Error("model did not call resolve_crop_identity");
    const args = ToolSchemas.resolve_crop_identity.input.safeParse(restoreOptionals(toRawJsonSchema(ToolSchemas.resolve_crop_identity.input), JSON.parse(fc.arguments)));
    rec.observations.argumentsValid = args.success;
    if (!args.success) throw new Error("tool arguments failed contract validation");
    if (!first.responseId) throw new Error("response id missing; cannot continue with previous_response_id");
    const output = resolveCropIdentity(args.data.text, [syntheticCrop()], [], { language: args.data.language });
    const followUp: InputItem[] = [{ type: "function_call_output", call_id: fc.callId, output: JSON.stringify(output) }];
    guard(JSON.stringify(followUp).length + (first.usage.inputTokens + first.usage.outputTokens) * 2);
    const second = await client.createResponse({ model, instructions: "Call tools when needed, then answer in one sentence.", input: followUp, tools: [tool], previousResponseId: first.responseId, maxOutputTokens: maxOut });
    record(rec, second);
    rec.observations.finalHasText = second.outputText !== null;
    rec.observations.toolOutputCandidates = output.candidates.length;
    if (second.outputText === null) throw new Error("no final text after function_call_output");
  });

  // 3. Tiny image-understanding call with a generated 64x64 PNG (sent as a base64 data URL).
  await run("image_understanding_64px_png", async (rec) => {
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png().toBuffer();
    guard(2000);
    const r = await client.createResponse({
      model,
      instructions: "Answer in one word.",
      input: [await imageUserMessage("What is the dominant colour of this image?", png)],
      maxOutputTokens: 100,
    });
    record(rec, r);
    rec.observations = { answeredText: r.outputText?.slice(0, 40) ?? null, mentionsRed: /red/i.test(r.outputText ?? ""), imageSentAs: "data_url_base64" };
    if (r.outputText === null) throw new Error("no text answer for the image");
  });

  const report: SmokeReport = {
    kind: "meta_live_smoke",
    generatedAt: (opts.now ?? new Date()).toISOString(),
    baseUrl,
    model,
    capUsd: SMOKE_CAP_USD,
    totalEstimatedUsd: Math.round(spent * 1e6) / 1e6,
    costBasis: "estimated_from_reported_usage_not_billed",
    allPassed: steps.length === 3 && steps.every((s) => s.ok),
    steps,
    notes: [
      "Confirms the account integration only; says nothing about agronomic accuracy.",
      "Cost is estimated from reported token usage with the configured price table; check the Meta console for billed cost.",
      "Open verification items covered by observations: structured output text path, usage fields, function-call cycle, data-URL image input.",
      `Price table version: ${prices === DEFAULT_PRICE_TABLE ? "default" : "default+override"}`,
    ],
  };
  const dir = opts.outDir ?? join(process.cwd(), "../../evals/results/live-smoke");
  const file = join(dir, `meta-${report.generatedAt.slice(0, 10)}.json`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${redactSecrets(JSON.stringify(report, null, 2), key)}\n`);
  log(`model=${model} requestIds=${steps.flatMap((s) => s.requestIds).join(",")} estimatedCostUsd=${report.totalEstimatedUsd} (cap ${SMOKE_CAP_USD})`);
  log(`trace written to ${file}`);
  return { skipped: false, report, file, exitCode: report.allPassed ? 0 : 1 };
}

function syntheticCrop() {
  return {
    schemaVersion: "1.0" as const,
    id: "smoke-ginger",
    botanicalName: "Zingiber officinale",
    commonNames: [{ text: "Ginger", language: "en", kind: "common" as const, sourceIds: [] }],
    aliases: [],
    varieties: [],
    productIds: ["smoke-ginger-fresh"],
    sourceMappings: [],
    mode: "synthetic" as const,
  };
}
