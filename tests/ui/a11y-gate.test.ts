import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { expect, test } from 'vitest'

const script = resolve('scripts/verify-ui-a11y.mjs')
test.each([[1, 0, 1], [0, 1, 1], [0, 0, 0]])('both native groups run and retain aggregate failure (%i, %i)', (first, second, expected) => {
  const root = mkdtempSync(join(tmpdir(), 'sparra-ui-gate-'))
  try {
    mkdirSync(join(root, 'node_modules', 'vitest'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'vitest', 'vitest.mjs'), `import {appendFileSync} from 'node:fs'; const first=process.argv.includes('--testNamePattern'); appendFileSync('groups.txt', (first?'proof':'screens')+String.fromCharCode(10)); process.exitCode=first?${first}:${second};`)
    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 })
    expect(result.error).toBeUndefined()
    expect(readFileSync(join(root, 'groups.txt'), 'utf8')).toBe('proof\nscreens\n')
    expect(result.status).toBe(expected)
  } finally {
    if (dirname(root) !== tmpdir() || !basename(root).startsWith('sparra-ui-gate-')) throw new Error('Non-owned UI gate cleanup')
    rmSync(root, { recursive: true, force: true })
  }
})
