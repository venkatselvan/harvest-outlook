import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FsStorage } from "../src/storage/fs";
import { StorageError } from "../src/storage/types";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const dirs: string[] = [];
async function make() {
  const d = await mkdtemp(join(tmpdir(), "ho-storage-"));
  dirs.push(d);
  return new FsStorage(d);
}
afterAll(async () => { await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))); });

describe("FsStorage", () => {
  it("scopes keys to the owner so another owner cannot read them", async () => {
    const s = await make();
    await s.put({ ownerId: A, key: "media/a.bin" }, new Uint8Array([1, 2, 3]));
    expect(Array.from(await s.get({ ownerId: A, key: "media/a.bin" }))).toEqual([1, 2, 3]);
    expect(await s.exists({ ownerId: B, key: "media/a.bin" })).toBe(false);
    await expect(s.get({ ownerId: B, key: "media/a.bin" })).rejects.toMatchObject({ code: "not_found" });
  });

  it.each(["../x", "a/../../x", "/etc/passwd", "a//b", "", ".hidden", "a/..", "a\\b"])("rejects traversal-like key %j", async (key) => {
    const s = await make();
    await expect(s.put({ ownerId: A, key }, new Uint8Array([0]))).rejects.toBeInstanceOf(StorageError);
  });

  it("rejects non-UUID owner ids (path injection)", async () => {
    const s = await make();
    await expect(s.put({ ownerId: "../..", key: "a" }, new Uint8Array([0]))).rejects.toBeInstanceOf(StorageError);
  });

  it("deleteOwner removes only that owner's objects", async () => {
    const s = await make();
    await s.put({ ownerId: A, key: "k" }, new Uint8Array([1]));
    await s.put({ ownerId: B, key: "k" }, new Uint8Array([2]));
    await s.deleteOwner(A);
    expect(await s.exists({ ownerId: A, key: "k" })).toBe(false);
    expect(await s.exists({ ownerId: B, key: "k" })).toBe(true);
  });
});
