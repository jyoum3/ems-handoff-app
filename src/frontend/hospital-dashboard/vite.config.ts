/**
 * vite.config.ts — Vite Build & Dev Server Configuration
 * ========================================================
 *
 * Two key responsibilities:
 *
 * 1. Dev Proxy — Eliminates CORS in local development
 *    ─────────────────────────────────────────────────
 *    When the React app calls fetch('/api/negotiate'), the browser sees
 *    a same-origin request to localhost:3000. Vite's dev server intercepts
 *    it and forwards it to localhost:7071 (the Azure Functions host).
 *    The browser never sees a cross-origin request, so CORS doesn't apply.
 *
 *    This is simpler and more reliable than relying on CORS headers for
 *    local dev. The CORS config in local.settings.json and host.json is
 *    still needed for the deployed environment (Azure SWA → Azure Functions),
 *    where the Vite proxy doesn't exist.
 *
 * 2. PWA Plugin — Makes the dashboard installable on ward tablets
 *    ─────────────────────────────────────────────────────────────
 *    vite-plugin-pwa generates a Service Worker and injects the Web App
 *    Manifest. This allows the dashboard to be "installed" on a workstation
 *    tablet as a standalone app — full screen, no browser chrome, with the
 *    ability to cache the shell for offline resilience (though real-time data
 *    requires connectivity). 'autoUpdate' ensures the Service Worker updates
 *    silently when a new build is deployed.
 */

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // workbox config: cache the app shell (JS/CSS/HTML) for offline resilience.
      // Network-first for API calls (always try live data, fall back to cache).
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
        runtimeCaching: [
          {
            urlPattern: /^\/api\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-cache',
              networkTimeoutSeconds: 10,
            },
          },
        ],
      },
      // The manifest is defined inline here so vite-plugin-pwa can inject
      // the <link rel="manifest"> tag into index.html automatically.
      // This does NOT replace public/manifest.json — we keep both for
      // compatibility with browsers that look for the standalone file.
      manifest: {
        name: 'EMS Handoff Dashboard',
        short_name: 'EMS Dashboard',
        description:
          'Real-time EMS patient handoff dashboard for emergency department staff',
        theme_color: '#0f1117',
        background_color: '#0f1117',
        display: 'standalone',
        scope: '/',
        start_url: '/',
        icons: [
          {
            src: '/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: '/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
        ],
      },
    }),
  ],

  server: {
    port: 3000,
    // ── API Proxy ───────────────────────────────────────────────────────────
    // All requests to /api/* are forwarded to the Azure Functions dev host.
    // changeOrigin: true rewrites the Host header so the Functions host
    // sees 'localhost:7071' rather than 'localhost:3000' — required for
    // the Functions routing middleware to match routes correctly.
    proxy: {
      '/api': {
        target: 'http://localhost:7071',
        changeOrigin: true,
      },
    },
  },
})
