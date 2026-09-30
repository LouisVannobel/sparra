import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const dossier = join(project, '.superpowers/sdd/2026-09-10-functional-auth')
const output = join(dossier, 'task-9c-panel-fixture-dist')
if (resolve(process.cwd()) !== project || dirname(output) !== dossier || existsSync(output) && realpathSync(output) !== output) throw new Error('Owned panel output target rejected')
const result = spawnSync(process.execPath, [join(project, 'node_modules/vite/bin/vite.js'), 'build', '--config', 'tests/helpers/vite.first-google-panel.config.ts'], {
  cwd: project, windowsHide: true, timeout: 60000, stdio: 'inherit',
  env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, NODE_ENV: 'production' },
})
if (result.error) process.stderr.write('Owned panel fixture build failed\n')
process.exitCode = result.status ?? 1
