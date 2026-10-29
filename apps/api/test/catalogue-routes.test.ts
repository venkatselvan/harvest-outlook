import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "../src/db/pool";
import { buildCatalogueApp, freshCatalogueDb } from "./catalogue-helpers";
import { farmBody, login, ORIGIN, testConfig } from "./helpers";

let pool: Pool;
let app: FastifyInstance;
let root: string;
const body = (o: Record<string, unknown> = {}) => ({ location: { stateId: "IN-KA", districtId: "IN-KA-hassan" }, planting: { month: 5 }, irrigation: "rainfed", ...o });
const post = (payload: unknown, headers: Record<string, string> = { origin: ORIGIN }) => app.inject({ method: "POST", url: "/api/v1/crop-comparisons", payload: payload as object, headers });

beforeAll(async () => {
  pool = await freshCatalogueDb();
  root = await mkdtemp(join(tmpdir(), "cat-"));
  app = await buildCatalogueApp(testConfig(), pool, root);
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await rm(root, { recursive: true, force: true });
});

describe("catalogue routes", () => {
  it("lists 25 qualified crops and per-crop coverage, detail with citations, districts", async () => {
    const list = (await app.inject({ method: "GET", url: "/api/v1/crops" })).json().data;
    expect(list.counts).toMatchObject({ crops: 25, qualified: 25 });
    const d = (await app.inject({ method: "GET", url: "/api/v1/crops/ginger" })).json().data;
    expect(d.evidence.length).toBeGreaterThan(10);
    expect(d.evidence[0].citation.sourceUrl).toMatch(/^https:/);
    const cov = (await app.inject({ method: "GET", url: "/api/v1/crops/okra/coverage" })).json().data;
    expect(cov.records.some((r: { capability: string }) => r.capability === "historical_reference_available")).toBe(true);
    expect((await app.inject({ method: "GET", url: "/api/v1/crops/nope" })).statusCode).toBe(404);
    const ka = (await app.inject({ method: "GET", url: "/api/v1/districts?state=IN-KA" })).json().data;
    expect(ka.districts).toHaveLength(31);
  });
  it("anonymous comparison works and returns rule and evidence ids", async () => {
    const res = await post(body());
    expect(res.statusCode).toBe(200);
    const g = res.json().data.items.find((i: { productId: string }) => i.productId === "ginger-fresh");
    expect(g.outcome).toBe("requires_review");
    expect(g.screening.appliedRuleIds.length).toBeGreaterThan(0);
    expect(g.screening.evidenceIds.length).toBeGreaterThan(0);
  });
  it("validates input", async () => {
    expect((await post(body({ planting: { month: 13 } }))).statusCode).toBe(400);
    expect((await post({ planting: { month: 5 }, irrigation: "rainfed" })).statusCode).toBe(400);
    expect((await post(body({ location: { stateId: "IN-KA", districtId: "IN-TN-salem" } }))).statusCode).toBe(400);
    expect((await post(body({ cropIds: ["unknown-crop"] }))).statusCode).toBe(400);
    expect((await post(body(), { origin: "http://evil.example" })).statusCode).toBe(403);
  });
  it("farm-linked comparison needs a session and is owner scoped (cross-owner 404)", async () => {
    const a = await login(app);
    const b = await login(app);
    const farm = (await a.call("POST", "/api/v1/farms", { payload: farmBody({ location: { districtId: "IN-KA-hassan", districtName: "Hassan", stateCode: "KA", precision: "district" } }) })).json().data;
    expect((await post({ farmId: farm.id, planting: { month: 5 }, irrigation: "rainfed" })).statusCode).toBe(401);
    const own = await a.call("POST", "/api/v1/crop-comparisons", { payload: { farmId: farm.id, planting: { month: 5 }, irrigation: "rainfed" } });
    expect(own.statusCode).toBe(200);
    expect(own.json().data.input.location).toMatchObject({ stateId: "IN-KA", districtId: "IN-KA-hassan" });
    expect(own.json().data.input.area).toMatchObject({ unit: "ha" });
    expect((await b.call("POST", "/api/v1/crop-comparisons", { payload: { farmId: farm.id, planting: { month: 5 }, irrigation: "rainfed" } })).statusCode).toBe(404);
  });
});
