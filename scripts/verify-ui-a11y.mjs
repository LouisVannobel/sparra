import { spawnSync } from 'node:child_process'

// Each group owns disposable stores; keep them sequential and retain every failure.
const groups = [
  ['tests/integration/magic-browser.test.ts', '--testNamePattern', 'compiled_magic_mailbox_signup_requires_browser_uv_passkey'],
  ['tests/integration/marketing-browser.test.ts', 'tests/integration/workspace-browser.test.ts', 'tests/integration/sparra-browser.test.ts'],
]
let failed = false
for (const group of groups) {
  const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.integration.config.ts', ...group, '--maxWorkers=1'], { stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) failed = true
}
process.exitCode = failed ? 1 : 0
