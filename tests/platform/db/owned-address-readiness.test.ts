import { ChildProcess } from 'node:child_process'
import type { ExecFileOptions } from 'node:child_process'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { awaitOwnedStoreAddresses } from '../../fixtures/db/owned-address-readiness'

type Completion = (error: Error | null, stdout: string, stderr: string) => void
const processBoundary = vi.hoisted(() => ({ exec: vi.fn<(file: string, args: string[], options: ExecFileOptions, callback: Completion) => ChildProcess>() }))
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), execFile: processBoundary.exec }))

const networkId = 'a'.repeat(64), bridge = 'br-aaaaaaaaaaaa'
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
type Address = { family: string; scope: string; local: string; prefixlen: number; tentative?: boolean; optimistic?: boolean; dadfailed?: boolean }
const address = (): Address => ({ family: 'inet6', scope: 'link', local: 'fe80::1234', prefixlen: 64 })
const links = () => ({
  bridge: [{ ifindex: 10, ifname: bridge, flags: ['UP', 'BROADCAST'], linkinfo: { info_kind: 'bridge' }, addr_info: [address()] }],
  veths: [11, 12, 13].map(ifindex => ({ ifindex, ifname: `veth${ifindex}`, master: bridge, flags: ['UP'], linkinfo: { info_kind: 'veth' }, addr_info: [address()] })),
})
type Snapshot = ReturnType<typeof links>
function answer(snapshot: Snapshot) {
  processBoundary.exec.mockImplementation((_file, args, _options, callback) => {
    const child = new ChildProcess()
    queueMicrotask(() => { callback(null, JSON.stringify(args.includes('dev') ? snapshot.bridge : snapshot.veths), ''); child.emit('close', 0, null) })
    return child
  })
}
beforeEach(() => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  answer(links())
})
afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.useRealTimers(); vi.restoreAllMocks(); vi.resetAllMocks() })

test('last owned tentative address holds the result until an actual ready snapshot', async () => {
  const snapshot = links()
  Object.assign(snapshot.veths[2].addr_info[0], { tentative: true })
  answer(snapshot)
  let returned = false
  const result = awaitOwnedStoreAddresses(networkId).then(value => { returned = true; return value })
  await vi.advanceTimersByTimeAsync(0)
  expect(returned).toBe(false)
  expect(processBoundary.exec).toHaveBeenCalledTimes(2)
  snapshot.veths[2].addr_info[0] = address()
  await vi.advanceTimersByTimeAsync(49)
  expect(returned).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(await result).toEqual({ scope: 'confirmed', state: 'ready', bridgeCount: 1, vethCount: 3, pendingRounds: 1, elapsedMs: 50 })
  expect(vi.getTimerCount()).toBe(0)
})

test('ready sparse flags use only the two owned non-shell selectors and closed evidence', async () => {
  const snapshot = links()
  Object.assign(snapshot.bridge[0].addr_info[0], { tentative: false, optimistic: false, dadfailed: false })
  answer(snapshot)
  const result = await awaitOwnedStoreAddresses(networkId)
  expect(processBoundary.exec.mock.calls.map(call => [call[0], call[1]])).toEqual([
    ['ip', ['-j', '-d', 'address', 'show', 'dev', bridge]],
    ['ip', ['-j', '-d', 'address', 'show', 'master', bridge, 'type', 'veth']],
  ])
  for (const call of processBoundary.exec.mock.calls) {
    expect(call[2]).toMatchObject({ shell: false, windowsHide: true, timeout: 1000, killSignal: 'SIGKILL', maxBuffer: 32768, encoding: 'utf8', env: { LC_ALL: 'C' } })
    expect(Object.keys(call[2].env!).sort()).toEqual(['LC_ALL', 'PATH'])
  }
  expect(result).toEqual({ scope: 'confirmed', state: 'ready', bridgeCount: 1, vethCount: 3, pendingRounds: 0, elapsedMs: 0 })
  expect(JSON.stringify(result)).not.toMatch(/fe80|veth1|aaaaaaaa|local|ifname|ifindex/)
  expect(vi.getTimerCount()).toBe(0)
})

test('top-level link flags do not invent an address DAD state', async () => {
  const snapshot = links(); snapshot.veths[2].flags.push('TENTATIVE', 'OPTIMISTIC')
  answer(snapshot)
  expect((await awaitOwnedStoreAddresses(networkId)).state).toBe('ready')
})

test.each([
  ['missing bridge', (value: Snapshot) => { value.bridge = [] }],
  ['missing third veth', (value: Snapshot) => { value.veths.pop() }],
  ['empty addresses', (value: Snapshot) => { value.veths[2].addr_info = [] }],
  ['absent addresses', (value: Snapshot) => { Reflect.deleteProperty(value.veths[2], 'addr_info') }],
  ['no IPv6 link address', (value: Snapshot) => { value.veths[2].addr_info[0].scope = 'global' }],
  ['inactive veth', (value: Snapshot) => { value.veths[2].flags = [] }],
  ['optimistic global IPv6', (value: Snapshot) => { value.veths[2].addr_info.push({ ...address(), scope: 'global', optimistic: true }) }],
] as const)('%s never passes vacuously and recovers only on readiness', async (_name, change) => {
  const snapshot = links(); change(snapshot); answer(snapshot)
  let settled = false
  const result = awaitOwnedStoreAddresses(networkId).then(value => { settled = true; return value })
  await vi.advanceTimersByTimeAsync(0)
  expect(settled).toBe(false)
  const ready = links(); snapshot.bridge = ready.bridge; snapshot.veths = ready.veths
  await vi.advanceTimersByTimeAsync(50)
  expect((await result).state).toBe('ready')
})

test.each([
  ['wrong bridge kind', (value: Snapshot) => { value.bridge[0].linkinfo.info_kind = 'veth' }],
  ['wrong bridge identity', (value: Snapshot) => { value.bridge[0].ifname = 'foreign' }],
  ['wrong veth master', (value: Snapshot) => { value.veths[2].master = 'foreign' }],
  ['wrong veth kind', (value: Snapshot) => { value.veths[2].linkinfo.info_kind = 'bridge' }],
  ['duplicate index', (value: Snapshot) => { value.veths[2].ifindex = 10 }],
  ['duplicate name', (value: Snapshot) => { value.veths[2].ifname = value.veths[0].ifname }],
  ['invalid index', (value: Snapshot) => { value.veths[2].ifindex = 0 }],
  ['oversized name', (value: Snapshot) => { value.veths[2].ifname = 'x'.repeat(16) }],
  ['four veths', (value: Snapshot) => { value.veths.push({ ...value.veths[2], ifindex: 14, ifname: 'veth14' }) }],
  ['two bridges', (value: Snapshot) => { value.bridge.push(value.bridge[0]) }],
  ['address overflow', (value: Snapshot) => { value.veths[2].addr_info = Array.from({ length: 17 }, address) }],
  ['numeric DAD flag', (value: Snapshot) => { Object.assign(value.veths[2].addr_info[0], { tentative: 1 }) }],
  ['string optimistic flag', (value: Snapshot) => { Object.assign(value.veths[2].addr_info[0], { optimistic: 'true' }) }],
  ['null DAD flag', (value: Snapshot) => { Object.assign(value.veths[2].addr_info[0], { dadfailed: null }) }],
  ['residual address flags', (value: Snapshot) => { Object.assign(value.veths[2].addr_info[0], { ifa_flags: 64 }) }],
  ['malformed addresses', (value: Snapshot) => { Object.assign(value.veths[2], { addr_info: {} }) }],
  ['malformed address entry', (value: Snapshot) => { Object.assign(value.veths[2], { addr_info: [null] }) }],
  ['malformed address family', (value: Snapshot) => { value.veths[2].addr_info[0].family = 'unsupported' }],
  ['malformed address scope', (value: Snapshot) => { value.veths[2].addr_info[0].scope = 'unsupported' }],
  ['malformed link flags', (value: Snapshot) => { Object.assign(value.veths[2], { flags: 'UP' }) }],
] as const)('%s rejects an invalid owned scope without raw details', async (_name, change) => {
  const snapshot = links(); change(snapshot); answer(snapshot)
  await expect(awaitOwnedStoreAddresses(networkId)).rejects.toThrow(/^Owned address readiness invalid snapshot$/)
})

test('DAD failure on any IPv6 address rejects immediately even when link-local is ready', async () => {
  const snapshot = links()
  snapshot.veths[2].addr_info.push({ ...address(), scope: 'global', dadfailed: true })
  answer(snapshot)
  await expect(awaitOwnedStoreAddresses(networkId)).rejects.toThrow(/^Owned address readiness DAD failed$/)
  expect(vi.getTimerCount()).toBe(0)
})

test.each([
  ['array', ['inet6']], ['object', { family: 'inet6' }], ['null', null], ['numeric', 6],
])('%s family refuses beside a separate ready IPv6 address', async (_name, family) => {
  const snapshot = links()
  snapshot.veths[2].addr_info.push(Object.assign(address(), { family, dadfailed: true }))
  answer(snapshot)
  await expect(awaitOwnedStoreAddresses(networkId)).rejects.toThrow(/^Owned address readiness invalid snapshot$/)
})

test.each(['enoent', 'stderr', 'malformed', 'overflow'] as const)('%s command result refuses without disclosing output', async failure => {
  processBoundary.exec.mockImplementation((_file, _args, _options, callback) => {
    const child = new ChildProcess()
    queueMicrotask(() => {
      callback(failure === 'enoent' ? new Error('ENOENT sensitive-target') : null,
        failure === 'overflow' ? 'sensitive-address'.repeat(3000) : 'sensitive-address', failure === 'stderr' ? 'sensitive-stderr' : '')
      child.emit('close', failure === 'enoent' ? -2 : 0, null)
    })
    return child
  })
  const error = await awaitOwnedStoreAddresses(networkId).then(() => 'accepted', failure => failure.message)
  expect(error).toMatch(/^Owned address readiness (command failed|invalid snapshot)$/)
  expect(error).not.toContain('sensitive')
})

test('callback completion does not release the result before actual child close', async () => {
  let close!: () => void
  const ready = links()
  processBoundary.exec.mockImplementationOnce((_file, _args, _options, callback) => {
    const child = new ChildProcess(); close = () => child.emit('close', 0, null)
    queueMicrotask(() => callback(null, JSON.stringify(ready.bridge), ''))
    return child
  })
  let settled = false
  const result = awaitOwnedStoreAddresses(networkId).then(value => { settled = true; return value })
  await vi.advanceTimersByTimeAsync(0)
  expect(settled).toBe(false)
  expect(processBoundary.exec).toHaveBeenCalledTimes(1)
  close(); close()
  expect((await result).state).toBe('ready')
  expect(processBoundary.exec).toHaveBeenCalledTimes(2)
})

test('failed or cancelled command remains owned until close and ignores duplicate callback', async () => {
  let close!: () => void
  processBoundary.exec.mockImplementationOnce((_file, _args, _options, callback) => {
    const child = new ChildProcess(); close = () => child.emit('close', null, 'SIGKILL')
    queueMicrotask(() => { callback(new Error('AbortError sensitive-address'), '', ''); callback(null, JSON.stringify(links().bridge), '') })
    return child
  })
  let settled = false
  const result = awaitOwnedStoreAddresses(networkId).then(() => 'accepted', error => { settled = true; return error.message })
  await vi.advanceTimersByTimeAsync(0)
  expect(settled).toBe(false)
  close(); close()
  expect(await result).toBe('Owned address readiness command failed')
  expect(processBoundary.exec).toHaveBeenCalledTimes(1)
})

test('a stalled command is killed at its bounded timeout and reaped before refusal', async () => {
  let killed = false, close!: () => void
  processBoundary.exec.mockImplementationOnce((_file, _args, options, callback) => {
    const child = new ChildProcess()
    child.kill = signal => { killed = signal === 'SIGKILL'; return true }
    close = () => child.emit('close', null, 'SIGKILL')
    setTimeout(() => { child.kill(options.killSignal); callback(new Error('sensitive timed out command'), '', '') }, options.timeout)
    return child
  })
  let settled = false
  const result = awaitOwnedStoreAddresses(networkId).then(() => 'accepted', error => { settled = true; return error.message })
  await vi.advanceTimersByTimeAsync(999)
  expect(killed).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(killed).toBe(true)
  expect(settled).toBe(false)
  close()
  expect(await result).toBe('Owned address readiness command failed')
  expect(processBoundary.exec).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

test('synchronous process creation failure carries only the fixed error', async () => {
  processBoundary.exec.mockImplementationOnce(() => { throw new Error('sensitive process options') })
  await expect(awaitOwnedStoreAddresses(networkId)).rejects.toThrow(/^Owned address readiness command failed$/)
})

test('a pending namespace exhausts the total monotonic budget without starting an extra round', async () => {
  const snapshot = links(); snapshot.veths = []; answer(snapshot)
  const result = awaitOwnedStoreAddresses(networkId).then(() => 'accepted', error => error.message)
  await vi.advanceTimersByTimeAsync(5000)
  expect(await result).toBe('Owned address readiness timeout')
  expect(processBoundary.exec).toHaveBeenCalledTimes(200)
  expect(vi.getTimerCount()).toBe(0)
})

test('query time consumes the same total budget and the last child has only the remaining time', async () => {
  const timeouts: number[] = []
  processBoundary.exec.mockImplementation((_file, args, options, callback) => {
    const child = new ChildProcess(), timeout = Number(options.timeout); timeouts.push(timeout)
    setTimeout(() => { callback(null, JSON.stringify(args.includes('dev') ? links().bridge : []), ''); child.emit('close', 0, null) }, Math.min(975, timeout))
    return child
  })
  const result = awaitOwnedStoreAddresses(networkId).then(() => 'accepted', error => error.message)
  await vi.advanceTimersByTimeAsync(5000)
  expect(await result).toBe('Owned address readiness timeout')
  expect(timeouts).toEqual([1000, 1000, 1000, 1000, 1000, 125])
  expect(vi.getTimerCount()).toBe(0)
})

test.each(['', 'a'.repeat(63), 'A'.repeat(64), 'a'.repeat(65)])('invalid network identity makes no process query', async value => {
  await expect(awaitOwnedStoreAddresses(value)).rejects.toThrow(/^Owned address readiness invalid network$/)
  expect(processBoundary.exec).not.toHaveBeenCalled()
})

test('Windows returns explicit unperformed evidence without invoking ip', async () => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  expect(await awaitOwnedStoreAddresses('unused')).toEqual({ scope: 'unperformed', state: 'unperformed', bridgeCount: 0, vethCount: 0, pendingRounds: 0, elapsedMs: 0 })
  expect(processBoundary.exec).not.toHaveBeenCalled()
})
