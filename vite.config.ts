import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { VitePWA } from "vite-plugin-pwa"

// https://vite.dev/config/
export default defineConfig({
  // GitHub Pages serves from /<repo>/ — CI sets BASE_PATH accordingly
  base: process.env.BASE_PATH ?? "/",
  // PORT lets tooling (preview harness) assign a free port; vite default otherwise
  server: process.env.PORT ? { port: Number(process.env.PORT) } : undefined,
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Bratislava Transit Map",
        short_name: "BA Transit",
        description:
          "Tram, trolleybus and bus routes, stops and departures in Bratislava.",
        theme_color: "#0f172a",
        background_color: "#0f172a",
        display: "standalone",
        icons: [
          { src: "pwa-192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "pwa-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // Precache the app shell only — the 46 MB of transit JSON is
        // runtime-cached below as it gets used.
        globPatterns: ["**/*.{js,css,html,woff2,png,svg}"],
        globIgnores: ["data/**"],
        navigateFallbackDenylist: [/\/data\//],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.includes("/data/"),
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "transit-data",
              expiration: { maxEntries: 4000, maxAgeSeconds: 7 * 24 * 3600 },
            },
          },
          {
            urlPattern: /^https:\/\/tiles\.openfreemap\.org\//,
            handler: "CacheFirst",
            options: {
              cacheName: "map-tiles",
              expiration: { maxEntries: 400, maxAgeSeconds: 30 * 24 * 3600 },
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // maplibre is ~2/3 of the bundle and changes only on dependency
        // bumps — its own chunk stays cached across app deploys
        manualChunks(id: string) {
          if (id.includes("node_modules/maplibre-gl")) return "maplibre"
        },
      },
    },
  },
})
