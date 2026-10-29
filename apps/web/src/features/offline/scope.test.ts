import { describe, expect, it } from "vitest";
import { getOwnerScope, rotateOwnerScope } from "./scope";

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};
describe("owner scope", () => {
  it("is stable within a session and different after rotation", () => {
    const s = mem();
    const a = getOwnerScope(s);
    expect(getOwnerScope(s)).toBe(a);
    rotateOwnerScope(s);
    expect(getOwnerScope(s)).not.toBe(a);
  });
  it("is random, not derived from anything about the owner", () => {
    expect(getOwnerScope(mem())).not.toBe(getOwnerScope(mem()));
  });
});
