import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    solid(),
    VitePWA({
      strategies: "generateSW",
      registerType: "autoUpdate",
      manifest: {
        name: "Harvest Outlook",
        short_name: "Harvest",
        description: "Crop comparison, season planning and visual journal.",
        start_url: "/farm",
        scope: "/",
        display: "standalone",
        background_color: "#ffffff",
        theme_color: "#1f5f3a",
        icons: [
          {
            src: "/brand/harvest-logo.png",
            sizes: "1254x1254",
            type: "image/png",
            purpose: "any",
          },
        ],
      },
      workbox: {
        // App shell plus one public, non-personal read endpoint family (the crop catalogue) so Explore opens offline.
        // GET /capabilities is deliberately NOT cached: for a signed-in guest it carries budget figures and the
        // response has no Vary on the session cookie.
        // Everything else under /api (plans, journal, farms, media, assistant, speech, session, jobs) is private and
        // is NEVER cached by the service worker; private snapshots live in IndexedDB under an owner scope instead
        // (src/features/plan-cache). The fixed `private` rule below is an allow-list, not a deny-list.
        globPatterns: ["**/*.{js,css,html,svg,png,webmanifest}"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            // GET /api/v1/crops* only. NetworkFirst with a short maxAge: fresh data when
            // online, last good copy (at most one hour old) when not. Cleared on logout (features/offline/purge.ts).
            urlPattern: ({ url, request }: { url: URL; request: Request }) =>
              request.method === "GET" &&
              (url.pathname === "/api/v1/crops" ||
                url.pathname.startsWith("/api/v1/crops/")),
            handler: "NetworkFirst",
            options: {
              cacheName: "ho-api-public",
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 60, maxAgeSeconds: 60 * 60 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.API_PROXY_TARGET ?? "http://127.0.0.1:8787",
        changeOrigin: false,
      },
    },
  },
  build: { target: "es2022" },
});
