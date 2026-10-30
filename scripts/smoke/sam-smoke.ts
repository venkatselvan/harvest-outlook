// Opt-in live smoke for SAM 3.1 (task L4). Run: pnpm smoke:sam
// Spends real credit when MODEL_API_KEY is set ($0.0025 per image per docs); hard cap SAM_SMOKE_CAP_USD (default
// $0.05) = at most 20 calls; this script makes at most 6. The test image is synthetic (two solid rectangles on a
// plain background), so the raw output can be stored verbatim as a fixture. Resolves the base85 alphabet and the bit
// order empirically: the decoding whose foreground bounding box matches the returned plain-text box wins.
import "../../apps/api/src/env";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { callSam, buildRequestBody, SamHttpError } from "../../apps/api/src/vision/sam/client";
import { DEFAULT_SAM_OPTIONS, type SamOptions } from "../../apps/api/src/vision/sam/options";
import { buildPromptText } from "../../apps/api/src/vision/sam/prompt";
import { planSentImage } from "../../apps/api/src/vision/sam/transform";
import { parseSamOutput, decodeMask, SamParseError } from "../../apps/api/src/vision/sam/parser";
import { BASE85_VARIANTS, compatibleVariants } from "../../apps/api/src/vision/sam/base85";
import { interpretSamText } from "../../apps/api/src/vision/sam/interpret";

// sharp is a dependency of @harvest/api, not of the repo root: resolve it from there.
const sharp = createRequire(new URL("../../apps/api/package.json", import.meta.url))("sharp") as typeof import("sharp");
const key = process.env.MODEL_API_KEY?.trim();
if (!key) {
  console.log("MODEL_API_KEY not set; skipping SAM smoke");
  process.exit(0);
}
const baseUrl = process.env.META_BASE_URL ?? "https://api.meta.ai/v1";
const model = process.env.META_SEGMENT_MODEL ?? "sam-3.1";
const PRICE = 0.0025;
const CAP = Number(process.env.SAM_SMOKE_CAP_USD ?? "0.05");
const W = 512;
const H = 384;
// Ground truth, inclusive pixel boxes.
const RECTS = { red: { x1: 60, y1: 80, x2: 219, y2: 299 }, blue: { x1: 300, y1: 60, x2: 459, y2: 199 } };
const rect = (r: { x1: number; y1: number; x2: number; y2: number }, rgb: string) =>
  `<rect x="${r.x1}" y="${r.y1}" width="${r.x2 - r.x1 + 1}" height="${r.y2 - r.y1 + 1}" fill="${rgb}"/>`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#e8e8e8"/>${rect(RECTS.red, "#c0392b")}${rect(RECTS.blue, "#2c5aa0")}</svg>`;
const png = await sharp(Buffer.from(svg)).png().toBuffer();
const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
const plan = planSentImage(W, H, 1024);

let spent = 0;
const calls: Record<string, unknown>[] = [];
const raws: Record<string, string> = {};

async function run(label: string, text: string, options: SamOptions, extraBody?: Record<string, unknown>) {
  if (spent + PRICE > CAP) throw new Error(`cap $${CAP} reached`);
  const started = Date.now();
  const fetchImpl: typeof fetch = extraBody
    ? (url, init) => fetch(url, { ...init, body: JSON.stringify({ ...JSON.parse(String(init!.body)), ...extraBody }) })
    : fetch;
  const sentBody = { ...buildRequestBody({ model, text, imageDataUrl: "[data-url]", options }), ...(extraBody ?? {}) };
  try {
    const r = await callSam({ baseUrl, apiKey: key!, model, text, imageDataUrl: dataUrl, options, fetchImpl });
    spent += PRICE;
    raws[label] = r.text;
    calls.push({ label, ok: true, prompt: text, sentBody, latencyMs: Date.now() - started, requestIdPresent: !!r.providerRequestId, usage: r.usage, outputChars: r.text.length });
    return r.text;
  } catch (e) {
    const err = e instanceof SamHttpError ? { code: e.code, status: e.status } : { message: String((e as Error).message).slice(0, 200) };
    // A 4xx is not billed per docs (failed requests); counted conservatively anyway.
    spent += PRICE;
    calls.push({ label, ok: false, prompt: text, sentBody, latencyMs: Date.now() - started, error: err });
    return null;
  }
}

/** Every alphabet x bit order: foreground bbox in sent pixels vs the object's box and the ground truth. */
function analyse(label: string, text: string) {
  const parsed = parseSamOutput(text);
  const objects = parsed.frames.flatMap((f) => f.objects.map((o) => ({ frame: f.index, ...o })));
  return {
    label,
    warnings: parsed.warnings,
    frames: parsed.frames.length,
    objects: objects.map((o) => {
      const decodings: Record<string, unknown>[] = [];
      if (o.mask) {
        for (const variant of BASE85_VARIANTS) {
          for (const bitOrder of ["msb", "lsb"] as const) {
            try {
              const r = decodeMask(o.mask, { base85Variant: variant, base85Fallback: "rfc1924", bitOrder });
              let x1 = Infinity, y1 = Infinity, x2 = -1, y2 = -1, fg = 0;
              for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) if (r.bits[y * r.width + x]) { fg++; x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y); }
              const sx = plan.width / r.width, sy = plan.height / r.height;
              const bb = fg ? { x1: Math.round(x1 * sx), y1: Math.round(y1 * sy), x2: Math.round((x2 + 1) * sx) - 1, y2: Math.round((y2 + 1) * sy) - 1 } : null;
              const err = bb && o.box ? Math.max(Math.abs(bb.x1 - o.box.x1), Math.abs(bb.y1 - o.box.y1), Math.abs(bb.x2 - o.box.x2), Math.abs(bb.y2 - o.box.y2)) : null;
              const fill = bb ? fg / (((x2 - x1 + 1) * (y2 - y1 + 1)) || 1) : 0;
              decodings.push({ variant, bitOrder, ok: true, foreground: fg, bboxSentPx: bb, maxCornerErrorPx: err, fillOfBbox: Math.round(fill * 1000) / 1000 });
            } catch (e) {
              decodings.push({ variant, bitOrder, ok: false, error: e instanceof SamParseError ? e.code : String(e).slice(0, 80) });
            }
          }
        }
      }
      return {
        id: o.id,
        frame: o.frame,
        box: o.box,
        mask: o.mask ? { x: o.mask.x, y: o.mask.y, height: o.mask.height, width: o.mask.width, encoding: o.mask.encoding, confidence: o.mask.confidence, payloadChars: o.mask.payload.length, compatibleVariants: compatibleVariants(o.mask.payload) } : null,
        decodings,
      };
    }),
    interpretAuto: (() => {
      const i = interpretSamText(text, plan, { base85Variant: "auto", base85Fallback: "rfc1924", bitOrder: DEFAULT_SAM_OPTIONS.bitOrder });
      return { proposals: i.proposals.map((p) => ({ source: p.source, score: p.segmentationScore, areaFraction: Math.round(p.areaFraction * 1e4) / 1e4, points: p.polygon.length, bbox: bboxOf(p.polygon) })), rejected: i.rejected, warnings: i.warnings, objectCount: i.objectCount };
    })(),
  };
}
const bboxOf = (poly: [number, number][]) => ({
  x1: Math.round(Math.min(...poly.map((p) => p[0])) * W), y1: Math.round(Math.min(...poly.map((p) => p[1])) * H),
  x2: Math.round(Math.max(...poly.map((p) => p[0])) * W) - 1, y2: Math.round(Math.max(...poly.map((p) => p[1])) * H) - 1,
});

const opts = { ...DEFAULT_SAM_OPTIONS };
// 1. Concept prompt with the documented placement of mask_encoding / include_confidence.
let conceptText = await run("concept_documented_params", buildPromptText({ kind: "concept", text: "rectangle" }, plan), opts);
if (conceptText === null) {
  conceptText = await run("concept_without_metadata", buildPromptText({ kind: "concept", text: "rectangle" }, plan), { ...opts, maskEncoding: null });
  if (conceptText === null) conceptText = await run("concept_no_extras", buildPromptText({ kind: "concept", text: "rectangle" }, plan), { ...opts, maskEncoding: null, includeConfidence: false });
}
// 2. Box prompt around the red rectangle (normalized coordinates, as the route passes them).
const boxPrompt = { kind: "box" as const, x0: (RECTS.red.x1 - 4) / W, y0: (RECTS.red.y1 - 4) / H, x1: (RECTS.red.x2 + 5) / W, y1: (RECTS.red.y2 + 5) / H };
const boxText = await run("box_red", buildPromptText(boxPrompt, plan), opts);
// 3. No mask_encoding: the server default ('~' lossless, ~50x longer text). store:false is now always sent.
const defaultEncText = await run("concept_default_encoding", buildPromptText({ kind: "concept", text: "rectangle" }, plan), { ...opts, maskEncoding: null });

const analyses = Object.entries(raws).map(([label, text]) => analyse(label, text));
const report = {
  kind: "sam_live_smoke",
  task: "L4",
  generatedAt: new Date().toISOString(),
  model,
  baseUrl,
  image: { width: W, height: H, synthetic: "two solid rectangles on a plain background, generated by this script", groundTruthInclusive: RECTS },
  capUsd: CAP,
  totalEstimatedUsd: Math.round(spent * 1e6) / 1e6,
  costBasis: "documented price per image x calls (failed calls counted), not billed",
  calls,
  rawOutputs: raws,
  analyses,
  storeFalseSentOnEveryCall: true,
  observedTexts: { concept: conceptText !== null, box: boxText !== null, defaultEncoding: defaultEncText !== null },
};
const outDir = fileURLToPath(new URL("../../evals/results/live-smoke", import.meta.url));
await mkdir(outDir, { recursive: true });
const file = `${outDir}/sam-${new Date().toISOString().slice(0, 10)}.json`;
await writeFile(file, JSON.stringify(report, null, 2).split(key).join("[redacted]") + "\n");
console.log(JSON.stringify(calls.map((c) => ({ label: c.label, ok: c.ok, error: c.error, chars: c.outputChars })), null, 0));
console.log(`total estimated $${spent.toFixed(4)}; trace ${file}`);
