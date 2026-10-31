import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildServer, type ServerDeps } from "../src/server";
import { loadConfig, type Config } from "../src/config";
import { createPool, type Pool } from "../src/db/pool";
import { migrate } from "../src/db/migrate";
import { FsStorage } from "../src/storage/fs";

export const TEST_DB = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/harvest_outlook_test";
export const ORIGIN = "http://localhost:5173";

export function testConfig(over: Record<string, string> = {}): Config {
  return loadConfig({
    DATABASE_URL: TEST_DB,
    SESSION_SECRET: "t".repeat(40),
    ALLOWED_ORIGINS: ORIGIN,
    LOG_LEVEL: "silent",
    SESSION_CREATE_PER_HOUR: "1000",
    ...over,
  });
}

export interface Harness {
  pool: Pool;
  storageRoot: string;
  storage: FsStorage;
  config: Config;
  app: FastifyInstance;
  close: () => Promise<void>;
  make: (over?: Record<string, string>, deps?: Omit<ServerDeps, "storage">) => Promise<FastifyInstance>;
}

/** Wipes the test database, migrates, and builds an app with a temp filesystem storage root. */
export async function setupHarness(over: Record<string, string> = {}): Promise<Harness> {
  const testUrl = new URL(TEST_DB);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(testUrl.hostname) || testUrl.pathname !== "/harvest_outlook_test") throw new Error("Refusing schema reset outside dedicated local harvest_outlook_test database");
  const pool = createPool(TEST_DB);
  const target = (await pool.query<{ name: string }>("SELECT current_database() AS name")).rows[0];
  if (target?.name !== "harvest_outlook_test") { await pool.end(); throw new Error("Refusing schema reset: unexpected database identity"); }
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(pool, undefined, () => undefined);
  const storageRoot = await mkdtemp(join(tmpdir(), "ho-test-"));
  const storage = new FsStorage(storageRoot);
  const config = testConfig(over);
  const apps: FastifyInstance[] = [];
  const make = async (o: Record<string, string> = {}, deps: Omit<ServerDeps, "storage"> = {}) => {
    const a = await buildServer(testConfig({ ...over, ...o }), pool, { storage, ...deps });
    apps.push(a);
    return a;
  };
  const app = await make();
  return {
    pool,
    storageRoot,
    storage,
    config,
    app,
    make,
    close: async () => {
      await Promise.all(apps.map((a) => a.close()));
      await pool.end();
      await rm(storageRoot, { recursive: true, force: true });
    },
  };
}

export interface Client {
  cookie: string;
  csrf: string;
  call: (method: string, url: string, opts?: CallOpts) => Promise<LightMyRequestResponse>;
}
interface CallOpts {
  payload?: unknown;
  headers?: Record<string, string>;
  origin?: string | null;
  csrf?: string | null;
  cookie?: string | null;
}

export async function login(app: FastifyInstance, origin = ORIGIN): Promise<Client> {
  const res = await app.inject({ method: "POST", url: "/api/v1/session", headers: { origin } });
  if (res.statusCode !== 201) throw new Error(`session failed ${res.statusCode} ${res.body}`);
  const cookies = Object.fromEntries(res.cookies.map((c) => [c.name, c.value]));
  const cookie = `ho_session=${cookies.ho_session}; ho_csrf=${cookies.ho_csrf}`;
  const csrf = cookies.ho_csrf!;
  return {
    cookie,
    csrf,
    call: (method, url, o = {}) => {
      const headers: Record<string, string> = { ...o.headers };
      if (o.origin !== null) headers.origin = o.origin ?? origin;
      if (o.cookie !== null) headers.cookie = o.cookie ?? cookie;
      if (o.csrf !== null) headers["x-csrf-token"] = o.csrf ?? csrf;
      return app.inject({ method: method as "GET", url, headers, ...(o.payload !== undefined ? { payload: o.payload as object } : {}) });
    },
  };
}

export async function makeJpeg(opts: { width?: number; height?: number; orientation?: number; exif?: boolean } = {}): Promise<Buffer> {
  let s = sharp({ create: { width: opts.width ?? 200, height: opts.height ?? 100, channels: 3, background: { r: 40, g: 160, b: 80 } } }).jpeg();
  if (opts.exif || opts.orientation) {
    // withExif alone resets Orientation to 1, so set orientation through withMetadata first.
    if (opts.orientation) s = s.withMetadata({ orientation: opts.orientation });
    s = s.withExif({ IFD0: { Copyright: "SECRET-OWNER-NAME" } });
  }
  return s.toBuffer();
}

export function multipart(file: { data: Buffer; filename?: string; type?: string }, fields: Record<string, string> = {}) {
  const boundary = "----hoTestBoundary7MA4YWxkTrZu0gW";
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename ?? "a.jpg"}"\r\nContent-Type: ${file.type ?? "image/jpeg"}\r\n\r\n`));
  parts.push(file.data);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

export async function upload(c: Client, data: Buffer, opts: { farmId?: string; key?: string; type?: string; filename?: string } = {}) {
  const m = multipart({ data, ...(opts.type ? { type: opts.type } : {}), ...(opts.filename ? { filename: opts.filename } : {}) }, opts.farmId ? { farmId: opts.farmId } : {});
  const headers: Record<string, string> = { ...m.headers };
  if (opts.key) headers["idempotency-key"] = opts.key;
  return c.call("POST", "/api/v1/media", { payload: m.payload, headers });
}

export const farmBody = (over: Record<string, unknown> = {}) => ({
  name: "North plot",
  location: { districtName: "Wayanad", stateId: "IN-KL", precision: "district" },
  areaHectares: 1.5,
  facts: {
    soil_ph: { value: 6.2, unit: "pH", basis: "farmer_reported", confirmed: false, source: "own strip test" },
    irrigation: { value: "drip", basis: "farmer_reported", confirmed: true },
  },
  ...over,
});
