import { test } from 'vitest'
import { Schema } from 'effect'
import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Pool, type Client } from 'pg'
import { V1TaskStatus, V1TaskEventType } from '@hatchet-dev/typescript-sdk/clients/rest/generated/data-contracts.js'
import { startDisposableStores, startDisposableHatchet } from '../fixtures/db/disposable-stores'
import { startMailHttpPeer } from '../fixtures/mail-http'
import { checkedRetryInterval, expiryGate, retryBudget, retryFixtureError, retryLabels, deferredCodes, retryCommandOperation, retryChildPhase, safeRetryParentPhase, appendRetryCommandReceipt, type RetryLabel } from '../helpers/mail-retry-observation'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { authorizeEmailRequest, materializeDelivery } from '../../src/modules/auth/auth-email-store.server'
import { createAuthEmailEnvelope } from '../../src/modules/auth/auth-email-envelope.server'

const uuid = Schema.String.check(Schema.isUUID())
const stamp = Schema.String.check(Schema.isMaxLength(64), Schema.isPattern(/^\d{4}-\d\d-\d\d[T ][0-9:.]+(?:Z|[+-][0-9:]+)$/))
const label = Schema.Literals(retryLabels)
const status = Schema.Literals(Object.values(V1TaskStatus))
const historySchema = Schema.Struct({ status, events: Schema.Array(Schema.Struct({ id: Schema.Int, taskId: uuid, timestamp: stamp,
  eventType: Schema.Literals(Object.values(V1TaskEventType)), retryCount: Schema.NullOr(Schema.Int), attempt: Schema.NullOr(Schema.Int),
  code: Schema.NullOr(Schema.Literals(deferredCodes)), unclassifiedError: Schema.Boolean })).check(Schema.isMaxLength(100)) })
const beforeSchema = Schema.Struct({ type: Schema.Literal('before'), label, outboxId: uuid, runId: uuid, taskId: uuid,
  retryCount: Schema.Int, hookId: Schema.String.check(Schema.isPattern(/^[A-E]:[a-f0-9-]{36}:[0-9]+$/)), gated: Schema.Boolean })
const businessState = Schema.Literals(['inert', 'cancelled', 'held', 'effect_unknown', 'plunk_queued'])
const eventSchema = Schema.Union([
  beforeSchema,
  Schema.Struct({ type: Schema.Literal('ready'), sdk: Schema.Literal('1.28.2'), engine: Schema.Literal('v0.101.27'), tenantId: uuid,
    policy: Schema.Struct({ retries: Schema.Literal(4), factor: Schema.Literal(5), cap: Schema.Literal(30), execution: Schema.Literal('30s'), schedule: Schema.Literal('10m'), ttl: Schema.Literal(600000), clientAttempts: Schema.Literal(1) }) }),
  Schema.Struct({ type: Schema.Literals(['lookup-held', 'lookup-returned']), label: Schema.Literal('A') }),
  Schema.Struct({ type: Schema.Literal('handler-settled'), label, state: Schema.Literals(['inert', 'cancelled', 'held', 'effect_unknown', 'plunk_queued', 'deferred']),
    reason: Schema.NullOr(Schema.Literals(['worker_stopping', 'outbox_in_flight', 'capacity_busy', 'claim_unresolved'])) }),
  Schema.Struct({ type: Schema.Literal('outcome'), label, runId: uuid, taskId: uuid, retryCount: Schema.Int,
    outcome: Schema.Struct({ state: businessState, queuedEvidence: Schema.optional(Schema.Literals(['response_200', 'duplicate_409'])), emailId: Schema.optional(Schema.NullOr(uuid)) }) }),
  Schema.Struct({ type: Schema.Literals(['closing', 'fatal']) }),
  Schema.Struct({ type: Schema.Literal('stopped'), nativeStartState: Schema.Literals(['pending', 'resolved', 'rejected']),
    nativeStopState: Schema.Literals(['not-started', 'resolved', 'rejected']), pendingHooks: Schema.Int, commandsJoined: Schema.Boolean }),
])
type Observation = typeof eventSchema.Type
type Hook = typeof beforeSchema.Type
type History = typeof historySchema.Type
const requireFact = (value: unknown) => { if (value !== true) throw retryFixtureError() }
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
function decode<A>(schema: Schema.Codec<A>, value: unknown): A {
  try { return Schema.decodeUnknownSync(schema)(value, { onExcessProperty: 'error' }) }
  catch { throw retryFixtureError() }
}

// Explicitly excluded from every non-native command. timeout:0 keeps the WHOLE
// acquisition/cleanup lifecycle awaited; it does not extend observation/stop.
test('I3 one owned native retry fixture: retained A/B, transient C, expired E, exhausted D', { timeout: 0 }, async () => {
  const evidenceId = randomUUID(), setupStarted = performance.now()
  const evidence: Record<string, unknown> = { evidenceId, nativeObservationLimitMs: 300000, normalStopObservationMs: 15000 }
  const cleanupReceipts: Record<string, boolean> = {}
  let peer: Awaited<ReturnType<typeof startMailHttpPeer>> | undefined
  let stores: Awaited<ReturnType<typeof startDisposableStores>> | undefined
  let engine: Awaited<ReturnType<typeof startDisposableHatchet>> | undefined
  let pool: Pool | undefined, child: ReturnType<typeof spawn> | undefined, exited: Promise<void> | undefined
  let processClosed = false, processCode: number | null = null, forced = false, outputBytes = 0, fatal = false, success = false, rowLocked = false
  let budget: ReturnType<typeof retryBudget> | undefined, nextCommand = 0
  const events: Observation[] = []
  const replies = new Map<number, { settle(value: unknown): void; reject(): void }>()
  const cases = new Map<RetryLabel, { id: string; outboxId: string; runId: string }>()
  const histories: Partial<Record<RetryLabel, History>> = {}
  const intervals: ReturnType<typeof checkedRetryInterval>[] = []
  const peerReceipts: { phase: string; calls: number }[] = []
  const phases: ReturnType<typeof safeRetryParentPhase>[] = [], commandReceipts: unknown[] = []
  let firstAHistory = true
  function checkLive() { if (fatal || processClosed) throw retryFixtureError() }
  async function waitFor<A>(read: () => A | undefined): Promise<A> {
    for (;;) {
      checkLive()
      const value = read(); if (value !== undefined) return value
      await pause(budget ? budget.remaining(25) : 25)
    }
  }
  function ask(op: string, fields: Record<string, unknown> = {}) {
    checkLive()
    const timeout = budget!.remaining(10000), id = ++nextCommand
    return new Promise<unknown>((settle, reject) => {
      const timer = setTimeout(() => { replies.delete(id); reject(retryFixtureError()) }, timeout)
      replies.set(id, { settle(value) { clearTimeout(timer); replies.delete(id); settle(value) }, reject() { clearTimeout(timer); replies.delete(id); reject(retryFixtureError()) } })
      child!.send({ id, op, ...fields }, error => { if (error) replies.get(id)?.reject() })
    })
  }
  async function query(client: Client, text: string, values: unknown[] = []) {
    const limit = budget!.remaining(1000)
    // SET itself is observed and awaited; the subsequent query is server-bounded.
    await client.query(`SET statement_timeout = ${limit}`)
    await client.query(`SET statement_timeout = ${budget!.remaining(1000)}`)
    budget!.remaining(1000)
    return (await client.query(text, values)).rows
  }
  async function hook(which: RetryLabel, retryCount: number) {
    return waitFor(() => events.find((event): event is Hook => event.type === 'before' && event.label === which && event.retryCount === retryCount))
  }
  async function history(which: RetryLabel) {
    const first = which === 'A' && firstAHistory
    if (first) { firstAHistory = false; phases.push(safeRetryParentPhase('a-first-history-started')) }
    const result = decode(historySchema, await ask('history', { label: which }))
    const owned = cases.get(which)!
    const firstHook = await hook(which, 0)
    requireFact(result.events.every(row => row.taskId === firstHook.taskId && (which === 'A' || !row.unclassifiedError)))
    requireFact(firstHook.runId === owned.runId)
    histories[which] = result
    if (first) phases.push(safeRetryParentPhase('a-first-history-completed'))
    return result
  }
  async function nativeUntil(which: RetryLabel, predicate: (value: History) => boolean) {
    for (;;) { const value = await history(which); if (predicate(value)) return value; await pause(budget!.remaining(50)) }
  }
  function received(phase: string, calls: number) {
    const actual = peer!.evidence().calls
    peerReceipts.push({ phase, calls: actual }); requireFact(actual === calls)
  }
  async function delivery(which: RetryLabel) {
    const rows = await query(stores!.administrator, `SELECT d.provider_state AS "providerState", d.provider_fence AS fence,
      d.state, d.ciphertext IS NULL AS purged, d.first_attempt_at IS NULL AS unattempted,
      o.admission_state AS admission, o.run_id AS "runId", c.expires_at::text AS expiry, c.created_at::text AS created,
      extract(epoch FROM (c.expires_at-c.created_at))::float8 AS "lifetimeSeconds",
      clock_timestamp() < c.expires_at AS "beforeExpiry", clock_timestamp() >= c.expires_at AS expired
      FROM email_delivery d JOIN auth_email_outbox o ON o.delivery_id=d.id JOIN auth_email_command c ON c.id=d.command_id WHERE d.id=$1`, [cases.get(which)!.id])
    requireFact(rows.length === 1)
    return decode(Schema.Struct({ providerState: Schema.Literals(['unattempted', 'attempting', 'effect_unknown', 'plunk_queued', 'held']), fence: Schema.Int,
      state: Schema.Literals(['active', 'consumed', 'terminal', 'superseded', 'expired']), purged: Schema.Boolean, unattempted: Schema.Boolean,
      admission: Schema.Literal('admitted'), runId: uuid, expiry: stamp, created: stamp, lifetimeSeconds: Schema.Number, beforeExpiry: Schema.Boolean, expired: Schema.Boolean }), rows[0])
  }
  async function lock(which: RetryLabel) {
    requireFact(!rowLocked)
    await query(stores!.administrator, 'BEGIN'); rowLocked = true
    const rows = await query(stores!.administrator, 'SELECT id FROM email_delivery WHERE id=$1 FOR UPDATE', [cases.get(which)!.id])
    requireFact(rows.length === 1)
  }
  async function unlock() { if (rowLocked) { await stores!.administrator.query('ROLLBACK'); rowLocked = false } }
  try {
    const hashes: Record<string, string> = {}
    for (const path of ['src/modules/auth/mail-worker.server.ts', 'src/modules/auth/mail-hatchet.server.ts', 'src/modules/auth/plunk.server.ts',
      'tests/helpers/mail-retry-harness.ts', 'tests/helpers/mail-retry-observation.ts', 'tests/integration/mail-retry-native.test.ts', '.output/worker/index.mjs', '.output/test-mail-retry/harness.mjs']) {
      hashes[path] = createHash('sha256').update(await readFile(resolve(path))).digest('hex')
    }
    evidence.beforeLaunchSha256 = hashes
    peer = await startMailHttpPeer(); evidence.tlsAcquiredMs = performance.now() - setupStarted
    stores = await startDisposableStores(); evidence.storesAcquiredMs = performance.now() - setupStarted
    await stores.migrate()
    await stores.administrator.query('GRANT USAGE ON SCHEMA public TO runtime; GRANT SELECT,INSERT,UPDATE ON auth_email_request,auth_email_command,email_delivery,auth_email_outbox TO runtime; GRANT SELECT,UPDATE ON "user" TO runtime')
    engine = await startDisposableHatchet(); evidence.engineAcquiredMs = performance.now() - setupStarted
    await stores.administrator.query('SET statement_timeout = 1000')
    await engine.administrator.query('SET statement_timeout = 1000')
    pool = new Pool({ connectionString: stores.runtimeUrl }); pool.on('error', () => {})
    const key = randomBytes(32), codec = createAuthEmailEnvelope({ currentKeyId: 'native', keys: { native: key } })
    const apiOrigin = peer.origin.replace('127.0.0.1', 'localhost')
    child = spawn(process.execPath, [resolve('.output/test-mail-retry/harness.mjs')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
      NODE_ENV: 'test', NODE_EXTRA_CA_CERTS: peer.certificate,
      AUTH_MAIL_RELAY_DATABASE_URL: stores.mailRelayUrl, AUTH_MAIL_WORKER_DATABASE_URL: stores.mailWorkerUrl,
      AUTH_MAIL_KEY_ID: 'native', AUTH_MAIL_KEYS_JSON: JSON.stringify({ native: key.toString('base64') }),
      AUTH_MAIL_PROJECT_ID: 'fixture', AUTH_MAIL_CREDENTIAL_ID: 'native', AUTH_MAIL_API_ORIGIN: apiOrigin, AUTH_MAIL_PLUNK_SECRET: 'sk_controlled_local_fixture_only',
      HATCHET_CLIENT_TOKEN: engine.config.token, HATCHET_CLIENT_HOST_PORT: engine.config.host_port, HATCHET_CLIENT_API_URL: engine.config.api_url, HATCHET_CLIENT_TLS_STRATEGY: 'none',
    } })
    child.stdout!.on('data', chunk => { outputBytes += chunk.length }); child.stderr!.on('data', chunk => { outputBytes += chunk.length })
    child.on('error', () => { fatal = true })
    exited = new Promise<void>(done => { child!.once('close', code => { processClosed = true; processCode = code; for (const reply of replies.values()) reply.reject(); done() }) })
    child.on('message', raw => {
      try {
        if (typeof raw === 'object' && raw !== null && 'type' in raw && raw.type === 'reply') {
          const reply = decode(Schema.Struct({ type: Schema.Literal('reply'), id: Schema.Int, op: retryCommandOperation, label: Schema.NullOr(label), ok: Schema.Boolean, phase: Schema.optional(retryChildPhase), value: Schema.optional(Schema.Unknown) }), raw)
          appendRetryCommandReceipt(commandReceipts, { id: reply.id, op: reply.op, label: reply.label, ok: reply.ok, ...(reply.phase ? { phase: reply.phase } : {}) })
          if (reply.ok) replies.get(reply.id)?.settle(reply.value); else replies.get(reply.id)?.reject()
        } else {
          const event = decode(eventSchema, raw)
          if (events.length >= 300) throw retryFixtureError()
          events.push(event); if (event.type === 'fatal') fatal = true
        }
      } catch { fatal = true }
    })
    const ready = await waitFor(() => events.find(event => event.type === 'ready'))
    evidence.ready = ready; evidence.setupElapsedMs = performance.now() - setupStarted
    budget = retryBudget(Date.now() + 300000)
    evidence.observationStartedAt = new Date().toISOString()
    requireFact(await ask('begin', { deadlineAtMs: budget.deadlineAtMs }))
    const owner = createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
    async function create(which: RetryLabel) {
      const options = () => ({ deadlineAtMs: Date.now() + budget!.remaining(5000), statementTimeoutMs: budget!.remaining(1000), cleanupTimeoutMs: 1000, correlationId: randomUUID() })
      const command = await owner.withAuthPromise(options(), lease => authorizeEmailRequest(lease, { email: `owned-${which.toLowerCase()}@example.test`, purpose: 'magic-link', locale: 'en', expectedGeneration: 0, lifetimeSeconds: which === 'E' ? 10 : 600 }))
      const materialized = await owner.withAuthPromise(options(), lease => materializeDelivery(lease, command.id, codec, { appOrigin: 'https://app.example.test', apiOrigin, projectId: 'fixture', credentialId: 'native', from: { name: 'Product', email: 'auth@example.test' }, reply: 'reply@example.test', replayWindowSeconds: null }))
      if (!materialized) throw retryFixtureError()
      requireFact(await ask('configure', { label: which, outboxId: materialized.outboxId }))
      requireFact(await ask('admit') === 'admitted')
      const rows = await query(stores!.administrator, 'SELECT run_id AS "runId", admission_state AS state FROM auth_email_outbox WHERE id=$1', [materialized.outboxId])
      requireFact(rows.length === 1)
      const admitted = decode(Schema.Struct({ runId: uuid, state: Schema.Literal('admitted') }), rows[0])
      cases.set(which, { ...materialized, runId: admitted.runId })
      requireFact(await ask('bind', { label: which, runId: admitted.runId }))
      const first = await hook(which, 0)
      requireFact(first.runId === admitted.runId && first.outboxId === materialized.outboxId)
      return first
    }
    const failed = (code: typeof deferredCodes[number]) => (value: History) => value.events.some(row => row.eventType === 'FAILED' && row.code === code)
    await create('A')
    await waitFor(() => events.find(event => event.type === 'lookup-held'))
    phases.push(safeRetryParentPhase('a-sql-check-started'))
    requireFact((await delivery('A')).fence === 1)
    phases.push(safeRetryParentPhase('a-sql-check-completed'))
    phases.push(safeRetryParentPhase('a-cancel-started'))
    requireFact(await ask('cancel-A', { label: 'A' }))
    phases.push(safeRetryParentPhase('a-cancel-completed'))
    await nativeUntil('A', value => value.status === 'CANCELLED')
    await create('B')
    await nativeUntil('B', failed('AUTH_MAIL_CAPACITY_BUSY'))
    requireFact(!events.some(event => event.type === 'handler-settled' && event.label === 'A'))
    received('A-retained-B-capacity-busy', 0)
    requireFact(await ask('release-lookup'))
    await waitFor(() => events.find(event => event.type === 'lookup-returned'))
    await waitFor(() => events.find(event => event.type === 'handler-settled' && event.label === 'A'))
    received('A-real-handler-joined-before-B-retry', 0)
    const b = await hook('B', 1); requireFact(b.gated); requireFact(await ask('release', { hookId: b.hookId }))
    await nativeUntil('B', value => value.status === 'COMPLETED')
    requireFact((await delivery('B')).providerState === 'plunk_queued'); received('B-recovered', 1)

    const c = await create('C'); requireFact(c.gated); await lock('C')
    requireFact(await ask('release', { hookId: c.hookId }))
    await nativeUntil('C', failed('AUTH_MAIL_CLAIM_UNRESOLVED')); await unlock()
    await nativeUntil('C', value => value.status === 'COMPLETED')
    requireFact((await delivery('C')).providerState === 'plunk_queued'); received('C-recovered', 2)

    const e = await create('E'); requireFact(e.gated); await lock('E')
    requireFact(await ask('release', { hookId: e.hookId }))
    await nativeUntil('E', failed('AUTH_MAIL_CLAIM_UNRESOLVED'))
    const beforeExpiry = await delivery('E'); requireFact(expiryGate(beforeExpiry, 'before-failure') && beforeExpiry.lifetimeSeconds === 10); evidence.eBeforeExpiry = beforeExpiry
    await unlock()
    const eRetry = await hook('E', 1); requireFact(eRetry.gated)
    for (;;) { if (expiryGate(await delivery('E'), 'after-expiry')) break; await pause(budget.remaining(25)) }
    requireFact(await ask('release', { hookId: eRetry.hookId }))
    await waitFor(() => events.find(event => event.type === 'outcome' && event.label === 'E' && event.retryCount === 1 && event.outcome.state === 'inert'))
    await nativeUntil('E', value => value.status === 'COMPLETED')
    const expired = await delivery('E'); requireFact(expired.state === 'expired' && expired.fence === 0 && expired.unattempted && expired.expiry === beforeExpiry.expiry && expired.created === beforeExpiry.created)
    evidence.eAfterExpiry = expired; received('E-real-function-after-expiry', 2)

    const d = await create('D'); requireFact(d.gated); await lock('D')
    const configRows = await query(engine.administrator, `SELECT s.retries, t.retry_backoff_factor AS factor, t.retry_max_backoff AS cap,
      t.step_timeout AS execution, t.schedule_timeout AS schedule FROM v1_task t JOIN "Step" s ON s.id=t.step_id WHERE t.tenant_id=$1 AND t.external_id=$2`, [engine.tenantId, d.taskId])
    requireFact(configRows.length === 1)
    evidence.enginePolicy = decode(Schema.Struct({ retries: Schema.Literal(4), factor: Schema.Literal(5), cap: Schema.Literal(30), execution: Schema.Literal('30s'), schedule: Schema.Literal('10m') }), configRows[0])
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await hook('D', attempt); requireFact(current.gated)
      const lower = decode(Schema.Struct({ clock: stamp }), (await query(engine.administrator, 'SELECT clock_timestamp()::text AS clock'))[0]).clock
      requireFact(await ask('release', { hookId: current.hookId }))
      if (attempt === 4) break
      for (;;) {
        const rows = await query(engine.administrator, `WITH observed AS MATERIALIZED (SELECT clock_timestamp() AS upper_clock)
          SELECT q.task_id::text AS "taskId", q.task_inserted_at::text AS "taskInsertedAt", q.task_retry_count AS "taskRetryCount",
            t.app_retry_count AS "appRetryIndex", t.retry_backoff_factor AS factor, t.retry_max_backoff AS cap,
            $3::timestamptz::text AS "lowerClock", observed.upper_clock::text AS "upperClock", q.retry_after::text AS "retryAfter",
            extract(epoch FROM (q.retry_after-observed.upper_clock))::text AS "lowerSeconds",
            extract(epoch FROM (q.retry_after-$3::timestamptz))::text AS "upperSeconds",
            extract(epoch FROM (observed.upper_clock-$3::timestamptz))::text AS "widthSeconds"
          FROM v1_retry_queue_item q JOIN v1_task t ON t.id=q.task_id AND t.inserted_at=q.task_inserted_at AND t.retry_count=q.task_retry_count
          CROSS JOIN observed WHERE t.tenant_id=$1 AND q.tenant_id=$1 AND t.external_id=$2 AND t.app_retry_count=$4`, [engine.tenantId, current.taskId, lower, attempt + 1])
        if (rows.length) { intervals.push(checkedRetryInterval(rows)); break }
        await pause(budget.remaining(25))
      }
    }
    const exhausted = await nativeUntil('D', value => value.status === 'FAILED' && value.events.filter(row => row.eventType === 'FAILED' && row.code === 'AUTH_MAIL_CLAIM_UNRESOLVED').length === 5)
    requireFact(exhausted.events.filter(row => row.eventType === 'FAILED' && row.code === 'AUTH_MAIL_CLAIM_UNRESOLVED').map(row => row.retryCount).sort().join(',') === '0,1,2,3,4')
    requireFact(events.filter(event => event.type === 'before' && event.label === 'D').length === 5)
    await unlock()
    const finalD = await delivery('D'); requireFact(finalD.fence === 0 && finalD.unattempted && finalD.providerState === 'unattempted')
    evidence.dFinal = finalD; received('D-exhausted', 2)
    for (const which of retryLabels) await history(which)
    key.fill(0)
    success = true
  } catch { evidence.failure = 'MAIL_RETRY_FIXTURE_REJECTED' }
  finally {
    evidence.observationFinishedAt = new Date().toISOString()
    const cleanupStarted = performance.now()
    async function clean(name: string, action: () => Promise<void>) {
      try { await action(); cleanupReceipts[name] = true }
      catch { cleanupReceipts[name] = false; success = false }
    }
    if (child && exited) {
      const stopStarted = performance.now()
      if (!processClosed && child.connected) child.send({ id: ++nextCommand, op: 'shutdown' }, () => {})
      while (!processClosed && !events.some(event => event.type === 'closing') && performance.now() - stopStarted < 15000) await pause(25)
      // Only release the SQL perturbation after closing has aborted owned work
      // and before hooks, or after the exact child is confirmed terminated.
      if (!processClosed && !events.some(event => event.type === 'closing')) { forced = true; child.kill('SIGKILL'); await exited }
      await clean('rowLockReleased', unlock)
      while (!processClosed && performance.now() - stopStarted < 15000) await pause(25)
      const stopped = events.find(event => event.type === 'stopped')
      evidence.normalStop = { elapsedMs: performance.now() - stopStarted, processClosed, receipt: stopped ?? null }
      if (!processClosed) { forced = true; child.kill('SIGKILL') }
      await clean('childClosed', async () => { await exited })
      if (forced || !stopped || stopped.type !== 'stopped' || stopped.nativeStartState !== 'resolved' || stopped.nativeStopState !== 'resolved' || stopped.pendingHooks !== 0 || !stopped.commandsJoined || processCode !== 0 || outputBytes !== 0) success = false
    } else await clean('rowLockReleased', unlock)
    for (const reply of replies.values()) reply.reject()
    if (pool) await clean('webPoolClosed', () => pool!.end())
    // Nested inventory must be gone before enclosing inventory is compared.
    if (engine) await clean('engineRemoved', () => engine!.cleanup())
    if (stores) await clean('storesRemoved', () => stores!.cleanup())
    if (peer) {
      await clean('tlsClosedAndMaterialsRemoved', () => peer!.close())
      evidence.finalPeer = peer.evidence()
      if (success && peer.evidence().calls !== 2) success = false
    }
    evidence.cleanup = { receipts: cleanupReceipts, elapsedMs: performance.now() - cleanupStarted, forced, processCode, exactOutputEmpty: outputBytes === 0 }
    evidence.cases = Object.fromEntries(cases); evidence.events = events; evidence.histories = histories; evidence.intervals = intervals; evidence.peer = peerReceipts
    evidence.phases = phases; evidence.commandReceipts = commandReceipts
    evidence.appStores = stores?.evidence; evidence.engine = engine?.evidence; evidence.passed = success
    await writeFile(resolve(`.superpowers/sdd/2026-09-10-functional-auth/task-7-i3-native-${evidenceId}.json`), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' })
  }
  requireFact(success)
})
