import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { ChildProcess, spawn } from 'node:child_process'
import { startPrivateNetworkEventProbe } from '../helpers/private-network-event-probe'

vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), spawn: vi.fn() }))

const network = 'a'.repeat(64), bridge = 'br-' + network.slice(0, 12)
let now = 100
function monitor() {
  const child = Object.assign(new ChildProcess(), {
    pid: 123, stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn((_signal: string) => { child.emit('close', null); return true }),
  })
  vi.mocked(spawn).mockImplementation(() => child)
  return child
}
// iproute2 v6.1.0 ipmonitor.c + ipaddress.c/iproute.c render these labelled,
// one-line records. No captured host identifiers are used in these fixtures.
function link(index: number, name: string, master = '', state = 'UP') {
  return `[LINK]${index}: ${name}: <BROADCAST,MULTICAST,UP> mtu 1500 ${master ? 'master ' + master + ' ' : ''}state ${state} \\    link/ether 02:00:00:00:00:01 brd ff:ff:ff:ff:ff:ff\n`
}
function report(result: { line: string }) {
  expect(result.line.startsWith('PRIVATE_NETWORK_EVENT_TIMELINE ')).toBe(true)
  const data: {
    outcome: string; scope: string; coverage: string; observer: string; cleanup: string
    events: { atMs: number; kind: string; membership: string; family: string; tentative: boolean | null; linkState: string | null }[]
    milestones: { stage: string; atMs: number }[]
    dropped: { rows: number; lines: number; associations: number; bytes: number }
  } = JSON.parse(result.line.slice('PRIVATE_NETWORK_EVENT_TIMELINE '.length))
  return data
}
beforeEach(() => {
  vi.useFakeTimers(); vi.mocked(spawn).mockReset(); now = 100
  vi.spyOn(performance, 'now').mockImplementation(() => now)
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

test('projects event-time ownership and one shared receipt clock without private input', async () => {
  const child = monitor(), probe = startPrivateNetworkEventProbe('linux')
  now = 110; probe.mark('fixture-create-start')
  child.stdout.write(link(7, bridge, '', 'DOWN'))
  child.stdout.write(link(8, 'vethfixture@if9', bridge))
  child.stdout.write('[ADDR]8: vethfixture    inet6 fe80::1/64 scope link tentative \\ valid_lft forever preferred_lft forever\n')
  child.stdout.write('[ROUTE]172.18.0.0/16 dev vethfixture proto kernel scope link src 172.18.0.1\n')
  child.stdout.write('[ADDR]Deleted 8: vethfixture    inet 172.18.0.1/16 scope global\n')
  child.stdout.write('[ROUTE]Deleted fe80::/64 dev vethfixture proto kernel metric 256\n')
  child.stdout.write('[LINK]Deleted 8: vethfixture@if9: <BROADCAST> mtu 1500 master ' + bridge + ' state DOWN\n')
  probe.ownNetwork(network); probe.mark('fixture-ready'); probe.mark('migration-done')
  now = 120; probe.mark('chromium-launch-start'); probe.mark('chromium-launch-done')
  probe.mark('goto-start'); probe.mark('goto-done'); probe.mark('first-script-network-change')
  const result = await probe.finish('native-failure'), data = report(result)
  expect([network, bridge, 'vethfixture', 'fe80::', '172.18.', '02:00:00', 'if9'].some(value => result.line.includes(value))).toBe(false)
  expect(/[a-f0-9]{64}/.test(result.line)).toBe(false)
  expect(data.scope).toBe('confirmed'); expect(data.coverage).toBe('complete'); expect(result.cleanup).toBe('reaped')
  expect(data.events).toEqual([
    { atMs: 10, kind: 'link-new', membership: 'owned-bridge', family: 'unknown', tentative: null, linkState: 'down' },
    { atMs: 10, kind: 'link-new', membership: 'owned-veth', family: 'unknown', tentative: null, linkState: 'up' },
    { atMs: 10, kind: 'address-new', membership: 'owned-veth', family: 'ipv6', tentative: true, linkState: null },
    { atMs: 10, kind: 'route-new', membership: 'owned-veth', family: 'ipv4', tentative: null, linkState: null },
    { atMs: 10, kind: 'address-delete', membership: 'owned-veth', family: 'ipv4', tentative: false, linkState: null },
    { atMs: 10, kind: 'route-delete', membership: 'owned-veth', family: 'ipv6', tentative: null, linkState: null },
    { atMs: 10, kind: 'link-delete', membership: 'owned-veth', family: 'unknown', tentative: null, linkState: 'down' },
  ])
  expect(data.milestones).toEqual([
    { stage: 'fixture-create-start', atMs: 10 }, { stage: 'fixture-ready', atMs: 10 }, { stage: 'migration-done', atMs: 10 },
    { stage: 'chromium-launch-start', atMs: 20 }, { stage: 'chromium-launch-done', atMs: 20 },
    { stage: 'goto-start', atMs: 20 }, { stage: 'goto-done', atMs: 20 }, { stage: 'first-script-network-change', atMs: 20 },
  ])
  const options = vi.mocked(spawn).mock.calls[0]
  // Assert closed booleans so even a regression cannot dump captured env values.
  expect(options?.[0] === 'ip').toBe(true)
  expect(JSON.stringify(options?.[1]) === JSON.stringify(['-o', 'monitor', 'label', 'link', 'address', 'route'])).toBe(true)
  expect(options?.[2]?.shell === false && options[2]?.detached === false).toBe(true)
  expect(JSON.stringify(options?.[2]?.stdio) === '["ignore","pipe","pipe"]').toBe(true)
  const envKeys = Object.keys(options?.[2]?.env ?? {})
  expect(envKeys.length === 2 && envKeys.every(key => key === 'LC_ALL' || key === 'PATH')).toBe(true)
})

test('does not turn spawn, another bridge, late receipt or invalid binding into confirmed scope', async () => {
  for (const scenario of ['no-event', 'other-bridge', 'late-event', 'invalid-id']) {
    const child = monitor(), probe = startPrivateNetworkEventProbe('linux')
    probe.ownNetwork(scenario === 'invalid-id' ? { toJSON() { throw new Error('private') } } : network)
    probe.mark('chromium-launch-start'); now += 1
    if (scenario !== 'no-event') child.stdout.write(link(7, scenario === 'other-bridge' ? 'br-unrelated' : bridge))
    expect(report(await probe.finish('signed-in')).scope).toBe('unknown')
  }
})

test('does not qualify a bridge received after launch even when both receipt times are equal', async () => {
  const child = monitor(), probe = startPrivateNetworkEventProbe('linux')
  probe.ownNetwork(network); probe.mark('chromium-launch-start'); child.stdout.write(link(7, bridge))
  expect(report(await probe.finish('signed-in')).scope).toBe('unknown')
})

test('does not select an arbitrary master when a route name has ambiguous active indices', async () => {
  const child = monitor(), probe = startPrivateNetworkEventProbe('linux')
  probe.ownNetwork(network)
  child.stdout.write(link(8, 'vethfixture@if9', bridge)); child.stdout.write(link(9, 'vethfixture@if10', 'br-unrelated'))
  child.stdout.write('[ROUTE]fe80::/64 dev vethfixture proto kernel metric 256\n')
  const data = report(await probe.finish('signed-in'))
  expect(data.events[2]?.membership).toBe('unknown'); expect(data.coverage).toBe('incomplete')
})

test('cannot attribute malformed or unsupported route destinations to a known owned interface', async () => {
  const child = monitor(), probe = startPrivateNetworkEventProbe('linux')
  probe.ownNetwork(network); child.stdout.write(link(7, bridge)); child.stdout.write(link(8, 'vethfixture@if9', bridge))
  for (const destination of ['unparseable', 'unsupported 192.0.2.0/24', '192.0.2.0/33', '2001:db8::/129', '192.0.2.0/', '192.0.2.0/24/1']) {
    child.stdout.write('[ROUTE]' + destination + ' dev vethfixture\n')
  }
  const result = await probe.finish('native-failure'), data = report(result)
  expect(['unparseable', 'unsupported', '192.0.2.', '2001:db8', 'vethfixture', bridge].some(value => result.line.includes(value))).toBe(false)
  expect(data.coverage).toBe('incomplete')
  expect(data.events.slice(2).every(row => row.kind === 'unknown' && row.membership === 'unknown' && row.family === 'unknown')).toBe(true)
})

test('keeps recognized typed IP routes and default routes observable with closed families', async () => {
  const child = monitor(), probe = startPrivateNetworkEventProbe('linux')
  probe.ownNetwork(network); child.stdout.write(link(7, bridge)); child.stdout.write(link(8, 'vethfixture@if9', bridge))
  child.stdout.write('[ROUTE]local 192.0.2.1 dev vethfixture proto kernel scope host\n')
  child.stdout.write('[ROUTE]Deleted unreachable 2001:db8::/64 dev vethfixture\n')
  child.stdout.write('[ROUTE]default dev vethfixture\n')
  const data = report(await probe.finish('signed-in'))
  expect(data.coverage).toBe('complete')
  expect(data.events.slice(2).map(row => ({ kind: row.kind, membership: row.membership, family: row.family }))).toEqual([
    { kind: 'route-new', membership: 'owned-veth', family: 'ipv4' },
    { kind: 'route-delete', membership: 'owned-veth', family: 'ipv6' },
    { kind: 'route-new', membership: 'owned-veth', family: 'unknown' },
  ])
})

test('keeps missing associations, index reuse, stale addresses and default route family unknown', async () => {
  const child = monitor(), probe = startPrivateNetworkEventProbe('linux')
  probe.ownNetwork(network); child.stdout.write(link(7, bridge)); probe.mark('chromium-launch-start')
  child.stdout.write('[ADDR]8: vethfixture inet6 fe80::1/64 scope link\n')
  child.stdout.write(link(8, 'vethfixture@if9', bridge))
  child.stdout.write(link(8, 'vethreplacement@if10'))
  child.stdout.write('[ADDR]8: vethfixture inet6 fe80::1/64 scope link\n')
  child.stdout.write('[ADDR]8: vethreplacement inet6 fe80::2/64 scope link\n')
  child.stdout.write('[ROUTE]default via 172.18.0.1 dev vethreplacement\n')
  child.stdout.write(link(9, 'vethother@if10', 'br-unrelated', 'DORMANT'))
  const events = report(await probe.finish('signed-in')).events
  expect(events.map(row => row.membership)).toEqual(['owned-bridge', 'unknown', 'owned-veth', 'unknown', 'unknown', 'unknown', 'unknown', 'other'])
  expect(events[6]?.family).toBe('unknown'); expect(events[7]?.linkState).toBe('other')
})

test('clears deleted associations and never backfills a later master into earlier rows', async () => {
  const child = monitor(), probe = startPrivateNetworkEventProbe('linux')
  child.stdout.write(link(8, 'vethfixture@if9'))
  child.stdout.write('[ADDR]8: vethfixture inet6 fe80::1/64 scope link\n')
  child.stdout.write(link(8, 'vethfixture@if9', bridge))
  child.stdout.write('[LINK]Deleted 8: vethfixture@if9: <BROADCAST> mtu 1500 state DOWN\n')
  child.stdout.write('[ADDR]8: vethfixture inet6 fe80::1/64 scope link\n')
  probe.ownNetwork(network)
  expect(report(await probe.finish('signed-in')).events.map(row => row.membership)).toEqual(['unknown', 'unknown', 'owned-veth', 'unknown', 'unknown'])
})

test('reassembles split input and discards an oversized line through its next newline', async () => {
  const child = monitor(), probe = startPrivateNetworkEventProbe('linux')
  probe.ownNetwork(network)
  const row = link(7, bridge)
  child.stdout.write(row.slice(0, 17)); child.stdout.write(row.slice(17))
  child.stdout.write('private'.repeat(700)); child.stdout.write('[LINK]9: vethspoof: master ' + bridge + ' state UP\n')
  child.stdout.write('[ADDR]7: ' + bridge + ' inet6 fe80::1/64 scope link\n')
  probe.mark('chromium-launch-start')
  const data = report(await probe.finish('signed-in'))
  expect(data.events.map(row => row.kind)).toEqual(['link-new', 'address-new'])
  expect(data.coverage).toBe('incomplete'); expect(data.dropped.lines).toBe(1)
})

test('bounds rows and associations while preserving unknown ownership after the bound', async () => {
  const child = monitor(), probe = startPrivateNetworkEventProbe('linux')
  probe.ownNetwork(network)
  for (let index = 1; index <= 65; index++) child.stdout.write(link(index, 'veth' + index, bridge))
  child.stdout.write('[ADDR]65: veth65 inet6 fe80::1/64 scope link\n')
  for (let index = 0; index < 400; index++) child.stdout.write('[ROUTE]default dev missing\n')
  const data = report(await probe.finish('signed-in'))
  expect(data.events).toHaveLength(128); expect(data.events[65]?.membership).toBe('unknown')
  expect(data.dropped.associations).toBe(1); expect(data.dropped.rows).toBe(255); expect(data.coverage).toBe('incomplete')
})

test('bounds total input, drains later chunks and never retains partial or malformed private input', async () => {
  const child = monitor(), probe = startPrivateNetworkEventProbe('linux')
  child.stdout.write('private'.repeat(40000)); child.stdout.write('\n'); child.stdout.write(link(7, bridge))
  child.stderr.write('denied private URL https://secret.invalid token=private\n')
  const result = await probe.finish('setup-incomplete'), data = report(result)
  expect(data.events).toEqual([]); expect(data.dropped.bytes).toBe(255); expect(data.coverage).toBe('incomplete')
  expect(['private', 'secret.invalid', 'token=', bridge].some(value => result.line.includes(value))).toBe(false)
  const partialChild = monitor(), partial = startPrivateNetworkEventProbe('linux')
  partialChild.stdout.write('[LINK]private')
  expect(report(await partial.finish('setup-incomplete')).coverage).toBe('incomplete')
})

test('reports malformed labels with a closed unknown category without inventing membership', async () => {
  const child = monitor(), probe = startPrivateNetworkEventProbe('linux')
  child.stdout.write('[ADDR]private\n[LINK]not-an-index: private: state PRIVATE\n[ROUTE]default\n[PRIVATE]sensitive\n')
  const data = report(await probe.finish('native-failure'))
  expect(data.events.map(row => row.kind)).toEqual(['unknown', 'unknown', 'route-new', 'unknown'])
  expect(data.events.every(row => row.membership === 'unknown')).toBe(true); expect(data.coverage).toBe('incomplete')
})

test('emits only once and freezes observations before owned-child retirement', async () => {
  const child = monitor(), probe = startPrivateNetworkEventProbe('linux')
  child.kill.mockImplementation(() => true)
  probe.mark('goto-start'); probe.mark('goto-start')
  // Deliberately bypass the compile-time union with an untrusted runtime value.
  probe.mark(JSON.parse('"https://private.invalid"'))
  const first = probe.finish('native-failure'), second = probe.finish('signed-in')
  expect(first === second).toBe(true)
  probe.mark('goto-done'); probe.ownNetwork(network); child.stdout.write(link(7, bridge))
  child.emit('close', null)
  const data = report(await first)
  expect(data.outcome).toBe('native-failure'); expect(data.events).toEqual([])
  expect(data.milestones).toEqual([{ stage: 'goto-start', atMs: 0 }]); expect(child.kill.mock.calls).toEqual([['SIGTERM']])
  expect(child.stdout.listenerCount('data')).toBe(0); expect(child.stderr.listenerCount('data')).toBe(0)
})

test('escalates only its child and requires close rather than kill or exit for reaping', async () => {
  const child = monitor(), probe = startPrivateNetworkEventProbe('linux')
  child.kill.mockImplementation(signal => { if (signal === 'SIGKILL') child.emit('close', null); return true })
  const done = probe.finish('native-failure'); child.emit('exit', null)
  await vi.advanceTimersByTimeAsync(499); expect(child.kill.mock.calls).toEqual([['SIGTERM']])
  await vi.advanceTimersByTimeAsync(1)
  expect((await done).cleanup).toBe('reaped'); expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
})

test('bounds unknown reaping and preserves that result when kill fails', async () => {
  const child = monitor(), probe = startPrivateNetworkEventProbe('linux')
  child.kill.mockImplementation(() => { throw new Error('private kill error') })
  const done = probe.finish('native-failure')
  await vi.advanceTimersByTimeAsync(1000)
  const result = await done
  expect(result.cleanup).toBe('unknown'); expect(report(result).coverage).toBe('incomplete')
  expect(result.line.includes('private kill error')).toBe(false)
  child.emit('close', null)
  expect(child.listenerCount('close')).toBe(0)
})

test('retires through the same watchdog and reports timeout without changing native deadlines', async () => {
  const child = monitor(), probe = startPrivateNetworkEventProbe('linux')
  await vi.advanceTimersByTimeAsync(120000)
  const data = report(await probe.finish('native-failure'))
  expect(data.observer).toBe('timed-out'); expect(data.coverage).toBe('incomplete'); expect(data.cleanup).toBe('reaped')
  expect(child.kill.mock.calls).toEqual([['SIGTERM']])
})

test('handles spawn failure, denied subscription and early close as unavailable evidence', async () => {
  vi.mocked(spawn).mockImplementationOnce(() => { throw new Error('private spawn input') })
  const unavailable = report(await startPrivateNetworkEventProbe('linux').finish('setup-incomplete'))
  expect(unavailable.observer).toBe('unavailable'); expect(unavailable.cleanup).toBe('not-spawned')
  const child = monitor(), denied = startPrivateNetworkEventProbe('linux')
  child.stderr.write('RTNETLINK answers: Operation not permitted private\n')
  child.emit('error', Object.assign(new Error('private'), { code: 'ENOENT' })); child.emit('close', 1)
  expect(report(await denied.finish('setup-incomplete'))).toMatchObject({ observer: 'unavailable', scope: 'unknown', coverage: 'incomplete' })
  const earlyChild = monitor(), early = startPrivateNetworkEventProbe('linux')
  early.ownNetwork(network); earlyChild.stdout.write(link(7, bridge)); early.mark('chromium-launch-start'); earlyChild.emit('close', 0)
  expect(report(await early.finish('native-failure'))).toMatchObject({ observer: 'early-exit', scope: 'unknown', coverage: 'incomplete', cleanup: 'reaped' })
})

test('never spawns a monitor on Windows', async () => {
  const result = await startPrivateNetworkEventProbe('win32').finish('setup-incomplete')
  expect(vi.mocked(spawn).mock.calls).toEqual([])
  expect(report(result)).toMatchObject({ observer: 'unsupported', scope: 'unknown', coverage: 'incomplete', cleanup: 'not-spawned' })
})

test.skipIf(process.platform !== 'linux')('actual Linux Node canary ignores SIGTERM, is closed by SIGKILL and leaves its PID absent', async () => {
  vi.useRealTimers()
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  const canary = actual.spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});process.stdout.write('ready\\n');setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: false })
  vi.mocked(spawn).mockReturnValueOnce(canary)
  const probe = startPrivateNetworkEventProbe('linux'), signals: string[] = [], pid = canary.pid
  let actualClosed = false, readyTimer: ReturnType<typeof setTimeout> | undefined
  const closed = new Promise<void>(resolve => canary.once('close', () => { actualClosed = true; resolve() }))
  try {
    const kill = canary.kill.bind(canary)
    vi.spyOn(canary, 'kill').mockImplementation(signal => { signals.push(String(signal)); return kill(signal) })
    await new Promise<void>((resolve, reject) => {
      canary.stdout?.once('data', () => resolve())
      readyTimer = setTimeout(() => reject(new Error('Owned canary readiness unconfirmed')), 1000)
    })
    clearTimeout(readyTimer)
    const result = await probe.finish('setup-incomplete')
    expect(result.cleanup).toBe('reaped'); expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    let absent = false
    if (pid) { try { process.kill(pid, 0) } catch (error) { absent = error instanceof Error && 'code' in error && error.code === 'ESRCH' } }
    expect(absent).toBe(true)
  } finally {
    clearTimeout(readyTimer); await probe.finish('setup-incomplete')
    if (!actualClosed) {
      try { canary.kill('SIGKILL') } catch { /* Keep any primary test failure. */ }
      let closeTimer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([closed, new Promise<void>(resolve => { closeTimer = setTimeout(resolve, 500) })])
      clearTimeout(closeTimer)
    }
  }
})
