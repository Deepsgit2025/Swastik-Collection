import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Deliberately separate from vite.config.ts: that config's electron() plugin
// tries to spawn the Electron binary on every dev-server boot, which vitest
// also spins up internally. Renderer tests only need React + jsdom.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/testSetup.ts'],
  },
})
