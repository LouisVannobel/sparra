import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [{ name: 'mail-retry-owned-config', generateBundle() { this.emitFile({ type: 'asset', fileName: 'hatchet-empty.yaml', source: '{}\n' }) } }],
  build: { ssr: 'tests/helpers/mail-retry-harness.ts', outDir: '.output/test-mail-retry', emptyOutDir: true,
    rollupOptions: { external: [/^@hatchet-dev\//], output: { entryFileNames: 'harness.mjs' } } },
})
