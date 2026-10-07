import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'
import { notBundle } from 'vite-plugin-electron/plugin'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    electron({
      main: {
        entry: 'electron/main.ts',
        // better-sqlite3 is a native module — it must stay a real require()
        // resolved from node_modules at runtime, not get inlined into the
        // bundle, or its .node binary path lookup (which relies on CommonJS
        // __dirname) breaks.
        vite: {
          plugins: [notBundle()],
        },
      },
      preload: {
        input: 'electron/preload.ts',
      },
      renderer: {},
    }),
  ],
})
