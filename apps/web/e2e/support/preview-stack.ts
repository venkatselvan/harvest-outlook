import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

/**
 * Production-like stack for offline tests: the REAL API (synthetic mode) on 8797 and the BUILT PWA (service worker
 * included) served by `vite preview` on 4177 with /api proxied. The dev server has no service worker, so a real
 * offline reload (context.setOffline) only works against this build.
 */
export const PREVIEW_PORT = 4177;
export const PREVIEW_API_PORT = 8797;
const webDir = process.cwd();
const outDir = resolve(webDir, "node_modules/.cache/ho-e2e-dist");

async function waitFor(url: string, ms: number): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > end) throw new Error(`timeout waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

function run(cmd: string, args: string[], env: Record<string, string>): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { cwd: webDir, env: { ...process.env, ...env }, stdio: "ignore" });
    p.on("exit", (c) => (c === 0 ? res() : rej(new Error(`${cmd} ${args.join(" ")} exited ${c}`))));
  });
}

export async function startPreviewStack(): Promise<() => void> {
  const procs: ChildProcess[] = [];
  const origin = `http://localhost:${PREVIEW_PORT}`;
  await run("pnpm", ["exec", "vite", "build", "--outDir", outDir, "--emptyOutDir"], {});
  procs.push(
    spawn("pnpm", ["--filter", "@harvest/api", "exec", "tsx", "../web/e2e/support/start-real-api.ts"], {
      cwd: webDir,
      stdio: "ignore",
      detached: false,
      env: { ...process.env, PORT: String(PREVIEW_API_PORT), RUNTIME_MODE: "synthetic", RATE_LIMIT_MAX: "5000", ALLOWED_ORIGINS: `${origin},http://127.0.0.1:${PREVIEW_PORT}` },
    }),
    spawn("pnpm", ["exec", "vite", "preview", "--outDir", outDir, "--port", String(PREVIEW_PORT), "--strictPort"], {
      cwd: webDir,
      stdio: "ignore",
      env: { ...process.env, API_PROXY_TARGET: `http://127.0.0.1:${PREVIEW_API_PORT}` },
    }),
  );
  await Promise.all([waitFor(`http://127.0.0.1:${PREVIEW_API_PORT}/api/v1/health`, 90_000), waitFor(origin + "/", 30_000)]);
  return () => {
    for (const p of procs) p.kill("SIGTERM");
  };
}
