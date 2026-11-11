import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// Vendor chunk groups (Rolldown `output.codeSplitting`). A group also captures its modules' dependencies
// (includeDependenciesRecursively), so the startup groups (react, supabase) get the highest priority — otherwise
// e.g. react would be pulled into the leaflet chunk and leaflet would load on first paint.
// firebase / leaflet stay lazy: only lazily-imported chunks reference them.
const VENDOR_GROUPS: { name: string; test: RegExp; priority: number }[] = [
  { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler|react-router|react-router-dom|cookie|set-cookie-parser)[\\/]/, priority: 40 },
  { name: 'supabase', test: /node_modules[\\/](@supabase|tslib|isows)[\\/]/, priority: 30 },
  { name: 'leaflet', test: /node_modules[\\/](leaflet|leaflet\.markercluster|react-leaflet|@react-leaflet)[\\/]/, priority: 20 },
  { name: 'firebase', test: /node_modules[\\/](firebase|@firebase|idb)[\\/]/, priority: 10 },
]

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectRegister: false, // registered manually in src/main.tsx via virtual:pwa-register
      includeManifestIcons: false, // icons the app itself uses are matched by globPatterns below
      devOptions: { enabled: true, type: 'module', navigateFallback: 'index.html' },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        // large OS-only icons are fetched by the OS on install, not by the app: keep them out of the precache
        globIgnores: ['**/icons/maskable-*.png', '**/icons/maskable.svg', '**/icons/apple-touch-icon-*.png', '**/icons/icon-512.png'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },
      manifest: {
        id: '/',
        name: 'Awaaz — آواز',
        short_name: 'Awaaz',
        description:
          'Report a local problem by voice, photo or text. AI verifies it, pins it on a live map and alerts the right responders. آواز: اپنے علاقے کا مسئلہ بول کر، تصویر یا لکھ کر بتائیں۔',
        start_url: '/map',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        theme_color: '#0f766e',
        background_color: '#f8fafc',
        lang: 'ur',
        // dir: omitted on purpose — the manifest default is 'auto' (plugin typings only accept 'ltr' / 'rtl')
        categories: ['utilities', 'social', 'navigation'],
        prefer_related_applications: false,
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
        shortcuts: [
          {
            name: 'Report by voice',
            short_name: 'Voice report',
            description: 'Record a voice note about a problem near you',
            url: '/report?mode=voice',
            icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
          },
          {
            name: 'Live map',
            short_name: 'Map',
            url: '/map',
            icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
          },
        ],
      },
    }),
  ],
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: VENDOR_GROUPS,
        },
      },
    },
  },
})
