import { afterEach, expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm, rmdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { workerOciFixture } from '../helpers/migrator-oci-fixture'
import { workerSourceManifest } from '../../scripts/worker-source-manifest.mjs'
import { verifyWorkerArtifact } from '../../scripts/verify-worker-release.mjs'

const execute = promisify(execFile), directories: string[] = []
const commit = 'a'.repeat(40)
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
async function fixture(input: Parameters<typeof workerOciFixture>[0] = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sparra-worker-receipt-')); directories.push(directory)
  const image = await workerOciFixture(input), sbom = JSON.stringify(image.sbom)
  const receipt = { ...await workerSourceManifest(), commit, image_id: image.imageId, platform: 'linux/amd64',
    archive_sha256: hash(image.archive), sbom_sha256: hash(sbom), run_id: 'synthetic-worker-run',
    checks: { closure: true, registration: true, clean_exit: true, cleanup: true, archive_reload: false } }
  await writeFile(join(directory, 'worker-image.tar'), image.archive)
  await writeFile(join(directory, 'worker-sbom.spdx.json'), sbom)
  await writeFile(join(directory, 'worker-receipt.json'), JSON.stringify(receipt))
  return { directory, receipt }
}
type Receipt = Awaited<ReturnType<typeof fixture>>['receipt']
async function save(directory: string, receipt: Receipt) {
  await writeFile(join(directory, 'worker-receipt.json'), JSON.stringify(receipt))
}
async function invoke(script: string, args: string[]) {
  try {
    const result = await execute(process.execPath, [script, ...args], { windowsHide: true, timeout: 10000 })
    return { code: 0, stdout: result.stdout, stderr: result.stderr }
  } catch { return { code: 1, stdout: '', stderr: '' } }
}
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    const target = resolve(directory)
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('sparra-worker-receipt-')) throw new Error('Non-owned worker fixture cleanup')
    await rm(target, { recursive: true })
  }
})

test('worker candidate binds the exact source archive and Trivy subject before any load', async () => {
  const { directory, receipt } = await fixture()
  await expect(verifyWorkerArtifact(directory, commit, 'candidate')).resolves.toEqual(receipt)
  await expect(verifyWorkerArtifact(directory, commit, 'release')).rejects.toThrow('Invalid worker artifact')
  receipt.checks.archive_reload = true; await save(directory, receipt)
  await expect(verifyWorkerArtifact(directory, commit, 'release')).resolves.toEqual(receipt)
  await expect(verifyWorkerArtifact(directory, commit, 'candidate')).rejects.toThrow('Invalid worker artifact')
})
test.each(['lock_sha256', 'dockerfile_sha256', 'source_sha256', 'archive_sha256', 'sbom_sha256'] as const)('worker receipt refuses mismatched %s', async key => {
  const { directory, receipt } = await fixture(); receipt[key] = 'c'.repeat(64); await save(directory, receipt)
  await expect(verifyWorkerArtifact(directory, commit, 'candidate')).rejects.toThrow('Invalid worker artifact')
})
test.each(['closure', 'registration', 'clean_exit', 'cleanup'] as const)('worker receipt refuses an unperformed %s', async key => {
  const { directory, receipt } = await fixture(); receipt.checks[key] = false; await save(directory, receipt)
  await expect(verifyWorkerArtifact(directory, commit, 'candidate')).rejects.toThrow('Invalid worker artifact')
})
test('worker transport tampering is refused even before decoding its carrier', async () => {
  const { directory } = await fixture()
  await writeFile(join(directory, 'worker-image.tar'), 'synthetic altered archive')
  await expect(verifyWorkerArtifact(directory, commit, 'candidate')).rejects.toThrow('Invalid worker artifact')
})
test('worker transport with an updated receipt hash still requires an actual bounded OCI archive', async () => {
  const { directory, receipt } = await fixture(), replacement = Buffer.from('synthetic non-tar')
  await writeFile(join(directory, 'worker-image.tar'), replacement); receipt.archive_sha256 = hash(replacement); await save(directory, receipt)
  await expect(verifyWorkerArtifact(directory, commit, 'candidate')).rejects.toThrow()
})
test.each(['wrong-user', 'wrong-entrypoint', 'wrong-workdir', 'wrong-platform', 'missing-layer', 'wrong-layer-size', 'wrong-config-id'] as const)('worker archive refuses %s', async mutation => {
  const { directory } = await fixture({ mutation })
  await expect(verifyWorkerArtifact(directory, commit, 'candidate')).rejects.toThrow()
})
test('worker receipt cannot select another immutable image or a mutable tag', async () => {
  const { directory, receipt } = await fixture()
  receipt.image_id = 'sha256:' + 'd'.repeat(64); await save(directory, receipt)
  await expect(verifyWorkerArtifact(directory, commit, 'candidate')).rejects.toThrow()
  receipt.image_id = 'worker:latest'; await save(directory, receipt)
  await expect(verifyWorkerArtifact(directory, commit, 'candidate')).rejects.toThrow('Invalid worker artifact')
})
test.each(['subject', 'diff-id', 'header', 'annotation-type'] as const)('worker receipt refuses a correctly hashed but misbound SPDX %s', async mutation => {
  const { directory, receipt } = await fixture({ sbomMutation: mutation })
  await expect(verifyWorkerArtifact(directory, commit, 'candidate')).rejects.toThrow()
  expect(receipt.sbom_sha256).toBe(hash(await readFile(join(directory, 'worker-sbom.spdx.json'))))
})
test('worker artifact rejects extra entries and linked artifact paths or directories', async () => {
  const first = await fixture(); await writeFile(join(first.directory, 'unexpected'), '')
  await expect(verifyWorkerArtifact(first.directory, commit, 'candidate')).rejects.toThrow('Invalid worker artifact')
  const second = await fixture(), third = await fixture(), source = join(second.directory, 'worker-image.tar')
  await rm(source)
  await symlink(process.platform === 'win32' ? third.directory : join(third.directory, 'worker-image.tar'), source, process.platform === 'win32' ? 'junction' : 'file')
  await expect(verifyWorkerArtifact(second.directory, commit, 'candidate')).rejects.toThrow('Invalid worker artifact')
  const linked = await mkdtemp(join(tmpdir(), 'sparra-worker-receipt-')); directories.push(linked)
  await rmdir(linked); await symlink(third.directory, linked, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(verifyWorkerArtifact(linked, commit, 'candidate')).rejects.toThrow('Invalid worker artifact')
})
test('worker artifact rejects extra receipt fields missing checks and mismatched source versions', async () => {
  const { directory, receipt } = await fixture()
  await writeFile(join(directory, 'worker-receipt.json'), JSON.stringify({ ...receipt, unproved: true }))
  await expect(verifyWorkerArtifact(directory, commit, 'candidate')).rejects.toThrow('Invalid worker artifact')
  const { cleanup: _omitted, ...checks } = receipt.checks
  await writeFile(join(directory, 'worker-receipt.json'), JSON.stringify({ ...receipt, checks }))
  await expect(verifyWorkerArtifact(directory, commit, 'candidate')).rejects.toThrow('Invalid worker artifact')
  await writeFile(join(directory, 'worker-receipt.json'), JSON.stringify({ ...receipt, node_version: '24.0.0' }))
  await expect(verifyWorkerArtifact(directory, commit, 'candidate')).rejects.toThrow('Invalid worker artifact')
  await expect(verifyWorkerArtifact(directory, 'b'.repeat(40), 'candidate')).rejects.toThrow('Invalid worker artifact')
})
test('worker candidate inspector only returns an admitted immutable ID and never overwrites output', async () => {
  const { directory, receipt } = await fixture(), output = join(tmpdir(), basename(directory) + '.iid')
  try {
    const args = ['--directory', directory, '--commit', commit, '--output', output]
    expect((await invoke('scripts/inspect-worker-candidate.mjs', args)).code).toBe(0)
    expect(await readFile(output, 'utf8')).toBe(receipt.image_id + '\n')
    expect((await invoke('scripts/inspect-worker-candidate.mjs', args)).code).toBe(1)
  } finally { await rm(output, { force: true }) }
})
test('worker writer requires this checkout and emits only a strict temporary candidate', async () => {
  const { directory, receipt } = await fixture(), current = (await execute('git', ['rev-parse', 'HEAD'], { windowsHide: true })).stdout.trim()
  await rm(join(directory, 'worker-receipt.json'))
  const args = ['--directory', directory, '--commit', current, '--image-id', receipt.image_id, '--run-id', 'synthetic-worker-writer']
  expect((await invoke('scripts/write-worker-candidate.mjs', args)).code).toBe(0)
  const candidate = await verifyWorkerArtifact(directory, current, 'candidate')
  expect(candidate.checks.archive_reload).toBe(false)
  expect((await invoke('scripts/verify-worker-release.mjs', ['--directory', directory, '--commit', current])).code).toBe(1)
  expect((await invoke('scripts/write-worker-candidate.mjs', ['--directory', directory, '--commit', commit, '--image-id', receipt.image_id, '--run-id', 'synthetic-worker-writer'])).code).toBe(1)
})

