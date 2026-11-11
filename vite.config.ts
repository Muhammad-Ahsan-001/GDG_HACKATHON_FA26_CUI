import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// PWA builder: add vite-plugin-pwa (injectManifest, src/sw.ts) here.
export default defineConfig({
  plugins: [react(), tailwindcss()],
})
