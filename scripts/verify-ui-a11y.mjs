import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { prepareVoiceSource } from './prepare-voice-source.mjs'
import { runNativePhase } from './native-test-phase.mjs'

// Each browser file owns a process and disposable stores; keep them sequential and retain every failure.
const groups = [
  ['tests/integration/magic-browser.test.ts', '--testNamePattern', 'compiled_magic_mailbox_signup_requires_browser_uv_passkey'],
  ['tests/integration/marketing-browser.test.ts'],
  ['tests/integration/workspace-browser.test.ts'],
  ['tests/integration/sparra-browser.test.ts'],
]
let failed = false
let voice, consumerCleanupUnknown = false
try {
  const root = realpathSync(process.cwd())
  voice = await prepareVoiceSource({ appRoot: root })
  const env = { ...process.env, SPARRA_VOICE_TEST_ROOT: voice.root, SPARRA_VOICE_FIXTURE_PYTHON: voice.fixturePython, SPARRA_VOICE_NLTK_DATA: voice.testEnvironment.NLTK_DATA, SPARRA_VOICE_TEST_HOME: voice.testEnvironment.HOME, SPARRA_VOICE_TOKENIZER_ARCHIVE: voice.tokenizerArchive }
  for (const group of groups) {
    await voice.assertIdentity()
    const result = await runNativePhase(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.integration.config.ts', ...group, '--maxWorkers=1'], { cwd: root, env, timeout: 600000 })
    if (!result.cleanExit) { failed = true; consumerCleanupUnknown = true }
    await voice.assertIdentity()
  }
} catch {
  failed = true
  process.stderr.write('Native UI Voice preparation or identity failed\n')
} finally {
  if (consumerCleanupUnknown && voice) process.stderr.write('Native UI Voice scope retained: consumer resource cleanup is unconfirmed\n')
  else try { await voice?.assertIdentity(); await voice?.retire() }
  catch { failed = true; process.stderr.write('Native UI Voice failed to retire owned output\n') }
}
process.exitCode = failed ? 1 : 0
