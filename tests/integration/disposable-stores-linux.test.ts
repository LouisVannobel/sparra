import { afterEach, expect, test, vi } from 'vitest'
import { Client } from 'pg'
import { createClient } from 'redis'
import { fixtureDockerEndpoint, fixtureDockerEnvironment } from '../fixtures/db/docker-endpoint'
import { startDisposableStores } from '../fixtures/db/disposable-stores'

// Fault injection stays below the real lifecycle; no foreign resource is changed.
const fault = vi.hoisted(() => ({ poolCreate: false, foreignInventory: false }))
vi.mock('node:child_process', async original => {
  const module = await original<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  const exec = promisify(module.execFile)
  return { ...module, execFile: Object.assign(module.execFile.bind(module), {
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
afterEach(() => { fault.poolCreate = false; fault.foreignInventory = false; vi.restoreAllMocks() })

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
  const stores = await startDisposableStores()
  try {
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
