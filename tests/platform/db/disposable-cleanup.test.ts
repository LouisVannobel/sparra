import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import type { ExecFileOptions } from 'node:child_process'
import { startDisposableHatchet, startDisposableStores } from '../../fixtures/db/disposable-stores'

const external = vi.hoisted(() => ({
  exec: vi.fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>>(),
  end: vi.fn<() => Promise<void>>(),
  remove: vi.fn<(path: string) => Promise<void>>(),
  realpath: vi.fn<(path: string) => Promise<string>>(),
  spawn: vi.fn<() => ChildProcess>(),
  ip: vi.fn<(args: string[], options: ExecFileOptions, callback: (error: Error | null, stdout: string, stderr: string) => void) => ChildProcess>(),
  directory: '',
}))
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), execFile: Object.assign((file: string, args: string[], options: ExecFileOptions, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
  if (file !== 'ip') throw new Error('Real process execution prohibited')
  return external.ip(args, options, callback)
}, {
  [Symbol.for('nodejs.util.promisify.custom')]: external.exec,
}), spawn: external.spawn }))
vi.mock('undici', () => ({ fetch: async () => ({ status: 200 }) }))
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

type Failure = 'ownership' | 'removal' | 'administrator' | 'network-ownership' | 'network-removal' | 'temporary-path' | 'temporary-removal' | 'inventory' | 'volume-foreign' | 'volume-unknown' | 'volume-removal' | 'none'
function dockerDouble() {
  const containers = new Map<string, { name: string; label: string }>()
  const volumes = new Map<string, { label: string; index: number }>()
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
    } else if (operation === 'volume') {
      if (args[1] === 'create') {
        const name = args.at(-1)!
        volumes.set(name, { label: args[3], index: volumes.size })
        stdout = name
      } else if (args[1] === 'ls') stdout = [...volumes.keys()].map(name => `${name}|local`).join('\n')
      else if (args[1] === 'inspect') {
        const volume = volumes.get(args[2])!
        if (cleaning) operations.push(`volume-inspect-${volume.index}`)
        if (cleaning && volume.index === 0 && failure === 'volume-unknown') throw new Error('synthetic secret volume inspection')
        stdout = JSON.stringify({ 'projetv0.template.auth-fixture': cleaning && volume.index === 0 && failure === 'volume-foreign' ? 'foreign' : volume.label.split('=')[1] })
      } else if (args[1] === 'rm') {
        const volume = volumes.get(args[2])!
        operations.push(`volume-remove-${volume.index}`)
        if (volume.index === 0 && failure === 'volume-removal') throw new Error('synthetic secret volume removal')
        volumes.delete(args[2])
      } else throw new Error('Unexpected volume operation')
    }
    else if (operation === 'network') {
      if (args[1] === 'create') { network = true; networkLabel = args[3]; stdout = 'a'.repeat(64) }
      else if (args[1] === 'ls') stdout = network ? 'owned-network|fixture|bridge' : ''
      else if (args[1] === 'inspect') {
        if (args.at(-1) === '{{json .IPAM.Config}}') stdout = JSON.stringify([{ Gateway: '172.20.0.1' }])
        else {
          operations.push('network-ownership')
          stdout = JSON.stringify({ 'projetv0.template.auth-fixture': failure === 'network-ownership' ? 'foreign' : networkLabel.split('=')[1] })
        }
      } else if (args[1] === 'rm') {
        operations.push('network-remove')
        if (failure === 'network-removal') throw new Error('synthetic secret Docker output')
        network = false
      }
    } else if (operation === 'image') stdout = args.at(-1) === '{{.Os}}/{{.Architecture}}' ? 'linux/amd64' : args.at(-1) === '{{.Id}}|{{.Os}}/{{.Architecture}}' ? `${args[2]}|linux/amd64` : 'synthetic-image'
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
        stdout = JSON.stringify(Object.fromEntries(['5432','6379','8888','7077'].map(port => [`${port}/tcp`, [{ HostIp: '127.0.0.1', HostPort: '43210' }]])))
      } else if (args.at(-1) === '{{.Image}}') stdout = 'synthetic-image'
      else if (args.at(-1) === '{{.State.Status}}') stdout = 'running'
      else if (args.at(-1) === '{{.State.Running}}') stdout = 'false'
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
  external.spawn.mockImplementation(() => {
    const child = new ChildProcess()
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
    child.stdin.once('finish', () => { queueMicrotask(() => child.emit('close', 0)) })
    return child
  })
  external.ip.mockImplementation((args, _options, callback) => {
    const child = new ChildProcess(), bridge = 'br-aaaaaaaaaaaa'
    const targets = args.includes('dev') ? [{ ifindex: 10, ifname: bridge, flags: ['UP'], linkinfo: { info_kind: 'bridge' } }]
      : [11, 12, 13].map(ifindex => ({ ifindex, ifname: `veth${ifindex}`, master: bridge, flags: ['UP'], linkinfo: { info_kind: 'veth' } }))
    queueMicrotask(() => { callback(null, JSON.stringify(targets.map(target => ({ ...target, addr_info: [{ family: 'inet6', scope: 'link', local: 'fe80::1', prefixlen: 64 }] }))), ''); child.emit('close', 0, null) })
    return child
  })
  return { operations, fail(value: Failure) { failure = value; cleaning = true } }
}
beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}) })
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks() })

describe.each(['win32', 'linux'] as const)('mocked %s local transport', platform => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const originalUid = Object.getOwnPropertyDescriptor(process, 'getuid'), originalGid = Object.getOwnPropertyDescriptor(process, 'getgid')
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform })
    Object.defineProperty(process, 'getuid', { configurable: true, value: () => 10001 })
    Object.defineProperty(process, 'getgid', { configurable: true, value: () => 10001 })
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform)
    if (originalUid) Object.defineProperty(process, 'getuid', originalUid); else delete process.getuid
    if (originalGid) Object.defineProperty(process, 'getgid', originalGid); else delete process.getgid
    vi.useRealTimers()
  })

if (platform === 'linux') test('initial stores cannot return until their owned address child closes', async () => {
  const docker = dockerDouble()
  let requested!: () => void, complete!: () => void
  const queried = new Promise<void>(resolve => { requested = resolve })
  const readyIp = external.ip.getMockImplementation()!
  external.ip.mockImplementationOnce((args, options, callback) => {
    const child = new ChildProcess()
    complete = () => {
      const ready = readyIp(args, options, callback)
      ready.once('close', () => child.emit('close', 0, null))
    }
    requested()
    return child
  })
  let returned = false
  const startup = startDisposableStores().then(stores => { returned = true; return stores })
  try {
    expect(await Promise.race([queried.then(() => 'query'), startup.then(() => 'returned')])).toBe('query')
    expect(returned).toBe(false)
    complete()
    const stores = await startup
    expect(stores.evidence.addressReadiness).toMatchObject({ scope: 'confirmed', state: 'ready', bridgeCount: 1, vethCount: 3 })
  } finally { const stores = await startup; docker.fail('none'); await stores.cleanup() }
})

if (platform === 'linux') test('owned readiness failure retires every initial store and preserves foreign inventory', async () => {
  const docker = dockerDouble()
  external.ip.mockImplementationOnce((_args, _options, callback) => {
    const child = new ChildProcess()
    queueMicrotask(() => { docker.fail('none'); callback(new Error('sensitive owned address'), '', 'sensitive stderr'); child.emit('close', 1, null) })
    return child
  })
  await expect(startDisposableStores()).rejects.toThrow(/^Owned address readiness command failed$/)
  expect(docker.operations).toEqual([
    'administrator', 'inspect-owned-2', 'remove-owned-2', 'inspect-owned-1', 'remove-owned-1',
    'inspect-owned-0', 'remove-owned-0', 'network-ownership', 'network-remove', 'temporary-remove', 'inventory',
  ])
  const emitted = String(vi.mocked(console.log).mock.calls[0][0])
  const evidence = JSON.parse(emitted.slice('AUTH_STORE_EVIDENCE '.length))
  expect(evidence.unrelatedUnchanged).toBe(true)
  expect(evidence.inventoryDelta).toEqual([])
  expect(evidence).not.toHaveProperty('cleanupFailures')
  expect(evidence).not.toHaveProperty('addressReadiness')
  expect(emitted).not.toMatch(/sensitive|fe80|veth/)
})

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

test.each(['volume-foreign', 'volume-unknown', 'volume-removal'] as const)('returned web image consumer fences %s and retires later owned volumes', async failure => {
  const docker = dockerDouble(), fixture = await startDisposableStores()
  const image = 'sha256:' + 'a'.repeat(64)
  const auth = { secret: 'synthetic secret auth', googleClientId: 'fixture.apps.googleusercontent.com', googleClientSecret: 'synthetic secret google' }
  await fixture.startWebImage(image, 'valid', auth)
  await fixture.startWebImage(image, 'valid', auth)
  docker.fail(failure)
  const rejection = await fixture.cleanup().then(() => 'accepted', error => error.message)
  expect(rejection).toBe('Disposable fixture cleanup failed: volume-removal, inventory')
  expect(docker.operations).toEqual([
    'administrator', 'inspect-owned-6', 'remove-owned-6', 'inspect-owned-5', 'remove-owned-5',
    'inspect-owned-4', 'remove-owned-4', 'inspect-owned-3', 'remove-owned-3',
    'inspect-owned-2', 'remove-owned-2', 'inspect-owned-1', 'remove-owned-1', 'inspect-owned-0', 'remove-owned-0',
    'network-ownership', 'network-remove', 'volume-inspect-0',
    ...(failure === 'volume-removal' ? ['volume-remove-0'] : []), 'volume-inspect-1', 'volume-remove-1', 'inventory',
  ])
  expect(external.remove).not.toHaveBeenCalled()
  expect(fixture.evidence.consumerRetirementConfirmed).toBe(false)
  expect(fixture.evidence.retainedTemporaryPath).toBe(external.directory)
  expect(fixture.evidence.cleanupFailures).toEqual(['volume-removal', 'inventory'])
  expect(fixture.evidence.unrelatedUnchanged).toBe(false)
  expect(fixture.evidence.after).toEqual({ fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), volumeCount: 1 })
  expect(fixture.evidence.inventoryDelta).toEqual([
    { kind: 'volume', id: 'volume-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', ownership: 'foreign', change: 'removed', fields: ['Name', 'Driver'] },
    { kind: 'volume', id: expect.stringMatching(/^volume-sha256:[a-f0-9]{64}$/), ownership: 'owned', change: 'added', fields: ['Name', 'Driver'] },
  ])
  expect(console.log).toHaveBeenCalledOnce()
  const emitted = vi.mocked(console.log).mock.calls[0][0]
  expect(emitted).toMatch(/^AUTH_STORE_EVIDENCE /)
  expect(emitted).not.toContain('synthetic secret')
  expect(rejection).not.toContain('synthetic secret')
})

test('returned web image consumers retire volumes in allocation order before source and final inventory', async () => {
  const docker = dockerDouble(), fixture = await startDisposableStores(), image = 'sha256:' + 'a'.repeat(64)
  await fixture.startWebImage(image)
  await fixture.startWebImage(image)
  docker.fail('none')
  await fixture.cleanup()
  expect(docker.operations).toEqual([
    'administrator', 'inspect-owned-6', 'remove-owned-6', 'inspect-owned-5', 'remove-owned-5',
    'inspect-owned-4', 'remove-owned-4', 'inspect-owned-3', 'remove-owned-3',
    'inspect-owned-2', 'remove-owned-2', 'inspect-owned-1', 'remove-owned-1', 'inspect-owned-0', 'remove-owned-0',
    'network-ownership', 'network-remove', 'volume-inspect-0', 'volume-remove-0', 'volume-inspect-1', 'volume-remove-1',
    'temporary-remove', 'inventory',
  ])
  expect(fixture.evidence.consumerRetirementConfirmed).toBe(true)
  expect(fixture.evidence.unrelatedUnchanged).toBe(true)
  expect(fixture.evidence.inventoryDelta).toEqual([])
  expect(fixture.evidence).not.toHaveProperty('retainedTemporaryPath')
  expect(fixture.evidence).not.toHaveProperty('cleanupFailures')
  expect(external.remove).toHaveBeenCalledWith(external.directory, { recursive: true })
  expect(console.log).toHaveBeenCalledOnce()
})

test('unresolved init CLI close reached through returned web image consumer retains temporary source', async () => {
  vi.useFakeTimers()
  const docker = dockerDouble(), fixture = await startDisposableStores()
  const child = new ChildProcess()
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
  child.kill = () => true
  external.spawn.mockReturnValue(child)
  const startup = expect(fixture.startWebImage('sha256:' + 'a'.repeat(64))).rejects.toThrow('Credential init retirement unresolved')
  await vi.advanceTimersByTimeAsync(16000)
  await startup
  docker.fail('none')
  await expect(fixture.cleanup()).rejects.toThrow('Disposable fixture cleanup failed: credential-init-child-retirement')
  expect(docker.operations).toEqual([
    'administrator', 'inspect-owned-3', 'remove-owned-3', 'inspect-owned-2', 'remove-owned-2',
    'inspect-owned-1', 'remove-owned-1', 'inspect-owned-0', 'remove-owned-0',
    'network-ownership', 'network-remove', 'volume-inspect-0', 'volume-remove-0', 'inventory',
  ])
  expect(external.remove).not.toHaveBeenCalled()
  expect(fixture.evidence.consumerRetirementConfirmed).toBe(false)
  expect(fixture.evidence.retainedTemporaryPath).toBe(external.directory)
  expect(fixture.evidence.cleanupFailures).toEqual(['credential-init-child-retirement'])
  expect(fixture.evidence.unrelatedUnchanged).toBe(true)
  expect(fixture.evidence.inventoryDelta).toEqual([])
  expect(console.log).toHaveBeenCalledOnce()
  expect(vi.mocked(console.log).mock.calls[0][0]).not.toContain('synthetic secret')
  child.emit('close', 0)
})
})
