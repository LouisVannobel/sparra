import { defineConfig } from 'vite'
import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

export default defineConfig({
  envDir: false,
  plugins: [{ name: 'mail-retry-owned-config',
    configResolved(config) {
      const root = realpathSync(process.cwd()), output = process.env.SPARRA_MAIL_RETRY_BUILD_DIR
      if (!output || !isAbsolute(output) || resolve(config.root) !== root || realpathSync(config.root) !== root
        || resolve(config.build.outDir) !== output || config.envDir !== false || config.build.copyPublicDir !== false) throw new Error('Native mail retry build ownership refused')
      const run = dirname(output)
      if (dirname(run) !== join(root, 'coverage') || !/^\.native-[0-9a-f-]{36}$/.test(basename(run))
        || basename(output) !== 'mail-retry-build') throw new Error('Native mail retry build ownership refused')
      for (const path of [root, join(root, 'coverage'), run, output]) {
        const stat = lstatSync(path)
        if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) throw new Error('Native mail retry build ownership refused')
      }
    },
    generateBundle() { this.emitFile({ type: 'asset', fileName: 'hatchet-empty.yaml', source: '{}\n' }) },
  }],
  build: { ssr: 'tests/helpers/mail-retry-harness.ts', outDir: '.output/test-mail-retry', emptyOutDir: true, copyPublicDir: false,
    rollupOptions: { external: [/^@hatchet-dev\//], output: { entryFileNames: 'harness.mjs' } } },
})
