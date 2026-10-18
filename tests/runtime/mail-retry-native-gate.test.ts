import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { assertMailRetryBuildConfig, assertMailRetryQualification, assertMailRetryReport, readMailRetryBuildIdentity } from '../../scripts/native-coverage-inputs.mjs'

const roots: string[] = []
const repositoryRoot = process.cwd()
const parentName = 'I3 one owned native retry fixture: retained A/B, transient C, expired E, exhausted D'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sparra-mail-retry-gate-')); roots.push(root)
  const run = join(root, 'coverage', '.native-' + randomUUID())
  const build = join(run, 'mail-retry-build'), evidence = join(run, 'mail-retry-evidence')
  mkdirSync(build, { recursive: true }); mkdirSync(evidence)
  const startedAt = Date.now(), evidenceId = randomUUID()
  const paths = ['src/modules/auth/mail-worker.server.ts', 'src/modules/auth/mail-hatchet.server.ts', 'src/modules/auth/plunk.server.ts',
    'tests/helpers/mail-retry-harness.ts', 'tests/helpers/mail-retry-observation.ts', 'tests/helpers/vite.mail-retry.config.ts',
    'tests/integration/mail-retry-native.test.ts', '.output/worker/index.mjs',
    ...['harness.mjs', 'hatchet-empty.yaml'].map(name => relative(root, join(build, name)).replaceAll('\\', '/'))]
  for (const path of paths) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), 'synthetic admission canary ' + path + '\n')
  }
  const beforeLaunchSha256 = Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')]))
  const report = { success: true, startTime: startedAt, numTotalTests: 1, numPassedTests: 1, numPendingTests: 0, numTodoTests: 0,
    numFailedTests: 0, numFailedTestSuites: 0, numPendingTestSuites: 0,
    testResults: [{ name: join(root, 'tests/integration/mail-retry-native.test.ts').replaceAll('\\', '/'), startTime: startedAt,
      status: 'passed', message: '', assertionResults: [{ fullName: parentName, status: 'passed', failureMessages: [] }] }] }
  const receipt = { evidenceId, beforeLaunchSha256, passed: true,
    normalStop: { elapsedMs: 1, processClosed: true, receipt: { type: 'stopped', nativeStartState: 'resolved', nativeStopState: 'resolved', pendingHooks: 0, commandsJoined: true } },
    cleanup: { forced: false, processCode: 0, exactOutputEmpty: true,
      receipts: { rowLockReleased: true, childClosed: true, webPoolClosed: true, engineRemoved: true, storesRemoved: true, tlsClosedAndMaterialsRemoved: true } } }
  const reportPath = join(run, 'mail-retry-qualification.json'), receiptPath = join(evidence, 'task-7-i3-native-' + evidenceId + '.json')
  writeFileSync(reportPath, JSON.stringify(report)); writeFileSync(receiptPath, JSON.stringify(receipt))
  return { root, run, build, evidence, startedAt, paths, report, receipt, reportPath, receiptPath }
}

function buildFixture() {
  const item = fixture(), config = join(item.root, 'tests/helpers/vite.mail-retry.config.ts')
  writeFileSync(join(item.root, 'package.json'), JSON.stringify({ name: 'synthetic-i3-build', private: true, type: 'module' }))
  mkdirSync(join(item.root, 'scripts'))
  writeFileSync(join(item.root, 'scripts/native-coverage-inputs.mjs'), readFileSync(join(repositoryRoot, 'scripts/native-coverage-inputs.mjs')))
  writeFileSync(config, readFileSync(join(repositoryRoot, 'tests/helpers/vite.mail-retry.config.ts')))
  writeFileSync(join(item.root, 'tests/helpers/mail-retry-harness.ts'), 'export const sentinel = import.meta.env.VITE_SPARRA_I3_FIXTURE_SENTINEL\n')
  mkdirSync(join(item.root, 'public'))
  writeFileSync(join(item.root, 'public/i3-public-copy-marker.txt'), 'owned public fixture marker\n')
  writeFileSync(join(item.root, '.env'), 'VITE_SPARRA_I3_FIXTURE_SENTINEL=owned-root-env-marker\n')
  writeFileSync(join(item.root, '.env.production'), 'VITE_SPARRA_I3_FIXTURE_SENTINEL=owned-production-env-marker\n')
  symlinkSync(join(repositoryRoot, 'node_modules'), join(item.root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  const metadata: unknown = JSON.parse(readFileSync(join(repositoryRoot, 'node_modules/vite/package.json'), 'utf8'))
  expect(metadata).toMatchObject({ name: 'vite', version: '8.2.2' })
  const build = (output = item.build) => spawnSync(process.execPath, [join(repositoryRoot, 'node_modules/vite/bin/vite.js'), 'build', '--config', config, '--outDir', output], {
    cwd: item.root, encoding: 'utf8', windowsHide: true, timeout: 12000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
      SPARRA_MAIL_RETRY_BUILD_DIR: item.build },
  })
  return { ...item, buildProcess: build }
}

function buildAdmissionFixture() {
  const item = fixture(), root = realpathSync(item.root), build = realpathSync(item.build), run = dirname(build)
  const config: Parameters<typeof assertMailRetryBuildConfig>[2] = { root, envDir: false, build: { outDir: build, copyPublicDir: false } }
  writeFileSync(join(build, 'harness.mjs'), 'export const retained = true\n')
  writeFileSync(join(build, 'hatchet-empty.yaml'), '{}\n')
  for (const name of ['harness.mjs', 'hatchet-empty.yaml']) utimesSync(join(build, name), new Date(2000), new Date(2000))
  return { ...item, root, run, build, config, buildStartedAt: 2000 }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    if (dirname(root) !== tmpdir() || !basename(root).startsWith('sparra-mail-retry-gate-')) throw new Error('Refusing non-owned mail retry canary cleanup')
    rmSync(root, { recursive: true })
  }
})

test('mail retry build admission binds the resolved root output options and native run shape before writes', () => {
  const item = buildAdmissionFixture(), refusal = 'Native mail retry build ownership refused'
  expect(() => assertMailRetryBuildConfig(item.root, item.build, item.config)).not.toThrow()
  for (const output of [undefined, 'relative-build']) {
    expect(() => assertMailRetryBuildConfig(item.root, output, item.config)).toThrow(refusal)
  }
  const foreign = join(item.root, 'foreign'), witness = join(foreign, 'preserved.txt')
  mkdirSync(foreign); writeFileSync(witness, 'owned admission witness\n')
  for (const config of [
    { ...item.config, root: foreign },
    { ...item.config, build: { ...item.config.build, outDir: foreign } },
    { ...item.config, envDir: item.root },
    { ...item.config, build: { ...item.config.build, copyPublicDir: true } },
  ]) expect(() => assertMailRetryBuildConfig(item.root, item.build, config)).toThrow(refusal)
  for (const output of [join(item.run, 'foreign-build'), join(item.root, 'coverage/unowned/mail-retry-build'),
    join(item.root, 'foreign', basename(item.run), 'mail-retry-build')]) {
    mkdirSync(output, { recursive: true })
    expect(() => assertMailRetryBuildConfig(item.root, output, { ...item.config, build: { ...item.config.build, outDir: output } })).toThrow(refusal)
  }
  expect(readFileSync(witness, 'utf8')).toBe('owned admission witness\n')
  expect(readdirSync(item.build).sort()).toEqual(['harness.mjs', 'hatchet-empty.yaml'])
})

test.each(['coverage', 'run', 'output'] as const)('mail retry build admission refuses a linked %s without modifying its foreign witness', kind => {
  const item = buildAdmissionFixture(), foreign = join(item.root, 'foreign'), witness = join(foreign, 'preserved.txt')
  const link = kind === 'coverage' ? dirname(item.run) : kind === 'run' ? item.run : item.build
  mkdirSync(join(foreign, relative(link, item.build)), { recursive: true }); writeFileSync(witness, 'owned linked admission witness\n')
  rmSync(link, { recursive: true })
  symlinkSync(foreign, link, process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => assertMailRetryBuildConfig(item.root, item.build, item.config)).toThrow('Native mail retry build ownership refused')
  expect(readFileSync(witness, 'utf8')).toBe('owned linked admission witness\n')
})

test('mail retry build identity binds ordered resource bytes and exact YAML at the freshness boundary', () => {
  const item = buildAdmissionFixture()
  const expected = '4bbd8325132addfb5b382ab4ebb58c5f31943270e6e922f33ec579c5637c4dbb'
  expect(readMailRetryBuildIdentity(item.build, item.buildStartedAt)).toBe(expected)
  writeFileSync(join(item.build, 'harness.mjs'), 'export const retained = false\n')
  expect(readMailRetryBuildIdentity(item.build, item.buildStartedAt)).not.toBe(expected)
  writeFileSync(join(item.build, 'hatchet-empty.yaml'), '{ }\n')
  expect(() => readMailRetryBuildIdentity(item.build, item.buildStartedAt)).toThrow('Native mail retry configuration changed')
})

test.each(['missing', 'extra', 'stale', 'empty', 'oversized', 'directory', 'linked'] as const)('mail retry build identity refuses %s resources without altering a witness', kind => {
  const item = buildAdmissionFixture(), target = join(item.build, 'harness.mjs'), foreign = join(item.root, 'foreign')
  mkdirSync(foreign); const witness = join(foreign, 'preserved.txt'); writeFileSync(witness, 'owned resource witness\n')
  switch (kind) {
    case 'missing': rmSync(target); break
    case 'extra': writeFileSync(join(item.build, 'unreviewed.mjs'), 'owned extra\n'); break
    case 'stale': utimesSync(target, new Date(1000), new Date(1000)); break
    case 'empty': writeFileSync(target, ''); break
    case 'oversized': truncateSync(target, 268435457); break
    case 'directory': rmSync(target); mkdirSync(target); break
    case 'linked': rmSync(target); symlinkSync(foreign, target, process.platform === 'win32' ? 'junction' : 'dir'); break
  }
  expect(() => readMailRetryBuildIdentity(item.build, item.buildStartedAt)).toThrow('Native mail retry build')
  expect(readFileSync(witness, 'utf8')).toBe('owned resource witness\n')
})

test('mail retry gate admits one exact parent with a fresh source-bound unforced receipt', () => {
  // Synthetic admission records qualify only the gate, never A/B/C/E/D behavior.
  const item = fixture()
  expect(() => assertMailRetryReport(item.report, item.root, item.startedAt)).not.toThrow()
  expect(() => assertMailRetryQualification(item.reportPath, item.root, item.startedAt, item.evidence)).not.toThrow()
})

test('mail retry gate refuses missing disabled adverse foreign and stale parent reports', () => {
  const item = fixture(), refusal = 'Native mail retry requires its exact one passing parent'
  for (const field of ['numTotalTests', 'numPassedTests', 'numPendingTests', 'numTodoTests', 'numFailedTests', 'numFailedTestSuites', 'numPendingTestSuites'] as const) {
    expect(() => assertMailRetryReport({ ...item.report, [field]: item.report[field] + 1 }, item.root, item.startedAt), field).toThrow(refusal)
  }
  for (const mutate of [
    (report: typeof item.report) => { report.success = false },
    (report: typeof item.report) => { report.startTime = item.startedAt - 1 },
    (report: typeof item.report) => { report.testResults = [] },
    (report: typeof item.report) => { report.testResults.push(structuredClone(report.testResults[0]!)) },
    (report: typeof item.report) => { report.testResults[0]!.name = join(item.root, 'tests/foreign.test.ts') },
    (report: typeof item.report) => { report.testResults[0]!.startTime = item.startedAt - 1 },
    (report: typeof item.report) => { report.testResults[0]!.status = 'failed' },
    (report: typeof item.report) => { report.testResults[0]!.message = 'owned failure' },
    (report: typeof item.report) => { report.testResults[0]!.assertionResults = [] },
    (report: typeof item.report) => { report.testResults[0]!.assertionResults.push(structuredClone(report.testResults[0]!.assertionResults[0]!)) },
    (report: typeof item.report) => { report.testResults[0]!.assertionResults[0]!.fullName = 'unreviewed I3 replacement' },
    (report: typeof item.report) => { report.testResults[0]!.assertionResults[0]!.status = 'skipped' },
  ]) {
    const report = structuredClone(item.report); mutate(report)
    expect(() => assertMailRetryReport(report, item.root, item.startedAt)).toThrow(refusal)
  }
  const failure = structuredClone(item.report)
  expect(() => assertMailRetryReport({ ...failure, testResults: [{ ...failure.testResults[0], assertionResults: [{ fullName: parentName, status: 'passed', failureMessages: ['failure'] }] }] }, item.root, item.startedAt)).toThrow(refusal)
  expect(() => assertMailRetryReport(item.report, join(item.root, 'foreign'), item.startedAt)).toThrow(refusal)
})

test('mail retry gate refuses stale absent oversized linked and duplicate receipts', () => {
  const item = fixture(), bytes = readFileSync(item.receiptPath)
  for (const arrange of [
    () => { writeFileSync(item.receiptPath, bytes); utimesSync(item.receiptPath, new Date(0), new Date(0)) },
    () => { writeFileSync(item.receiptPath, '') },
    () => { writeFileSync(item.receiptPath, bytes); truncateSync(item.receiptPath, 268435457) },
    () => { symlinkSync(item.build, item.receiptPath, process.platform === 'win32' ? 'junction' : 'dir') },
  ]) {
    rmSync(item.receiptPath); arrange()
    expect(() => assertMailRetryQualification(item.reportPath, item.root, item.startedAt, item.evidence)).toThrow('Native mail retry report or receipt is invalid')
    rmSync(item.receiptPath, { recursive: true }); writeFileSync(item.receiptPath, bytes)
  }
  const extra = join(item.evidence, 'task-7-i3-native-' + randomUUID() + '.json')
  writeFileSync(extra, bytes)
  expect(() => assertMailRetryQualification(item.reportPath, item.root, item.startedAt, item.evidence)).toThrow('Native mail retry requires exactly one fresh receipt')
  rmSync(extra); rmSync(item.receiptPath)
  expect(() => assertMailRetryQualification(item.reportPath, item.root, item.startedAt, item.evidence)).toThrow('Native mail retry requires exactly one fresh receipt')
  expect(existsSync(join(item.root, '.superpowers'))).toBe(false)
  const historical = join(item.root, '.superpowers/sdd/2026-09-10-functional-auth')
  mkdirSync(historical, { recursive: true }); writeFileSync(join(historical, basename(item.receiptPath)), bytes)
  expect(() => assertMailRetryQualification(item.reportPath, item.root, item.startedAt, item.evidence)).toThrow('Native mail retry requires exactly one fresh receipt')
})

test('mail retry gate refuses changed sources resources cleanup and forced or incomplete drain', () => {
  const item = fixture()
  for (const path of item.paths) {
    const target = join(item.root, path), original = readFileSync(target)
    writeFileSync(target, Buffer.concat([original, Buffer.from('changed')]))
    expect(() => assertMailRetryQualification(item.reportPath, item.root, item.startedAt, item.evidence), path).toThrow('Native mail retry receipt source changed')
    writeFileSync(target, original)
  }
  for (const mutate of [
    (receipt: typeof item.receipt) => { receipt.passed = false },
    (receipt: typeof item.receipt) => { receipt.evidenceId = randomUUID() },
    (receipt: typeof item.receipt) => { receipt.cleanup.forced = true },
    (receipt: typeof item.receipt) => { receipt.cleanup.processCode = 1 },
    (receipt: typeof item.receipt) => { receipt.cleanup.exactOutputEmpty = false },
    (receipt: typeof item.receipt) => { receipt.cleanup.receipts.engineRemoved = false },
    (receipt: typeof item.receipt) => { receipt.normalStop.elapsedMs = 15001 },
    (receipt: typeof item.receipt) => { receipt.normalStop.processClosed = false },
    (receipt: typeof item.receipt) => { receipt.normalStop.receipt.nativeStopState = 'rejected' },
    (receipt: typeof item.receipt) => { receipt.normalStop.receipt.pendingHooks = 1 },
    (receipt: typeof item.receipt) => { receipt.normalStop.receipt.commandsJoined = false },
  ]) {
    const receipt = structuredClone(item.receipt); mutate(receipt); writeFileSync(item.receiptPath, JSON.stringify(receipt))
    expect(() => assertMailRetryQualification(item.reportPath, item.root, item.startedAt, item.evidence)).toThrow()
  }
})

test('public Vite fixture build excludes owned public and dotenv markers from its exact two resources', async () => {
  const item = buildFixture(), result = item.buildProcess()
  expect(result.error).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0)
  expect(readdirSync(item.build).sort()).toEqual(['harness.mjs', 'hatchet-empty.yaml'])
  expect(readFileSync(join(item.build, 'hatchet-empty.yaml'), 'utf8')).toBe('{}\n')
  const generated: unknown = await import(pathToFileURL(join(item.build, 'harness.mjs')).href)
  expect(generated).toHaveProperty('sentinel', undefined)
  const output = readFileSync(join(item.build, 'harness.mjs'), 'utf8')
  expect(output).not.toContain('owned-root-env-marker'); expect(output).not.toContain('owned-production-env-marker')
  expect(readFileSync(join(item.root, 'public/i3-public-copy-marker.txt'), 'utf8')).toBe('owned public fixture marker\n')
  expect(readFileSync(join(item.root, '.env'), 'utf8')).toBe('VITE_SPARRA_I3_FIXTURE_SENTINEL=owned-root-env-marker\n')
  expect(readFileSync(join(item.root, '.env.production'), 'utf8')).toBe('VITE_SPARRA_I3_FIXTURE_SENTINEL=owned-production-env-marker\n')
}, 15000)

test.each(['foreign output', 'linked output'] as const)('public Vite fixture build refuses %s before modifying its owned witness', kind => {
  const item = buildFixture(), foreign = join(item.root, 'foreign-output'), witness = join(foreign, 'preserved.txt')
  mkdirSync(foreign); writeFileSync(witness, 'owned refusal witness\n')
  if (kind === 'linked output') {
    rmSync(item.build, { recursive: true })
    symlinkSync(foreign, item.build, process.platform === 'win32' ? 'junction' : 'dir')
  }
  const result = item.buildProcess(kind === 'foreign output' ? foreign : item.build)
  expect(result.error).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(1)
  expect(result.stdout + result.stderr).toContain('Native mail retry build ownership refused')
  expect(readFileSync(witness, 'utf8')).toBe('owned refusal witness\n')
}, 15000)
