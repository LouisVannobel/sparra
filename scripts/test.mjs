import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { admitCommonGeometry, assertDirectory, assertRunTree, readNativeBlob, sourceIdentity } from './native-coverage-inputs.mjs'

const startedAt = Date.now()
const root = realpathSync(process.cwd())
const coverageDirectory = join(root, 'coverage')
const publication = join(coverageDirectory, 'coverage-final.json')
const runId = randomUUID()
const runDirectory = join(coverageDirectory, '.native-' + runId)
const pending = join(coverageDirectory, '.coverage-final-' + runId + '.pending')
const vitestCli = join(root, 'node_modules/vitest/vitest.mjs')
let coverageOwner, runOwner, pendingOwner, frozenIdentity, version
const blobDigests = new Map()

function assertOwnedRun() {
  if (realpathSync(process.cwd()) !== root || dirname(runDirectory) !== coverageDirectory
    || basename(runDirectory) !== '.native-' + runId) throw new Error('Native coverage root changed')
  assertDirectory(coverageDirectory, coverageOwner)
  assertDirectory(runDirectory, runOwner)
  assertRunTree(runDirectory)
}

function assertFrozenIdentity() {
  assertOwnedRun()
  if (sourceIdentity(root) !== frozenIdentity) throw new Error('Native coverage source or build changed')
}

function runPhase(name, args, timeout) {
  assertFrozenIdentity()
  process.stdout.write('[tests] ' + name + '\n')
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true, timeout })
  if (result.error || result.signal || result.status !== 0) throw new Error('Native coverage ' + name + ' failed')
  assertFrozenIdentity()
}

function admitBlob(name) {
  const { table, coverage, digest } = readNativeBlob(join(runDirectory, 'blobs', name + '.json'), name, root, startedAt, version)
  const admittedDigest = blobDigests.get(name)
  if (admittedDigest && admittedDigest !== digest) throw new Error('Native coverage admitted blob changed')
  if (!admittedDigest) blobDigests.set(name, digest)
  return { table, coverage }
}

function admitBlobs() {
  assertFrozenIdentity()
  if (readdirSync(join(runDirectory, 'blobs')).sort().join('|') !== 'activity.json|ordinary.json') {
    throw new Error('Native coverage requires exactly two current blobs')
  }
  admitCommonGeometry(admitBlob('ordinary'), admitBlob('activity'))
}

function retireRun() {
  assertOwnedRun()
  rmSync(runDirectory, { recursive: true })
}

try {
  if (!existsSync(coverageDirectory)) mkdirSync(coverageDirectory, { mode: 0o700 })
  coverageOwner = assertDirectory(coverageDirectory)
  if (existsSync(publication)) {
    const previous = lstatSync(publication)
    if (!previous.isFile() || previous.isSymbolicLink()) throw new Error('Unsafe existing coverage publication')
    rmSync(publication)
  }
  if (process.argv.length !== 2 || dirname(fileURLToPath(import.meta.url)) !== join(root, 'scripts')) throw new Error('Use the fixed native test consumer from its source root')
  const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  version = JSON.parse(readFileSync(join(root, 'node_modules/vitest/package.json'), 'utf8')).version
  const providerVersion = JSON.parse(readFileSync(join(root, 'node_modules/@vitest/coverage-istanbul/package.json'), 'utf8')).version
  if (process.version !== 'v' + metadata.engines.node || metadata.devDependencies.vitest !== version
    || metadata.devDependencies['@vitest/coverage-istanbul'] !== providerVersion || version !== providerVersion) throw new Error('Native coverage runtime pins mismatch')
  if (!lstatSync(join(root, '.output/server/index.mjs')).isFile()) throw new Error('Native coverage requires the frozen web build')
  mkdirSync(runDirectory, { mode: 0o700 }); runOwner = assertDirectory(runDirectory)
  for (const directory of ['blobs', 'ordinary', 'activity', 'final']) mkdirSync(join(runDirectory, directory), { mode: 0o700 })
  frozenIdentity = sourceIdentity(root)
  runPhase('prerequisites', [join(root, 'scripts/test-prerequisites.mjs')], 300000)
  const blobs = join(runDirectory, 'blobs')
  runPhase('ordinary', [vitestCli, 'run', '--config', 'vitest.config.ts', '--maxWorkers=1', '--coverage', '--reporter=default', '--reporter=blob',
    '--outputFile.blob=' + join(blobs, 'ordinary.json'), '--coverage.reportsDirectory=' + join(runDirectory, 'ordinary')], 600000)
  admitBlob('ordinary')
  runPhase('activity', [vitestCli, 'run', '--config', 'vitest.integration.config.ts', 'tests/integration/sparra-activity.test.ts', '--maxWorkers=1', '--coverage', '--reporter=default', '--reporter=blob',
    '--outputFile.blob=' + join(blobs, 'activity.json'), '--coverage.reportsDirectory=' + join(runDirectory, 'activity')], 600000)
  admitBlob('activity')
  admitBlobs()
  runPhase('merge', [vitestCli, '--config', 'vitest.config.ts', '--coverage', '--mergeReports=' + blobs, '--reporter=default',
    '--coverage.reportsDirectory=' + join(runDirectory, 'final')], 120000)
  admitBlobs()
  const final = join(runDirectory, 'final/coverage-final.json'), finalStat = lstatSync(final)
  if (!finalStat.isFile() || finalStat.isSymbolicLink() || finalStat.mtimeMs < startedAt || finalStat.size === 0 || finalStat.size > 268435456) throw new Error('Native coverage final report is invalid')
  const bytes = readFileSync(final), map = JSON.parse(bytes.toString('utf8'))
  if (!map || typeof map !== 'object' || Array.isArray(map) || !Object.keys(map).length) throw new Error('Native coverage final map is empty')
  const descriptor = openSync(pending, 'wx', 0o600)
  try {
    pendingOwner = fstatSync(descriptor)
    writeFileSync(descriptor, bytes)
  } finally { closeSync(descriptor) }
  retireRun()
  assertDirectory(coverageDirectory, coverageOwner)
  if (sourceIdentity(root) !== frozenIdentity || existsSync(publication)) throw new Error('Native coverage publication identity changed')
  renameSync(pending, publication)
  process.stdout.write('[tests] Native coverage published after retirement\n')
} catch (error) {
  try {
    assertDirectory(coverageDirectory, coverageOwner)
    if (pendingOwner && existsSync(pending)) {
      const current = lstatSync(pending)
      if (current.isFile() && !current.isSymbolicLink() && current.dev === pendingOwner.dev && current.ino === pendingOwner.ino) rmSync(pending)
    }
    if (runOwner && existsSync(runDirectory)) {
      assertDirectory(runDirectory, runOwner)
      // Node removes descendant links themselves; it never follows them.
      rmSync(runDirectory, { recursive: true })
    }
  } catch {
    process.stderr.write('Native coverage failed to retire owned output\n')
  }
  process.stderr.write((error instanceof Error ? error.message : 'Native coverage failed') + '\n')
  process.exitCode = 1
}
