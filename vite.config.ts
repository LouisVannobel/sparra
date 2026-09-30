import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { nitro } from 'nitro/vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [
    tanstackStart({
      importProtection: {
        behavior: 'error',
        client: { specifiers: [/^effect(?:\/|$)/] },
      },
    }),
    nitro({
      preset: 'node-server',
      plugins: ['./src/platform/startup.server.ts'],
      tracingChannel: false,
    }),
    react(),
  ],
})
