import { afterAll, afterEach, beforeAll, expect, test } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Client, Pool } from 'pg'
import { Effect } from 'effect'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { calendarFixtureConfig, calendarFixturePolicy } from '../helpers/calendar-fixture'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { PgTransactionError } from '../../src/platform/db/auth-pg-lease.server'
import { acquireDatabase } from '../../src/platform/db/resources.server'
import { readCalendarDatabaseConfig } from '../../src/platform/db/config.server'
import { createCalendarStore } from '../../src/modules/calendar/store.server'
import { runCalendarOnce, type CalendarBookingProvider } from '../../src/modules/calendar/worker.server'
import { encryptCalendarTokens } from '../../src/modules/calendar/token-crypto.server'
import { createRequestOperations } from '../../src/modules/sparra/requests.server'
let stores: Awaited<ReturnType<typeof startDisposableStores>>, a: Client, b: Client, worker: Client
const workspace = randomUUID(),
  connection = randomUUID()
async function diagnoseBridgeMigration() {
  await stores.administrator.query('BEGIN')
  let tag=0,statement=0
  try {
    for(const migration of readMigrationFiles({migrationsFolder:'drizzle'})) {
      tag++;statement=0
      for(const sql of migration.sql){statement++;await stores.administrator.query(sql)}
    }
  } catch(error) {
    throw new Error(`Migration ${tag} statement ${statement}: ${error instanceof Error?error.message:'failed'}`)
  } finally {await stores.administrator.query('ROLLBACK')}
}
async function grantBridgeVoiceRoles() {
  for (const role of ['sparra_voice_a', 'sparra_voice_b']) {
    await stores.administrator.query(`GRANT USAGE ON SCHEMA voice TO ${role}`)
    for (const name of ['calendar_catalog_v1(uuid)','calendar_submit_v1(uuid,uuid,jsonb)','calendar_result_v1(uuid,uuid)','ingest_operation_v1(jsonb)'])
      if((await stores.administrator.query('SELECT to_regprocedure($1) p',['voice.'+name])).rows[0].p)
        await stores.administrator.query(`GRANT EXECUTE ON FUNCTION voice.${name} TO ${role}`)
  }
}
beforeAll(async () => {
  stores = await startDisposableStores()
  try {
    await stores.migrate()
  } catch {await diagnoseBridgeMigration()}
  await grantBridgeVoiceRoles()
  await stores.administrator.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Fixture\',$2)', [
    workspace,
    workspace + '@example.test',
  ])
  await stores.administrator.query('INSERT INTO workspace(id,owner_user_id) VALUES($1::uuid,$1::text)', [
    workspace,
  ])
  await stores.administrator.query(
    "INSERT INTO sparra_knowledge_revision(workspace_id,revision,business_name,sector,opening_hours,services,prices,faq,instructions) VALUES($1,1,'Fixture','garage','','','','','')",
    [workspace],
  )
  await stores.administrator.query(
    "INSERT INTO voice_private.deployment_binding(service_login,service_role_oid,deployment_id,workspace_id,connection_id,to_e164,admission_enabled) SELECT 'sparra_voice_a',oid,'calendar-fixture',$1,'fixture','+33123456789',true FROM pg_roles WHERE rolname='sparra_voice_a'",
    [workspace],
  )
  await stores.administrator.query(
    "INSERT INTO sparra_calendar_connection(id,workspace_id,generation,status,google_subject,account_email,token_envelope,policy_revision,policy,calendar_id,calendar_summary,enabled) VALUES($1,$2,1,'connected','fixture-sub','owner@example.test','synthetic-envelope',1,$3,'fixture-calendar','Agenda',true)",
    [connection, workspace, calendarFixturePolicy()],
  )
  a = new Client({ connectionString: stores.voiceUrlA })
  b = new Client({ connectionString: stores.voiceUrlB })
  await a.connect()
  await b.connect()
  const url = new URL(stores.directRuntimeUrl)
  url.username = 'calendar_worker'
  url.password = 'calendar-fixture-password'
  if ((await stores.administrator.query("SELECT 1 FROM pg_roles WHERE rolname='calendar_worker'")).rowCount) {
    await stores.administrator.query("ALTER ROLE calendar_worker PASSWORD 'calendar-fixture-password'")
    worker = new Client({ connectionString: url.toString() })
    await worker.connect()
  }
}, 180000)
afterAll(async () => {
  try {
    await a?.end()
    await b?.end()
    await worker?.end()
  } finally {
    await stores?.cleanup()
  }
})
afterEach(async () => {
  if (stores) {
    await stores.administrator.query('DELETE FROM sparra_calendar_offer;DELETE FROM sparra_calendar_command')
    await stores.administrator.query(
      "UPDATE sparra_calendar_connection SET generation=1,policy_revision=1,status='connected',enabled=true,work_id=NULL,work_expires_at=NULL,calendar_id='fixture-calendar',google_subject='fixture-sub',token_envelope='synthetic-envelope',policy=$2 WHERE id=$1",
      [connection, calendarFixturePolicy()],
    )
  }
})
async function call() {
  const id = randomUUID()
  await stores.administrator.query(
    "INSERT INTO sparra_call(id,workspace_id,deployment_id,provider_call_control_id,admitted_at,retention_until,configuration_revision) VALUES($1::uuid,$2,'calendar-fixture',$1::text,clock_timestamp(),clock_timestamp()+interval '30 days',1)",
    [id, workspace],
  )
  return id
}
const submit = async (callId: string, operation: string, input: unknown, client = a) =>
  (await client.query('SELECT voice.calendar_submit_v1($1,$2,$3) v', [callId, operation, input])).rows[0].v
const search = () => ({
  kind: 'find_slots',
  serviceId: 'oil-change',
  policyRevision: 1,
  windowStart: new Date(Date.now() + 86400000).toISOString(),
  windowEnd: new Date(Date.now() + 172800000).toISOString(),
})
test('Calendar exact function catalog is installed and execute-only worker has no memberships/table access', async () => {
  expect(
    (
      await stores.administrator.query(
        "SELECT to_regprocedure('voice.calendar_catalog_v1(uuid)') IS NOT NULL present",
      )
    ).rows[0].present,
  ).toBe(true)
  expect(
    (
      await stores.administrator.query(
        "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','voice_private') AND c.relkind='r' AND has_table_privilege('calendar_worker',c.oid,'SELECT,INSERT,UPDATE,DELETE')",
      )
    ).rows,
  ).toEqual([])
  expect(
    (
      await stores.administrator.query(
        "SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member OR r.oid=m.roleid WHERE r.rolname IN ('calendar_worker','calendar_definer')",
      )
    ).rows,
  ).toEqual([])
})
test('binding/OID authority, erasure and private projections precede replay', async () => {
  const id = await call(),
    op = randomUUID(),
    input = search()
  const catalog = (await a.query('SELECT voice.calendar_catalog_v1($1) v', [id])).rows[0].v
  expect(catalog).toMatchObject({ schema_version: 1, call_id: id, policy_revision: 1 })
  expect(JSON.stringify(catalog)).not.toMatch(/token|subject|calendarId|workspace/)
  await expect(submit(id, op, input, b)).rejects.toThrow()
  expect(await submit(id, op, input)).toMatchObject({ state: 'pending', operationId: op })
  await expect(submit(await call(), op, input)).rejects.toThrow()
  expect(await submit(id, op, input)).toMatchObject({ state: 'pending', operationId: op })
  await expect(submit(id, op, { ...input, serviceId: 'other' })).rejects.toThrow()
  await stores.administrator.query("SELECT set_config('app.tenant_id',$1,false)", [workspace])
  await stores.administrator.query(
    'UPDATE sparra_call SET erasure_requested_at=clock_timestamp() WHERE id=$1',
    [id],
  )
  await expect(submit(id, op, input)).rejects.toThrow()
  await expect(a.query('SELECT voice.calendar_result_v1($1,$2)', [id, op])).rejects.toThrow()
})
test('revised policy and authority/PII injection fail closed', async () => {
  const id = await call()
  for (const input of [
    { ...search(), workspaceId: workspace },
    { ...search(), calendarId: 'attacker' },
    { ...search(), contact: 'person' },
    { ...search(), policyRevision: 999 },
    { ...search(), windowStart: '2020-01-01T00:00:00Z' },
  ])
    await expect(submit(id, randomUUID(), input)).rejects.toThrow()
})
const work = async (name: string, args: unknown[] = []) =>
  (await worker.query(`SELECT app_private.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) v`, args))
    .rows[0].v
async function expireForImmediateClaim(id: string, observedAt: string | null = null) {
  await stores.administrator.query(
    `WITH observed AS (SELECT coalesce($2::timestamptz,clock_timestamp()) AS at)
    UPDATE sparra_calendar_command SET lease_until=observed.at-interval '1 second',retry_at=date_trunc('milliseconds',observed.at)
    FROM observed WHERE id=$1`,
    [id, observedAt],
  )
}
async function offer(id: string, start = new Date(Date.now() + 86400000).toISOString()) {
  const op = randomUUID(),
    end = new Date(Date.parse(start) + 1800000).toISOString()
  await submit(id, op, {
    ...search(),
    windowStart: start,
    windowEnd: new Date(Date.parse(start) + 3600000).toISOString(),
  })
  const q = await work('calendar_claim_v1')
  expect(q.id).toBe(op)
  expect(await work('calendar_finish_v1', [op, q.fence, { state: 'offered', slots: [{ start, end }] }])).toBe(
    true,
  )
  const result = (await a.query('SELECT voice.calendar_result_v1($1,$2) v', [id, op])).rows[0].v
  return result.offers[0]
}
async function confirmation(
  id: string,
  ids = { recapTurnId: randomUUID(), confirmationTurnId: randomUUID(), at: new Date().toISOString() },
) {
  const { recapTurnId, confirmationTurnId, at } = ids
  const common = {
    crypto_version: 1,
    key_version: 1,
    nonce_b64: Buffer.alloc(12).toString('base64'),
    ciphertext_b64: Buffer.alloc(16).toString('base64'),
    started_at: at,
    ended_at: at,
    interrupted: false,
  }
  const turns = {
    [recapTurnId]: {
      ...common,
      turn_id: recapTurnId,
      turn_no: 1,
      role: 'assistant',
      source: 'pipecat_assistant',
    },
    [confirmationTurnId]: {
      ...common,
      turn_id: confirmationTurnId,
      turn_no: 2,
      role: 'user',
      source: 'stt_final',
    },
  }
  for (const payload of Object.values(turns))
    expect(
      (
        await a.query('SELECT voice.ingest_operation_v1($1) v', [
          {
            schema_version: 1,
            operation_id: randomUUID(),
            deployment_id: 'calendar-fixture',
            call_id: id,
            occurred_at: at,
            kind: 'turn.upsert',
            payload,
          },
        ])
      ).rows[0].v.status,
    ).toBe('applied')
  return {
    recapTurnId,
    confirmationTurnId,
    playbackMark: 'sparra-calendar-recap-' + recapTurnId,
    playbackAcknowledgedAt: at,
  }
}
test('replication lag cannot admit a write; actual persisted roles/order and playback acknowledgement are required', async () => {
  const id = await call(),
    o = await offer(id),
    op = randomUUID(),
    recapTurnId = randomUUID(),
    cf = {
      recapTurnId,
      confirmationTurnId: randomUUID(),
      playbackMark: 'sparra-calendar-recap-' + recapTurnId,
      playbackAcknowledgedAt: new Date().toISOString(),
    }
  expect(await submit(id, op, { kind: 'book_appointment', offerId: o.offerId, confirmation: cf })).toEqual({
    state: 'waiting_evidence',
    operationId: op,
  })
  expect(
    (
      await stores.administrator.query(
        "SELECT state,current_start,possible_send_fence FROM sparra_calendar_command WHERE kind='book_appointment'",
      )
    ).rows,
  ).toEqual([{ state: 'waiting_evidence', current_start: null, possible_send_fence: null }])
  expect(await work('calendar_claim_v1')).toBeNull()
  await expect(
    submit(id, op, {
      kind: 'book_appointment',
      offerId: o.offerId,
      confirmation: { ...cf, confirmationTurnId: randomUUID() },
    }),
  ).rejects.toThrow()
  const real = await confirmation(id, {
    recapTurnId: cf.recapTurnId,
    confirmationTurnId: cf.confirmationTurnId,
    at: cf.playbackAcknowledgedAt,
  })
  for (const confirmation of [
    { ...real, recapTurnId: real.confirmationTurnId, confirmationTurnId: real.recapTurnId },
    { ...real, playbackAcknowledgedAt: new Date(Date.now() + 60000).toISOString() },
  ])
    await expect(
      submit(id, randomUUID(), { kind: 'book_appointment', offerId: o.offerId, confirmation }),
    ).rejects.toThrow()
  expect(
    await submit(id, op, { kind: 'book_appointment', offerId: o.offerId, confirmation: real }),
  ).toMatchObject({ state: 'pending' })
  expect(
    await submit(id, randomUUID(), { kind: 'book_appointment', offerId: o.offerId, confirmation: real }),
  ).toMatchObject({ operationId: op })
})
test('overlapping distinct starts cannot both reserve; unknown keeps the interval after lease/offer expiry', async () => {
  const x = await call(),
    y = await call(),
    start = new Date(Date.now() + 86400000).toISOString(),
    one = await offer(x, start),
    two = await offer(y, new Date(Date.parse(start) + 900000).toISOString())
  const op = randomUUID()
  await submit(x, op, { kind: 'book_appointment', offerId: one.offerId, confirmation: await confirmation(x) })
  const q = await work('calendar_claim_v1')
  expect(await work('calendar_prepare_create_v1', [op, q.fence])).toBe(true)
  await expect(
    submit(y, randomUUID(), {
      kind: 'book_appointment',
      offerId: two.offerId,
      confirmation: await confirmation(y),
    }),
  ).rejects.toThrow()
  // timestamp(3) rounds this instant forward; an expired fixture must already be due.
  const boundary = '2026-10-22T09:13:17.000600Z'
  await expireForImmediateClaim(op, boundary)
  expect((await stores.administrator.query(
    'SELECT retry_at<=$2::timestamptz AS due FROM sparra_calendar_command WHERE id=$1',
    [op, boundary],
  )).rows[0].due).toBe(true)
  await expireForImmediateClaim(op)
  const replacement = await work('calendar_claim_v1')
  expect(replacement.possibleSendFence).toBe(q.fence)
  expect(replacement.fence).toBe(q.fence + 1)
  expect(await work('calendar_prepare_create_v1', [op, replacement.fence])).toBe(false)
  expect(
    await work('calendar_finish_v1', [
      op,
      q.fence,
      { state: 'confirmed', eventId: q.eventId, operationId: op, start: q.windowStart, end: q.windowEnd },
    ]),
  ).toBe(false)
})
test('revision, disconnect and deadline are rechecked at final send transition', async () => {
  for (const change of [
    'UPDATE sparra_calendar_connection SET policy_revision=policy_revision+1',
    'UPDATE sparra_calendar_connection SET enabled=false,generation=generation+1',
    "UPDATE sparra_calendar_command SET first_send_deadline=clock_timestamp()-interval '1 second'",
  ]) {
    const id = await call(),
      o = await offer(id),
      op = randomUUID()
    await submit(id, op, {
      kind: 'book_appointment',
      offerId: o.offerId,
      confirmation: await confirmation(id),
    })
    const q = await work('calendar_claim_v1')
    await stores.administrator.query(change)
    expect(await work('calendar_prepare_create_v1', [op, q.fence])).toBe(false)
    await stores.administrator.query('DELETE FROM sparra_calendar_offer;DELETE FROM sparra_calendar_command')
    await stores.administrator.query(
      'UPDATE sparra_calendar_connection SET enabled=true,generation=1,policy_revision=1',
    )
  }
})

test.each([-1, 30])(
  'an unexpired offer starting in %i minutes cannot bypass current notice at admission',
  async (minutes) => {
    if (minutes < 0)
      await stores.administrator.query(
        "UPDATE sparra_calendar_connection SET policy=jsonb_set(policy,'{noticeMinutes}','0')",
      )
    const id = await call(),
      o = await offer(id, new Date(Date.now() + minutes * 60000).toISOString()),
      op = randomUUID()
    expect(Date.parse(o.expiresAt)).toBeGreaterThan(Date.now())
    await expect(
      submit(id, op, { kind: 'book_appointment', offerId: o.offerId, confirmation: await confirmation(id) }),
    ).rejects.toMatchObject({ code: 'PV202' })
    expect(
      (
        await stores.administrator.query(
          'SELECT possible_send_fence FROM sparra_calendar_command WHERE id=$1',
          [op],
        )
      ).rows,
    ).toEqual([])
  },
)

test.each([-1, 30])(
  'final send refuses an admitted slot now starting in %i minutes without marking possible send',
  async (minutes) => {
    if (minutes < 0)
      await stores.administrator.query(
        "UPDATE sparra_calendar_connection SET policy=jsonb_set(policy,'{noticeMinutes}','0')",
      )
    const id = await call(),
      o = await offer(id),
      op = randomUUID()
    await submit(id, op, {
      kind: 'book_appointment',
      offerId: o.offerId,
      confirmation: await confirmation(id),
    })
    const q = await work('calendar_claim_v1')
    await stores.administrator.query(
      'UPDATE sparra_calendar_command SET window_start=clock_timestamp()+make_interval(mins=>$2),window_end=clock_timestamp()+make_interval(mins=>$2+30),current_start=clock_timestamp()+make_interval(mins=>$2),current_end=clock_timestamp()+make_interval(mins=>$2+40) WHERE id=$1',
      [op, minutes],
    )
    expect(await work('calendar_prepare_create_v1', [op, q.fence])).toBe(false)
    expect(
      (
        await stores.administrator.query(
          'SELECT possible_send_fence FROM sparra_calendar_command WHERE id=$1',
          [op],
        )
      ).rows,
    ).toEqual([{ possible_send_fence: null }])
  },
)
test('one existing workId/generation owner controls refresh and stale settlement cannot restore disconnect', async () => {
  const id = await call(),
    op = randomUUID()
  await submit(id, op, search())
  const q = await work('calendar_claim_v1')
  const wid = await work('calendar_token_claim_v1', [op, q.fence])
  expect(wid).toMatch(/^[0-9a-f-]{36}$/)
  expect(await work('calendar_token_claim_v1', [op, q.fence])).toBeNull()
  await stores.administrator.query(
    'UPDATE sparra_calendar_connection SET generation=2,enabled=false,work_id=NULL',
  )
  expect(await work('calendar_token_finish_v1', [op, q.fence, wid, 'v1.synthetic', false])).toBe(false)
})
test('expired opaque offers and foreign call replay are refused', async () => {
  const id = await call(),
    other = await call(),
    o = await offer(id),
    cf = await confirmation(id)
  await expect(
    submit(other, randomUUID(), { kind: 'book_appointment', offerId: o.offerId, confirmation: cf }),
  ).rejects.toThrow()
  await stores.administrator.query(
    "UPDATE sparra_calendar_offer SET expires_at=clock_timestamp()-interval '1 second'",
  )
  await expect(
    submit(id, randomUUID(), { kind: 'book_appointment', offerId: o.offerId, confirmation: cf }),
  ).rejects.toThrow()
})
test('native worker store commits before HTTP, confirms Inbox independently and erasure fences subsequent writes', async () => {
  const url = new URL(stores.directRuntimeUrl)
  url.username = 'calendar_worker'
  url.password = 'calendar-fixture-password'
  const binding = { workspaceId: workspace, connectionId: connection },
    tokens = encryptCalendarTokens(calendarFixtureConfig, binding, {
      accessToken: 'fixture-access',
      refreshToken: 'fixture-refresh',
      expiresAt: Date.now() + 3600000,
      grantedScopes: ['openid'],
    })
  await stores.administrator.query('UPDATE sparra_calendar_connection SET token_envelope=$1', [tokens])
  const id = await call(),
    o = await offer(id),
    op = randomUUID()
  await submit(id, op, { kind: 'book_appointment', offerId: o.offerId, confirmation: await confirmation(id) })
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* acquireDatabase(
          readCalendarDatabaseConfig({ SPARRA_CALENDAR_DATABASE_URL: url.toString() }),
          'calendar_worker',
        )
        const store = createCalendarStore(db.transactions),
          provider: CalendarBookingProvider = {
            async freeBusy() {
              expect(
                (
                  await stores.administrator.query(
                    "SELECT count(*)::int n FROM pg_stat_activity WHERE usename='calendar_worker' AND state='idle in transaction'",
                  )
                ).rows[0].n,
              ).toBe(0)
              return []
            },
            async insertEvent(_token, input) {
              expect(
                (
                  await stores.administrator.query(
                    'SELECT possible_send_fence FROM sparra_calendar_command WHERE id=$1',
                    [op],
                  )
                ).rows[0].possible_send_fence,
              ).not.toBeNull()
              expect(input.calendarId).toBe('fixture-calendar')
              expect(input.event.summary).toBe('Vidange')
              expect(input.event.description).toBe(calendarFixtureConfig.origin + '/app/demandes/' + id)
              return { ...input.event, status: 'confirmed' }
            },
            async getEvent() {
              throw new Error('Unexpected GET')
            },
            async refreshTokens() {
              throw new Error('Unexpected refresh')
            },
            async userInfo() {
              throw new Error('Unexpected userinfo')
            },
            async listCalendars() {
              return []
            },
            async close() {},
          }
        yield* Effect.promise(() =>
          runCalendarOnce(store, calendarFixtureConfig, new AbortController().signal, provider),
        )
      }),
    ),
  )
  expect((await a.query('SELECT voice.calendar_result_v1($1,$2) v', [id, op])).rows[0].v).toMatchObject({
    state: 'confirmed',
    booking: { serviceName: 'Vidange', providerReference: 'sparra' + op.replaceAll('-', '') },
  })
  const principal = {
    userId: workspace,
    sessionId: randomUUID(),
    name: 'Fixture',
    email: workspace + '@example.test',
  }
  await stores.administrator.query(
    "INSERT INTO session(id,token,user_id,expires_at,auth_state,auth_method,authenticated_at,recovery_generation,last_activity_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 day','ACTIVE','google',clock_timestamp(),0,clock_timestamp())",
    [principal.sessionId, randomUUID(), workspace],
  )
  const pool = new Pool({ connectionString: stores.directRuntimeUrl, max: 1 }),
    requests = createRequestOperations(
      createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 }),
    )
  try {
    const detail = await requests.detail(principal, id)
    expect(detail.resultAvailability).toBe('unavailable')
    expect(detail.bookings).toMatchObject([
      { state: 'confirmed', serviceName: 'Vidange', providerReference: 'sparra' + op.replaceAll('-', '') },
    ])
    await requests.erase(principal, id)
    expect(
      (await stores.administrator.query('SELECT 1 FROM sparra_calendar_command WHERE id=$1', [op])).rows,
    ).toEqual([])
    await expect(requests.detail(principal, id)).rejects.toThrow()
  } finally {
    await pool.end()
  }
})
test('confirmed observations move or release the current hold while preserving original confirmation evidence', async () => {
  const id = await call(),
    o = await offer(id),
    op = randomUUID()
  await submit(id, op, { kind: 'book_appointment', offerId: o.offerId, confirmation: await confirmation(id) })
  const q = await work('calendar_claim_v1')
  await work('calendar_prepare_create_v1', [op, q.fence])
  await work('calendar_finish_v1', [
    op,
    q.fence,
    { state: 'confirmed', eventId: q.eventId, operationId: op, start: q.windowStart, end: q.windowEnd },
  ])
  const searchId = await call(),
    searchOp = randomUUID()
  await submit(searchId, searchOp, search())
  const searchQ = await work('calendar_claim_v1')
  const moved = {
    eventId: q.eventId,
    status: 'confirmed',
    start: new Date(Date.parse(q.windowStart) + 86400000).toISOString(),
    end: new Date(Date.parse(q.windowEnd) + 86400000).toISOString(),
  }
  expect(await work('calendar_observe_v1', [searchOp, searchQ.fence, op, moved])).toBe(true)
  const row = (
    await stores.administrator.query(
      'SELECT window_start,current_start,result FROM sparra_calendar_command WHERE id=$1',
      [op],
    )
  ).rows[0]
  expect(row.current_start.toISOString()).toBe(moved.start)
  expect(Date.parse(row.result.booking.start)).toBe(Date.parse(q.windowStart))
  expect(row.window_start.toISOString()).toBe(new Date(q.windowStart).toISOString())
  expect(
    await work('calendar_observe_v1', [
      searchOp,
      searchQ.fence,
      op,
      { eventId: q.eventId, status: 'cancelled' },
    ]),
  ).toBe(true)
  expect(
    (
      await stores.administrator.query(
        'SELECT current_start,current_end,observed_state FROM sparra_calendar_command WHERE id=$1',
        [op],
      )
    ).rows[0],
  ).toEqual({ current_start: null, current_end: null, observed_state: 'cancelled' })
})
test('erasure after possible submission keeps only unresolved proof and never restores Inbox content', async () => {
  const id = await call(),
    o = await offer(id),
    op = randomUUID()
  await submit(id, op, { kind: 'book_appointment', offerId: o.offerId, confirmation: await confirmation(id) })
  const q = await work('calendar_claim_v1')
  expect(await work('calendar_prepare_create_v1', [op, q.fence])).toBe(true)
  await stores.administrator.query("SELECT set_config('app.tenant_id',$1,false)", [workspace])
  await stores.administrator.query(
    'UPDATE sparra_call SET erasure_requested_at=clock_timestamp() WHERE id=$1',
    [id],
  )
  const retained = (
    await stores.administrator.query(
      'SELECT call_id,deployment_id,request,result,policy,service_name FROM sparra_calendar_command WHERE id=$1',
      [op],
    )
  ).rows[0]
  expect(retained).toEqual({
    call_id: null,
    deployment_id: null,
    request: null,
    result: null,
    policy: null,
    service_name: '',
  })
  expect(await work('calendar_prepare_create_v1', [op, q.fence])).toBe(false)
  expect(
    await work('calendar_finish_v1', [
      op,
      q.fence,
      { state: 'confirmed', eventId: q.eventId, operationId: op, start: q.windowStart, end: q.windowEnd },
    ]),
  ).toBe(true)
  expect(
    (await stores.administrator.query('SELECT 1 FROM sparra_calendar_command WHERE id=$1', [op])).rows,
  ).toEqual([])
  await expect(a.query('SELECT voice.calendar_result_v1($1,$2)', [id, op])).rejects.toThrow()
})
test('a foreign bound Workspace and replacement login OID cannot impersonate an admitted call through GUCs', async () => {
  const id = await call(),
    other = randomUUID()
  await stores.administrator.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Other\',$2)', [
    other,
    other + '@example.test',
  ])
  await stores.administrator.query('INSERT INTO workspace(id,owner_user_id) VALUES($1::uuid,$1::text)', [
    other,
  ])
  await stores.administrator.query(
    "INSERT INTO voice_private.deployment_binding(service_login,service_role_oid,deployment_id,workspace_id,connection_id,to_e164,admission_enabled) SELECT 'sparra_voice_b',oid,'other-calendar',$1,'other','+33123456780',true FROM pg_roles WHERE rolname='sparra_voice_b'",
    [other],
  )
  await b.query("SELECT set_config('app.tenant_id',$1,false)", [workspace])
  await expect(b.query('SELECT voice.calendar_catalog_v1($1)', [id])).rejects.toThrow()
  await stores.administrator.query(
    "CREATE ROLE calendar_voice_replaced LOGIN PASSWORD 'fixture-only' NOINHERIT; GRANT USAGE ON SCHEMA voice TO calendar_voice_replaced; GRANT EXECUTE ON FUNCTION voice.calendar_catalog_v1(uuid) TO calendar_voice_replaced",
  )
  await stores.administrator.query(
    "INSERT INTO voice_private.deployment_binding(service_login,service_role_oid,deployment_id,workspace_id,connection_id,to_e164,admission_enabled) SELECT 'calendar_voice_replaced',oid,'replaced-calendar',$1,'replaced','+33123456781',true FROM pg_roles WHERE rolname='sparra_voice_shared'",
    [workspace],
  )
  const url = new URL(stores.directRuntimeUrl)
  url.username = 'calendar_voice_replaced'
  url.password = 'fixture-only'
  const replaced = new Client({ connectionString: url.toString() })
  try {
    await replaced.connect()
    await expect(replaced.query('SELECT voice.calendar_catalog_v1($1)', [id])).rejects.toThrow()
  } finally {
    await replaced.end()
  }
})

test.each(['tentative','buffer','expired-offer','source-generation','source-destination','source-policy','booking-generation','booking-subject','booking-destination','booking-policy'] as const)('natural-key confirmation refuses changed %s while preserving operation history',async changed=>{
  const id=await call(),o=await offer(id),op=randomUUID(),cf=await confirmation(id)
  const input={kind:'book_appointment',offerId:o.offerId,confirmation:cf}
  await submit(id,op,input)
  const q=await work('calendar_claim_v1')
  expect(await work('calendar_prepare_create_v1',[op,q.fence])).toBe(true)
  expect(await work('calendar_finish_v1',[op,q.fence,{state:'confirmed',eventId:q.eventId,operationId:op,start:q.windowStart,end:q.windowEnd}])).toBe(true)
  // Backend branch coverage complements the actual native cancellation/move consumers.
  if(changed==='tentative')await stores.administrator.query("UPDATE sparra_calendar_command SET observed_state='tentative' WHERE id=$1",[op])
  if(changed==='buffer')await stores.administrator.query("UPDATE sparra_calendar_command SET current_end=current_end+interval '1 minute' WHERE id=$1",[op])
  if(changed==='expired-offer')await stores.administrator.query("UPDATE sparra_calendar_offer SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[o.offerId])
  if(changed==='source-generation'||changed==='source-destination'||changed==='source-policy'){
    const changes={'source-generation':'generation=generation+1','source-destination':"calendar_id='other-calendar'",'source-policy':'policy_revision=policy_revision+1'}
    await stores.administrator.query('UPDATE sparra_calendar_command SET '+changes[changed]+' WHERE id=(SELECT command_id FROM sparra_calendar_offer WHERE id=$1)',[o.offerId])
  }
  if(changed==='booking-generation'||changed==='booking-subject'||changed==='booking-destination'||changed==='booking-policy'){
    const changes={'booking-generation':'generation=generation+1','booking-subject':"google_subject='other-subject'",'booking-destination':"calendar_id='other-calendar'",'booking-policy':'policy_revision=policy_revision+1'}
    await stores.administrator.query('UPDATE sparra_calendar_command SET '+changes[changed]+' WHERE id=$1',[op])
  }
  const original=(await stores.administrator.query('SELECT * FROM sparra_calendar_command WHERE id=$1',[op])).rows[0]
  await expect(submit(id,randomUUID(),input)).rejects.toMatchObject({code:'PV202'})
  expect((await stores.administrator.query('SELECT * FROM sparra_calendar_command WHERE id=$1',[op])).rows[0]).toEqual(original)
  expect(await submit(id,op,input)).toMatchObject({state:'confirmed',operationId:op})
})

test.each(['selection','unsent','generation','subject','revoking','disconnected'] as const)('pinned recovery credentials enforce %s authority',async changed=>{
  const id=await call(),o=await offer(id),op=randomUUID()
  await submit(id,op,{kind:'book_appointment',offerId:o.offerId,confirmation:await confirmation(id)})
  const q=await work('calendar_claim_v1')
  if(changed!=='unsent')expect(await work('calendar_prepare_create_v1',[op,q.fence])).toBe(true)
  await stores.administrator.query("UPDATE sparra_calendar_connection SET calendar_id='calendar-b' WHERE id=$1",[connection])
  if(changed==='generation')await stores.administrator.query('UPDATE sparra_calendar_connection SET generation=generation+1 WHERE id=$1',[connection])
  if(changed==='subject')await stores.administrator.query("UPDATE sparra_calendar_connection SET google_subject='replacement-subject' WHERE id=$1",[connection])
  if(changed==='revoking'||changed==='disconnected')await stores.administrator.query("UPDATE sparra_calendar_connection SET status=$2,enabled=false,token_envelope=CASE WHEN $2='disconnected' THEN NULL ELSE token_envelope END WHERE id=$1",[connection,changed])
  const read=await work('calendar_read_v1',[op,q.fence])
  expect(read.calendarId).toBe('fixture-calendar')
  if(changed==='selection')expect(read.tokenEnvelope).not.toBeNull()
  else expect(read.tokenEnvelope).toBeNull()
  expect(await work('calendar_prepare_create_v1',[op,q.fence])).toBe(false)
})

test.each(['released','statement-failure'] as const)('idle native claim shutdown joins %s without hiding transaction failure',async mode=>{
  const url=new URL(stores.directRuntimeUrl);url.username='calendar_worker';url.password='calendar-fixture-password'
  const pool=new Pool({connectionString:url.toString(),max:1})
  const store=createCalendarStore(createTransactions(pool,{maxStatementTimeoutMs:1000,maxCleanupTimeoutMs:1000}))
  const shutdown=new AbortController()
  await stores.administrator.query('BEGIN; LOCK TABLE sparra_calendar_command IN ACCESS EXCLUSIVE MODE')
  try{
    const pending=runCalendarOnce(store,calendarFixtureConfig,shutdown.signal).then(value=>({value}),error=>({error}))
    await expect.poll(async()=>{
      await stores.administrator.query('SELECT pg_stat_clear_snapshot()')
      return (await stores.administrator.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename='calendar_worker' AND wait_event_type='Lock') blocked")).rows[0].blocked
    }).toBe(true)
    shutdown.abort()
    if(mode==='released')await stores.administrator.query('COMMIT')
    const result=await pending
    if('error' in result){
      expect(result.error).toBeInstanceOf(PgTransactionError)
      const error:PgTransactionError=result.error
      console.log('CALENDAR_IDLE_CLAIM', {mode,aborted:shutdown.signal.aborted,phase:error.phase,outcome:error.outcome})
    }
    if(mode==='released')expect(result).toEqual({value:false})
    else expect(result).toHaveProperty('error')
  }finally{
    await stores.administrator.query('ROLLBACK')
    await pool.end()
  }
})
