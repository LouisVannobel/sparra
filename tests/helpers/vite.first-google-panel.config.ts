import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  root: resolve('tests/helpers'), envDir: false, envPrefix: 'TASK9C_FIXTURE_PUBLIC_', plugins: [react()],
  build: { outDir: resolve('.superpowers/sdd/2026-09-10-functional-auth/task-9c-panel-fixture-dist'), emptyOutDir: true,
    rollupOptions: { input: resolve('tests/helpers/first-google-panel-fixture.html') } },
})
