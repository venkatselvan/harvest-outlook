import { defineConfig } from "@playwright/test";

const API_PORT = process.env.E2E_API_PORT ?? "8791";
const WEB_PORT = process.env.E2E_WEB_PORT ?? "5173";

// Real dev server: API (synthetic mode, in-process job loop) on 8791 and Vite proxying /api to it.
// Mobile viewport 360 px. RATE_LIMIT_MAX gives the e2e seeds headroom over the production default of 120/min.
export default defineConfig({
  testDir: "e2e",
  workers: 1,
  use: { baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${WEB_PORT}`, viewport: { width: 360, height: 740 } },
  webServer: [
    {
      command: "pnpm --filter @harvest/api exec tsx ../web/e2e/support/start-real-api.ts",
      url: `http://127.0.0.1:${API_PORT}/api/v1/health`,
      reuseExistingServer: true,
      timeout: 90_000,
      env: { PORT: API_PORT, RUNTIME_MODE: "synthetic", RATE_LIMIT_MAX: "5000", ALLOWED_ORIGINS: `http://localhost:${WEB_PORT},http://127.0.0.1:${WEB_PORT}` },
    },
    {
      command: "pnpm --filter @harvest/web exec vite --port " + WEB_PORT + " --strictPort",
      url: `http://localhost:${WEB_PORT}/`,
      reuseExistingServer: true,
      timeout: 60_000,
      env: { API_PROXY_TARGET: `http://127.0.0.1:${API_PORT}` },
    },
  ],
});
