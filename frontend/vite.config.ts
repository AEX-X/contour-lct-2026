/// <reference types="vitest/config" />

import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const apiProxyTarget = env.CONTOUR_API_PROXY_TARGET?.trim();

  return {
  build: {
    outDir: "dist/client",
    rollupOptions: {
      output: {
        manualChunks: {
          "react-vendor": ["react", "react-dom", "react-router-dom"],
          "query-vendor": ["@tanstack/react-query"],
          "forms-vendor": ["react-hook-form", "@hookform/resolvers", "zod"],
          "icons-vendor": ["@phosphor-icons/react"],
        },
      },
    },
  },
  optimizeDeps: {
    include: ["react", "react-dom/client", "react-router-dom"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local", "localhost"],
    warmup: {
      clientFiles: ["./src/main.tsx"],
    },
    proxy: apiProxyTarget ? {
      "/api": {
        target: apiProxyTarget,
        changeOrigin: true,
        secure: false,
      },
    } : undefined,
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
    css: true,
    coverage: {
      reporter: ["text", "json-summary"],
    },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: "prompt",
      injectRegister: false,
      manifestFilename: "app.webmanifest",
      manifest: {
        name: "Contour: инженерная инфраструктура",
        short_name: "Contour",
        description: "Центр управления инженерной инфраструктурой",
        lang: "ru",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#f5f8fc",
        theme_color: "#2467e8",
        icons: [
          {
            src: "/assets/pwa-64x64.png",
            sizes: "64x64",
            type: "image/png",
          },
          {
            src: "/assets/pwa-192x192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "/assets/pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/assets/maskable-icon-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [
          /^\/api(?:\/|$)/,
          /^\/docs(?:\/|$)/,
          /^\/openapi\.json$/,
          /^\/health$/,
        ],
        globPatterns: ["**/*.{js,css,html,png,svg,ico,woff,woff2,json}"],
        globIgnores: [
          "assets/pwa-64x64.png",
          "assets/pwa-192x192.png",
          "assets/pwa-512x512.png",
          "assets/maskable-icon-512x512.png",
        ],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  };
});
