import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "../..");

/** Dev server for the T12 e2e entry only. PORT 5195, proxying /api to the e2e API on 8795. Not used by the real build. */
export default defineConfig({
  root: resolve(here, "plan-app"),
  plugins: [solid()],
  server: {
    port: 5195,
    strictPort: true,
    fs: { allow: [webRoot, resolve(webRoot, "../..")] },
    proxy: { "/api": { target: process.env.API_PROXY_TARGET ?? "http://127.0.0.1:8795", changeOrigin: false } },
  },
});
