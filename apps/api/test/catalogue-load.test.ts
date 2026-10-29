import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type Pool } from "../src/db/pool";
import { migrate } from "../src/db/migrate";
import { loadCatalogueIntoDb, normaliseProductIds, uuidFromKey, topicOf } from "../src/catalogue/load";
import { readCatalogueFiles } from "../src/catalogue/files";
import { CAT_DB } from "./catalogue-helpers";

let pool: Pool;
const n = async (sql: string) => Number((await pool.query<{ c: string }>(sql)).rows[0]!.c);
const tables = ["crop_identities", "crop_products", "crop_profiles", "evidence_records", "source_documents", "crop_rules", "stage_definitions", "coverage_records", "districts"];

beforeAll(async () => {
  pool = createPool(CAT_DB);
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(pool, undefined, () => undefined);
});
afterAll(async () => pool.end());

describe("catalogue loader", () => {
  it("loads the measured catalogue and is idempotent", async () => {
    const first = await loadCatalogueIntoDb(pool);
    expect(first.identities).toBe(25);
    expect(first.qualifiedProfiles).toBe(25);
    expect(first.products).toBeGreaterThanOrEqual(36);
    expect(first.evidence).toBeGreaterThanOrEqual(134);
    expect(first.stages).toBe(5);
    const before = await Promise.all(tables.map((t) => n(`SELECT count(*) c FROM ${t}`)));
    const second = await loadCatalogueIntoDb(pool);
    expect(second).toEqual(first);
    const after = await Promise.all(tables.map((t) => n(`SELECT count(*) c FROM ${t}`)));
    expect(after).toEqual(before);
    expect(await n("SELECT count(*) c FROM crop_identities")).toBe(25);
  });

  it("stores ginger reviewed rules (11, 8 approved) and never the candidates file", async () => {
    const r = await pool.query<{ review_status: string; c: string }>(
      "SELECT review_status, count(*) c FROM crop_rules WHERE crop_id=(SELECT id FROM crop_identities WHERE slug='ginger') AND source_id LIKE 'T05b:%' GROUP BY 1",
    );
    const m = Object.fromEntries(r.rows.map((x) => [x.review_status, Number(x.c)]));
    expect(m).toEqual({ approved: 8, candidate: 2, disabled: 1 });
    expect(await n("SELECT count(*) c FROM crop_rules WHERE source_id='T05b:ginger.rules.candidates.json'")).toBe(0);
  });

  it("marks derived approved rules as mechanical_derivation and candidates as unreviewed; no derived rule is ineligible", async () => {
    expect(await n("SELECT count(*) c FROM crop_rules WHERE source_id='T06b:derive-rules' AND review_status='approved' AND reviewer='mechanical_derivation'")).toBeGreaterThan(80);
    expect(await n("SELECT count(*) c FROM crop_rules WHERE source_id='T06b:derive-rules' AND review_status='approved' AND reviewer IS NULL")).toBe(0);
    expect(await n("SELECT count(*) c FROM crop_rules WHERE source_id='T06b:derive-rules' AND rule->'effect'->>'type'='ineligible'")).toBe(0);
    expect(await n("SELECT count(*) c FROM crop_rules WHERE source_id='T06b:derive-rules' AND review_status='candidate'")).toBeGreaterThan(0);
  });

  it("populates the agent-facing evidence columns, keeps validation_status as in the file, and tracks sources", async () => {
    expect(await n("SELECT count(*) c FROM evidence_records WHERE cardinality(geography_ids)=0 OR geography_level IS NULL OR excerpt IS NULL")).toBe(0);
    expect(await n("SELECT count(*) c FROM evidence_records WHERE validation_status='validated'")).toBe(0); // no human validation recorded
    // D28: every curated excerpt passes the machine check against the saved source text -> grounded, never validated
    expect(await n("SELECT count(*) c FROM evidence_records WHERE validation_status='grounded'")).toBe(185);
    expect(await n("SELECT count(*) c FROM evidence_records WHERE validation_status='pending'")).toBe(0);
    expect(await n("SELECT count(*) c FROM evidence_records WHERE 'IN-TN'=ANY(geography_ids) AND 'okra'=ANY(crop_ids)")).toBeGreaterThan(0);
    expect(await n("SELECT count(*) c FROM evidence_records WHERE 'IN-KA-hassan'=ANY(geography_ids) OR 'IN-KA'=ANY(geography_ids)")).toBeGreaterThan(0);
    expect(await n("SELECT count(*) c FROM evidence_records WHERE array_length(topics,1) IS NOT NULL")).toBeGreaterThan(150); // records without a sluggable section keep empty topics
    expect(await n("SELECT count(*) c FROM crop_identities WHERE source_id IS NULL")).toBe(0);
    // T05b used dotted product ids; they are mapped onto catalogue ids
    expect(await n("SELECT count(*) c FROM evidence_records WHERE 'ginger.fresh'=ANY(product_ids)")).toBe(0);
    expect(await n("SELECT count(*) c FROM evidence_records WHERE 'ginger-fresh'=ANY(product_ids)")).toBeGreaterThan(0);
  });

  it("stores names in the shape resolve_crop_identity reads and keeps products distinct", async () => {
    const r = await pool.query<{ names: Record<string, { text: string; kind: string }[]> }>("SELECT names FROM crop_identities WHERE slug='okra'");
    expect(r.rows[0]!.names.en!.map((x) => x.text)).toEqual(expect.arrayContaining(["Okra", "Bhendi"]));
    const p = await pool.query<{ slug: string }>("SELECT slug FROM crop_products WHERE slug IN ('paddy-grain','paddy-milled-rice','chilli-green','chilli-dry') ORDER BY slug");
    expect(p.rows.map((x) => x.slug)).toEqual(["chilli-dry", "chilli-green", "paddy-grain", "paddy-milled-rice"]);
  });

  it("loads the district registry: Karnataka 31 incl. Hassan, Tamil Nadu 38, Assam 35, west-coast region", async () => {
    expect(await n("SELECT count(*) c FROM districts WHERE state_id='IN-KA' AND level='district'")).toBe(31);
    expect(await n("SELECT count(*) c FROM districts WHERE id='IN-KA-hassan'")).toBe(1);
    expect(await n("SELECT count(*) c FROM districts WHERE state_id='IN-TN' AND level='district'")).toBe(38);
    expect(await n("SELECT count(*) c FROM districts WHERE state_id='IN-AS' AND level='district'")).toBe(35);
    expect(await n("SELECT count(*) c FROM districts WHERE id='IN-region-west-coast' AND level='region'")).toBe(1);
    expect(await n("SELECT count(*) c FROM districts WHERE source_id IS NULL OR validation_status IS NULL")).toBe(0);
  });
});

describe("loader helpers", () => {
  it("uuid keys are deterministic and distinct", () => {
    expect(uuidFromKey("a")).toBe(uuidFromKey("a"));
    expect(uuidFromKey("a")).not.toBe(uuidFromKey("b"));
    expect(uuidFromKey("a")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it("drops product ids it cannot map instead of guessing", () => {
    const known = new Set(["ginger-fresh", "ginger-dry"]);
    expect(normaliseProductIds(["ginger.fresh", "ginger-dry", "ginger.seed_rhizome"], known)).toEqual({ kept: ["ginger-fresh", "ginger-dry"], dropped: ["ginger.seed_rhizome"] });
    expect(topicOf("Season (West Coast)")).toEqual(["season_west_coast"]);
    expect(topicOf(undefined)).toEqual([]);
  });
  it("every file-level rule and evidence reference resolves", () => {
    const f = readCatalogueFiles();
    const ev = new Set(f.evidence.map((e) => e.record.id));
    for (const s of f.ruleSets) for (const r of s.rules) for (const e of r.evidenceIds) expect(ev.has(e), `${r.id} -> ${e}`).toBe(true);
  });
});

import { makeGrounder } from "../src/catalogue/load";
describe("grounding check (D28)", () => {
  const g = makeGrounder();
  const base = { sourceUrl: "https://spices.res.in/storage/app/public/pdfs/GINGER/3ENG.pdf", contentHash: "8dde754dc3defc1c116fd11e963b091870e463b99f7c601a040f1aae0f1fe65e", locator: { page: 3 } };
  const text = "states namely Madhya Pradesh, Karnataka, Orissa, Assam, Meghalaya, Arunachal Pradesh and Gujarat together contribute 65 percent to the country's total production.";
  it("accepts an excerpt on its cited page and rejects it on another page or when altered", () => {
    expect(g({ ...base, content: { kind: "excerpt", text } })).toBe(true);
    expect(g({ ...base, locator: { page: 4 }, content: { kind: "excerpt", text } })).toBe(false);
    expect(g({ ...base, content: { kind: "excerpt", text: text.replace("65 percent", "75 percent") } })).toBe(false);
  });
});
