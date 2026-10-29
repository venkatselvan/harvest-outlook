import { defineConfig } from "@playwright/test";

// Browser journeys arrive in a later task; this config only wires the runner.
export default defineConfig({
  testDir: "e2e",
  use: { baseURL: process.env.E2E_BASE_URL ?? "http://localhost:5173" },
});
