import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [{ name: 'auth-mail-native-config', generateBundle() { this.emitFile({ type: 'asset', fileName: 'hatchet-empty.yaml', source: '{}\n' }) } }],
  build: { ssr: 'src/worker.ts', outDir: '.output/worker', emptyOutDir: true,
    // The SDK heartbeat resolves its adjacent worker-thread module at runtime.
    // Keep the installed pinned package intact; do not flatten/bundle its files.
    rollupOptions: { external: [/^@hatchet-dev\//], output: { entryFileNames: 'index.mjs' } } },
})
