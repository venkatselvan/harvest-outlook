import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page } from "@playwright/test";

/** Shared e2e seed (SYNTHETIC mode): a farm and a ginger plan from the synthetic fixture, created through the real API. */
const ginger = () => JSON.parse(readFileSync(resolve(process.cwd(), "../../data/fixtures/synthetic/plan-ginger-basic.json"), "utf8"));

export async function seedFarmAndPlan(page: Page): Promise<{ farmId: string; planId: string }> {
  await page.goto("/farm");
  await expect(page.getByRole("heading", { name: "My farm" })).toBeVisible();
  const fx = ginger();
  const r = await page.evaluate(async (fx) => {
    let s = (await (await fetch("/api/v1/session", { credentials: "same-origin" })).json()).data;
    if (!s?.authenticated) s = (await (await fetch("/api/v1/session", { method: "POST", credentials: "same-origin" })).json()).data;
    const h = { "x-csrf-token": s.csrfToken, accept: "application/json", "content-type": "application/json" };
    const rnd = () => Math.random().toString(36).slice(2);
    const farmRes = await fetch("/api/v1/farms", {
      method: "POST",
      headers: { ...h, "idempotency-key": "e2e-farm-" + rnd() },
      body: JSON.stringify({
        name: "Hassan farm",
        location: { districtId: "typed:KA:hassan", districtName: "Hassan", stateCode: "KA", precision: "district" },
        areaHectares: 1.2,
        facts: { irrigation_category: { value: "supplemental", basis: "farmer_reported", confirmed: true, source: "e2e" } },
      }),
    });
    const farm = (await farmRes.json()).data;
    const planRes = await fetch("/api/v1/plans", {
      method: "POST",
      headers: { ...h, "idempotency-key": "e2e-plan-" + rnd() },
      body: JSON.stringify({ farmId: farm.id, cropId: fx.cropId, productId: fx.productId, confirmedInputs: fx.confirmedInputs, assumptions: fx.assumptions, ruleVersions: fx.ruleVersions, stageDefinitions: fx.stageDefinitions, parameters: fx.parameters }),
    });
    const plan = (await planRes.json()).data;
    return { farmId: farm.id as string, planId: (plan?.snapshot?.id ?? plan?.id) as string, status: planRes.status };
  }, fx);
  expect(r.status).toBeLessThan(300);
  expect(r.planId).toBeTruthy();
  return { farmId: r.farmId, planId: r.planId };
}
