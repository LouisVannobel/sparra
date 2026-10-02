import { afterEach, expect, test, vi } from 'vitest'
import { fixtureDockerEndpoint, fixtureDockerEnvironment, assertFixtureDockerEndpoint, fixtureDockerFileUser } from '../fixtures/db/docker-endpoint'

const filesystem = vi.hoisted(() => ({ lstat: vi.fn() }))
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), lstat: filesystem.lstat }))
afterEach(() => vi.resetAllMocks())

test('preserves_windows_pipe', async () => {
  const endpoint = fixtureDockerEndpoint('win32')
  expect(endpoint.args).toEqual(['--context', 'desktop-linux'])
  expect(endpoint.endpoint).toBe('npipe:////./pipe/dockerDesktopLinuxEngine')
  await expect(assertFixtureDockerEndpoint('win32', endpoint.endpoint)).resolves.toBeUndefined()
  await expect(assertFixtureDockerEndpoint('win32', 'npipe:////./pipe/foreign')).rejects.toThrow()
})

test('rejects_remote_inherited_docker_authority', () => {
  const environment = fixtureDockerEnvironment({ PATH: 'synthetic-path', SystemRoot: 'synthetic-root', TMPDIR: 'synthetic-tmp',
    DOCKER_HOST: 'tcp://remote.invalid:2376', DOCKER_CONTEXT: 'remote', DOCKER_TLS_VERIFY: '1',
    DOCKER_CERT_PATH: '/synthetic/certs', DOCKER_CONFIG: '/synthetic/config', AUTH_SECRET: 'synthetic-secret' })
  expect(environment).toEqual({ PATH: 'synthetic-path', SystemRoot: 'synthetic-root', TMPDIR: 'synthetic-tmp' })
  expect(fixtureDockerEndpoint('linux')).toEqual({ args: ['--host', 'unix:///var/run/docker.sock'], endpoint: 'unix:///var/run/docker.sock' })
  expect(() => fixtureDockerEndpoint('darwin')).toThrow()
  expect(() => fixtureDockerEndpoint('freebsd')).toThrow()
})

test('Linux admission rejects remote endpoints and regular files before Docker execution', async () => {
  await expect(assertFixtureDockerEndpoint('linux', 'tcp://remote.invalid:2376')).rejects.toThrow()
  filesystem.lstat.mockResolvedValue({ isSocket: () => false, isSymbolicLink: () => false })
  await expect(assertFixtureDockerEndpoint('linux', 'unix:///var/run/docker.sock')).rejects.toThrow()
})

test('Linux admission accepts a socket and rejects a symlink leaf or missing socket', async () => {
  filesystem.lstat.mockResolvedValue({ isSocket: () => true, isSymbolicLink: () => false })
  await expect(assertFixtureDockerEndpoint('linux', 'unix:///var/run/docker.sock')).resolves.toBeUndefined()
  expect(filesystem.lstat).toHaveBeenCalledWith('/var/run/docker.sock')
  filesystem.lstat.mockResolvedValue({ isSocket: () => true, isSymbolicLink: () => true })
  await expect(assertFixtureDockerEndpoint('linux', 'unix:///var/run/docker.sock')).rejects.toThrow()
  filesystem.lstat.mockRejectedValue(new Error('synthetic socket missing'))
  await expect(assertFixtureDockerEndpoint('linux', 'unix:///var/run/docker.sock')).rejects.toThrow()
})

test('Linux private file consumers use the nonroot creator without altering Windows commands', () => {
  expect(fixtureDockerFileUser('win32', undefined, undefined)).toEqual([])
  expect(fixtureDockerFileUser('linux', 1000, 990)).toEqual(['--user', '1000:990'])
  for (const [uid, gid] of [[0, 990], [undefined, 990], [1000, undefined], [-1, 990], [1000, -1], [1.5, 990]]) {
    expect(() => fixtureDockerFileUser('linux', uid, gid)).toThrow()
  }
})
