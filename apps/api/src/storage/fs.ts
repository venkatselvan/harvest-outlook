import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { StorageError, type StorageAdapter, type StorageObjectRef } from "./types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class FsStorage implements StorageAdapter {
  private readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }

  private ownerDir(ownerId: string): string {
    if (!UUID_RE.test(ownerId)) throw new StorageError("invalid_key", "ownerId must be a UUID");
    return resolve(this.root, ownerId.toLowerCase());
  }

  private path({ ownerId, key }: StorageObjectRef): string {
    const dir = this.ownerDir(ownerId);
    const segments = key.split("/");
    if (segments.length === 0 || segments.length > 6 || !segments.every((s) => s !== ".." && SEGMENT_RE.test(s))) {
      throw new StorageError("invalid_key", "invalid storage key");
    }
    const full = resolve(dir, ...segments);
    if (!full.startsWith(dir + sep)) throw new StorageError("invalid_key", "invalid storage key");
    return full;
  }

  async put(ref: StorageObjectRef, data: Uint8Array) {
    const p = this.path(ref);
    await mkdir(dirname(p), { recursive: true, mode: 0o700 });
    await writeFile(p, data, { mode: 0o600 });
    return { bytes: data.byteLength };
  }

  async get(ref: StorageObjectRef) {
    try {
      return new Uint8Array(await readFile(this.path(ref)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new StorageError("not_found", "object not found");
      throw e;
    }
  }

  async exists(ref: StorageObjectRef) {
    try {
      return (await stat(this.path(ref))).isFile();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw e;
    }
  }

  async delete(ref: StorageObjectRef) {
    await rm(this.path(ref), { force: true });
  }

  async deleteOwner(ownerId: string) {
    await rm(this.ownerDir(ownerId), { recursive: true, force: true });
  }
}
