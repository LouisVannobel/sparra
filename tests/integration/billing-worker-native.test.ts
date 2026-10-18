import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Pool } from 'pg'
import { Effect, Schema } from 'effect'
import type { HatchetClient } from '@hatchet-dev/typescript-sdk/v1/index.js'
import { startDisposableStores, startDisposableHatchet } from '../fixtures/db/disposable-stores'
import { startMailHttpPeer } from '../fixtures/mail-http'
import { bounded } from '../helpers/web-process'
import { startStripeFinancialPeer } from '../helpers/stripe-financial-protocol-peer'
import { billingWorkerClaim, installBillingReadReplies, seedBillingWorker } from '../helpers/billing-worker-fixture'
import { checkoutOperation, config, termsA, termsB, workspaceId } from '../helpers/billing-fixtures'
import { createMailWorkerResources } from '../../src/platform/mail-runtime.server'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { createBillingStore } from '../../src/modules/billing/store.server'
import { authorizeEmailRequest, materializeDelivery } from '../../src/modules/auth/auth-email-store.server'
import { createAuthEmailEnvelope } from '../../src/modules/auth/auth-email-envelope.server'

type NativeObservation = { clients: HatchetClient[]; disposed: Set<HatchetClient>; sqlStops: string[]; mailCa: string;
  peer: Awaited<ReturnType<typeof startStripeFinancialPeer>> | undefined;
  target: { nativeTenant: string; outboxId: string; workspaceId: string } | null;
  armed: boolean; targetPosts: number; losses: number; acknowledgedRun: string | null }
const nativeJob = Schema.Struct({ outboxId: Schema.String, tenantId: Schema.String })
const wire = vi.hoisted((): NativeObservation => ({ clients: [], disposed: new Set(), sqlStops: [], mailCa: '',
  peer: undefined, target: null, armed: false, targetPosts: 0, losses: 0, acknowledgedRun: null,
}))
vi.mock('../../src/modules/auth/plunk.server', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/modules/auth/plunk.server')>()
  return { ...actual, createPlunkTransport: (binding: Parameters<typeof actual.createPlunkTransport>[0]) => actual.createPlunkTransport(binding, { ca: wire.mailCa }) }
})
vi.mock('../../src/modules/auth/mail-hatchet.server', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/modules/auth/mail-hatchet.server')>()
  return { ...actual, createAuthMailHatchet: (...args: Parameters<typeof actual.createAuthMailHatchet>) => {
    const client = actual.createAuthMailHatchet(...args)
    const dispose = client.dispose.bind(client)
    client.dispose = async () => { await dispose(); wire.disposed.add(client) }
    const trigger = client.api.v1WorkflowRunCreate.bind(client.api)
    client.api.v1WorkflowRunCreate = (tenant, data, params) => {
      const input = data.input
      const target = wire.target
      let job: typeof nativeJob.Type | null = null
      try { job = Schema.decodeUnknownSync(nativeJob)(input, { onExcessProperty: 'error' }) } catch { /* Unrelated native requests retain their original result. */ }
      const selected = !!target && tenant === target.nativeTenant && data.workflowName === 'billing-reconciliation'
        && data.return_only_id === true && job?.outboxId === target.outboxId && job.tenantId === target.workspaceId
      if (selected) wire.targetPosts++
      const lose = selected && wire.armed
      if (lose) wire.armed = false
      const original = trigger(tenant, data, params)
      if (!lose) return original
      // Controlled post-response ACK uncertainty, not actual network ACK loss.
      // Keep the real request handle so the production REST owner still joins it.
      return original.then(response => {
        const id = response.data.run?.metadata?.id
        if (response.status !== 200 || typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) return response
        wire.losses++; wire.acknowledgedRun = id
        throw Object.assign(new Error('Synthetic admission ACK unavailable after native response'), { request: response.request, response })
      })
    }
    wire.clients.push(client)
    return client
  } }
})
vi.mock('../../src/platform/db/resources.server', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/platform/db/resources.server')>()
  return { ...actual, acquireDatabase: (...args: Parameters<typeof actual.acquireDatabase>) => actual.acquireDatabase(...args).pipe(
    Effect.map(database => ({ ...database, stop() {
      const client = wire.clients.at(-1)
      expect(client && wire.disposed.has(client)).toBe(true)
      if (wire.peer) expect(wire.peer.evidence().clientSockets).toBe(0)
      wire.sqlStops.push(args[1] ?? 'runtime')
      database.stop()
    } })),
  ) }
})

let stores: Awaited<ReturnType<typeof startDisposableStores>>, engine: Awaited<ReturnType<typeof startDisposableHatchet>>
let mail: Awaited<ReturnType<typeof startMailHttpPeer>>, billingUrls: Awaited<ReturnType<typeof seedBillingWorker>>
let runtimePool: Pool, owner: ReturnType<typeof createTransactions>, ingress: ReturnType<typeof createBillingStore>
let running: ReturnType<typeof createMailWorkerResources> | undefined
let child: ReturnType<typeof spawn> | undefined, exited: Promise<number | null> | undefined
const key = randomBytes(32), envelope = createAuthEmailEnvelope({ currentKeyId: 'native', keys: { native: key } })
const logins = ['auth_mail_relay', 'auth_mail_worker', 'billing_relay', 'billing_worker']
beforeAll(async () => {
  stores = await startDisposableStores(); await stores.migrate()
  billingUrls = await seedBillingWorker(stores)
  await stores.administrator.query('GRANT USAGE ON SCHEMA public TO runtime; GRANT SELECT,INSERT,UPDATE ON auth_email_request,auth_email_command,email_delivery,auth_email_outbox TO runtime; GRANT SELECT,UPDATE ON "user" TO runtime')
  engine = await startDisposableHatchet()
  mail = await startMailHttpPeer(); wire.mailCa = await readFile(mail.certificate, 'utf8')
  runtimePool = new Pool({ connectionString: stores.directRuntimeUrl, max: 1 }); runtimePool.on('error', () => {})
  owner = createTransactions(runtimePool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
  ingress = createBillingStore(owner)
}, 300000)
beforeEach(() => {
  wire.clients.length = 0; wire.disposed.clear(); wire.sqlStops.length = 0
  wire.target = null; wire.armed = false; wire.targetPosts = 0; wire.losses = 0; wire.acknowledgedRun = null
})
afterEach(async () => {
  const failures: unknown[] = []
  try { await running?.dispose() } catch (error) { failures.push(error) }
  running = undefined
  if (child) {
    try {
      if (child.exitCode === null && child.signalCode === null) child.send('shutdown')
      if (exited) expect(await bounded(exited, 15000)).toBe(0)
    } catch (error) { failures.push(error); child.kill('SIGKILL'); if (exited) await bounded(exited, 6000).catch(() => {}) }
  }
  child = undefined; exited = undefined
  if (wire.peer) {
    try { await expect.poll(wire.peer.evidence).toEqual({ clientSockets: 0, serverSockets: 0, requests: 0, responses: 0 }); await wire.peer.close() }
    catch (error) { failures.push(error) }
    wire.peer = undefined
  }
  if (failures.length) throw new AggregateError(failures, 'Billing worker native retirement failed')
}, 30000)
afterAll(async () => {
  const failures: unknown[] = []
  for (const close of [() => runtimePool?.end(), () => mail?.close(), () => engine?.cleanup(), () => stores?.cleanup()]) {
    try { await close() } catch (error) { failures.push(error) }
  }
  key.fill(0); wire.mailCa = ''
  expect(stores.evidence.unrelatedUnchanged).toBe(true)
  expect(stores.evidence.inventoryDelta).toEqual([])
  if (failures.length) throw new AggregateError(failures, 'Billing worker native fixture cleanup failed')
}, 30000)

function environment(withMail = false) {
  return { NODE_ENV: 'test', APP_ORIGIN: config.origin, DB_POOL_MAX: '2', DB_STATEMENT_TIMEOUT_MS: '1000', DB_CLEANUP_TIMEOUT_MS: '1000',
    HATCHET_CLIENT_TOKEN: engine.config.token, HATCHET_CLIENT_HOST_PORT: engine.config.host_port,
    HATCHET_CLIENT_API_URL: engine.config.api_url, HATCHET_CLIENT_TLS_STRATEGY: 'none',
    STRIPE_API_KEY: 'sk_test_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_fixture', STRIPE_ACCOUNT_ID: config.accountId, STRIPE_ENVIRONMENT: config.environment,
    BILLING_RELAY_DATABASE_URL: billingUrls.relay, BILLING_WORKER_DATABASE_URL: billingUrls.worker,
    ...(withMail ? { AUTH_MAIL_RELAY_DATABASE_URL: stores.mailRelayUrl, AUTH_MAIL_WORKER_DATABASE_URL: stores.mailWorkerUrl,
      AUTH_MAIL_KEY_ID: 'native', AUTH_MAIL_KEYS_JSON: JSON.stringify({ native: key.toString('base64') }),
      AUTH_MAIL_PROJECT_ID: 'fixture', AUTH_MAIL_CREDENTIAL_ID: 'native', AUTH_MAIL_API_ORIGIN: mail.origin, AUTH_MAIL_PLUNK_SECRET: 'sk_synthetic' } : {}) }
}
async function start(withMail = false) {
  running = createMailWorkerResources(environment(withMail), engine.clientConfigPath)
  await running.ready()
  const client = wire.clients.at(-1)
  if (!client) throw new Error('Actual composed client was not observed')
  return client
}
async function command(eventId: string) {
  const rows = (await stores.administrator.query<{ id: string; command_id: string; run_id: string | null; admission_state: string; completed_at: Date | null }>(
    'SELECT o.id,o.command_id,o.run_id,o.admission_state,c.completed_at FROM billing_event_receipt r JOIN billing_command c ON c.receipt_id=r.id JOIN billing_outbox o ON o.command_id=c.id WHERE r.event_id=$1', [eventId])).rows
  expect(rows).toHaveLength(1)
  return rows[0]!
}
async function receive(eventId: string) {
  // Durable worker ingress is tested here; HTTP signature admission remains in
  // billing-consumer-webhook.test.ts and is not claimed by this direct store call.
  const event = { ...billingWorkerClaim().event, id: eventId }
  await ingress.receive(event, new AbortController().signal)
  return command(eventId)
}
async function peer(options: Parameters<typeof installBillingReadReplies>[1] = {}) {
  wire.peer = await startStripeFinancialPeer(); installBillingReadReplies(wire.peer, options)
  return wire.peer
}
async function closedWorker() {
  await running?.dispose(); running = undefined
  await expect.poll(async () => (await stores.administrator.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename=ANY($1::text[])',
    [['billing_relay', 'billing_worker']])).rows[0].n).toBe(0)
  // Mail uses PgBouncer: its retained server backends are not application pools.
  const poolAdmin = await stores.poolAdmin()
  try {
    await expect.poll(async () => (await poolAdmin.query<{ user: string }>('SHOW CLIENTS')).rows
      .filter(row => row.user === 'auth_mail_relay' || row.user === 'auth_mail_worker').length).toBe(0)
  } finally { await poolAdmin.end() }
}

test('compiled billing-only worker registers and drains with no mail configuration or provider effect', async () => {
  let output = ''
  child = spawn(process.execPath, ['--import', pathToFileURL(resolve('tests/helpers/mail-process.mjs')).href, resolve('.output/worker/index.mjs')], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, ...environment(),
    },
  })
  child.stdout!.on('data', chunk => { output += String(chunk) }); child.stderr!.on('data', chunk => { output += String(chunk) })
  exited = new Promise<number | null>((done, reject) => { child!.once('error', reject); child!.once('close', done) })
  await expect.poll(() => output.includes('Application worker ready'), { timeout: 25000 }).toBe(true)
  const response = await fetch(`${engine.config.api_url}/api/v1/tenants/${engine.tenantId}/workflows?limit=100&offset=0`, {
    headers: { authorization: `Bearer ${engine.config.token}` }, signal: AbortSignal.timeout(3000), redirect: 'error' })
  expect(response.status).toBe(200)
  const body: unknown = await response.json()
  expect(body).toMatchObject({ rows: [{ name: 'billing-reconciliation' }] })
  expect((await stores.administrator.query('SELECT usename,count(*)::int AS n FROM pg_stat_activity WHERE usename=ANY($1::text[]) GROUP BY usename ORDER BY usename', [logins])).rows)
    .toEqual([{ usename: 'billing_relay', n: 1 }, { usename: 'billing_worker', n: 1 }])
  child.send('shutdown'); expect(await bounded(exited, 15000)).toBe(0)
  expect(output.includes('billing-handler-stopped')).toBe(true)
  expect(output.includes('Application worker stopped')).toBe(true)
}, 45000)

test('three native mail arrivals finish while billing waits on owned SQL, then immutable A reconciles after B beyond startup deadline', async () => {
  const pending = await receive('evt_nativeSqlWait')
  await stores.administrator.query('BEGIN')
  await stores.administrator.query('SELECT id FROM billing_command WHERE id=$1 FOR UPDATE', [pending.command_id])
  let locked = true
  try {
    const client = await start(true)
    expect((await client.workflows.list()).rows?.map(row => row.name).sort()).toEqual(['auth-email-delivery', 'billing-reconciliation'])
    expect((await stores.administrator.query('SELECT usename,count(*)::int AS n FROM pg_stat_activity WHERE usename=ANY($1::text[]) GROUP BY usename ORDER BY usename', [logins])).rows)
      .toEqual([...logins].sort().map(usename => ({ usename, n: 1 })))
    // Real lifetime tasks must remain admissible after the15000ms startup window.
    await new Promise(resolve => setTimeout(resolve, 15500))
    const options = () => ({ deadlineAtMs: Date.now() + 5000, statementTimeoutMs: 1000, cleanupTimeoutMs: 1000, correlationId: randomUUID() })
    for (let arrival = 0; arrival < 3; arrival++) {
      const before = performance.now()
      const command = await owner.withAuthPromise(options(), lease => authorizeEmailRequest(lease, {
        email: `native-${randomUUID()}@example.test`, purpose: 'magic-link', locale: 'en', expectedGeneration: 0, lifetimeSeconds: 600 }))
      const delivery = await owner.withAuthPromise(options(), lease => materializeDelivery(lease, command.id, envelope, {
        appOrigin: 'https://app.example.test', apiOrigin: mail.origin, projectId: 'fixture', credentialId: 'native',
        from: { name: 'Product', email: 'auth@example.test' }, reply: 'reply@example.test', replayWindowSeconds: null }))
      if (!delivery) throw new Error('Owned native mail delivery was not materialized')
      await expect.poll(async () => (await stores.administrator.query('SELECT provider_state FROM email_delivery WHERE id=$1', [delivery.id])).rows[0].provider_state,
        { timeout: 45000 }).toBe('plunk_queued')
      expect(performance.now() - before).toBeLessThan(45000)
      expect((await commandForPending()).completed_at).toBeNull()
    }
    expect(mail.evidence().calls).toBe(3)
    // The3a Stripe peer blocks other HTTPS, so activate it only after mail has
    // finished. This proves mail during a SQL wait, not during a Stripe read.
    await peer()
    await stores.administrator.query('INSERT INTO billing_agreed_terms(id,workspace_id,environment,account_id,revision,monthly_price_id,currency,monthly_unit_amount) VALUES($1,$2,\'sandbox\',\'acct_fixture\',2,$3,\'eur\',$4)',
      [termsB.id, workspaceId, termsB.monthlyPriceId, termsB.monthlyUnitAmount])
    await stores.administrator.query('COMMIT'); locked = false
    await expect.poll(async () => (await command('evt_nativeSqlWait')).completed_at, { timeout: 60000 }).not.toBeNull()
    expect((await stores.administrator.query('SELECT count(*)::int AS n FROM billing_agreement WHERE workspace_id=$1', [workspaceId])).rows[0].n).toBe(1)
    expect((await stores.administrator.query('SELECT a.operation_id,o.agreed_terms_id,a.proof FROM billing_agreement a JOIN billing_operation o ON o.id=a.operation_id WHERE a.workspace_id=$1', [workspaceId])).rows)
      .toMatchObject([{ operation_id: checkoutOperation.id, agreed_terms_id: termsA.id, proof: { amount: 1500, currency: 'eur' } }])
    await closedWorker()
    expect([...wire.sqlStops].sort()).toEqual([...logins].sort())
  } finally { if (locked) await stores.administrator.query('ROLLBACK') }
  function commandForPending() { return command('evt_nativeSqlWait') }
}, 180000)

test('post-response native admission ACK loss resolves the same durable outbox and run with one dispatch', async () => {
  const pending = await receive('evt_nativeAckLoss')
  await peer()
  wire.target = { nativeTenant: engine.tenantId, outboxId: pending.id, workspaceId }; wire.armed = true
  const client = await start()
  await expect.poll(() => wire.acknowledgedRun, { timeout: 15000 }).not.toBeNull()
  await expect.poll(async () => (await command('evt_nativeAckLoss')).admission_state, { timeout: 45000 }).toBe('retired')
  const settled = await command('evt_nativeAckLoss')
  expect(settled.id).toBe(pending.id); expect(settled.run_id).toBe(wire.acknowledgedRun); expect(settled.completed_at).not.toBeNull()
  expect(wire.targetPosts).toBe(1); expect(wire.losses).toBe(1)
  expect((await client.runs.get(settled.run_id!)).run.status).toBe('COMPLETED')
  await closedWorker()
}, 70000)

test('native worker shutdown during a held Stripe read body joins the client transport before billing SQL stop', async () => {
  await receive('evt_nativeHeldBody')
  const transport = await peer({ holdInvoice: 'body' })
  await start()
  await expect.poll(() => transport.requests().some(request => request.path === '/v1/invoices/in_fixture123'), { timeout: 15000 }).toBe(true)
  await closedWorker()
  expect(transport.evidence().clientSockets).toBe(0)
  expect([...wire.sqlStops].sort()).toEqual(['billing_relay', 'billing_worker'])
}, 45000)
