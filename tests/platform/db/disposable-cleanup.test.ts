import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startDisposableHatchet } from '../../fixtures/db/disposable-stores'

const external = vi.hoisted(() => ({
  exec: vi.fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>>(),
  end: vi.fn<() => Promise<void>>(),
  remove: vi.fn<(path: string) => Promise<void>>(),
  realpath: vi.fn<(path: string) => Promise<string>>(),
  directory: '',
}))
vi.mock('node:child_process', () => ({ execFile: Object.assign(() => { throw new Error('Real process execution prohibited') }, {
  [Symbol.for('nodejs.util.promisify.custom')]: external.exec,
}) }))
vi.mock('node:fs/promises', () => ({
  mkdtemp: async (prefix: string) => { external.directory = `${prefix}owned`; return external.directory },
  mkdir: async () => {}, writeFile: async () => {}, cp: async () => {}, readFile: async () => Buffer.from('synthetic'),
  lstat: async (path: string) => {
    if (path !== '/var/run/docker.sock' || process.platform !== 'linux') throw new Error('Unexpected socket metadata boundary')
    return { isSymbolicLink: () => false, isSocket: () => true }
  },
  rm: external.remove, realpath: external.realpath,
}))
vi.mock('pg', () => ({ Client: class {
  on() {} async connect() {} async query() { return { rows: [{ server_version: '16.15' }] } }
  end() { return external.end() }
} }))
vi.mock('../../helpers/web-process.ts', () => ({ unusedLoopbackPort: async () => 43210 }))

type Failure = 'ownership' | 'removal' | 'administrator' | 'network-ownership' | 'network-removal' | 'temporary-path' | 'temporary-removal' | 'inventory' | 'none'
function dockerDouble() {
  const containers = new Map<string, { name: string; label: string }>()
  let networkLabel = '', network = false, cleaning = false, failure: Failure = 'none'
  const operations: string[] = []
  external.exec.mockImplementation(async (file, input) => {
    const expected = process.platform === 'win32' ? ['--context', 'desktop-linux'] : ['--host', 'unix:///var/run/docker.sock']
    if (file !== 'docker' || input[0] !== expected[0] || input[1] !== expected[1]) throw new Error('Unexpected process boundary')
    const args = input.slice(2), operation = args[0]
    let stdout = ''
    if (operation === 'context') {
      if (process.platform !== 'win32') throw new Error('Unexpected context lookup on explicit Unix socket')
      stdout = JSON.stringify([{ Endpoints: { docker: { Host: 'npipe:////./pipe/dockerDesktopLinuxEngine' } } }])
    }
    else if (operation === 'version') stdout = JSON.stringify({ Version: 'synthetic', Os: 'linux', Arch: 'amd64' })
    else if (operation === 'ps') {
      if (cleaning) { operations.push('inventory'); if (failure === 'inventory') throw new Error('synthetic secret Docker output') }
      stdout = [...containers.keys()].join('\n')
    } else if (operation === 'volume') stdout = ''
    else if (operation === 'network') {
      if (args[1] === 'create') { network = true; networkLabel = args[3]; stdout = 'owned-network' }
      else if (args[1] === 'ls') stdout = network ? 'owned-network|fixture|bridge' : ''
      else if (args[1] === 'inspect') {
        operations.push('network-ownership')
        stdout = JSON.stringify({ 'projetv0.template.auth-fixture': failure === 'network-ownership' ? 'foreign' : networkLabel.split('=')[1] })
      } else if (args[1] === 'rm') {
        operations.push('network-remove')
        if (failure === 'network-removal') throw new Error('synthetic secret Docker output')
        network = false
      }
    } else if (operation === 'image') stdout = args.at(-1) === '{{.Os}}/{{.Architecture}}' ? 'linux/amd64' : 'synthetic-image'
    else if (operation === 'create') {
      const id = `owned-${containers.size}`
      containers.set(id, { name: args[args.indexOf('--name')+1], label: args[args.indexOf('--label')+1] })
      stdout = id
    } else if (operation === 'inspect') {
      if (args.at(-1) === '{{json .Config.Labels}}') {
        if (cleaning) operations.push(`inspect-${args[1]}`)
        if (cleaning && failure === 'ownership' && args[1] === 'owned-1') throw new Error('synthetic secret Docker output')
        stdout = JSON.stringify({ 'projetv0.template.auth-fixture': containers.get(args[1])?.label.split('=')[1] })
      } else if (args.at(-1) === '{{json .NetworkSettings.Ports}}') {
        stdout = JSON.stringify(Object.fromEntries(['5432','8888','7077'].map(port => [`${port}/tcp`, [{ HostIp: '127.0.0.1', HostPort: '43210' }]])))
      } else if (args.at(-1) === '{{.Image}}') stdout = 'synthetic-image'
      else if (args.at(-1) === '{{.State.Status}}') stdout = 'running'
      else stdout = [...containers.keys()].map(id => `${id}|owned`).join('\n')
    } else if (operation === 'rm') {
      operations.push(`remove-${args[2]}`)
      if (failure === 'removal' && args[2] === 'owned-1') throw new Error('synthetic secret Docker output')
      containers.delete(args[2])
    } else if (operation === 'exec') stdout = args.includes('token') ? 'synthetic.synthetic.synthetic' : ''
    else if (operation !== 'start') throw new Error('Unexpected Docker operation')
    return { stdout, stderr: '' }
  })
  external.end.mockImplementation(async () => { operations.push('administrator'); if (failure === 'administrator') throw new Error('synthetic secret credential') })
  external.remove.mockImplementation(async () => { operations.push('temporary-remove'); if (failure === 'temporary-removal') throw new Error('synthetic secret path') })
  external.realpath.mockImplementation(async path => failure === 'temporary-path' && path === external.directory ? join(tmpdir(), 'foreign') : path)
  return { operations, fail(value: Failure) { failure = value; cleaning = true } }
}
beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}) })
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks() })

describe.each(['win32', 'linux'] as const)('mocked %s local transport', platform => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  beforeEach(() => { Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform }) })
  afterEach(() => { Object.defineProperty(process, 'platform', originalPlatform) })

test.each(['ownership', 'removal', 'administrator'] as const)('existing fixture retains %s failure and still attempts every remaining owned cleanup', async failure => {
  const docker = dockerDouble(), fixture = await startDisposableHatchet()
  docker.fail(failure)
  const result = await fixture.cleanup().then(() => 'accepted', error => error.message)
  expect(docker.operations).toContain('remove-owned-0')
  expect(docker.operations).toContain('network-remove')
  expect(docker.operations).not.toContain('temporary-remove')
  expect(fixture.evidence.retainedTemporaryPath).toBe(external.directory)
  expect(fixture.evidence.consumerRetirementConfirmed).toBe(false)
  expect(docker.operations).toContain('inventory')
  if (failure === 'ownership') expect(docker.operations).not.toContain('remove-owned-1')
  expect(result).toMatch(/^Disposable fixture cleanup failed:/)
  expect(result.includes('synthetic secret')).toBe(false)
  expect(JSON.stringify(fixture.evidence).includes('synthetic secret')).toBe(false)
  expect(fixture.evidence.cleanupFailures).toEqual(expect.arrayContaining([failure === 'ownership' ? 'container-0-ownership' : failure === 'removal' ? 'container-0-removal' : 'administrator']))
})

test.each(['network-ownership', 'network-removal', 'temporary-path', 'temporary-removal', 'inventory'] as const)('existing fixture safely records %s failure after other owned cleanup', async failure => {
  const docker = dockerDouble(), fixture = await startDisposableHatchet()
  docker.fail(failure)
  await expect(fixture.cleanup()).rejects.toThrow('Disposable fixture cleanup failed:')
  expect(docker.operations).toEqual(expect.arrayContaining(['remove-owned-1','remove-owned-0','network-ownership','inventory']))
  if (failure === 'network-ownership') {
    expect(docker.operations).not.toContain('network-remove')
    expect(docker.operations).not.toContain('temporary-remove')
    expect(fixture.evidence.retainedTemporaryPath).toBe(external.directory)
    expect(fixture.evidence.consumerRetirementConfirmed).toBe(false)
  }
  if (failure === 'temporary-path') expect(external.remove).not.toHaveBeenCalled()
  if (failure === 'network-removal') {
    expect(docker.operations).not.toContain('temporary-remove')
    expect(fixture.evidence.retainedTemporaryPath).toBe(external.directory)
    expect(fixture.evidence.consumerRetirementConfirmed).toBe(false)
  }
  if (failure === 'inventory') expect(fixture.evidence.unrelatedUnchanged).toBe(false)
  expect(fixture.evidence.cleanupFailures).toEqual(expect.arrayContaining([failure === 'temporary-removal' ? 'temporary-path' : failure]))
  expect(JSON.stringify(fixture.evidence).includes('synthetic secret')).toBe(false)
})

test('successful cleanup preserves the existing evidence shape and exact owned temporary target', async () => {
  const docker = dockerDouble(), fixture = await startDisposableHatchet()
  docker.fail('none')
  await fixture.cleanup()
  expect(fixture.evidence.unrelatedUnchanged).toBe(true)
  expect(fixture.evidence).not.toHaveProperty('cleanupFailures')
  expect(external.remove).toHaveBeenCalledWith(external.directory, { recursive: true })
  expect(docker.operations).toEqual(['administrator','inspect-owned-1','remove-owned-1','inspect-owned-0','remove-owned-0','network-ownership','network-remove','temporary-remove','inventory'])
})
})
