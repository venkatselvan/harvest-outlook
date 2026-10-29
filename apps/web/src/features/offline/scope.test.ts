import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("owner scope persistence (H1)", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("a new tab (new sessionStorage, same localStorage) gets the same scope; rotation gives a new one", () => {
    const local = mem();
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("sessionStorage", mem());
    const tab1 = getOwnerScope();
    vi.stubGlobal("sessionStorage", mem()); // reopened PWA / new tab
    expect(getOwnerScope()).toBe(tab1);
    rotateOwnerScope();
    expect(getOwnerScope()).not.toBe(tab1);
  });
  it("adopts a scope an older build kept in sessionStorage so its data stays reachable", () => {
    const session = mem();
    session.setItem("ho.ownerScope", "legacy-tab-scope");
    vi.stubGlobal("localStorage", mem());
    vi.stubGlobal("sessionStorage", session);
    expect(getOwnerScope()).toBe("legacy-tab-scope");
  });
});
