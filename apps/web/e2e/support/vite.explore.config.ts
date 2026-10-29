import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { fileURLToPath } from "node:url";

const web = fileURLToPath(new URL("../../..", import.meta.url));
// Dev server for the Explore e2e harness. SPA fallback serves the harness for /explore and /farm. No PWA plugin.
export default defineConfig({
  root: fileURLToPath(new URL("./explore-harness", import.meta.url)),
  plugins: [solid()],
  server: {
    fs: { allow: [web, fileURLToPath(new URL("../../../../..", import.meta.url))] },
    proxy: { "/api": { target: process.env.API_PROXY_TARGET ?? "http://127.0.0.1:8793", changeOrigin: false } },
  },
});
