import type { ExecFileOptions } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { nativeImage } from '../helpers/native-image'

const boundary = vi.hoisted(() => ({
  exec: vi.fn<(file: string, args: string[], options: ExecFileOptions) => Promise<{ stdout: string; stderr: string }>>(),
}))
vi.mock('node:child_process', () => ({
  execFile: Object.assign(() => { throw new Error('Real Docker prohibited') }, {
    [Symbol.for('nodejs.util.promisify.custom')]: boundary.exec,
  }),
}))

const reference = 'ghcr.io/louisvannobel/sparra-web@sha256:' + 'b'.repeat(64)
const id = 'sha256:' + 'c'.repeat(64)
const otherId = 'sha256:' + 'd'.repeat(64)
const programFiles = 'C:\\synthetic\\Program Files'
const dockerEnvironment = {
  PATH: 'synthetic-path', SystemRoot: 'synthetic-root', TEMP: 'synthetic-temp',
  TMP: 'synthetic-tmp', TMPDIR: 'synthetic-tmpdir', USERPROFILE: 'synthetic-profile',
}
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const targets = [
  { target: 'web', selectedKey: 'SPARRA_TEST_WEB_IMAGE_ID' },
  { target: 'migrator', selectedKey: 'SPARRA_TEST_MIGRATOR_IMAGE_ID' },
] as const

beforeEach(() => {
  for (const key of ['SPARRA_TEST_IMAGE_REFERENCE', 'SPARRA_TEST_WEB_IMAGE_ID', 'SPARRA_TEST_MIGRATOR_IMAGE_ID']) vi.stubEnv(key, undefined)
  for (const [key, value] of Object.entries({
    ...dockerEnvironment, ProgramFiles: programFiles, DOCKER_HOST: 'tcp://remote.invalid:2376',
    DOCKER_CONTEXT: 'remote', DOCKER_TLS_VERIFY: '1', DOCKER_CERT_PATH: '/synthetic/certs',
    DOCKER_CONFIG: '/synthetic/config', AUTH_SECRET: 'synthetic-excluded-secret',
  })) vi.stubEnv(key, value)
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'linux' })
  boundary.exec.mockRejectedValue(new Error('Unexpected Docker command'))
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform)
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetAllMocks()
})

// These supported platforms are simulated consumer branches, not native Docker qualification.
describe.each([
  { platform: 'linux', args: ['--host', 'unix:///var/run/docker.sock'], buildEnvironment: dockerEnvironment },
  { platform: 'win32', args: ['--context', 'desktop-linux'], buildEnvironment: { ...dockerEnvironment, ProgramFiles: programFiles } },
] as const)('offline $platform image consumer', ({ platform, args, buildEnvironment }) => {
  beforeEach(() => Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform }))

  test('immutable_published_reference_uses_previously_pulled_object_without_rebuild', async () => {
    vi.stubEnv('SPARRA_TEST_IMAGE_REFERENCE', reference)
    vi.stubEnv('SPARRA_TEST_MIGRATOR_IMAGE_ID', otherId)
    boundary.exec.mockResolvedValueOnce({ stdout: id + '|linux/amd64\n', stderr: '' })

    expect(await nativeImage('web')).toBe(id)
    expect(boundary.exec).toHaveBeenCalledExactlyOnceWith('docker', [
      ...args, 'image', 'inspect', reference, '--format', '{{.Id}}|{{.Os}}/{{.Architecture}}',
    ], { env: dockerEnvironment, windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 })
    expect(console.log).not.toHaveBeenCalled()
  })

  test.each(targets)('selected $target ID is inspected and reused without rebuilding', async ({ target, selectedKey }) => {
    vi.stubEnv(selectedKey, id)
    boundary.exec.mockResolvedValueOnce({ stdout: id + '|linux/amd64\n', stderr: '' })

    expect(await nativeImage(target)).toBe(id)
    expect(boundary.exec).toHaveBeenCalledExactlyOnceWith('docker', [
      ...args, 'image', 'inspect', id, '--format', '{{.Id}}|{{.Os}}/{{.Architecture}}',
    ], { env: dockerEnvironment, windowsHide: true })
    expect(console.log).not.toHaveBeenCalled()
  })

  test.each(targets)('unselected $target builds its exact target and inspects the qualification tag', async ({ target }) => {
    boundary.exec.mockResolvedValueOnce({ stdout: '', stderr: '' })
    boundary.exec.mockResolvedValueOnce({ stdout: id + '\n', stderr: '' })

    expect(await nativeImage(target)).toBe(id)
    expect(boundary.exec).toHaveBeenCalledTimes(2)
    expect(boundary.exec).toHaveBeenNthCalledWith(1, 'docker', [
      ...args, 'build', '--platform', 'linux/amd64', '--target', target, '--tag', 'sparra-' + target + ':qualification', '.',
    ], { env: buildEnvironment, windowsHide: true, timeout: 600000, maxBuffer: 8 * 1024 * 1024 })
    expect(boundary.exec).toHaveBeenNthCalledWith(2, 'docker', [
      ...args, 'image', 'inspect', 'sparra-' + target + ':qualification', '--format', '{{.Id}}',
    ], { env: dockerEnvironment, windowsHide: true })
    expect(console.log).toHaveBeenCalledExactlyOnceWith('NATIVE_IMAGE_ID ' + target + ' ' + id)
  })
})

test.each([
  'ghcr.io/louisvannobel/sparra-web:latest',
  'ghcr.io/louisvannobel/foreign@sha256:' + 'b'.repeat(64),
  'ghcr.io/louisvannobel/sparra-web@sha256:short',
  'ghcr.io/louisvannobel/sparra-web@sha256:' + 'B'.repeat(64),
  '',
])('mutable_or_foreign_reference_is_refused_before_Docker: %s', async reference => {
  vi.stubEnv('SPARRA_TEST_IMAGE_REFERENCE', reference)
  await expect(nativeImage('web')).rejects.toThrow(/^Immutable published web image required$/)
  expect(boundary.exec).not.toHaveBeenCalled()
})

test('two_image_authorities_or_wrong_loaded_platform_fail_closed', async () => {
  vi.stubEnv('SPARRA_TEST_IMAGE_REFERENCE', reference)
  vi.stubEnv('SPARRA_TEST_WEB_IMAGE_ID', id)
  await expect(nativeImage('web')).rejects.toThrow(/^Ambiguous image authority$/)
  expect(boundary.exec).not.toHaveBeenCalled()

  vi.stubEnv('SPARRA_TEST_WEB_IMAGE_ID', undefined)
  boundary.exec.mockResolvedValueOnce({ stdout: id + '|linux/arm64\n', stderr: '' })
  await expect(nativeImage('web')).rejects.toThrow(/^Pulled image mismatch$/)
  expect(boundary.exec).toHaveBeenCalledTimes(1)
})

test.each([
  'sha256:short|linux/amd64',
  'sha256:' + 'C'.repeat(64) + '|linux/amd64',
  id,
  id + '|linux/amd64|extra',
])('published malformed metadata fails with a neutral error: %s', async stdout => {
  vi.stubEnv('SPARRA_TEST_IMAGE_REFERENCE', reference)
  boundary.exec.mockResolvedValueOnce({ stdout, stderr: '' })
  await expect(nativeImage('web')).rejects.toThrow(/^Pulled image mismatch$/)
  expect(boundary.exec).toHaveBeenCalledTimes(1)
  expect(console.log).not.toHaveBeenCalled()
})

describe.each(targets)('selected $target authority', ({ target, selectedKey }) => {
  test.each(['', 'sparra-web:qualification', 'sha256:short', 'sha256:' + 'C'.repeat(64)])('rejects invalid selected ID before Docker: %s', async selected => {
    vi.stubEnv(selectedKey, selected)
    await expect(nativeImage(target)).rejects.toThrow(/^Immutable test image required$/)
    expect(boundary.exec).not.toHaveBeenCalled()
  })

  test.each([otherId + '|linux/amd64', id + '|linux/arm64'])('refuses a different actual ID or platform: %s', async stdout => {
    vi.stubEnv(selectedKey, id)
    boundary.exec.mockResolvedValueOnce({ stdout, stderr: '' })
    await expect(nativeImage(target)).rejects.toThrow(/^Loaded image mismatch$/)
    expect(boundary.exec).toHaveBeenCalledTimes(1)
    expect(console.log).not.toHaveBeenCalled()
  })
})

test('migrator uses its selected ID without consuming the web ID or published reference', async () => {
  vi.stubEnv('SPARRA_TEST_IMAGE_REFERENCE', reference)
  vi.stubEnv('SPARRA_TEST_WEB_IMAGE_ID', otherId)
  vi.stubEnv('SPARRA_TEST_MIGRATOR_IMAGE_ID', id)
  boundary.exec.mockResolvedValueOnce({ stdout: id + '|linux/amd64', stderr: '' })

  expect(await nativeImage('migrator')).toBe(id)
  expect(boundary.exec).toHaveBeenCalledExactlyOnceWith('docker', [
    '--host', 'unix:///var/run/docker.sock', 'image', 'inspect', id, '--format', '{{.Id}}|{{.Os}}/{{.Architecture}}',
  ], { env: dockerEnvironment, windowsHide: true })
})

test('migrator builds when only unconsumed invalid web selectors are present', async () => {
  vi.stubEnv('SPARRA_TEST_IMAGE_REFERENCE', 'ghcr.io/louisvannobel/sparra-web:latest')
  vi.stubEnv('SPARRA_TEST_WEB_IMAGE_ID', 'invalid-web-id')
  boundary.exec.mockResolvedValueOnce({ stdout: '', stderr: '' })
  boundary.exec.mockResolvedValueOnce({ stdout: id, stderr: '' })

  expect(await nativeImage('migrator')).toBe(id)
  expect(boundary.exec).toHaveBeenCalledTimes(2)
  expect(boundary.exec).toHaveBeenNthCalledWith(1, 'docker', [
    '--host', 'unix:///var/run/docker.sock', 'build', '--platform', 'linux/amd64', '--target', 'migrator', '--tag', 'sparra-migrator:qualification', '.',
  ], { env: dockerEnvironment, windowsHide: true, timeout: 600000, maxBuffer: 8 * 1024 * 1024 })
  expect(boundary.exec).toHaveBeenNthCalledWith(2, 'docker', [
    '--host', 'unix:///var/run/docker.sock', 'image', 'inspect', 'sparra-migrator:qualification', '--format', '{{.Id}}',
  ], { env: dockerEnvironment, windowsHide: true })
})

test.each(['', 'sparra-web:qualification', 'sha256:short', 'sha256:' + 'C'.repeat(64), id + '\n' + otherId])('build rejects an invalid final image ID without publishing it: %s', async stdout => {
  boundary.exec.mockResolvedValueOnce({ stdout: '', stderr: '' })
  boundary.exec.mockResolvedValueOnce({ stdout, stderr: '' })

  await expect(nativeImage('web')).rejects.toThrow(/^Immutable image ID missing$/)
  expect(boundary.exec).toHaveBeenCalledTimes(2)
  expect(console.log).not.toHaveBeenCalled()
})

test('unsupported host platform is refused before Docker execution', async () => {
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'darwin' })
  await expect(nativeImage('web')).rejects.toThrow(/^Disposable fixture requires Windows or Linux local Docker transport$/)
  expect(boundary.exec).not.toHaveBeenCalled()
})
