import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { expect, test } from 'vitest'

test.each([[0, 1], [1, 1], [2, 1], [3, 1], [-1, 0]])('all four native groups run and retain aggregate failure (failed group %i)', (failedGroup, expected) => {
  const root = mkdtempSync(join(tmpdir(), 'sparra-ui-gate-'))
  try {
    mkdirSync(join(root, 'scripts'))
    const script = join(root, 'scripts', 'verify-ui-a11y.mjs')
    writeFileSync(script, readFileSync(resolve('scripts/verify-ui-a11y.mjs')))
    writeFileSync(join(root, 'scripts', 'native-test-phase.mjs'), readFileSync(resolve('scripts/native-test-phase.mjs')))
    // Replace only this owned fixture's preparation boundary; the production entry and phase stay real.
    writeFileSync(join(root, 'scripts', 'prepare-voice-source.mjs'), `import {appendFileSync,existsSync,mkdirSync,realpathSync,rmSync} from 'node:fs';import {join} from 'node:path';
export async function prepareVoiceSource({appRoot}){if(appRoot!==realpathSync(process.cwd()))throw Error('Wrong preparation root');mkdirSync('canary-voice-owner');appendFileSync('lifecycle.txt','prepare\\n');return {root:join(appRoot,'canary-voice-owner'),fixturePython:join(appRoot,'canary-python'),testEnvironment:{NLTK_DATA:join(appRoot,'canary-nltk'),HOME:join(appRoot,'canary-home')},tokenizerArchive:join(appRoot,'canary-tokenizer.zip'),assertIdentity:async()=>{if(!existsSync('canary-voice-owner'))throw Error('Retired before consumer');appendFileSync('lifecycle.txt','identity\\n')},retire:async()=>{rmSync('canary-voice-owner',{recursive:true});appendFileSync('lifecycle.txt','retire\\n')}}}
`)
    mkdirSync(join(root, 'node_modules', 'vitest'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'vitest', 'vitest.mjs'), `import {appendFileSync,existsSync,readFileSync} from 'node:fs';import {join} from 'node:path';
const expected={SPARRA_VOICE_TEST_ROOT:'canary-voice-owner',SPARRA_VOICE_FIXTURE_PYTHON:'canary-python',SPARRA_VOICE_NLTK_DATA:'canary-nltk',SPARRA_VOICE_TEST_HOME:'canary-home',SPARRA_VOICE_TOKENIZER_ARCHIVE:'canary-tokenizer.zip'};for(const [key,value]of Object.entries(expected))if(process.env[key]!==join(process.cwd(),value))throw Error('Missing native fixture environment '+key);if(!existsSync('canary-voice-owner'))throw Error('Voice retired before group');
const args=process.argv.slice(2),index=existsSync('groups.txt')?readFileSync('groups.txt','utf8').trimEnd().split('\\n').length:0;
appendFileSync('groups.txt',JSON.stringify(args)+'\\n');appendFileSync('lifecycle.txt',args.filter(value=>value.endsWith('.test.ts')).join(',')+'\\n');process.exitCode=index===${failedGroup}?1:0;`)
    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 })
    expect(result.error).toBeUndefined()
    expect(readFileSync(join(root, 'groups.txt'), 'utf8').trimEnd().split('\n').map(line => JSON.parse(line))).toEqual([
      ['run', '--config', 'vitest.integration.config.ts', 'tests/integration/magic-browser.test.ts', '--testNamePattern', 'compiled_magic_mailbox_signup_requires_browser_uv_passkey', '--maxWorkers=1'],
      ['run', '--config', 'vitest.integration.config.ts', 'tests/integration/marketing-browser.test.ts', '--maxWorkers=1'],
      ['run', '--config', 'vitest.integration.config.ts', 'tests/integration/workspace-browser.test.ts', '--maxWorkers=1'],
      ['run', '--config', 'vitest.integration.config.ts', 'tests/integration/sparra-browser.test.ts', '--maxWorkers=1'],
    ])
    expect(result.status).toBe(expected)
    expect(readFileSync(join(root, 'lifecycle.txt'), 'utf8')).toBe('prepare\nidentity\ntests/integration/magic-browser.test.ts\nidentity\nidentity\ntests/integration/marketing-browser.test.ts\nidentity\nidentity\ntests/integration/workspace-browser.test.ts\nidentity\nidentity\ntests/integration/sparra-browser.test.ts\nidentity\n'+(expected===0?'identity\nretire\n':''))
    expect(existsSync(join(root, 'canary-voice-owner'))).toBe(expected !== 0)
    if (expected === 0) {
      expect(result.stderr).toBe('')
    } else {
      expect(result.stderr).toContain('consumer resource cleanup is unconfirmed')
    }
  } finally {
    if (dirname(root) !== tmpdir() || !basename(root).startsWith('sparra-ui-gate-')) throw new Error('Non-owned UI gate cleanup')
    rmSync(root, { recursive: true, force: true })
  }
})
