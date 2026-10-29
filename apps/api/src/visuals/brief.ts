import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { payloadHash } from "../services/hash";
import { ILLUSTRATIVE_LABEL } from "./labels";

/**
 * Source-constrained visual brief (PRD 8.3). The image model never decides crop biology: every stage
 * descriptor below is a short paraphrase of wording that appears in the cited evidence excerpts, and
 * the builder rejects a descriptor that cites evidence the stage does not carry or contains digits.
 * Prompt templates therefore contain no numeric agronomic claim.
 */

const here = dirname(fileURLToPath(import.meta.url));
export const CURATED_DIR = resolve(here, "../../../../data/curated");
export const BRIEF_DIR = join(CURATED_DIR, "visual-briefs");
export const GINGER_BRIEF_FILE = "ginger.hassan.brief.json";

export const PROMPT_VERSION = "ginger-brief-1";

export const NEGATIVE_CONSTRAINTS = [
  "no text, letters or numbers anywhere in the image",
  "no labels, captions, watermarks or overlays",
  "no prices, dates or calendar marks",
  "no rain, storm or weather effects added to the scene",
  "no people, animals, buildings or equipment added or removed",
] as const;

export const PRESERVATION =
  "Keep the same field, camera angle, lighting and background. Change only the planting region to show";

export interface StageDescriptor {
  stageId: string;
  /** Short visual wording; every phrase must be traceable to the cited excerpts. No digits. */
  descriptor: string;
  evidenceIds: string[];
  /** What the sources do not say; copied into the brief so reviewers see the gap. */
  gaps: string[];
}

/**
 * Ginger (Hassan, kharif). Source: ICAR-IISR extension guide excerpts in
 * data/curated/evidence/ginger.hassan.evidence.json. The guide gives stage timing and field conditions,
 * not above-ground appearance, so descriptors stay minimal and add no plant dimensions.
 */
export const GINGER_DESCRIPTORS: StageDescriptor[] = [
  {
    stageId: "sprouting_vegetative",
    descriptor: "young ginger sprouts emerging in moist soil as the planted crop establishes",
    evidenceIds: ["ev.ginger.iisr2025.p3.rainfall-pattern", "ev.ginger.iisr2025.p15.soft-rot-monsoon-moisture"],
    gaps: ["The source does not describe sprout height, leaf count or canopy cover."],
  },
  {
    stageId: "rhizome_initiation",
    descriptor: "growing ginger plants with mulch on the soil between them, while rhizomes begin to form below ground",
    evidenceIds: ["ev.ginger.iisr2025.p14.critical-stages", "ev.ginger.iisr2025.p14.mulching-repeat"],
    gaps: ["Rhizomes form below ground and are not visible; the source gives no above-ground size."],
  },
  {
    stageId: "rhizome_development",
    descriptor: "established ginger plants while the rhizomes develop below ground",
    evidenceIds: ["ev.ginger.iisr2025.p14.critical-stages", "ev.ginger.iisr2025.p25.maturity-days"],
    gaps: ["The source does not describe above-ground appearance at this stage."],
  },
  {
    stageId: "maturation",
    descriptor: "a ginger crop approaching maturity, with irrigation stopped and drier field conditions",
    evidenceIds: ["ev.ginger.iisr2025.p25.irrigation-stop", "ev.ginger.iisr2025.p3.rainfall-pattern"],
    gaps: ["The source does not describe leaf colour before full maturity."],
  },
  {
    stageId: "harvest_full_maturity",
    descriptor: "ginger leaves turning yellow and starting to dry at full maturity",
    evidenceIds: ["ev.ginger.iisr2025.p25.harvest-indicator-dry"],
    gaps: ["Late harvest is also practiced; the source does not describe the field after leaves dry."],
  },
];

const stageFileEntry = z.object({ stageId: z.string(), name: z.string(), order: z.number().int(), evidenceIds: z.array(z.string()), cropId: z.string() }).passthrough();
const evidenceEntry = z
  .object({ id: z.string(), locator: z.object({ page: z.number().nullable().optional() }).passthrough(), content: z.object({ text: z.string() }).passthrough() })
  .passthrough();

export interface BriefStage {
  stageId: string;
  order: number;
  stageName: string;
  descriptor: string;
  evidenceIds: string[];
  evidenceExcerpts: { id: string; page: number | null; text: string }[];
  promptTemplate: string;
  promptTemplateHash: string;
  gaps: string[];
}

export interface VisualBrief {
  schemaVersion: "1.0";
  cropId: string;
  scopeId: string;
  promptVersion: string;
  label: string;
  disclaimer: string;
  preservation: string;
  negativeConstraints: string[];
  stages: BriefStage[];
  briefHash: string;
}

const DISCLAIMER =
  "Generated crop appearances are illustrative. They do not predict leaf count, plant height, biomass, rhizome mass, disease or yield, and are not field observations.";

export function buildPromptTemplate(descriptor: string): string {
  return `Edit this farm photo. ${PRESERVATION} ${descriptor}. Constraints: ${NEGATIVE_CONSTRAINTS.join("; ")}.`;
}

export class BriefError extends Error {}

/** Builds the brief from the T05b stage file and evidence file. Throws BriefError on any unsourced or numeric content. */
export function buildBrief(input: { cropId: string; scopeId: string; stages: unknown; evidence: unknown; descriptors: StageDescriptor[]; promptVersion?: string }): VisualBrief {
  const stages = z.array(stageFileEntry).parse(input.stages).filter((s) => s.cropId === input.cropId);
  const evidence = new Map(z.array(evidenceEntry).parse(input.evidence).map((e) => [e.id, e]));
  const promptVersion = input.promptVersion ?? PROMPT_VERSION;
  const out: BriefStage[] = [];
  for (const d of input.descriptors) {
    const st = stages.find((s) => s.stageId === d.stageId);
    if (!st) throw new BriefError(`descriptor for unknown stage ${d.stageId}`);
    if (/\d/.test(d.descriptor)) throw new BriefError(`descriptor for ${d.stageId} contains a digit; prompts may carry no numeric claim`);
    if (d.evidenceIds.length === 0) throw new BriefError(`descriptor for ${d.stageId} cites no evidence`);
    const excerpts = d.evidenceIds.map((id) => {
      if (!st.evidenceIds.includes(id)) throw new BriefError(`stage ${d.stageId} does not cite ${id}`);
      const ev = evidence.get(id);
      if (!ev) throw new BriefError(`evidence ${id} not found`);
      return { id, page: ev.locator.page ?? null, text: ev.content.text };
    });
    const promptTemplate = buildPromptTemplate(d.descriptor);
    out.push({
      stageId: d.stageId,
      order: st.order,
      stageName: st.name,
      descriptor: d.descriptor,
      evidenceIds: d.evidenceIds,
      evidenceExcerpts: excerpts,
      promptTemplate,
      promptTemplateHash: payloadHash(promptTemplate),
      gaps: d.gaps,
    });
  }
  out.sort((a, b) => a.order - b.order);
  const body = {
    schemaVersion: "1.0" as const,
    cropId: input.cropId,
    scopeId: input.scopeId,
    promptVersion,
    label: ILLUSTRATIVE_LABEL,
    disclaimer: DISCLAIMER,
    preservation: PRESERVATION,
    negativeConstraints: [...NEGATIVE_CONSTRAINTS],
    stages: out,
  };
  return { ...body, briefHash: payloadHash(body) };
}

const briefSchema = z.object({
  schemaVersion: z.literal("1.0"),
  cropId: z.string(),
  scopeId: z.string(),
  promptVersion: z.string(),
  label: z.string(),
  disclaimer: z.string(),
  preservation: z.string(),
  negativeConstraints: z.array(z.string()),
  stages: z.array(
    z.object({
      stageId: z.string(),
      order: z.number().int(),
      stageName: z.string(),
      descriptor: z.string(),
      evidenceIds: z.array(z.string()).min(1),
      evidenceExcerpts: z.array(z.object({ id: z.string(), page: z.number().nullable(), text: z.string() })),
      promptTemplate: z.string(),
      promptTemplateHash: z.string(),
      gaps: z.array(z.string()),
    }),
  ),
  briefHash: z.string(),
});

/** Re-verifies a loaded brief: hashes must match and prompts must contain no digits. A tampered file is rejected. */
export function validateBrief(raw: unknown): VisualBrief {
  const b = briefSchema.parse(raw) as VisualBrief;
  const { briefHash, ...body } = b;
  if (payloadHash(body) !== briefHash) throw new BriefError("brief hash mismatch");
  for (const s of b.stages) {
    if (/\d/.test(s.promptTemplate)) throw new BriefError(`prompt for ${s.stageId} contains a digit`);
    if (payloadHash(s.promptTemplate) !== s.promptTemplateHash) throw new BriefError(`prompt hash mismatch for ${s.stageId}`);
  }
  return b;
}

/** Loads every `*.brief.json` in the directory, keyed by crop id. */
export async function loadBriefs(dir = BRIEF_DIR): Promise<Map<string, VisualBrief>> {
  const map = new Map<string, VisualBrief>();
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".brief.json")).sort();
  } catch {
    return map;
  }
  for (const f of files) {
    const b = validateBrief(JSON.parse(await readFile(join(dir, f), "utf8")));
    map.set(b.cropId, b);
  }
  return map;
}

/** CLI: `pnpm --filter @harvest/api exec tsx src/visuals/brief.ts` regenerates the ginger brief file. */
async function main() {
  const stages = JSON.parse(await readFile(join(CURATED_DIR, "stages/ginger.hassan-kharif.stages.json"), "utf8"));
  const evidence = JSON.parse(await readFile(join(CURATED_DIR, "evidence/ginger.hassan.evidence.json"), "utf8"));
  const brief = buildBrief({ cropId: "ginger", scopeId: "IN-KA-hassan", stages, evidence, descriptors: GINGER_DESCRIPTORS });
  await writeFile(join(BRIEF_DIR, GINGER_BRIEF_FILE), JSON.stringify(brief, null, 2) + "\n");
  console.log(`wrote ${GINGER_BRIEF_FILE} briefHash=${brief.briefHash}`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
