import { afterEach, expect, test, vi } from 'vitest'
import type { ExecFileException, ExecFileOptionsWithStringEncoding } from 'node:child_process'
import { release } from 'node:os'
import { Client } from 'pg'
import { createClient } from 'redis'
import { fixtureDockerEndpoint, fixtureDockerEnvironment } from '../fixtures/db/docker-endpoint'
import { startDisposableStores } from '../fixtures/db/disposable-stores'

// Fault injection stays below the real lifecycle; no foreign resource is changed.
const fault = vi.hoisted(() => ({ poolCreate: false, foreignInventory: false, observeGate: false, gateChildren: 0, closedGateChildren: 0, tentativeObserved: false, missingIPv6Observed: false }))

type NativeFields = Readonly<{
  ifindex?: unknown; ifname?: unknown; flags?: unknown; master?: unknown; linkinfo?: unknown; info_kind?: unknown
  addr_info?: unknown; family?: unknown; scope?: unknown; tentative?: unknown; optimistic?: unknown; dadfailed?: unknown
}>
const nativeObject = (value: unknown): value is NativeFields => value !== null && typeof value === 'object' && !Array.isArray(value)
const linkIPv6 = (value: unknown) => nativeObject(value) && value.family === 'inet6' && value.scope === 'link'

function nativeAddressFlags(value: unknown) {
  if (!nativeObject(value)) return { valid: false, tentative: false, ready: false }
  if (value.family !== 'inet6') return { valid: value.family === 'inet', tentative: false, ready: true }
  const flags: ('tentative' | 'optimistic' | 'dadfailed')[] = ['tentative', 'optimistic', 'dadfailed']
  const valid = !Object.hasOwn(value, 'ifa_flags') && flags.every(flag => !Object.hasOwn(value, flag) || typeof value[flag] === 'boolean')
  return { valid, tentative: value.tentative === true || value.optimistic === true, ready: valid && value.dadfailed !== true }
}

function kernelAddressState(raw: string) {
  try {
    const values: unknown = JSON.parse(raw)
    if (!Array.isArray(values)) return { valid: false, tentative: false, missingIPv6: false }
    let tentative = false, missingIPv6 = false, ready = values.length > 0
    const targets: unknown[] = values
    for (const target of targets) {
      if (!nativeObject(target) || (target.addr_info !== undefined && !Array.isArray(target.addr_info))) return { valid: false, tentative: false, missingIPv6: false }
      const addresses: unknown[] = target.addr_info ?? []
      const states = addresses.map(nativeAddressFlags)
      if (states.some(state => !state.valid)) return { valid: false, tentative: false, missingIPv6: false }
      missingIPv6 ||= !addresses.some(linkIPv6)
      tentative ||= states.some(state => state.tentative)
      ready &&= states.every(state => state.ready)
    }
    return { valid: true, tentative, missingIPv6, ready: ready && !tentative && !missingIPv6 }
  } catch { return { valid: false, tentative: false, missingIPv6: false } }
}

vi.mock('node:child_process', async original => {
  const module = await original<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  const exec = promisify(module.execFile)
  const wrapped = (file: string, args: string[], options: ExecFileOptionsWithStringEncoding, callback: (error: ExecFileException | null, stdout: string, stderr: string) => void) => {
    const ownedQuery = file === 'ip' && fault.observeGate && args.includes('address')
    const child = module.execFile(file, args, options, (error, stdout, stderr) => {
      if (ownedQuery && !error && !stderr) {
        const state = kernelAddressState(stdout)
        fault.tentativeObserved ||= state.valid && state.tentative
        fault.missingIPv6Observed ||= state.valid && state.missingIPv6
      }
      callback(error, stdout, stderr)
    })
    if (ownedQuery) { fault.gateChildren++; child.once('close', () => { fault.closedGateChildren++ }) }
    return child
  }
  return { ...module, execFile: Object.assign(wrapped, {
    [Symbol.for('nodejs.util.promisify.custom')]: async (file: string, args: string[], options: Parameters<typeof exec>[2]) => {
      if (file === 'docker' && fault.poolCreate && args.includes('create') && args.includes('pool')) {
        fault.poolCreate = false
        throw new Error('Synthetic owned pool create failure')
      }
      const result = await exec(file, args, options)
      if (file === 'docker' && fault.foreignInventory && args.includes('network') && args.includes('ls')) {
        result.stdout = String(result.stdout).trimEnd() + '\nsynthetic-foreign-network|synthetic-foreign|bridge'
      }
      return result
    },
  }) }
})

function nativeTargetMatches(value: unknown, bridge: string, kind: 'bridge' | 'veth') {
  if (!nativeObject(value) || !nativeObject(value.linkinfo) || value.linkinfo.info_kind !== kind) return false
  if (kind === 'bridge' ? value.ifname !== bridge : value.master !== bridge) return false
  return Number.isSafeInteger(value.ifindex) && Number(value.ifindex) > 0
    && typeof value.ifname === 'string' && /^[a-zA-Z0-9_.-]{1,15}$/.test(value.ifname)
    && Array.isArray(value.flags) && value.flags.includes('UP')
    && Array.isArray(value.addr_info) && value.addr_info.length <= 16
}
afterEach(() => {
  fault.poolCreate = false; fault.foreignInventory = false; fault.observeGate = false
  fault.gateChildren = 0; fault.closedGateChildren = 0; fault.tentativeObserved = false; fault.missingIPv6Observed = false
  vi.restoreAllMocks()
})

async function actualOwnedAddressSnapshot(networkId: unknown) {
  if (typeof networkId !== 'string' || !/^[a-f0-9]{64}$/.test(networkId)) throw new Error('Native owned address identity unavailable')
  const bridge = 'br-' + networkId.slice(0, 12)
  const { execFile } = await import('node:child_process'), { promisify } = await import('node:util')
  const exec = promisify(execFile), selected: unknown[][] = []
  for (const selector of [['dev', bridge], ['master', bridge, 'type', 'veth']]) {
    try {
      const result = await exec('ip', ['-j', '-d', 'address', 'show', ...selector], {
        shell: false, windowsHide: true, encoding: 'utf8', env: { PATH: process.env.PATH, LC_ALL: 'C' }, timeout: 1000, killSignal: 'SIGKILL', maxBuffer: 32768,
      })
      const values: unknown = JSON.parse(result.stdout), addressState = kernelAddressState(result.stdout)
      if (result.stderr || !Array.isArray(values) || !addressState.valid || !addressState.ready) throw new Error('Native owned address snapshot unavailable')
      selected.push(values)
    } catch { throw new Error('Native owned address snapshot unavailable') }
  }
  const indexes = new Set<number>(), names = new Set<string>()
  const targetsMatch = selected.every((values, index) => values.length === (index === 0 ? 1 : 3) && values.every(value => {
    if (!nativeObject(value) || !nativeTargetMatches(value, bridge, index === 0 ? 'bridge' : 'veth')) return false
    const name = String(value.ifname), ifindex = Number(value.ifindex)
    if (indexes.has(ifindex) || names.has(name)) return false
    indexes.add(ifindex); names.add(name); return true
  }))
  return { scopeConfirmed: targetsMatch, addressesReady: true, bridgeCount: selected[0].length, vethCount: selected[1].length }
}

async function noResidue(runId: string) {
  const { execFile } = await import('node:child_process'), { promisify } = await import('node:util')
  const exec = promisify(execFile), prefix = fixtureDockerEndpoint(process.platform).args
  for (const command of [['ps', '-aq'], ['network', 'ls', '-q'], ['volume', 'ls', '-q']]) {
    const result = await exec('docker', [...prefix, ...command, '--filter', `label=projetv0.template.auth-fixture=${runId}`],
      { env: fixtureDockerEnvironment(), timeout: 120000, maxBuffer: 1024 * 1024 })
    expect(result.stdout.trim()).toBe('')
  }
}

test('linux_owned_store_lifecycle', async () => {
  expect(process.platform).toBe('linux')
  fault.observeGate = true
  const stores = await startDisposableStores().finally(() => { fault.observeGate = false })
  try {
    expect(fault.gateChildren > 0 && fault.gateChildren === fault.closedGateChildren).toBe(true)
    expect(stores.evidence.addressReadiness).toMatchObject({ scope: 'confirmed', state: 'ready', bridgeCount: 1, vethCount: 3 })
    const snapshot = await actualOwnedAddressSnapshot(stores.evidence.network)
    expect(snapshot).toEqual({ scopeConfirmed: true, addressesReady: true, bridgeCount: 1, vethCount: 3 })
    // Only real initial-gate address observations may support natural race reproduction.
    stores.evidence.nativeAddressReadiness = {
      checkedBeforeMigration: true, gateChildrenClosedAtReturn: true, ...snapshot,
      tentativeObserved: fault.tentativeObserved, missingIPv6Observed: fault.missingIPv6Observed,
      naturalRaceReproduced: fault.tentativeObserved || fault.missingIPv6Observed,
      versions: { nodeMatchesPin: process.versions.node === '24.14.0', kernelObserved: /^[0-9]+\.[0-9]+\.[0-9]+/.test(release()) },
    }
    await stores.migrate()
    expect((await stores.administrator.query('SHOW server_version_num')).rows[0].server_version_num).toBe('160015')
    const role = (await stores.administrator.query("SELECT rolsuper, rolinherit, rolbypassrls FROM pg_roles WHERE rolname='runtime'")).rows[0]
    expect(role).toEqual({ rolsuper: false, rolinherit: false, rolbypassrls: false })
    expect((await stores.administrator.query("SELECT count(*)::int AS owned FROM pg_class WHERE relnamespace='public'::regnamespace AND relowner=(SELECT oid FROM pg_roles WHERE rolname='runtime')")).rows[0].owned).toBe(0)
    const pool = await stores.poolAdmin()
    try {
      const config = new Map((await pool.query('SHOW CONFIG')).rows.map(row => [row.key, row.value]))
      expect(config.get('pool_mode')).toBe('transaction')
      expect(config.get('max_prepared_statements')).toBe('0')
    } finally { await pool.end() }
    const identities: { session_user: string; oid: string }[] = []
    for (const url of [stores.voiceUrlA, stores.voiceUrlB, stores.voiceUrlShared]) {
      const client = new Client({ connectionString: url, connectionTimeoutMillis: 1000 })
      try { await client.connect(); identities.push((await client.query('SELECT session_user, (SELECT oid::text FROM pg_roles WHERE rolname=session_user) AS oid')).rows[0]) }
      finally { await client.end() }
    }
    expect(identities.map(identity => identity.session_user)).toEqual(['sparra_voice_a', 'sparra_voice_b', 'sparra_voice_shared'])
    expect(new Set(identities.map(identity => identity.oid)).size).toBe(3)
    const redis = createClient({ url: stores.redisUrl }); redis.on('error', () => {})
    try {
      await redis.connect(); expect(await redis.ping()).toBe('PONG')
      expect(await redis.sendCommand(['CLIENT', 'INFO'])).toMatch(/(?:^|\s)db=0(?:\s|$)/)
    } finally { if (redis.isOpen) redis.destroy() }
    const publicAddress = new URL(stores.redisUrl); publicAddress.password = ''; publicAddress.username = ''
    const unauthenticated = createClient({ url: publicAddress.href, socket: { reconnectStrategy: false } })
    unauthenticated.on('error', () => {})
    try {
      await expect(async () => { await unauthenticated.connect(); await unauthenticated.ping() }).rejects.toThrow(/NOAUTH/)
    } finally { if (unauthenticated.isOpen) unauthenticated.destroy() }
  } finally { await stores.cleanup() }
  expect(stores.evidence.unrelatedUnchanged).toBe(true)
  expect(stores.evidence).not.toHaveProperty('cleanupFailures')
  await noResidue(String(stores.evidence.runId))
}, 120000)

test('partial_start_cleanup_preserves_inventory', async () => {
  expect(process.platform).toBe('linux')
  const logs = vi.spyOn(console, 'log')
  fault.poolCreate = true
  await expect(startDisposableStores()).rejects.toThrow('Disposable Docker operation failed: create')
  const line = logs.mock.calls.map(call => String(call[0])).find(value => value.startsWith('AUTH_STORE_EVIDENCE '))
  expect(line).toBeDefined()
  const evidence = JSON.parse(line!.slice('AUTH_STORE_EVIDENCE '.length))
  expect(evidence.unrelatedUnchanged).toBe(true)
  expect(evidence).not.toHaveProperty('cleanupFailures')
  await noResidue(evidence.runId)
}, 120000)

test('foreign_inventory_drift_fails', async () => {
  expect(process.platform).toBe('linux')
  const stores = await startDisposableStores()
  fault.foreignInventory = true
  try { await expect(stores.cleanup()).rejects.toThrow('Disposable fixture cleanup failed: inventory') }
  finally { fault.foreignInventory = false }
  expect(stores.evidence.unrelatedUnchanged).toBe(false)
  expect(stores.evidence.inventoryDelta).toEqual([{ kind: 'network', id: 'synthetic-foreign-network', ownership: 'foreign', change: 'added', fields: ['Id', 'Name', 'Driver'] }])
  await noResidue(String(stores.evidence.runId))
}, 120000)
