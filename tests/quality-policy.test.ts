import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, dirname, basename } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterAll, beforeAll, expect, test } from 'vitest'

const repositoryRoot = process.cwd()
const fixtureRoot = mkdtempSync(join(repositoryRoot, 'src', '.anti-slop-canary-'))
const oxlint = join(repositoryRoot, 'node_modules', 'oxlint', 'bin', 'oxlint')
let acceptedFiles: string[], rejectedFiles: string[]

function writeFixture(name: string, source: string): string {
  const path = join(fixtureRoot, name)
  writeFileSync(path, source)
  return relative(repositoryRoot, path).replaceAll('\\', '/')
}
function runOxlint(files: string[]) {
  return spawnSync(process.execPath, [oxlint, '--threads=1', '--format', 'json', ...files], {
    cwd: repositoryRoot, encoding: 'utf8', windowsHide: true, timeout: 15000,
  })
}
beforeAll(() => {
  acceptedFiles = [
    writeFixture('boundaries.ts', "export function decode(input: unknown): string { return typeof input === 'string' ? input : ''; }\nexport const browser = typeof window !== 'undefined';\n"),
    writeFixture('service.test.ts', "import { makeMarketingService } from './marketing-service';\nvoid makeMarketingService;\n"),
  ]
  rejectedFiles = [
    writeFixture('assertion.ts', 'declare const input: unknown;\ninterface User { id: string }\nexport const user = input as object as User;\n'),
    writeFixture('service.ts', "import { makeMarketingService } from './marketing-service';\nvoid makeMarketingService;\n"),
  ]
})
afterAll(() => {
  const target = resolve(fixtureRoot)
  if (dirname(target) !== join(repositoryRoot, 'src') || !basename(target).startsWith('.anti-slop-canary-')) throw new Error('Refusing non-owned canary cleanup')
  rmSync(target, { recursive: true, force: true })
})

test('accepts narrowed boundaries and test-only service constructors', () => {
  const result = runOxlint(acceptedFiles)
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr || result.stdout).toBe(0)
  expect(JSON.parse(result.stdout).diagnostics).toEqual([])
})

test.each([
  [0, 'anti-slop(no-chained-type-assertions)'],
  [1, 'anti-slop-effect(no-service-constructor-imports)'],
])('rejects runtime canary %i with its selected rule', (index, expectedCode) => {
  const result = runOxlint([rejectedFiles[index]!])
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr || result.stdout).toBe(1)
  const report = JSON.parse(result.stdout)
  expect(report.diagnostics.map((item: { code: string }) => item.code)).toContain(expectedCode)
  expect(report.diagnostics.every((item: { code: string }) => item.code.startsWith('anti-slop'))).toBe(true)
  expect(report.diagnostics.every((item: { filename: string }) => item.filename.replaceAll('\\', '/') === rejectedFiles[index])).toBe(true)
})
