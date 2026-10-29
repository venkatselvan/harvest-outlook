import { describe, expect, it } from "vitest";
import { precheckFile } from "./precheck";

const f = (name: string, type: string, size: number) => ({ name, type, size });
describe("precheckFile", () => {
  it("accepts JPEG/PNG/WebP up to the limit", () => {
    expect(precheckFile(f("a.jpg", "image/jpeg", 10 * 1024 * 1024))).toEqual({ ok: true });
    expect(precheckFile(f("a.png", "image/png", 5))).toEqual({ ok: true });
    expect(precheckFile(f("a.webp", "image/webp", 5))).toEqual({ ok: true });
  });
  it("rejects over-size, empty, wrong type and HEIC with specific messages", () => {
    const big = precheckFile(f("a.jpg", "image/jpeg", 10 * 1024 * 1024 + 1));
    expect(big).toMatchObject({ ok: false });
    expect((big as { message: string }).message).toMatch(/10 MB/);
    expect(precheckFile(f("a.jpg", "image/jpeg", 0))).toMatchObject({ ok: false });
    expect(precheckFile(f("a.gif", "image/gif", 5))).toMatchObject({ ok: false });
    expect(precheckFile(f("a.pdf", "application/pdf", 5))).toMatchObject({ ok: false });
    expect((precheckFile(f("IMG_1.HEIC", "image/heic", 5)) as { message: string }).message).toMatch(/HEIC/);
  });
  it("honours a server-provided limit and tolerates an empty browser MIME type for a known extension", () => {
    expect(precheckFile(f("a.jpg", "image/jpeg", 2 * 1024 * 1024), 1024 * 1024)).toMatchObject({ ok: false });
    expect(precheckFile(f("photo.jpeg", "", 5))).toEqual({ ok: true });
    expect(precheckFile(f("photo.exe", "", 5))).toMatchObject({ ok: false });
  });
});
