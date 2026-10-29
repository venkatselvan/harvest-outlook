import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";

// Solid SSR transform so component tests can use renderToString in the node environment (added by T06c).
export default defineConfig({
  plugins: [solid({ ssr: true })],
  resolve: { conditions: ["node"] },
  test: { include: ["src/**/*.test.{ts,tsx}"], environment: "node", server: { deps: { inline: [/solid-js/] } } },
});
