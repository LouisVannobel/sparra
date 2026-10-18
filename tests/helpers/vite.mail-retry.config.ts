import { defineConfig } from 'vite'
import { realpathSync } from 'node:fs'
import { assertMailRetryBuildConfig } from '../../scripts/native-coverage-inputs.mjs'

export default defineConfig({
  envDir: false,
  plugins: [{ name: 'mail-retry-owned-config',
    configResolved(config) {
      assertMailRetryBuildConfig(realpathSync(process.cwd()), process.env.SPARRA_MAIL_RETRY_BUILD_DIR, config)
    },
    generateBundle() { this.emitFile({ type: 'asset', fileName: 'hatchet-empty.yaml', source: '{}\n' }) },
  }],
  build: { ssr: 'tests/helpers/mail-retry-entry.ts', outDir: '.output/test-mail-retry', emptyOutDir: true, copyPublicDir: false,
    rollupOptions: { external: [/^@hatchet-dev\//], output: { entryFileNames: 'harness.mjs' } } },
})
