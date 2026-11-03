import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { planTabGate } from "./farmTabs";

/**
 * Review fix: when the workspace fails to load the Plan tab must show an error, not mount the year plan with no field (a
 * farm with fields answers an unscoped request 400 field_required). The command center is not renderable under the node
 * renderer (router, session, resources), so the gate is a pure function and its wiring is checked in the source.
 */
describe("planTabGate", () => {
  it("shows the error, not the plan, when the workspace failed and is not known", () => {
    expect(planTabGate(null, false, true)).toBe("error");
    expect(planTabGate(undefined, false, true)).toBe("error");
  });
  it("loads while the workspace is pending, with or without a ?field= link", () => {
    expect(planTabGate(null, false, false)).toBe("loading");
    expect(planTabGate(undefined, false, false)).toBe("loading");
  });
  it("mounts the plan once the workspace is known and the field is resolved (a field, or null for All fields)", () => {
    expect(planTabGate("a", true, false)).toBe("ready");
    expect(planTabGate(null, true, false)).toBe("ready");
    expect(planTabGate(null, true, true)).toBe("ready"); // an earlier error followed by a successful reload
  });
  it("waits while the field is still unresolved even though the workspace is known", () => {
    expect(planTabGate(undefined, true, false)).toBe("loading");
  });
});

describe("Plan tab wiring", () => {
  const source = readFileSync(new URL("./FarmCommandCenter.tsx", import.meta.url), "utf8");
  const plan = source.slice(source.indexOf('<Show when={tab() === "year"}>'), source.indexOf('<Show when={tab() === "harvest"}>'));
  it("mounts YearPlanView only in the ready branch, and offers a retry in the error branch", () => {
    expect(plan.match(/<YearPlanView/g)).toHaveLength(1);
    expect(plan.indexOf('planGate() === "ready"')).toBeLessThan(plan.indexOf("<YearPlanView"));
    expect(plan.indexOf("<YearPlanView")).toBeLessThan(plan.indexOf('planGate() === "error"'));
    expect(plan).toContain('data-testid="plan-workspace-error"');
    expect(plan).toContain("s.refreshWorkspace()");
    expect(source).toContain("planTabGate(todayField(), workspaceKnown(), !!s.workspace.error)");
  });
});
