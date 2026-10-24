import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createOwnedFixtureDependencies } from './owned-fixture-dependencies.mjs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'

export function createLintFixture(repositoryRoot: string, toolingRoot = repositoryRoot) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'sparra-lint-canary-'))
  const cleanup = () => {
    const target = resolve(fixtureRoot)
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('sparra-lint-canary-')) throw new Error('Refusing non-owned canary cleanup')
    rmSync(target, { recursive: true, force: true })
  }
  try {
    mkdirSync(join(fixtureRoot, 'src'))
    cpSync(join(toolingRoot, '.oxlintrc.json'), join(fixtureRoot, '.oxlintrc.json'))
    mkdirSync(join(fixtureRoot, 'tools', 'oxlint'), { recursive: true })
    cpSync(join(toolingRoot, 'tools', 'oxlint', 'anti-slop'), join(fixtureRoot, 'tools', 'oxlint', 'anti-slop'), { recursive: true })
    createOwnedFixtureDependencies(fixtureRoot, toolingRoot)
  } catch (error) { cleanup(); throw error }
  const canaryRoot = join(fixtureRoot, 'src', '.anti-slop-canary')
  mkdirSync(canaryRoot)
  const writeFixture = (name: string, source: string) => {
    const path = join(canaryRoot, name)
    writeFileSync(path, source)
    return relative(fixtureRoot, path).replaceAll('\\', '/')
  }
  try {
  const acceptedFiles = [
    writeFixture('boundaries.ts', "export function decode(input: unknown): string { return typeof input === 'string' ? input : ''; }\nexport const browser = typeof window !== 'undefined';\n"),
    writeFixture('service.test.ts', "import { makeMarketingService } from './marketing-service';\nvoid makeMarketingService;\n"),
  ]
  const rejectedFiles = [
    writeFixture('assertion.ts', 'declare const input: unknown;\ninterface User { id: string }\nexport const user = input as object as User;\n'),
    writeFixture('service.ts', "import { makeMarketingService } from './marketing-service';\nvoid makeMarketingService;\n"),
  ]
  return { root: fixtureRoot, acceptedFiles, rejectedFiles, cleanup }
  } catch (error) { cleanup(); throw error }
}
