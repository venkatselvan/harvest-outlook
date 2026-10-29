import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveDistrict } from "../src/catalogue/districts";
import { farmBody, login, setupHarness, type Client, type Harness } from "./helpers";

let h: Harness;
let a: Client;
beforeAll(async () => {
  h = await setupHarness();
  a = await login(h.app);
});
afterAll(async () => h.close());

const create = (location: Record<string, unknown>) => a.call("POST", "/api/v1/farms", { payload: farmBody({ location: { precision: "district", ...location } }) });

describe("farm district resolution", () => {
  it.each(["Hassan", "hassan", "HASSAN", "  Hássan "])("resolves the name %j within the state", async (name) => {
    const r = await create({ stateId: "IN-KA", districtName: name });
    expect(r.statusCode).toBe(201);
    const farm = r.json().data;
    expect(farm.location).toMatchObject({ districtId: "IN-KA-hassan", stateCode: "IN-KA" });
    expect(farm.warnings).toBeUndefined();
  });

  it("keeps a canonical id, fills the display name and derives the state", async () => {
    const farm = (await create({ districtId: "IN-KA-hassan" })).json().data;
    expect(farm.location).toMatchObject({ districtId: "IN-KA-hassan", districtName: "Hassan", stateCode: "IN-KA" });
  });

  it("stores null plus a warning for an unmatched name, keeping the farmer's text", async () => {
    const r = await create({ stateId: "IN-KA", districtName: "Bangalore" });
    expect(r.statusCode).toBe(201);
    const farm = r.json().data;
    expect(farm.location).toMatchObject({ districtId: null, districtName: "Bangalore", stateCode: "IN-KA" });
    expect(farm.warnings).toEqual([expect.objectContaining({ code: "district_unresolved" })]);
    // A state without a district list is also unresolved, not guessed.
    const kl = (await create({ stateId: "IN-KL", districtName: "Wayanad" })).json().data;
    expect(kl.location.districtId).toBeNull();
    expect(kl.warnings[0].code).toBe("district_unresolved");
  });

  it("rejects an unknown state and a district that contradicts the state", async () => {
    for (const loc of [{ stateId: "IN-ZZ", districtName: "Hassan" }, { stateId: "Karnataka-ish", districtName: "Hassan" }]) {
      const r = await create(loc);
      expect(r.statusCode).toBe(400);
      expect(r.json().error.code).toBe("validation_error");
    }
    const mismatch = await create({ stateId: "IN-TN", districtId: "IN-KA-hassan" });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error.code).toBe("validation_error");
  });

  it("canonicalises legacy bare state codes and legacy typed ids instead of storing them", async () => {
    const legacy = (await create({ districtId: "typed:KA:hassan", districtName: "Hassan", stateCode: "KA" })).json().data;
    expect(legacy.location).toMatchObject({ districtId: "IN-KA-hassan", stateCode: "IN-KA" });
    const unknown = (await create({ districtId: "typed:xx:nowhere" })).json().data;
    expect(unknown.location.districtId).toBeNull();
  });

  it("PATCH re-resolves the location and warns", async () => {
    const farm = (await create({ stateId: "IN-TN", districtName: "Madurai" })).json().data;
    expect(farm.location.districtId).toBe("IN-TN-madurai");
    const p = await a.call("PATCH", `/api/v1/farms/${farm.id}`, { payload: { location: { stateId: "IN-TN", districtName: "Nowhere", precision: "district" } } });
    expect(p.statusCode).toBe(200);
    expect(p.json().data.location).toMatchObject({ districtId: null, districtName: "Nowhere" });
    expect(p.json().data.warnings[0].code).toBe("district_unresolved");
  });

  it("never stores a non-canonical district_code", async () => {
    await create({ districtName: "Hassan" }); // no state: unique name across lists still resolves
    await create({ stateId: "IN-AS", districtName: "zzz" });
    const rows = (await h.pool.query<{ district_code: string | null; state_code: string | null }>("SELECT district_code, state_code FROM farms")).rows;
    expect(rows.length).toBeGreaterThan(5);
    for (const r of rows) {
      if (r.district_code !== null) expect(r.district_code).toMatch(/^IN-[A-Z]{2}(-[a-z0-9-]+)?$/);
      if (r.state_code !== null) expect(r.state_code).toMatch(/^IN-[A-Z]{2}$/);
    }
    expect(rows.some((r) => r.district_code?.startsWith("typed:"))).toBe(false);
  });
});

describe("resolveDistrict", () => {
  it("does not resolve an ambiguous or unknown name without a state", () => {
    expect(resolveDistrict({ districtIdOrName: "nonexistent place" }).districtId).toBeNull();
    expect(resolveDistrict({ districtIdOrName: "" }).districtId).toBeNull();
  });
});
