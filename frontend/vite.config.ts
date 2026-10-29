import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';

// The API serves this build in production (FEEPILOT_WEB_DIR=frontend/dist). In development the
// dev server proxies API calls to a locally running feepilot-api.
export default defineConfig({
  // One .env at the repository root drives the API, the tracker and this build.
  // Only VITE_-prefixed variables are exposed to the browser.
  envDir: fileURLToPath(new URL('..', import.meta.url)),
  plugins: [
    react(),
    tailwindcss(),
    // PWA: the app (/app/*) works offline from the precache; API responses are never cached here
    // (the app keeps its own last-known fee data and shows its age).
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      manifest: {
        name: 'FeePilot',
        short_name: 'FeePilot',
        description:
          'Unstick a Bitcoin transaction. You sign; FeePilot never holds your keys.',
        start_url: '/app',
        scope: '/',
        display: 'standalone',
        theme_color: '#0a0a0c',
        background_color: '#0a0a0c',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,woff2,svg,png,webmanifest}'],
        // app-shell.html is written by scripts/prerender.mjs after this build, so list it here.
        additionalManifestEntries: [
          { url: '/app-shell.html', revision: String(Date.now()) },
        ],
        navigateFallback: '/app-shell.html',
        navigateFallbackAllowlist: [/^\/app/],
        navigateFallbackDenylist: [/^\/v1\//, /^\/v2\//],
        cleanupOutdatedCaches: true,
        // No runtimeCaching: nothing from /v1 or /v2 is ever stored by the service worker.
      },
    }),
  ],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5173,
    proxy: { '/v1': 'http://127.0.0.1:8080', '/v2': 'http://127.0.0.1:8080' },
  },
  // react-helmet-async ships CJS that Node cannot import by name; bundle it into the SSR build.
  ssr: { noExternal: ['react-helmet-async'] },
  build: { target: 'es2022' },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
