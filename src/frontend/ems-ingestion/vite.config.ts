/**
 * vite.config.ts — EMS Ingestion PWA: Vite Build & Dev Server Configuration
 * ===========================================================================
 *
 * Mirrors the hospital-dashboard vite.config.ts pattern with two key
 * differences:
 *
 * 1. Port — 5174 (hospital-dashboard is 3000; both can run simultaneously)
 * 2. PWA manifest — EMS branding (orange accent, "EMS Handoff" name)
 *
 * Dev Proxy:
 * ----------
 * All /api/* requests are forwarded to the Azure Functions host at
 * localhost:7071. The browser sees a same-origin call — no CORS headers
 * needed in local dev. The proxy does not exist in production; Azure SWA
 * handles the routing there.
 *
 * PWA Plugin:
 * -----------
 * vite-plugin-pwa generates the Service Worker and injects the manifest.
 * The 'autoUpdate' register type silently refreshes the SW on new deploys.
 * Medics on degraded field networks benefit from the cached app shell.
 */

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
        runtimeCaching: [
          {
            urlPattern: /^\/api\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'ems-api-cache',
              networkTimeoutSeconds: 10,
            },
          },
        ],
      },
      manifest: {
        name: 'EMS Handoff',
        short_name: 'EMS',
        description: 'EMS patient handoff ingestion PWA for field medics',
        theme_color: '#F97316',
        background_color: '#0f172a',
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
    port: 5174,
    // ── API Proxy ───────────────────────────────────────────────────────────
    // Forwards /api/* to Azure Functions host. changeOrigin rewrites the Host
    // header so the Functions routing middleware matches routes correctly.
    proxy: {
      '/api': {
        target: 'http://localhost:7071',
        changeOrigin: true,
      },
    },
  },
})
