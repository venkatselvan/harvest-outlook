// Opt-in live smoke for Muse Image reference edits (task L4). Run: pnpm smoke:image
// Spends real credit when MODEL_API_KEY is set ($0.01 per generated image per docs); hard cap IMAGE_SMOKE_CAP_USD
// (default $0.05) = at most 5 images; this script makes 2 calls. The base photo is SYNTHETIC (brown ground, blue sky,
// drawn by this script); outputs are generated illustrations of that synthetic base, not biological predictions or
// field observations. Uses the production client (editImage) and the production QA (evaluateScene) with the same
// JPEG data-URL encoding as visuals/job.ts.
import "../../apps/api/src/env";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { editImage, buildEditBody, MuseImageError } from "../../apps/api/src/visuals/muse-image";
import { evaluateScene } from "../../apps/api/src/visuals/qa";

const sharp = createRequire(new URL("../../apps/api/package.json", import.meta.url))("sharp") as typeof import("sharp");
const key = process.env.MODEL_API_KEY?.trim();
if (!key) {
  console.log("MODEL_API_KEY not set; skipping Muse Image smoke");
  process.exit(0);
}
const baseUrl = process.env.META_BASE_URL ?? "https://api.meta.ai/v1";
const model = process.env.META_IMAGE_MODEL ?? "muse-image-1.0";
const PRICE = 0.01;
const CAP = Number(process.env.IMAGE_SMOKE_CAP_USD ?? "0.05");
const W = 768;
const H = 512;
// Planting region (normalized), the lower-middle band of the ground.
const polygon: [number, number][] = [[0.2, 0.55], [0.8, 0.55], [0.85, 0.92], [0.15, 0.92]];
const pts = polygon.map(([x, y]) => `${x * W},${y * H}`).join(" ");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5b9bd5"/><stop offset="1" stop-color="#b9d7f0"/></linearGradient></defs>
<rect width="${W}" height="${H * 0.42}" fill="url(#s)"/><rect y="${H * 0.42}" width="${W}" height="${H * 0.58}" fill="#7a5230"/>
<rect y="${H * 0.42}" width="${W}" height="6" fill="#4f7a3a"/>
${Array.from({ length: 9 }, (_, i) => `<line x1="${W * 0.2 + i * W * 0.075}" y1="${H * 0.55}" x2="${W * 0.15 + i * W * 0.0875}" y2="${H * 0.92}" stroke="#5e3d22" stroke-width="5"/>`).join("")}
<polygon points="${pts}" fill="none" stroke="#6b4628" stroke-width="2"/></svg>`;
const baseJpeg = (await sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true }));
const imageDataUrl = `data:image/jpeg;base64,${baseJpeg.data.toString("base64")}`;
const size = `${baseJpeg.info.width}x${baseJpeg.info.height}`;

const brief = JSON.parse(await readFile(fileURLToPath(new URL("../../data/curated/visual-briefs/ginger.hassan.brief.json", import.meta.url)), "utf8")) as { label: string; disclaimer: string; promptVersion: string; briefHash: string; stages: { stageId: string; order: number; promptTemplate: string; promptTemplateHash: string }[] };
const outDir = fileURLToPath(new URL("../../evals/results/live-smoke", import.meta.url));
await mkdir(outDir, { recursive: true });
const day = new Date().toISOString().slice(0, 10);
await writeFile(`${outDir}/muse-image-${day}-base-synthetic.jpg`, baseJpeg.data);

let spent = 0;
const calls: Record<string, unknown>[] = [];
// Capture the raw response shape (keys and usage only; the image bytes are written to a file, never to the trace).
let lastShape: unknown = null;
const shapeFetch: typeof fetch = async (url, init) => {
  const res = await fetch(url, init);
  const text = await res.text();
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const data = Array.isArray(j.data) ? (j.data as Record<string, unknown>[]) : [];
    lastShape = { status: res.status, topLevelKeys: Object.keys(j), dataLength: data.length, dataItemKeys: data[0] ? Object.keys(data[0]) : [], b64Chars: typeof data[0]?.b64_json === "string" ? (data[0].b64_json as string).length : null, revisedPrompt: data[0]?.revised_prompt ?? null, usage: j.usage ?? null, error: j.error ?? null, otherFields: Object.fromEntries(Object.entries(j).filter(([k]) => !["data", "usage", "error"].includes(k)).map(([k, v]) => [k, typeof v === "string" && /^(img|resp|req)/.test(v) ? "[id]" : v])) };
  } catch {
    lastShape = { status: res.status, nonJson: text.slice(0, 120) };
  }
  return new Response(text, { status: res.status, headers: res.headers });
};

for (const order of [0, 2]) {
  const stage = brief.stages.find((s) => s.order === order)!;
  if (spent + PRICE > CAP) break;
  const started = Date.now();
  lastShape = null;
  try {
    const r = await editImage({ baseUrl, apiKey: key, model, prompt: stage.promptTemplate, imageDataUrl, size, fetchImpl: shapeFetch, timeoutMs: 180_000 });
    spent += PRICE;
    const png = await sharp(r.png, { failOn: "error" }).png().toBuffer({ resolveWithObject: true });
    const file = `muse-image-${day}-ginger-${stage.stageId}-ILLUSTRATIVE-synthetic-base.png`;
    await writeFile(`${outDir}/${file}`, png.data);
    const qa = await evaluateScene({ base: baseJpeg.data, output: png.data, polygon });
    calls.push({ stage: stage.stageId, order, ok: true, latencyMs: Date.now() - started, retries: r.retries, requestIdPresent: !!r.requestId, usage: r.usage, responseShape: lastShape, output: { file, width: png.info.width, height: png.info.height, bytes: png.data.length }, qa });
    console.log(`${stage.stageId}: ok ${Date.now() - started} ms ${png.info.width}x${png.info.height} qa=${qa.passed} ${JSON.stringify(qa.scores)}`);
  } catch (e) {
    const err = e instanceof MuseImageError ? { kind: e.kind, status: e.opts.status, outcomeUnknown: e.outcomeUnknown } : { message: String((e as Error).message).slice(0, 200) };
    if (!(e instanceof MuseImageError) || e.outcomeUnknown) spent += PRICE;
    calls.push({ stage: stage.stageId, order, ok: false, latencyMs: Date.now() - started, error: err, responseShape: lastShape });
    console.log(`${stage.stageId}: failed ${JSON.stringify(err)} ${JSON.stringify(lastShape)}`);
    if (e instanceof MuseImageError && e.kind === "bad_request") break;
  }
}

const report = {
  kind: "muse_image_live_smoke",
  task: "L4",
  generatedAt: new Date().toISOString(),
  model,
  baseUrl,
  label: "Generated illustrative images of a SYNTHETIC base drawing. Not biological predictions, not field observations.",
  briefLabel: brief.label,
  briefDisclaimer: brief.disclaimer,
  promptVersion: brief.promptVersion,
  briefHash: brief.briefHash,
  base: { file: `muse-image-${day}-base-synthetic.jpg`, size, encoding: "image/jpeg data URL (same as visuals/job.ts)", polygon },
  requestBodyShape: buildEditBody({ model, prompt: "[stage promptTemplate]", imageDataUrl: "[data-url]", size }),
  capUsd: CAP,
  totalEstimatedUsd: Math.round(spent * 1e6) / 1e6,
  costBasis: "documented $0.01 per returned image, not billed",
  calls,
};
await writeFile(`${outDir}/muse-image-${day}.json`, JSON.stringify(report, null, 2).split(key).join("[redacted]") + "\n");
console.log(`total estimated $${spent.toFixed(2)}; trace ${outDir}/muse-image-${day}.json`);
