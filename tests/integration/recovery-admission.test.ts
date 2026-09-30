import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { inspect } from 'node:util'
import { eq } from 'drizzle-orm'
import { Client, Pool } from 'pg'
import { expect, test, vi } from 'vitest'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { startGoogleProtocolPeer } from '../helpers/google-protocol-peer.mjs'
import { registrationCredentialFixture } from '../helpers/registration-ceremony'
import { bounded } from '../helpers/web-process'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { PgTransactionError } from '../../src/platform/db/auth-pg-lease.server'
import { createApplicationAuth, readAuthConfig } from '../../src/modules/auth/auth.server'
import { createAuthRateLimiter, readRateLimitConfig } from '../../src/modules/auth/rate-limit.server'
import { createAuthEmailEnvelope } from '../../src/modules/auth/auth-email-envelope.server'
import { googleAccountCallbackResponse, magicConsumeResponse, magicEnrollmentResponse } from '../../src/modules/auth/http-boundary.server'
import { createPersonalWorkspaces } from '../../src/modules/workspaces/personal.server'
import { passkey, verification } from '../../src/modules/auth/schema.server'

const observed = vi.hoisted(() => ({ enrollmentToken: '', injectHeader: false, injected: 0, observeOrdinary: false,
  nativeVerificationLookups: 0, nativeVerificationSweeps: 0,
  observeRotationOuter: false, rotationOuterEntries: 0, rotationOuterOutside: false,
  lateBegin: false, lateComplete: false, lateRotation: false, proofCreateFailure: false,
  lateBeginReached: 0, lateCompleteReached: 0, lateRotationReached: 0, proofCreateReached: 0,
  holdRotationCreate: false, rotationCreateReached: 0, rotationCreatedExpiresAtMs: 0,
  rotationCreateEntered: () => {}, rotationCreateGate: Promise.resolve(),
  observeRecoveryLookup: false, stateExpiryBefore: false, stateReturnIdentifier: false, stateReturnValue: false,
  stateExpiryBeforeReached: 0, stateReturnIdentifierReached: 0, stateReturnValueReached: 0,
  holdConsumedRotation: false, consumedRotationReached: 0, consumedRotationEntered: () => {}, consumedRotationGate: Promise.resolve(),
  consumedCounterKeyId: '', consumedRotationIdentifier: '', consumedCounterOneSeen: false, consumedRowAbsentSeen: false,
  readConsumedScope: async (): Promise<{ counterOne: boolean; absent: boolean }> => ({ counterOne: false, absent: false }),
  cleanupAttack: '' as '' | 'different-delete' | 'create' | 'direct-transaction', cleanupAttackIdentifier: '', cleanupAttackReached: 0,
  directWriteAttack: '' as '' | 'rotation-session' | 'google-user' | 'google-transaction', directWriteTarget: '', directWriteReached: 0 }))
vi.mock('../../src/modules/auth/admission.server', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/modules/auth/admission.server')>()
  const { createAuthMiddleware } = await import('better-auth/api')
  return { ...actual, googleAdmission(...args: Parameters<typeof actual.googleAdmission>) {
    const plugin = actual.googleAdmission(...args)
    const priorAfter = 'after' in plugin.hooks ? plugin.hooks.after : undefined
    if (priorAfter !== undefined && !Array.isArray(priorAfter)) throw new Error('Unexpected native after-hook shape')
    return { ...plugin, hooks: { ...plugin.hooks, before: [...plugin.hooks.before, {
      matcher: (ctx: { path?: string }) => ctx.path === '/application/recovery/codes/rotate', handler: createAuthMiddleware(async () => {
      if (observed.observeRotationOuter) {
        observed.rotationOuterEntries++
        try { args[0].assertNoActiveAuthTransaction(); observed.rotationOuterOutside = true }
        catch { observed.rotationOuterOutside = false }
      }
    }) }], after: [...(priorAfter ?? []), {
      matcher: (ctx: { path?: string }) => ['/application/recovery/google/begin', '/application/recovery/google/complete', '/application/recovery/codes/rotate'].includes(ctx.path ?? ''),
      handler: createAuthMiddleware(async ctx => {
        if (observed.directWriteAttack && (ctx.path === '/application/recovery/codes/rotate' && observed.directWriteAttack === 'rotation-session'
          || ctx.path === '/application/recovery/google/complete' && observed.directWriteAttack.startsWith('google-'))) {
          observed.directWriteReached++
          if (observed.directWriteAttack === 'rotation-session') await ctx.context.adapter.update({ model: 'session',
            where: [{ field: 'id', value: observed.directWriteTarget }], update: { userAgent: 'r1-direct-hook-write' } })
          else if (observed.directWriteAttack === 'google-user') await ctx.context.adapter.update({ model: 'user',
            where: [{ field: 'id', value: observed.directWriteTarget }], update: { name: 'r1-direct-hook-write' } })
          else await ctx.context.adapter.transaction(child => child.create({ model: 'verification', data: {
            id: randomUUID(), identifier: 'r1-direct-hook-write', value: 'forbidden', expiresAt: new Date(Date.now() + 300000),
          } }))
        }
        if (ctx.path === '/application/recovery/google/begin' && observed.lateBegin) {
          observed.lateBeginReached++; throw new Error('r1-secret-sentinel late begin')
        }
        if (ctx.path === '/application/recovery/google/complete' && observed.lateComplete) {
          observed.lateCompleteReached++; throw new Error('r1-secret-sentinel late complete')
        }
        if (ctx.path === '/application/recovery/codes/rotate' && observed.lateRotation) {
          observed.lateRotationReached++; throw new Error('r1-secret-sentinel late rotation')
        }
      }),
    }] } }
  } }
})
vi.mock('../../src/modules/auth/adapter.server', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/modules/auth/adapter.server')>()
  return { ...actual, createAuthAdapter(...args: Parameters<typeof actual.createAuthAdapter>) {
    const adapter = actual.createAuthAdapter(...args)
    observed.readConsumedScope = async () => {
      const [key] = await args[0].currentDb().select({ counter: passkey.counter }).from(passkey)
        .where(eq(passkey.id, observed.consumedCounterKeyId))
      const rows = await args[0].currentDb().select({ id: verification.id }).from(verification)
        .where(eq(verification.identifier, observed.consumedRotationIdentifier)).limit(1)
      return { counterOne: key?.counter === 1, absent: rows.length === 0 }
    }
    return { ...adapter,
      findOne: (input: Parameters<typeof adapter.findOne>[0]) => {
        if ((observed.observeOrdinary || observed.observeRecoveryLookup) && input.model === 'verification') observed.nativeVerificationLookups++
        return adapter.findOne(input)
      },
      findMany: (input: Parameters<typeof adapter.findMany>[0]) => {
        if ((observed.observeOrdinary || observed.observeRecoveryLookup) && input.model === 'verification') observed.nativeVerificationLookups++
        return adapter.findMany(input)
      },
      deleteMany: (input: Parameters<typeof adapter.deleteMany>[0]) => {
        if ((observed.observeOrdinary || observed.observeRecoveryLookup) && input.model === 'verification') observed.nativeVerificationSweeps++
        return adapter.deleteMany(input)
      },
    }
  } }
})
vi.mock('better-auth', async importOriginal => {
  const actual = await importOriginal<typeof import('better-auth')>()
  return { ...actual, betterAuth(options: Parameters<typeof actual.betterAuth>[0]) {
    return actual.betterAuth({ ...options, databaseHooks: { ...options.databaseHooks,
      verification: { delete: { before: async (data, ctx) => {
        if (observed.cleanupAttack && data.identifier === observed.cleanupAttackIdentifier) {
          observed.cleanupAttackReached++
          if (!ctx) throw new Error('Native cleanup hook context missing')
          if (observed.cleanupAttack === 'different-delete') await ctx.context.internalAdapter.deleteVerificationByIdentifier('r1-foreign-cleanup-target')
          else if (observed.cleanupAttack === 'create') await ctx.context.internalAdapter.createVerificationValue({
            identifier: 'r1-foreign-cleanup-create', value: 'forbidden', expiresAt: new Date(Date.now() + 300000),
          })
          else await ctx.context.adapter.transaction(child => child.create({ model: 'verification', data: {
            id: randomUUID(), identifier: 'r1-direct-cleanup-write', value: 'forbidden', expiresAt: new Date(Date.now() + 300000),
          } }))
        }
      }, after: async data => {
        if (observed.holdConsumedRotation && data.identifier === observed.consumedRotationIdentifier) {
          const scope = await observed.readConsumedScope()
          observed.consumedCounterOneSeen = scope.counterOne
          observed.consumedRowAbsentSeen = scope.absent
          observed.consumedRotationReached++
          observed.consumedRotationEntered()
          await observed.consumedRotationGate
        }
      } }, create: { before: async data => {
        if (observed.stateExpiryBefore && data.value.includes('"purpose":"recovery-google-proof"')) {
          observed.stateExpiryBeforeReached++
          return { data: { expiresAt: new Date(data.expiresAt.getTime() + 60000) } }
        }
        return { data }
      }, after: async (_data, ctx) => {
        if (observed.stateReturnIdentifier && _data.value.includes('"purpose":"recovery-google-proof"')) {
          observed.stateReturnIdentifierReached++
          _data.identifier = 'altered-return-only-' + _data.identifier
        }
        if (observed.stateReturnValue && _data.value.includes('"purpose":"recovery-google-proof"')) {
          observed.stateReturnValueReached++
          _data.value = '{"altered":"return-only"}'
        }
        if (observed.holdRotationCreate && _data.identifier.startsWith('application-recovery-rotation-v1:')) {
          observed.rotationCreateReached++
          observed.rotationCreatedExpiresAtMs = _data.expiresAt.getTime()
          observed.rotationCreateEntered()
          await observed.rotationCreateGate
        }
        if (observed.proofCreateFailure && _data.identifier.startsWith('application-recovery-google-v1:')) {
          observed.proofCreateReached++; throw new Error('r1-secret-sentinel proof create')
        }
        if (observed.injectHeader) {
          if (!ctx) throw new Error('Native hook context missing')
          ctx.responseHeaders.append('set-cookie', '__Secure-better-auth.session_token=forbidden; Path=/; HttpOnly; Secure; SameSite=Lax')
          observed.injected++
        }
      } } },
    } })
  } }
})
vi.mock('../../src/modules/auth/mail-snapshot.server', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/modules/auth/mail-snapshot.server')>()
  return { ...actual, createMailSnapshot(...args: Parameters<typeof actual.createMailSnapshot>) {
    const result = actual.createMailSnapshot(...args)
    observed.enrollmentToken = args[3].toString('base64url')
    return result
  } }
})

const origin = 'https://app.example.test'
const profile = { appOrigin: origin, apiOrigin: 'https://mail.example.test', projectId: 'fixture', credentialId: 'fixture',
  from: { name: 'Fixture', email: 'auth@example.test' }, reply: 'support@example.test', replayWindowSeconds: null }
let ip = 1
function request(cookie = '', path = '/recovery-internal', method = 'POST', signal?: AbortSignal) {
  const value = Object.assign(new Request(origin + path, { method, signal, headers: {
    cookie, ...(method === 'POST' ? { origin } : {}), 'x-real-ip': `198.18.0.${ip++}`,
  } }), { runtime: { node: { req: { socket: { remoteAddress: '127.0.0.1' } } } } })
  Object.defineProperty(value, 'appAuthDeadlineAtMs', { value: Date.now() + 15000 })
  return value
}
const cookies = (headers: Headers) => headers.getSetCookie().filter(value => !/;\s*Max-Age=0(?:;|$)/i.test(value)).map(value => value.split(';')[0]).join('; ')
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const sentinel = 'r1-secret-sentinel'
function captureSecretLogs() {
  const leaked: string[] = []
  const spies = (['error', 'warn', 'log', 'info', 'debug'] as const).map(name => vi.spyOn(console, name).mockImplementation((...values: unknown[]) => {
    if (values.some(value => {
      try { return inspect(value, { depth: 4, customInspect: false, getters: false, maxArrayLength: 20, maxStringLength: 10000 }).includes(sentinel) }
      catch { return false }
    })) leaked.push(name)
  }))
  return { leaked, restore: () => { for (const spy of spies) spy.mockRestore() } }
}
async function fixedFailure(work: Promise<unknown>, message: string) {
  const error = await work.then(() => null, (failure: unknown) => failure)
  expect(error instanceof Error).toBe(true)
  if (!(error instanceof Error)) throw new Error('Expected fixed internal error')
  expect(error.message).toBe(message)
  expect('headers' in error).toBe(false)
  expect(error.message.includes(sentinel)).toBe(false)
}
function assertFixedRefusal(error: unknown, message: string) {
  expect(error instanceof Error).toBe(true)
  if (!(error instanceof Error)) throw new Error('Expected fixed native refusal')
  expect(error.message).toBe(message)
  expect('headers' in error).toBe(false)
}
async function settleOwnedClose(name: string, close: () => Promise<unknown> | undefined, failures: string[]) {
  const result: { status: 'pending' | 'fulfilled' | 'rejected' } = { status: 'pending' }
  const pending = Promise.resolve().then(close).then(() => { result.status = 'fulfilled' }, () => { result.status = 'rejected' })
  try { await bounded(pending, 15000) } catch {}
  if (result.status === 'pending') {
    // Keep observing the same operation after a first timeout. A race that
    // times out cannot establish that teardown itself has settled.
    try { await bounded(pending, 15000) } catch {}
  }
  if (result.status !== 'fulfilled') failures.push(name + (result.status === 'pending' ? '-unconfirmed' : '-failed'))
}
function assertOwnedCleanup(failures: string[]) {
  if (failures.length) throw new Error('Owned cleanup failed or unconfirmed; ROOT independent inventory required: ' + failures.join(','))
}
type SeededRecoveryGoogle = {
  stores: Awaited<ReturnType<typeof startDisposableStores>>
  peer: Awaited<ReturnType<typeof startGoogleProtocolPeer>>
  app: ReturnType<typeof createApplicationAuth>
  userId: string; accountId: string; batchId: string; codeId: string; email: string; code: string; subject: string
}
async function withSeededRecoveryGoogle(use: (fixture: SeededRecoveryGoogle) => Promise<void>,
  decorateOwner?: (owner: ReturnType<typeof createTransactions>, stores: SeededRecoveryGoogle['stores'], userId: string) => ReturnType<typeof createTransactions>) {
  const markerDirectory = await mkdtemp(join(tmpdir(), 'r1-headless-marker-'))
  let stores: SeededRecoveryGoogle['stores'] | undefined, peer: SeededRecoveryGoogle['peer'] | undefined
  let pool: Pool | undefined, limiter: ReturnType<typeof createAuthRateLimiter> | undefined
  let app: SeededRecoveryGoogle['app'] | undefined
  const cleanupFailures: string[] = []
  try {
    await mkdir(join(markerDirectory, 'server'))
    await writeFile(join(markerDirectory, 'server/index.mjs'), '// R1 headless fixture marker; not a built application.\n', { flag: 'wx' })
    stores = await startDisposableStores(markerDirectory)
    await stores.migrate()
    await stores.administrator.query('GRANT USAGE ON SCHEMA public TO runtime')
    await stores.administrator.query('GRANT SELECT,INSERT,UPDATE,DELETE ON public."user",public.account,public.session,public.verification TO runtime')
    const userId = randomUUID(), accountId = randomUUID(), batchId = randomUUID(), codeId = randomUUID(), subject = randomUUID()
    const email = 'r1-fix-' + userId + '@example.test', code = 'rc1_' + randomBytes(20).toString('base64url')
    const digest = createHash('sha256').update('recovery-code-v1\0' + code).digest('hex')
    await stores.administrator.query('INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$2,$3,true)', [userId, 'R1 native contract fixture', email])
    await stores.administrator.query('INSERT INTO account(id,user_id,provider_id,account_id) VALUES($1,$2,$3,$4)', [accountId, userId, 'google', subject])
    await stores.administrator.query('INSERT INTO recovery_code_batch(user_id,batch_id,format_version,recovery_generation,issued_at) VALUES($1,$2,1,0,clock_timestamp())', [userId, batchId])
    await stores.administrator.query('INSERT INTO recovery_code(id,user_id,batch_id,digest) VALUES($1,$2,$3,$4)', [codeId, userId, batchId, digest])
    peer = await startGoogleProtocolPeer({ ports: [stores.runtimeUrl, stores.directRuntimeUrl, stores.redisUrl].map(value => Number(new URL(value).port)) })
    pool = new Pool({ connectionString: stores.runtimeUrl, max: 3 })
    const actualOwner = createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
    const owner = decorateOwner?.(actualOwner, stores, userId) ?? actualOwner
    limiter = createAuthRateLimiter(readRateLimitConfig({ NODE_ENV: 'test', REDIS_URL: stores.redisUrl, RATE_LIMIT_HMAC_SECRET: stores.hmac,
      RATE_LIMIT_KEY_ID: 'r1-native-fix', TRUSTED_PROXY_IPS: '127.0.0.1' }))
    await limiter.connect()
    app = createApplicationAuth(owner, readAuthConfig({ APP_ORIGIN: origin, AUTH_SECRET: randomBytes(48).toString('hex'),
      GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fixture-only' })!, limiter)
    await use({ stores, peer, app, userId, accountId, batchId, codeId, email, code, subject })
  } finally {
    observed.observeRecoveryLookup = false; observed.stateExpiryBefore = false
    observed.stateReturnIdentifier = false; observed.stateReturnValue = false
    for (const [name, close] of [['app', () => app?.close()], ['limiter', () => limiter?.close()], ['pool', () => pool?.end()],
      ['peer', () => peer?.close()], ['stores', () => stores?.cleanup()]] as const) await settleOwnedClose(name, close, cleanupFailures)
    try {
      const target = await realpath(markerDirectory), parent = await realpath(tmpdir())
      if (dirname(target) !== parent || !basename(target).startsWith('r1-headless-marker-')) throw new Error('Marker ownership mismatch')
      await settleOwnedClose('marker', () => rm(target, { recursive: true }), cleanupFailures)
    } catch { cleanupFailures.push('marker') }
    assertOwnedCleanup(cleanupFailures)
  }
}
async function assertUnchangedRecoveryBeginAfterRefusal(fixture: SeededRecoveryGoogle, beforeVerification: string,
  beforeUser: string, beforeAccount: string) {
  const { stores, peer, app, userId, accountId, codeId, email, code } = fixture
  expect(hash((await stores.administrator.query('SELECT * FROM verification ORDER BY identifier,id')).rows)).toBe(beforeVerification)
  expect((await stores.administrator.query('SELECT count(*)::int n FROM recovery_attempt WHERE user_id=$1', [userId])).rows[0].n).toBe(0)
  expect((await stores.administrator.query('SELECT spent_at FROM recovery_code WHERE id=$1', [codeId])).rows[0].spent_at).toBeNull()
  expect(hash((await stores.administrator.query('SELECT * FROM "user" WHERE id=$1', [userId])).rows)).toBe(beforeUser)
  expect(hash((await stores.administrator.query('SELECT * FROM account WHERE id=$1', [accountId])).rows)).toBe(beforeAccount)
  expect(peer.evidence().posts).toBe(0)
  const positive = await bounded(app.beginRecoveryGoogleProof(request(), { email, code }), 16000)
  const state = new URL(positive.url).searchParams.get('state')
  expect(Boolean(state) && positive.headers.getSetCookie().length === 1).toBe(true)
  expect((await stores.administrator.query('SELECT count(*)::int n FROM recovery_attempt WHERE user_id=$1 AND phase=$2 AND oauth_state=$3',
    [userId, 'PENDING_GOOGLE', state])).rows[0].n).toBe(1)
  expect((await stores.administrator.query('SELECT count(*)::int n FROM verification WHERE identifier=$1', [state])).rows[0].n).toBe(1)
  expect(peer.evidence().posts).toBe(0)
}

type GoogleInvalidation = 'generation' | 'batch' | 'spent-code' | 'removed-code' | 'unlinked-account' | 'replaced-account'
const googleInvalidations: readonly GoogleInvalidation[] = [
  'generation', 'batch', 'spent-code', 'removed-code', 'unlinked-account', 'replaced-account',
]
async function googleInventory(fixture: SeededRecoveryGoogle) {
  const { administrator } = fixture.stores, user = fixture.userId
  return {
    user: hash((await administrator.query('SELECT * FROM "user" WHERE id=$1', [user])).rows),
    account: hash((await administrator.query('SELECT * FROM account WHERE user_id=$1 ORDER BY id', [user])).rows),
    session: hash((await administrator.query('SELECT * FROM session WHERE user_id=$1 ORDER BY id', [user])).rows),
    batch: hash((await administrator.query('SELECT * FROM recovery_code_batch WHERE user_id=$1', [user])).rows),
    code: hash((await administrator.query('SELECT * FROM recovery_code WHERE user_id=$1 ORDER BY id', [user])).rows),
    attempt: hash((await administrator.query('SELECT * FROM recovery_attempt WHERE user_id=$1 ORDER BY id', [user])).rows),
    verification: hash((await administrator.query('SELECT * FROM verification ORDER BY identifier,id')).rows),
    fact: hash((await administrator.query('SELECT * FROM recovery_code_rotation_fact WHERE actor_user_id=$1 ORDER BY id', [user])).rows),
  }
}
async function administerGoogleInvalidation(fixture: SeededRecoveryGoogle, kind: GoogleInvalidation) {
  const { administrator } = fixture.stores
  await bounded(administrator.query('BEGIN'), 16000)
  try {
    await bounded(administrator.query("SET LOCAL statement_timeout = '1000ms'"), 16000)
    const locked = await bounded(administrator.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [fixture.userId]), 16000)
    expect(locked.rows.length).toBe(1)
    if (kind === 'generation') {
      await bounded(administrator.query('UPDATE "user" SET recovery_generation=recovery_generation+1 WHERE id=$1', [fixture.userId]), 16000)
    } else if (kind === 'batch') {
      // The composite NO ACTION FK requires old code removal before replacing the current batch.
      await bounded(administrator.query('DELETE FROM recovery_code WHERE user_id=$1 AND batch_id=$2', [fixture.userId, fixture.batchId]), 16000)
      await bounded(administrator.query('DELETE FROM recovery_code_batch WHERE user_id=$1 AND batch_id=$2', [fixture.userId, fixture.batchId]), 16000)
      const nextBatch = randomUUID()
      await bounded(administrator.query('INSERT INTO recovery_code_batch(user_id,batch_id,format_version,recovery_generation,issued_at) VALUES($1,$2,1,0,clock_timestamp())',
        [fixture.userId, nextBatch]), 16000)
      for (let index = 0; index < 8; index++) {
        const replacement = 'rc1_' + randomBytes(20).toString('base64url')
        const digest = createHash('sha256').update('recovery-code-v1\0' + replacement).digest('hex')
        await bounded(administrator.query('INSERT INTO recovery_code(id,user_id,batch_id,digest) VALUES($1,$2,$3,$4)',
          [randomUUID(), fixture.userId, nextBatch, digest]), 16000)
      }
    } else if (kind === 'spent-code') {
      await bounded(administrator.query('UPDATE recovery_code SET spent_at=clock_timestamp() WHERE id=$1', [fixture.codeId]), 16000)
    } else if (kind === 'removed-code') {
      await bounded(administrator.query('DELETE FROM recovery_code WHERE id=$1', [fixture.codeId]), 16000)
    } else if (kind === 'unlinked-account') {
      await bounded(administrator.query('DELETE FROM account WHERE id=$1', [fixture.accountId]), 16000)
    } else {
      await bounded(administrator.query('DELETE FROM account WHERE id=$1', [fixture.accountId]), 16000)
      await bounded(administrator.query('INSERT INTO account(id,user_id,provider_id,account_id) VALUES($1,$2,$3,$4)',
        [randomUUID(), fixture.userId, 'google', fixture.subject]), 16000)
    }
    await bounded(administrator.query('COMMIT'), 16000)
  } catch (error) {
    await bounded(administrator.query('ROLLBACK'), 16000)
    throw error
  }
}
type GoogleCallbackOutcome = { value: Awaited<ReturnType<SeededRecoveryGoogle['app']['completeRecoveryGoogleProof']>>; error?: never }
  | { error: unknown; value?: never }
function googleCallback(fixture: SeededRecoveryGoogle, state: string, stateHeaders: Headers, providerCode: string) {
  return fixture.app.completeRecoveryGoogleProof(request(cookies(stateHeaders),
    '/api/auth/recovery/google/callback?state=' + state + '&code=' + providerCode, 'GET'))
    .then((value): GoogleCallbackOutcome => ({ value }), (error: unknown): GoogleCallbackOutcome => ({ error }))
}
async function waitForPeerHandoff(fixture: SeededRecoveryGoogle) {
  const start = Date.now()
  while (fixture.peer.evidence().pendingHandoffs === 0 && Date.now() - start < 5000) {
    await bounded(new Promise(resolve => setTimeout(resolve, 20)), 100)
  }
  expect(fixture.peer.evidence().pendingHandoffs).toBeGreaterThan(0)
}
async function assertExactGoogleProof(fixture: SeededRecoveryGoogle, originalAttempt: Record<string, unknown>) {
  const { administrator } = fixture.stores
  const finalAttempt = (await administrator.query('SELECT * FROM recovery_attempt WHERE id=$1', [originalAttempt.id])).rows
  expect(finalAttempt.length).toBe(1)
  expect(finalAttempt[0].phase).toBe('PROVED')
  expect(hash([{ ...finalAttempt[0], phase: 'PENDING_GOOGLE' }])).toBe(hash([originalAttempt]))
  const expectedIdentifier = 'application-recovery-google-v1:' + originalAttempt.id
  const rows = (await administrator.query('SELECT * FROM verification WHERE identifier=$1', [expectedIdentifier])).rows
  expect(rows.length).toBe(1)
  expect(rows[0].identifier === expectedIdentifier).toBe(true)
  expect(new Date(rows[0].expires_at).getTime() === new Date(originalAttempt.expires_at as string).getTime()).toBe(true)
  let storedValue: unknown
  try { storedValue = JSON.parse(rows[0].value) } catch { throw new Error('Native proof shape invalid') }
  const expectedValue = { version: 1, purpose: 'recovery-google-proof', userId: originalAttempt.user_id,
    attemptId: originalAttempt.id, recoveryGeneration: originalAttempt.recovery_generation,
    batchId: originalAttempt.batch_id, codeId: originalAttempt.code_id, googleAccountId: originalAttempt.google_account_id,
    issuer: 'https://accounts.google.com', subject: originalAttempt.subject,
    expiresAt: new Date(originalAttempt.expires_at as string).toISOString() }
  expect(hash(storedValue)).toBe(hash(expectedValue))
  expect((await administrator.query('SELECT count(*)::int n FROM verification WHERE identifier=$1',
    [originalAttempt.oauth_state])).rows[0].n).toBe(0)
}

test('R1 malformed callbacks leave an otherwise valid signed recovery tuple usable', async () => {
  await withSeededRecoveryGoogle(async fixture => {
    const { app, stores, peer, email, code } = fixture
    const begun = await bounded(app.beginRecoveryGoogleProof(request(), { email, code }), 16000)
    const state = new URL(begun.url).searchParams.get('state')
    if (!state) throw new Error('Missing native state')
    const providerCode = peer.register(begun.url, fixture.subject, { email })
    const canonical = '/api/auth/recovery/google/callback?state=' + state + '&code=' + providerCode
    const lengthOnlyCode = providerCode + 'a'.repeat(4096 - providerCode.length)
    const encodedLengthOnlyCode = Array.from(lengthOnlyCode, character => '%' + character.charCodeAt(0).toString(16).padStart(2, '0')).join('')
    const overlongURL = origin + '/api/auth/recovery/google/callback?state=' + state + '&code=' + encodedLengthOnlyCode
    const parsedOverlongURL = new URL(overlongURL)
    expect(overlongURL.length > 8192 && parsedOverlongURL.searchParams.getAll('state').length === 1
      && parsedOverlongURL.searchParams.getAll('code').length === 1
      && state.length > 0 && state.length <= 1024 && parsedOverlongURL.searchParams.get('state') === state
      && parsedOverlongURL.searchParams.get('code')?.length === 4096).toBe(true)
    const malformed = [
      ['missing-state', '?code=' + providerCode], ['empty-state', '?state=&code=' + providerCode],
      ['duplicate-state', '?state=' + state + '&state=' + state + '&code=' + providerCode],
      ['missing-code', '?state=' + state], ['empty-code', '?state=' + state + '&code='],
      ['duplicate-code', '?state=' + state + '&code=' + providerCode + '&code=' + providerCode],
      ['error-form', '?state=' + state + '&error=access_denied'],
      ['mixed-error', '?state=' + state + '&code=' + providerCode + '&error=access_denied'],
      ['overlong-state', '?state=' + state + 'a'.repeat(1025 - state.length) + '&code=' + providerCode],
      ['overlong-code', '?state=' + state + '&code=' + providerCode + 'a'.repeat(4097 - providerCode.length)],
      ['overlong-url', parsedOverlongURL.search],
      ['wrong-method', '?state=' + state + '&code=' + providerCode],
    ] as const
    const baseline = await googleInventory(fixture)
    observed.nativeVerificationLookups = 0; observed.nativeVerificationSweeps = 0; observed.observeRecoveryLookup = true
    try {
      for (const [kind, query] of malformed) {
        const method = kind === 'wrong-method' ? 'POST' : 'GET'
        const invalid = request(cookies(begun.headers), '/api/auth/recovery/google/callback' + query, method)
        await fixedFailure(bounded(app.completeRecoveryGoogleProof(invalid), 16000), 'Authentication rejected')
        expect(observed.nativeVerificationLookups).toBe(0)
        expect(observed.nativeVerificationSweeps).toBe(0)
        expect(peer.evidence().posts).toBe(0)
        expect(await googleInventory(fixture)).toEqual(baseline)
      }
    } finally { observed.observeRecoveryLookup = false }
    const original = (await stores.administrator.query('SELECT * FROM recovery_attempt WHERE oauth_state=$1', [state])).rows
    expect(original.length).toBe(1)
    const callback = googleCallback(fixture, state, begun.headers, providerCode)
    const cleanupFailures: string[] = []
    try {
      const outcome = await bounded(callback, 16000)
      expect(outcome.error).toBeUndefined()
      expect(outcome.value?.outcome).toBe('proved')
      expect(peer.evidence().posts).toBe(1)
      await assertExactGoogleProof(fixture, original[0])
    } finally {
      await settleOwnedClose('malformed-original-valid-callback', () => callback, cleanupFailures)
      assertOwnedCleanup(cleanupFailures)
    }
  })
}, 300000)

for (const kind of ['missing nonce', 'wrong nonce', 'raw subject mismatch'] as const) {
  test(`R1 Google ${kind} after confirmed claim leaves no proof`, async () => {
    await withSeededRecoveryGoogle(async fixture => {
      const { app, stores, peer, email, code } = fixture
      const begun = await bounded(app.beginRecoveryGoogleProof(request(), { email, code }), 16000)
      const state = new URL(begun.url).searchParams.get('state')
      if (!state) throw new Error('Missing native state')
      const original = (await stores.administrator.query('SELECT * FROM recovery_attempt WHERE oauth_state=$1', [state])).rows
      expect(original.length).toBe(1)
      const before = await googleInventory(fixture)
      const providerCode = kind === 'missing nonce' ? peer.register(begun.url, fixture.subject, { email, omitClaims: ['nonce'] })
        : kind === 'wrong nonce' ? peer.register(begun.url, fixture.subject, { email, claims: { nonce: 'wrong-nonce' } })
          : peer.register(begun.url, randomUUID(), { email })
      const callback = googleCallback(fixture, state, begun.headers, providerCode)
      const cleanupFailures: string[] = []
      try {
        const outcome = await bounded(callback, 16000)
        expect(outcome.value).toBeUndefined()
        assertFixedRefusal(outcome.error, kind === 'raw subject mismatch' ? 'Authentication rejected' : 'Authentication unavailable')
        expect(peer.evidence().posts).toBe(1)
        const after = await googleInventory(fixture)
        for (const field of ['user', 'account', 'session', 'batch', 'code', 'fact'] as const) expect(after[field]).toBe(before[field])
        const attempted = (await stores.administrator.query('SELECT * FROM recovery_attempt WHERE oauth_state=$1', [state])).rows
        expect(attempted.length).toBe(1)
        expect(attempted[0].phase).toBe('EXCHANGING')
        expect(hash([{ ...attempted[0], phase: 'PENDING_GOOGLE' }])).toBe(hash(original))
        expect((await stores.administrator.query('SELECT count(*)::int n FROM verification WHERE identifier=$1', [state])).rows[0].n).toBe(0)
        expect((await stores.administrator.query('SELECT count(*)::int n FROM verification WHERE identifier=$1',
          ['application-recovery-google-v1:' + original[0].id])).rows[0].n).toBe(0)
      } finally {
        await settleOwnedClose('nonce-subject-original-callback', () => callback, cleanupFailures)
        assertOwnedCleanup(cleanupFailures)
      }
    })
  }, 300000)
}

for (const kind of ['batch rotation', 'account unlink', 'attempt removal'] as const) {
  test(`R1 ordinary callback fences retained recovery state after ${kind}`, async () => {
    await withSeededRecoveryGoogle(async fixture => {
      const { app, stores, peer, email, code, userId } = fixture
      const begun = await bounded(app.beginRecoveryGoogleProof(request(), { email, code }), 16000)
      const state = new URL(begun.url).searchParams.get('state')
      if (!state) throw new Error('Missing native state')
      const providerCode = peer.register(begun.url, fixture.subject, { email })
      if (kind === 'batch rotation') await administerGoogleInvalidation(fixture, 'batch')
      else if (kind === 'account unlink') await administerGoogleInvalidation(fixture, 'unlinked-account')
      else {
        await bounded(stores.administrator.query('BEGIN'), 16000)
        try {
          await bounded(stores.administrator.query("SET LOCAL statement_timeout = '1000ms'"), 16000)
          await bounded(stores.administrator.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [userId]), 16000)
          await bounded(stores.administrator.query('DELETE FROM recovery_attempt WHERE oauth_state=$1', [state]), 16000)
          await bounded(stores.administrator.query('COMMIT'), 16000)
        } catch (error) { await bounded(stores.administrator.query('ROLLBACK'), 16000); throw error }
      }
      await bounded(stores.administrator.query(`INSERT INTO verification(id,identifier,value,expires_at)
        VALUES($1,'r1-fence-expired-canary','canary',clock_timestamp()-interval '1 minute')`, [randomUUID()]), 16000)
      const before = await googleInventory(fixture)
      expect((await stores.administrator.query('SELECT count(*)::int n FROM verification WHERE identifier=$1', [state])).rows[0].n).toBe(1)
      observed.nativeVerificationLookups = 0; observed.nativeVerificationSweeps = 0; observed.observeOrdinary = true
      try {
        const response = await bounded(app.callback(request(cookies(begun.headers),
          '/api/auth/callback/google?state=' + state + '&code=' + providerCode, 'GET')), 16000)
        expect(response.status).toBe(401)
        expect(response.headers.getSetCookie().length).toBe(0)
      } finally { observed.observeOrdinary = false }
      expect(observed.nativeVerificationLookups).toBe(0)
      expect(observed.nativeVerificationSweeps).toBe(0)
      expect(peer.evidence().posts).toBe(0)
      expect(await googleInventory(fixture)).toEqual(before)
      if (kind === 'attempt removal') {
        const normal = await bounded(app.beginGoogleSignIn(request()), 16000)
        const normalState = new URL(normal.url).searchParams.get('state')
        if (!normalState) throw new Error('Missing ordinary state')
        const normalCode = peer.register(normal.url, fixture.subject, { email })
        const positive = await bounded(app.callback(request(cookies(normal.headers),
          '/api/auth/callback/google?state=' + normalState + '&code=' + normalCode, 'GET')), 16000)
        expect(positive.status).toBe(302)
        expect((await bounded(app.requirePrincipal(request(cookies(positive.headers))), 16000)).userId).toBe(userId)
        expect(peer.evidence().posts).toBe(1)
      }
    })
  }, 300000)
}

type NativeRotationFixture = {
  stores: Awaited<ReturnType<typeof startDisposableStores>>; app: ReturnType<typeof createApplicationAuth>
  cookie: string; credential: ReturnType<typeof registrationCredentialFixture>; userId: string; sessionId: string; keyId: string
}
async function withNativeRecoveryRotation(use: (fixture: NativeRotationFixture) => Promise<void>,
  decorateOwner?: (owner: ReturnType<typeof createTransactions>, stores: NativeRotationFixture['stores']) => ReturnType<typeof createTransactions>) {
  const markerDirectory = await mkdtemp(join(tmpdir(), 'r1-headless-marker-'))
  let stores: NativeRotationFixture['stores'] | undefined, app: NativeRotationFixture['app'] | undefined
  let pool: Pool | undefined, limiter: ReturnType<typeof createAuthRateLimiter> | undefined
  const cleanupFailures: string[] = []
  try {
    await mkdir(join(markerDirectory, 'server'))
    await writeFile(join(markerDirectory, 'server/index.mjs'), '// R1 headless fixture marker; not a built application.\n', { flag: 'wx' })
    stores = await startDisposableStores(markerDirectory)
    await stores.migrate()
    await stores.administrator.query(`GRANT USAGE ON SCHEMA public TO runtime;
      GRANT SELECT,INSERT,UPDATE,DELETE ON public."user",public.account,public.session,public.verification TO runtime;
      GRANT SELECT,INSERT ON public.passkey TO runtime; GRANT UPDATE(counter) ON public.passkey TO runtime;
      GRANT SELECT,INSERT,UPDATE ON public.auth_email_request TO runtime; GRANT SELECT,INSERT ON public.auth_email_command TO runtime;
      GRANT SELECT ON public.email_delivery,public.auth_email_outbox TO runtime;
      GRANT INSERT(id,command_id,state,verifier_hash,key_id,ciphertext,nonce,tag,snapshot_format,snapshot_hash,replay_window_seconds)
        ON public.email_delivery TO runtime;
      GRANT UPDATE(state,verifier_hash,ciphertext,nonce,tag) ON public.email_delivery TO runtime;
      GRANT INSERT(id,delivery_id) ON public.auth_email_outbox TO runtime`)
    pool = new Pool({ connectionString: stores.runtimeUrl, max: 3 })
    const actualOwner = createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
    const owner = decorateOwner?.(actualOwner, stores) ?? actualOwner
    limiter = createAuthRateLimiter(readRateLimitConfig({ NODE_ENV: 'test', REDIS_URL: stores.redisUrl, RATE_LIMIT_HMAC_SECRET: stores.hmac,
      RATE_LIMIT_KEY_ID: 'r1-native-remaining', TRUSTED_PROXY_IPS: '127.0.0.1' }))
    await limiter.connect()
    app = createApplicationAuth(owner, { ...readAuthConfig({ APP_ORIGIN: origin, AUTH_SECRET: randomBytes(48).toString('hex') })!,
      magic: { envelope: createAuthEmailEnvelope({ currentKeyId: 'fixture', keys: { fixture: randomBytes(32) } }), profile } }, limiter)
    const email = 'r1-native-remaining-' + randomUUID() + '@example.test'
    await bounded(app.requestMagicLink(request(), { email, locale: 'en' }), 16000)
    const enrollment = { token: observed.enrollmentToken, intendedEmail: email }
    const options = await bounded(magicConsumeResponse(request(), enrollment, app, limiter), 16000)
    expect(options.status).toBe(200)
    const body = await options.json(), credential = registrationCredentialFixture(body.options, origin)
    const enrolled = await bounded(magicEnrollmentResponse(request(cookies(options.headers)),
      { ...enrollment, response: credential.response }, app, limiter), 16000)
    expect(enrolled.status).toBe(200)
    const cookie = cookies(enrolled.headers), principal = await bounded(app.requirePrincipal(request(cookie)), 16000)
    const keys = (await stores.administrator.query('SELECT id FROM passkey WHERE user_id=$1', [principal.userId])).rows
    expect(keys.length).toBe(1)
    await use({ stores, app, cookie, credential, userId: principal.userId, sessionId: principal.sessionId, keyId: keys[0].id })
  } finally {
    for (const [name, close] of [['app', () => app?.close()], ['limiter', () => limiter?.close()], ['pool', () => pool?.end()],
      ['stores', () => stores?.cleanup()]] as const) await settleOwnedClose(name, close, cleanupFailures)
    try {
      const target = await realpath(markerDirectory), parent = await realpath(tmpdir())
      if (dirname(target) !== parent || !basename(target).startsWith('r1-headless-marker-')) throw new Error('Marker ownership mismatch')
      await settleOwnedClose('marker', () => rm(target, { recursive: true }), cleanupFailures)
    } catch { cleanupFailures.push('marker') }
    assertOwnedCleanup(cleanupFailures)
  }
}
async function rotationInventory(fixture: NativeRotationFixture) {
  const { administrator } = fixture.stores, id = fixture.userId
  return {
    user: hash((await administrator.query('SELECT * FROM "user" WHERE id=$1', [id])).rows),
    session: hash((await administrator.query('SELECT * FROM session WHERE user_id=$1 ORDER BY id', [id])).rows),
    account: hash((await administrator.query('SELECT * FROM account WHERE user_id=$1 ORDER BY id', [id])).rows),
    key: hash((await administrator.query('SELECT * FROM passkey WHERE user_id=$1 ORDER BY id', [id])).rows),
    batch: hash((await administrator.query('SELECT * FROM recovery_code_batch WHERE user_id=$1', [id])).rows),
    code: hash((await administrator.query('SELECT * FROM recovery_code WHERE user_id=$1 ORDER BY id', [id])).rows),
    fact: hash((await administrator.query('SELECT * FROM recovery_code_rotation_fact WHERE actor_user_id=$1 ORDER BY id', [id])).rows),
    verification: hash((await administrator.query('SELECT * FROM verification ORDER BY identifier,id')).rows),
  }
}
for (const condition of ['authenticated age', 'idle age', 'non-ACTIVE', 'recovering', 'generation mismatch'] as const) {
  test(`R1 protected rotation ${condition} refuses Begin and signed Finish without touch`, async () => {
    await withNativeRecoveryRotation(async fixture => {
      const { app, stores, cookie, credential, userId, sessionId } = fixture
      const challenge = await bounded(app.beginRecoveryCodeRotation(request(cookie)), 16000)
      await bounded(stores.administrator.query('BEGIN'), 16000)
      try {
        await bounded(stores.administrator.query("SET LOCAL statement_timeout = '1000ms'"), 16000)
        await bounded(stores.administrator.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [userId]), 16000)
        if (condition === 'authenticated age') await bounded(stores.administrator.query(
          "UPDATE session SET authenticated_at=clock_timestamp()-interval '8 days' WHERE id=$1", [sessionId]), 16000)
        else if (condition === 'idle age') await bounded(stores.administrator.query(
          "UPDATE session SET last_activity_at=clock_timestamp()-interval '13 hours' WHERE id=$1", [sessionId]), 16000)
        else if (condition === 'non-ACTIVE') await bounded(stores.administrator.query(
          "UPDATE session SET auth_state='MFA_PENDING' WHERE id=$1", [sessionId]), 16000)
        else if (condition === 'recovering') await bounded(stores.administrator.query(
          'UPDATE "user" SET recovering=true WHERE id=$1', [userId]), 16000)
        else await bounded(stores.administrator.query('UPDATE "user" SET recovery_generation=recovery_generation+1 WHERE id=$1', [userId]), 16000)
        await bounded(stores.administrator.query('COMMIT'), 16000)
      } catch (error) { await bounded(stores.administrator.query('ROLLBACK'), 16000); throw error }
      const declared = await rotationInventory(fixture)
      await fixedFailure(bounded(app.beginRecoveryCodeRotation(request(cookie)), 16000), 'Authentication rejected')
      expect(await rotationInventory(fixture)).toEqual(declared)
      await fixedFailure(bounded(app.finishRecoveryCodeRotation(request(cookie), { challengeId: challenge.challengeId,
        response: credential.authenticationResponse(challenge.options, { counter: 1 }) }), 16000), 'Authentication rejected')
      expect(await rotationInventory(fixture)).toEqual(declared)
      expect((await stores.administrator.query('SELECT count(*)::int n FROM verification WHERE identifier LIKE $1',
        ['%:' + challenge.challengeId])).rows[0].n).toBe(1)
    })
  }, 300000)
}

test('R1 signed Finish rolls back nonzero counter after reached native challenge consumption crosses cap', async () => {
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const cleanupFailures: string[] = []
  let pending: Promise<{ accepted: true } | { accepted: false; error: unknown }> | undefined
  try {
    await withNativeRecoveryRotation(async fixture => {
      const { app, stores, cookie, credential, sessionId, keyId } = fixture
      try {
      await bounded(stores.administrator.query(
        "UPDATE session SET last_activity_at=clock_timestamp()-interval '11 hours 59 minutes 54 seconds' WHERE id=$1", [sessionId]), 16000)
      const challenge = await bounded(app.beginRecoveryCodeRotation(request(cookie)), 16000)
      const identifierRows = (await stores.administrator.query('SELECT identifier FROM verification WHERE identifier LIKE $1',
        ['%:' + challenge.challengeId])).rows
      expect(identifierRows.length).toBe(1)
      const before = await rotationInventory(fixture)
      const counter = (await stores.administrator.query('SELECT counter FROM passkey WHERE id=$1', [keyId])).rows[0].counter
      expect(counter).toBe(0)
      let entered = () => {}
      const reached = new Promise<void>(resolve => { entered = resolve })
      observed.consumedRotationEntered = entered; observed.consumedRotationGate = gate
      observed.consumedRotationReached = 0; observed.consumedCounterKeyId = keyId
      observed.consumedRotationIdentifier = identifierRows[0].identifier
      observed.consumedCounterOneSeen = false; observed.consumedRowAbsentSeen = false; observed.holdConsumedRotation = true
      pending = app.finishRecoveryCodeRotation(request(cookie), { challengeId: challenge.challengeId,
        response: credential.authenticationResponse(challenge.options, { counter: 1 }) })
        .then(() => ({ accepted: true as const }), (error: unknown) => ({ accepted: false as const, error }))
      try {
        await bounded(reached, 6000)
        expect(observed.consumedRotationReached).toBe(1)
        expect(observed.consumedCounterOneSeen).toBe(true)
        expect(observed.consumedRowAbsentSeen).toBe(true)
        const waitMs = Date.parse(challenge.expiresAt) - Date.now() + 100
        expect(waitMs > 0 && waitMs < 10000).toBe(true)
        await bounded(new Promise(resolve => setTimeout(resolve, waitMs)), 11000)
      } finally { release(); observed.holdConsumedRotation = false }
      const outcome = await bounded(pending, 16000)
      expect(outcome.accepted).toBe(false)
      if (outcome.accepted) throw new Error('Expired signed Finish was accepted')
      assertFixedRefusal(outcome.error, 'Authentication rejected')
      expect(await rotationInventory(fixture)).toEqual(before)
      expect((await stores.administrator.query('SELECT counter FROM passkey WHERE id=$1', [keyId])).rows[0].counter).toBe(0)
      } finally {
        release(); observed.holdConsumedRotation = false
        if (pending) await settleOwnedClose('consumed-cap-original-finish', () => pending, cleanupFailures)
        assertOwnedCleanup(cleanupFailures)
      }
    })
  } finally {
    release(); observed.holdConsumedRotation = false; observed.consumedRotationEntered = () => {}
    observed.consumedRotationGate = Promise.resolve(); observed.consumedCounterKeyId = ''
    observed.consumedRotationIdentifier = ''; observed.consumedRowAbsentSeen = false
    if (pending) await settleOwnedClose('consumed-cap-original-finish-finally', () => pending, cleanupFailures)
    assertOwnedCleanup(cleanupFailures)
  }
}, 300000)

test('R1 signed Finish refuses cap crossed inside reached awaited fact INSERT trigger', async () => {
  await withNativeRecoveryRotation(async fixture => {
    const { app, stores, cookie, credential, sessionId, keyId } = fixture
    let observer: Client | undefined
    let pending: Promise<{ accepted: true } | { accepted: false; error: unknown }> | undefined
    const cleanupFailures: string[] = []
    try {
      await bounded(stores.administrator.query(
        "UPDATE session SET last_activity_at=clock_timestamp()-interval '11 hours 59 minutes 54 seconds' WHERE id=$1", [sessionId]), 16000)
      const challenge = await bounded(app.beginRecoveryCodeRotation(request(cookie)), 16000)
      const before = await rotationInventory(fixture)
      await bounded(stores.administrator.query('CREATE TABLE r1_fact_pause_control(target_at timestamptz NOT NULL)'), 16000)
      await bounded(stores.administrator.query('GRANT SELECT ON r1_fact_pause_control TO runtime'), 16000)
      await bounded(stores.administrator.query('INSERT INTO r1_fact_pause_control(target_at) VALUES($1)',
        [new Date(Date.parse(challenge.expiresAt) + 80)]), 16000)
      await bounded(stores.administrator.query(`CREATE FUNCTION r1_fact_pause_after_insert() RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE remaining_seconds double precision;
        observed_counter integer;
        BEGIN
          SELECT counter INTO observed_counter FROM passkey WHERE id=NEW.authorizing_passkey_id;
          IF observed_counter IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'r1 fact counter setup'; END IF;
          SELECT EXTRACT(EPOCH FROM target_at-clock_timestamp()) INTO remaining_seconds FROM r1_fact_pause_control LIMIT 1;
          IF remaining_seconds <= 0 OR remaining_seconds >= 0.85 THEN RAISE EXCEPTION 'r1 fact pause setup window'; END IF;
          PERFORM pg_sleep(remaining_seconds);
          RETURN NEW;
        END $$`), 16000)
      await bounded(stores.administrator.query(`CREATE TRIGGER r1_fact_pause_after_insert AFTER INSERT ON recovery_code_rotation_fact
        FOR EACH ROW EXECUTE FUNCTION r1_fact_pause_after_insert()`), 16000)
      observer = new Client({ connectionString: stores.directRuntimeUrl, connectionTimeoutMillis: 500 })
      await bounded(observer.connect(), 16000)
      const approach = Date.parse(challenge.expiresAt) - Date.now() - 700
      expect(approach > 0 && approach < 10000).toBe(true)
      await bounded(new Promise(resolve => setTimeout(resolve, approach)), 11000)
      pending = app.finishRecoveryCodeRotation(request(cookie), { challengeId: challenge.challengeId,
        response: credential.authenticationResponse(challenge.options, { counter: 1 }) })
        .then(() => ({ accepted: true as const }), (error: unknown) => ({ accepted: false as const, error }))
      let reached = false
      const started = Date.now()
      while (!reached && Date.now() - started < 900) {
        const rows = (await bounded(observer.query(`SELECT count(*)::int n FROM pg_stat_activity WHERE usename='runtime'
          AND wait_event='PgSleep' AND query ILIKE '%recovery_code_rotation_fact%'`), 16000)).rows
        reached = rows[0].n > 0
        if (!reached) await bounded(new Promise(resolve => setTimeout(resolve, 10)), 100)
      }
      expect(reached).toBe(true)
      const outcome = await bounded(pending, 16000)
      expect(outcome.accepted).toBe(false)
      if (outcome.accepted) throw new Error('Fact INSERT crossed challenge cap and returned codes')
      assertFixedRefusal(outcome.error, 'Authentication rejected')
      expect(Date.now() >= Date.parse(challenge.expiresAt)).toBe(true)
      expect(await rotationInventory(fixture)).toEqual(before)
      expect((await stores.administrator.query('SELECT counter FROM passkey WHERE id=$1', [keyId])).rows[0].counter).toBe(0)
    } finally {
      if (pending) await settleOwnedClose('fact-insert-original-finish', () => pending, cleanupFailures)
      if (observer) await settleOwnedClose('fact-insert-observer', () => observer?.end(), cleanupFailures)
      assertOwnedCleanup(cleanupFailures)
    }
  })
}, 300000)

test('R1 signed Finish refuses fresh expiry after reached User-lock wait', async () => {
  let pending: Promise<{ accepted: true } | { accepted: false; error: unknown }> | undefined
  let observer: Client | undefined, locked = false
  const cleanupFailures: string[] = []
  await withNativeRecoveryRotation(async fixture => {
    const { app, stores, cookie, credential, sessionId, userId, keyId } = fixture
    try {
      await bounded(stores.administrator.query(
        "UPDATE session SET last_activity_at=clock_timestamp()-interval '11 hours 59 minutes 54 seconds' WHERE id=$1", [sessionId]), 16000)
      const challenge = await bounded(app.beginRecoveryCodeRotation(request(cookie)), 16000)
      const before = await rotationInventory(fixture)
      observer = new Client({ connectionString: stores.directRuntimeUrl, connectionTimeoutMillis: 500 })
      await bounded(observer.connect(), 16000)
      const approach = Date.parse(challenge.expiresAt) - Date.now() - 800
      expect(approach > 0 && approach < 10000).toBe(true)
      await bounded(new Promise(resolve => setTimeout(resolve, approach)), 11000)
      await bounded(stores.administrator.query('BEGIN'), 16000); locked = true
      await bounded(stores.administrator.query("SET LOCAL statement_timeout = '1000ms'"), 16000)
      await bounded(stores.administrator.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [userId]), 16000)
      pending = app.finishRecoveryCodeRotation(request(cookie), { challengeId: challenge.challengeId,
        response: credential.authenticationResponse(challenge.options, { counter: 1 }) })
        .then(() => ({ accepted: true as const }), (error: unknown) => ({ accepted: false as const, error }))
      let reached = false
      const started = Date.now()
      while (!reached && Date.now() - started < 500) {
        const rows = (await bounded(observer.query(
          "SELECT count(*)::int n FROM pg_stat_activity WHERE usename='runtime' AND wait_event_type='Lock' AND query ILIKE '%user%' AND query ILIKE '%FOR UPDATE%'"), 16000)).rows
        reached = rows[0].n > 0
        if (!reached) await bounded(new Promise(resolve => setTimeout(resolve, 10)), 100)
      }
      expect(reached).toBe(true)
      const waitMs = Date.parse(challenge.expiresAt) - Date.now() + 60
      expect(waitMs > 0 && waitMs < 900).toBe(true)
      await bounded(new Promise(resolve => setTimeout(resolve, waitMs)), 1000)
      await bounded(stores.administrator.query('COMMIT'), 16000); locked = false
      const outcome = await bounded(pending, 16000)
      expect(outcome.accepted).toBe(false)
      if (outcome.accepted) throw new Error('User-lock-tail expired Finish was accepted')
      assertFixedRefusal(outcome.error, 'Authentication rejected')
      expect(await rotationInventory(fixture)).toEqual(before)
      expect((await stores.administrator.query('SELECT counter FROM passkey WHERE id=$1', [keyId])).rows[0].counter).toBe(0)
    } finally {
      if (locked) await settleOwnedClose('user-tail-lock-release', () => stores.administrator.query('ROLLBACK'), cleanupFailures)
      if (pending) await settleOwnedClose('user-tail-original-finish', () => pending, cleanupFailures)
      if (observer) await settleOwnedClose('user-tail-observer', () => observer?.end(), cleanupFailures)
      assertOwnedCleanup(cleanupFailures)
    }
  })
}, 300000)

test('R1 reached audit INSERT privilege failure rolls back signed rotation and withholds codes', async () => {
  await withNativeRecoveryRotation(async fixture => {
    const { app, stores, cookie, credential, keyId } = fixture
    const challenge = await bounded(app.beginRecoveryCodeRotation(request(cookie)), 16000)
    const identifierRows = (await stores.administrator.query('SELECT identifier FROM verification WHERE identifier LIKE $1',
      ['%:' + challenge.challengeId])).rows
    expect(identifierRows.length).toBe(1)
    const before = await rotationInventory(fixture)
    await bounded(stores.administrator.query('REVOKE INSERT ON public.recovery_code_rotation_fact FROM runtime'), 16000)
    observed.holdConsumedRotation = true; observed.consumedRotationReached = 0
    observed.consumedCounterKeyId = keyId; observed.consumedRotationIdentifier = identifierRows[0].identifier
    observed.consumedCounterOneSeen = false; observed.consumedRowAbsentSeen = false
    observed.consumedRotationGate = Promise.resolve(); observed.consumedRotationEntered = () => {}
    const pending = app.finishRecoveryCodeRotation(request(cookie), { challengeId: challenge.challengeId,
      response: credential.authenticationResponse(challenge.options, { counter: 1 }) })
      .then(() => ({ accepted: true as const }), (error: unknown) => ({ accepted: false as const, error }))
    const cleanupFailures: string[] = []
    try {
      const outcome = await bounded(pending, 16000)
      expect(outcome.accepted).toBe(false)
      if (outcome.accepted) throw new Error('Denied audit insertion returned codes')
      assertFixedRefusal(outcome.error, 'PostgreSQL transaction failed')
      expect(observed.consumedRotationReached).toBe(1)
      expect(observed.consumedCounterOneSeen).toBe(true)
      expect(observed.consumedRowAbsentSeen).toBe(true)
      expect(await rotationInventory(fixture)).toEqual(before)
      expect((await stores.administrator.query('SELECT counter FROM passkey WHERE id=$1', [keyId])).rows[0].counter).toBe(0)
    } finally {
      observed.holdConsumedRotation = false; observed.consumedRotationGate = Promise.resolve()
      observed.consumedRotationEntered = () => {}; observed.consumedCounterKeyId = ''
      observed.consumedRotationIdentifier = ''; observed.consumedRowAbsentSeen = false
      await settleOwnedClose('audit-denied-original-finish', () => pending, cleanupFailures)
      assertOwnedCleanup(cleanupFailures)
    }
  })
}, 300000)

test('R1 rotation Begin cleanup inspects only first 25 physical rows and preserves unsafe groups', async () => {
  await withNativeRecoveryRotation(async fixture => {
    const { app, stores, cookie, userId, sessionId } = fixture
    const source = await bounded(app.beginRecoveryCodeRotation(request(cookie)), 16000)
    const current = (await stores.administrator.query('SELECT identifier,value FROM verification WHERE identifier LIKE $1',
      ['%:' + source.challengeId])).rows
    expect(current.length).toBe(1)
    const prefix = String(current[0].identifier).slice(0, -source.challengeId.length)
    const template = JSON.parse(current[0].value)
    const anchor = Date.now() - 600000
    const ids: string[] = [], unsafe: string[] = [], boundary: string[] = []
    async function insert(index: number, mode: 'safe' | 'malformed' | 'foreign' | 'duplicate' | 'boundary') {
      const id = randomUUID(), identifier = prefix + randomUUID(), expiry = new Date(anchor + index * 1000)
      const value = mode === 'malformed' ? '{malformed' : JSON.stringify({ ...template,
        userId: mode === 'foreign' ? randomUUID() : userId, originalSessionId: sessionId, expiresAt: expiry.toISOString() })
      await bounded(stores.administrator.query('INSERT INTO verification(id,identifier,value,expires_at) VALUES($1,$2,$3,$4)',
        [id, identifier, value, expiry]), 16000)
      ids.push(id)
      if (mode === 'malformed' || mode === 'foreign' || mode === 'duplicate') unsafe.push(id)
      if (mode === 'boundary') boundary.push(id)
      if (mode === 'duplicate') {
        const activeId = randomUUID()
        await bounded(stores.administrator.query('INSERT INTO verification(id,identifier,value,expires_at) VALUES($1,$2,$3,$4)',
          [activeId, identifier, value, new Date(Date.now() + 300000)]), 16000)
        unsafe.push(activeId)
      }
    }
    for (let index = 0; index < 21; index++) await insert(index, 'safe')
    await insert(21, 'duplicate'); await insert(22, 'malformed'); await insert(23, 'foreign')
    await insert(24, 'safe'); await insert(25, 'boundary'); await insert(26, 'boundary')
    const foreignId = randomUUID()
    await bounded(stores.administrator.query('INSERT INTO verification(id,identifier,value,expires_at) VALUES($1,$2,$3,$4)',
      [foreignId, 'application-recovery-rotation-v1:foreign:' + randomUUID(), '{malformed', new Date(anchor)]), 16000)
    const survivors = [...unsafe, ...boundary, foreignId]
    const survivorsBefore = hash((await stores.administrator.query('SELECT * FROM verification WHERE id=ANY($1::text[]) ORDER BY id',
      [survivors])).rows)
    const currentBefore = hash((await stores.administrator.query('SELECT * FROM verification WHERE identifier LIKE $1',
      ['%:' + source.challengeId])).rows)
    const before = await rotationInventory(fixture)
    const pending = app.beginRecoveryCodeRotation(request(cookie))
    const cleanupFailures: string[] = []
    try {
    const created = await bounded(pending, 16000)
    expect(created.challengeId === source.challengeId).toBe(false)
    const after = await rotationInventory(fixture)
    for (const field of ['user', 'session', 'account', 'key', 'batch', 'code', 'fact'] as const) expect(after[field]).toBe(before[field])
    const left = (await stores.administrator.query('SELECT id FROM verification WHERE id=ANY($1::text[])', [ids])).rows.map(row => row.id)
    expect(hash(left.slice().sort())).toBe(hash([...unsafe, ...boundary].filter(id => ids.includes(id)).sort()))
    const allUnsafe = (await stores.administrator.query('SELECT id FROM verification WHERE id=ANY($1::text[])',
      [[...unsafe, ...boundary]])).rows.map(row => row.id)
    expect(hash(allUnsafe.slice().sort())).toBe(hash([...unsafe, ...boundary].sort()))
    expect(hash((await stores.administrator.query('SELECT * FROM verification WHERE id=ANY($1::text[]) ORDER BY id',
      [survivors])).rows)).toBe(survivorsBefore)
    expect(hash((await stores.administrator.query('SELECT * FROM verification WHERE identifier LIKE $1',
      ['%:' + source.challengeId])).rows)).toBe(currentBefore)
    expect((await stores.administrator.query('SELECT count(*)::int n FROM verification WHERE id=$1', [foreignId])).rows[0].n).toBe(1)
    expect((await stores.administrator.query('SELECT count(*)::int n FROM verification WHERE identifier LIKE $1',
      ['%:' + source.challengeId])).rows[0].n).toBe(1)
    expect((await stores.administrator.query('SELECT count(*)::int n FROM verification WHERE identifier LIKE $1',
      ['%:' + created.challengeId])).rows[0].n).toBe(1)
    } finally {
      await settleOwnedClose('rotation-bounded-cleanup-original-begin', () => pending, cleanupFailures)
      assertOwnedCleanup(cleanupFailures)
    }
  })
}, 300000)

test('R1 Google Begin cleanup keeps its 25-attempt boundary and unsafe native bindings', async () => {
  await withSeededRecoveryGoogle(async fixture => {
    const { app, stores, peer, email, code, userId, accountId, batchId, codeId, subject } = fixture
    const first = await bounded(app.beginRecoveryGoogleProof(request(), { email, code }), 16000)
    const firstState = new URL(first.url).searchParams.get('state')
    if (!firstState) throw new Error('Missing native state')
    const firstAttempt = (await stores.administrator.query('SELECT * FROM recovery_attempt WHERE oauth_state=$1', [firstState])).rows
    const firstNative = (await stores.administrator.query('SELECT value FROM verification WHERE identifier=$1', [firstState])).rows
    expect(firstAttempt.length).toBe(1); expect(firstNative.length).toBe(1)
    const anchor = Date.now() - 600000
    await bounded(stores.administrator.query('UPDATE recovery_attempt SET created_at=$2,expires_at=$3 WHERE id=$1',
      [firstAttempt[0].id, new Date(anchor - 60000), new Date(anchor)]), 16000)
    const ids: string[] = [], unsafe: string[] = [], boundary: string[] = []
    let proofId = ''
    async function insert(index: number, mode: 'missing' | 'duplicate' | 'malformed' | 'foreign' | 'boundary') {
      const id = randomUUID(), state = randomUUID(), expiry = new Date(anchor + index * 1000)
      await bounded(stores.administrator.query(`INSERT INTO recovery_attempt(id,user_id,recovery_generation,batch_id,code_id,google_account_id,
        issuer,subject,oauth_state,created_at,expires_at,phase) VALUES($1,$2,0,$3,$4,$5,$6,$7,$8,$9,$10,'PENDING_GOOGLE')`,
      [id, userId, batchId, codeId, accountId, 'https://accounts.google.com', subject, state,
        new Date(expiry.getTime() - 60000), expiry]), 16000)
      ids.push(id)
      if (mode === 'duplicate' || mode === 'malformed' || mode === 'foreign') unsafe.push(id)
      if (mode === 'boundary') boundary.push(id)
      if (mode !== 'missing' && mode !== 'boundary') {
        const valid = JSON.parse(firstNative[0].value)
        const value = mode === 'malformed' ? '{malformed' : JSON.stringify({ ...valid, oauthState: state,
          serverContext: { ...valid.serverContext, attemptId: mode === 'foreign' ? randomUUID() : id } })
        await bounded(stores.administrator.query('INSERT INTO verification(id,identifier,value,expires_at) VALUES($1,$2,$3,$4)',
          [randomUUID(), state, value, new Date(Date.now() + 300000)]), 16000)
        if (mode === 'duplicate') await bounded(stores.administrator.query(
          'INSERT INTO verification(id,identifier,value,expires_at) VALUES($1,$2,$3,$4)',
          [randomUUID(), state, value, new Date(anchor)]), 16000)
      }
      if (index === 1) {
        proofId = 'application-recovery-google-v1:' + id
        const proof = { version: 1, purpose: 'recovery-google-proof', userId, attemptId: id, recoveryGeneration: 0,
          batchId, codeId, googleAccountId: accountId, issuer: 'https://accounts.google.com', subject,
          expiresAt: expiry.toISOString() }
        await bounded(stores.administrator.query('INSERT INTO verification(id,identifier,value,expires_at) VALUES($1,$2,$3,$4)',
          [randomUUID(), proofId, JSON.stringify(proof), expiry]), 16000)
      }
    }
    for (let index = 1; index <= 20; index++) await insert(index, 'missing')
    await insert(21, 'duplicate'); await insert(22, 'malformed'); await insert(23, 'foreign')
    await insert(24, 'missing'); await insert(25, 'boundary'); await insert(26, 'boundary')
    const activeAttempt = randomUUID()
    const activeCreated = new Date()
    await bounded(stores.administrator.query(`INSERT INTO recovery_attempt(id,user_id,recovery_generation,batch_id,code_id,google_account_id,
      issuer,subject,oauth_state,created_at,expires_at,phase) VALUES($1,$2,0,$3,$4,$5,$6,$7,$8,$9,$10,'PENDING_GOOGLE')`,
    [activeAttempt, userId, batchId, codeId, accountId, 'https://accounts.google.com', subject, randomUUID(),
      activeCreated, new Date(activeCreated.getTime() + 300000)]), 16000)
    const otherUser = randomUUID()
    await bounded(stores.administrator.query('INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$2,$3,true)',
      [otherUser, 'Other cleanup user', 'r1-cleanup-' + otherUser + '@example.test']), 16000)
    const otherAttempt = randomUUID()
    await bounded(stores.administrator.query(`INSERT INTO recovery_attempt(id,user_id,recovery_generation,batch_id,code_id,google_account_id,
      issuer,subject,oauth_state,created_at,expires_at,phase) VALUES($1,$2,0,$3,$4,$5,$6,$7,$8,$9,$10,'PENDING_GOOGLE')`,
    [otherAttempt, otherUser, batchId, codeId, accountId, 'https://accounts.google.com', subject, randomUUID(),
      new Date(anchor - 60000), new Date(anchor)]), 16000)
    const survivorAttempts = [...unsafe, ...boundary, activeAttempt, otherAttempt]
    const survivorAttemptsBefore = hash((await stores.administrator.query(
      'SELECT * FROM recovery_attempt WHERE id=ANY($1::uuid[]) ORDER BY id', [survivorAttempts])).rows)
    const unsafeStates = (await stores.administrator.query('SELECT oauth_state FROM recovery_attempt WHERE id=ANY($1::uuid[]) ORDER BY id',
      [unsafe])).rows.map(row => row.oauth_state as string)
    const unsafeNativeBefore = hash((await stores.administrator.query(
      'SELECT * FROM verification WHERE identifier=ANY($1::text[]) ORDER BY identifier,id', [unsafeStates])).rows)
    const before = await googleInventory(fixture)
    const pending = app.beginRecoveryGoogleProof(request(), { email, code })
    const cleanupFailures: string[] = []
    try {
    const second = await bounded(pending, 16000)
    expect(Boolean(new URL(second.url).searchParams.get('state'))).toBe(true)
    const after = await googleInventory(fixture)
    for (const field of ['user', 'account', 'session', 'batch', 'code', 'fact'] as const) expect(after[field]).toBe(before[field])
    expect(peer.evidence().posts).toBe(0)
    expect((await stores.administrator.query('SELECT count(*)::int n FROM recovery_attempt WHERE id=$1', [firstAttempt[0].id])).rows[0].n).toBe(0)
    expect((await stores.administrator.query('SELECT count(*)::int n FROM verification WHERE identifier=$1', [firstState])).rows[0].n).toBe(0)
    expect((await stores.administrator.query('SELECT count(*)::int n FROM verification WHERE identifier=$1', [proofId])).rows[0].n).toBe(0)
    const left = (await stores.administrator.query('SELECT id FROM recovery_attempt WHERE id=ANY($1::uuid[])', [ids])).rows.map(row => row.id)
    expect(hash(left.slice().sort())).toBe(hash([...unsafe, ...boundary].sort()))
    expect(hash((await stores.administrator.query('SELECT * FROM recovery_attempt WHERE id=ANY($1::uuid[]) ORDER BY id',
      [survivorAttempts])).rows)).toBe(survivorAttemptsBefore)
    expect(hash((await stores.administrator.query('SELECT * FROM verification WHERE identifier=ANY($1::text[]) ORDER BY identifier,id',
      [unsafeStates])).rows)).toBe(unsafeNativeBefore)
    expect((await stores.administrator.query('SELECT count(*)::int n FROM recovery_attempt WHERE id=$1', [activeAttempt])).rows[0].n).toBe(1)
    expect((await stores.administrator.query('SELECT count(*)::int n FROM recovery_attempt WHERE id=$1', [otherAttempt])).rows[0].n).toBe(1)
    } finally {
      await settleOwnedClose('google-bounded-cleanup-original-begin', () => pending, cleanupFailures)
      assertOwnedCleanup(cleanupFailures)
    }
  })
}, 300000)

test('R1 Google Begin cleanup removes at most 75 rows from 25 safe attempt proof state triples', async () => {
  await withSeededRecoveryGoogle(async fixture => {
    const { app, stores, peer, userId, accountId, batchId, codeId, subject, email, code } = fixture
    const first = await bounded(app.beginRecoveryGoogleProof(request(), { email, code }), 16000)
    const firstState = new URL(first.url).searchParams.get('state')
    if (!firstState) throw new Error('Missing native state')
    const native = (await stores.administrator.query('SELECT value FROM verification WHERE identifier=$1', [firstState])).rows
    const firstAttempt = (await stores.administrator.query('SELECT id FROM recovery_attempt WHERE oauth_state=$1', [firstState])).rows
    expect(native.length).toBe(1); expect(firstAttempt.length).toBe(1)
    const anchor = Date.now() - 600000
    const attempts = [firstAttempt[0].id as string], states = [firstState], proofs: string[] = []
    await bounded(stores.administrator.query('UPDATE recovery_attempt SET created_at=$2,expires_at=$3 WHERE id=$1',
      [firstAttempt[0].id, new Date(anchor - 60000), new Date(anchor)]), 16000)
    for (let index = 0; index < 26; index++) {
      const id = index === 0 ? firstAttempt[0].id as string : randomUUID()
      const state = index === 0 ? firstState : randomUUID()
      const expiry = new Date(anchor + index * 1000)
      if (index > 0) await bounded(stores.administrator.query(`INSERT INTO recovery_attempt(id,user_id,recovery_generation,batch_id,code_id,
        google_account_id,issuer,subject,oauth_state,created_at,expires_at,phase)
        VALUES($1,$2,0,$3,$4,$5,$6,$7,$8,$9,$10,'PENDING_GOOGLE')`,
      [id, userId, batchId, codeId, accountId, 'https://accounts.google.com', subject, state,
        new Date(expiry.getTime() - 60000), expiry]), 16000)
      if (index > 0) await bounded(stores.administrator.query('INSERT INTO verification(id,identifier,value,expires_at) VALUES($1,$2,$3,$4)',
        [randomUUID(), state, JSON.stringify({ ...JSON.parse(native[0].value), oauthState: state,
          serverContext: { ...JSON.parse(native[0].value).serverContext, attemptId: id } }), new Date(Date.now() + 300000)]), 16000)
      const proofId = 'application-recovery-google-v1:' + id
      const value = { version: 1, purpose: 'recovery-google-proof', userId, attemptId: id, recoveryGeneration: 0,
        batchId, codeId, googleAccountId: accountId, issuer: 'https://accounts.google.com', subject, expiresAt: expiry.toISOString() }
      await bounded(stores.administrator.query('INSERT INTO verification(id,identifier,value,expires_at) VALUES($1,$2,$3,$4)',
        [randomUUID(), proofId, JSON.stringify(value), expiry]), 16000)
      if (index > 0 && index < 25) { attempts.push(id); states.push(state) }
      if (index < 25) proofs.push(proofId)
    }
    const boundary = (await stores.administrator.query('SELECT id,oauth_state FROM recovery_attempt WHERE expires_at=$1',
      [new Date(anchor + 25000)])).rows
    expect(boundary.length).toBe(1)
    const boundaryAttemptBefore = hash((await stores.administrator.query('SELECT * FROM recovery_attempt WHERE id=$1', [boundary[0].id])).rows)
    const boundaryNativeBefore = hash((await stores.administrator.query('SELECT * FROM verification WHERE identifier=$1 OR identifier=$2 ORDER BY identifier,id',
      [boundary[0].oauth_state, 'application-recovery-google-v1:' + boundary[0].id])).rows)
    const before = await googleInventory(fixture)
    const pending = app.beginRecoveryGoogleProof(request(), { email, code })
    const cleanupFailures: string[] = []
    try {
    const next = await bounded(pending, 16000)
    expect(Boolean(new URL(next.url).searchParams.get('state'))).toBe(true)
    const after = await googleInventory(fixture)
    for (const field of ['user', 'account', 'session', 'batch', 'code', 'fact'] as const) expect(after[field]).toBe(before[field])
    const removedAttempts = (await stores.administrator.query('SELECT id FROM recovery_attempt WHERE id=ANY($1::uuid[])', [attempts])).rows
    const removedStates = (await stores.administrator.query('SELECT identifier FROM verification WHERE identifier=ANY($1::text[])', [states])).rows
    const removedProofs = (await stores.administrator.query('SELECT identifier FROM verification WHERE identifier=ANY($1::text[])', [proofs])).rows
    expect(attempts.length).toBe(25); expect(states.length).toBe(25); expect(proofs.length).toBe(25)
    expect(removedAttempts.length + removedStates.length + removedProofs.length).toBe(0)
    expect((await stores.administrator.query('SELECT count(*)::int n FROM recovery_attempt WHERE id=$1', [boundary[0].id])).rows[0].n).toBe(1)
    expect((await stores.administrator.query('SELECT count(*)::int n FROM verification WHERE identifier=$1', [boundary[0].oauth_state])).rows[0].n).toBe(1)
    expect((await stores.administrator.query('SELECT count(*)::int n FROM verification WHERE identifier=$1',
      ['application-recovery-google-v1:' + boundary[0].id])).rows[0].n).toBe(1)
    expect(hash((await stores.administrator.query('SELECT * FROM recovery_attempt WHERE id=$1', [boundary[0].id])).rows)).toBe(boundaryAttemptBefore)
    expect(hash((await stores.administrator.query('SELECT * FROM verification WHERE identifier=$1 OR identifier=$2 ORDER BY identifier,id',
      [boundary[0].oauth_state, 'application-recovery-google-v1:' + boundary[0].id])).rows)).toBe(boundaryNativeBefore)
    expect(peer.evidence().posts).toBe(0)
    } finally {
      await settleOwnedClose('google-75row-original-begin', () => pending, cleanupFailures)
      assertOwnedCleanup(cleanupFailures)
    }
  })
}, 300000)

for (const attack of ['different-delete', 'create', 'direct-transaction'] as const) {
  test(`R1 Google cleanup ${attack} hook cannot escape owner or partially commit Begin`, async () => {
    await withSeededRecoveryGoogle(async fixture => {
      const { app, stores, peer, userId, accountId, batchId, codeId, subject, email, code } = fixture
      const first = await bounded(app.beginRecoveryGoogleProof(request(), { email, code }), 16000)
      const state = new URL(first.url).searchParams.get('state')
      if (!state) throw new Error('Missing native state')
      const anchor = Date.now() - 600000
      const earlierId = randomUUID()
      await bounded(stores.administrator.query(`INSERT INTO recovery_attempt(id,user_id,recovery_generation,batch_id,code_id,google_account_id,
        issuer,subject,oauth_state,created_at,expires_at,phase) VALUES($1,$2,0,$3,$4,$5,$6,$7,$8,$9,$10,'PENDING_GOOGLE')`,
      [earlierId, userId, batchId, codeId, accountId, 'https://accounts.google.com', subject, randomUUID(),
        new Date(anchor - 120000), new Date(anchor - 60000)]), 16000)
      await bounded(stores.administrator.query('UPDATE recovery_attempt SET created_at=$2,expires_at=$3 WHERE oauth_state=$1',
        [state, new Date(anchor - 60000), new Date(anchor)]), 16000)
      const before = await googleInventory(fixture)
      observed.cleanupAttackIdentifier = state; observed.cleanupAttack = attack; observed.cleanupAttackReached = 0
      const pending = app.beginRecoveryGoogleProof(request(), { email, code })
        .then(() => ({ accepted: true as const }), (error: unknown) => ({ accepted: false as const, error }))
      const cleanupFailures: string[] = []
      try {
        const outcome = await bounded(pending, 16000)
        expect(observed.cleanupAttackReached).toBe(1)
        expect(outcome.accepted).toBe(false)
        if (outcome.accepted) throw new Error('Unsafe cleanup hook was admitted')
        assertFixedRefusal(outcome.error, attack === 'direct-transaction' ? 'Authentication unavailable' : 'Authentication rejected')
        expect(await googleInventory(fixture)).toEqual(before)
        expect(peer.evidence().posts).toBe(0)
      } finally {
        observed.cleanupAttack = ''; observed.cleanupAttackIdentifier = ''
        await settleOwnedClose('cleanup-attack-original-begin', () => pending, cleanupFailures)
        assertOwnedCleanup(cleanupFailures)
      }
    })
  }, 300000)
}

test('R1 runtime audit UPDATE and DELETE stay denied and fact survives code batch User cleanup', async () => {
  await withNativeRecoveryRotation(async fixture => {
    const { app, stores, cookie, credential, userId } = fixture
    const challenge = await bounded(app.beginRecoveryCodeRotation(request(cookie)), 16000)
    const issued = await bounded(app.finishRecoveryCodeRotation(request(cookie), { challengeId: challenge.challengeId,
      response: credential.authenticationResponse(challenge.options, { counter: 1 }) }), 16000)
    expect(issued.codes.length).toBe(8)
    const fact = (await stores.administrator.query('SELECT * FROM recovery_code_rotation_fact WHERE actor_user_id=$1', [userId])).rows
    expect(fact.length).toBe(1)
    const originalFact = hash(fact)
    const runtime = new Client({ connectionString: stores.directRuntimeUrl, connectionTimeoutMillis: 500 })
    const cleanupFailures: string[] = []
    try {
      await bounded(runtime.connect(), 16000)
      const privileges = (await bounded(runtime.query(`SELECT has_table_privilege(current_user,'public.recovery_code_rotation_fact','UPDATE') AS can_update,
        has_table_privilege(current_user,'public.recovery_code_rotation_fact','DELETE') AS can_delete`), 16000)).rows
      expect(privileges.length).toBe(1)
      expect(privileges[0].can_update).toBe(false); expect(privileges[0].can_delete).toBe(false)
      const updateDenied = await bounded(runtime.query('UPDATE recovery_code_rotation_fact SET code_count=8')
        .then(() => false, (error: { code?: string }) => error.code === '42501'), 16000)
      const deleteDenied = await bounded(runtime.query('DELETE FROM recovery_code_rotation_fact')
        .then(() => false, (error: { code?: string }) => error.code === '42501'), 16000)
      expect(updateDenied).toBe(true); expect(deleteDenied).toBe(true)
      expect(hash((await stores.administrator.query('SELECT * FROM recovery_code_rotation_fact WHERE id=$1', [fact[0].id])).rows)).toBe(originalFact)
    } finally {
      await settleOwnedClose('runtime-audit-client', () => runtime.end(), cleanupFailures)
      assertOwnedCleanup(cleanupFailures)
    }
    await bounded(stores.administrator.query('BEGIN'), 16000)
    try {
      await bounded(stores.administrator.query("SET LOCAL statement_timeout = '1000ms'"), 16000)
      await bounded(stores.administrator.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [userId]), 16000)
      await bounded(stores.administrator.query('DELETE FROM recovery_code WHERE user_id=$1', [userId]), 16000)
      await bounded(stores.administrator.query('DELETE FROM recovery_code_batch WHERE user_id=$1', [userId]), 16000)
      await bounded(stores.administrator.query(`DELETE FROM auth_email_outbox WHERE delivery_id IN
        (SELECT d.id FROM email_delivery d JOIN auth_email_command c ON c.id=d.command_id
         JOIN auth_email_request r ON r.id=c.request_id WHERE r.user_id=$1 OR c.user_id=$1)`, [userId]), 16000)
      await bounded(stores.administrator.query(`DELETE FROM email_delivery WHERE command_id IN
        (SELECT c.id FROM auth_email_command c JOIN auth_email_request r ON r.id=c.request_id WHERE r.user_id=$1 OR c.user_id=$1)`, [userId]), 16000)
      await bounded(stores.administrator.query(`DELETE FROM auth_email_command WHERE request_id IN
        (SELECT id FROM auth_email_request WHERE user_id=$1) OR user_id=$1`, [userId]), 16000)
      await bounded(stores.administrator.query('DELETE FROM auth_email_request WHERE user_id=$1', [userId]), 16000)
      await bounded(stores.administrator.query('DELETE FROM "user" WHERE id=$1', [userId]), 16000)
      await bounded(stores.administrator.query('COMMIT'), 16000)
    } catch (error) { await bounded(stores.administrator.query('ROLLBACK'), 16000); throw error }
    expect((await stores.administrator.query('SELECT count(*)::int n FROM "user" WHERE id=$1', [userId])).rows[0].n).toBe(0)
    expect((await stores.administrator.query('SELECT count(*)::int n FROM recovery_code_batch WHERE user_id=$1', [userId])).rows[0].n).toBe(0)
    expect((await stores.administrator.query('SELECT count(*)::int n FROM recovery_code WHERE user_id=$1', [userId])).rows[0].n).toBe(0)
    expect(hash((await stores.administrator.query('SELECT * FROM recovery_code_rotation_fact WHERE id=$1', [fact[0].id])).rows)).toBe(originalFact)
  })
}, 300000)

test('R1 rotation late direct adapter Session write is denied after legitimate committed fact', async () => {
  await withNativeRecoveryRotation(async fixture => {
    const { app, stores, cookie, credential, userId, sessionId } = fixture
    const challenge = await bounded(app.beginRecoveryCodeRotation(request(cookie)), 16000)
    const before = await rotationInventory(fixture)
    observed.directWriteAttack = 'rotation-session'; observed.directWriteTarget = sessionId; observed.directWriteReached = 0
    const pending = app.finishRecoveryCodeRotation(request(cookie), { challengeId: challenge.challengeId,
      response: credential.authenticationResponse(challenge.options, { counter: 1 }) })
      .then(() => ({ accepted: true as const }), (error: unknown) => ({ accepted: false as const, error }))
    const cleanupFailures: string[] = []
    try {
      const outcome = await bounded(pending, 16000)
      expect(observed.directWriteReached).toBe(1)
      const after = await rotationInventory(fixture)
      expect(after.session).toBe(before.session)
      expect(after.user).toBe(before.user)
      expect(after.account).toBe(before.account)
      expect((await stores.administrator.query('SELECT count(*)::int n FROM recovery_code WHERE user_id=$1', [userId])).rows[0].n).toBe(8)
      expect((await stores.administrator.query('SELECT count(*)::int n FROM recovery_code_rotation_fact WHERE actor_user_id=$1', [userId])).rows[0].n).toBe(1)
      expect(outcome.accepted).toBe(false)
      if (outcome.accepted) throw new Error('Late direct adapter write exposed rotation codes')
      assertFixedRefusal(outcome.error, 'Authentication outcome unconfirmed')
    } finally {
      observed.directWriteAttack = ''; observed.directWriteTarget = ''
      await settleOwnedClose('direct-rotation-original-finish', () => pending, cleanupFailures)
      assertOwnedCleanup(cleanupFailures)
    }
  })
}, 300000)

for (const attack of ['google-user', 'google-transaction'] as const) {
  test(`R1 Google late direct adapter ${attack} write is denied after legitimate PROVED commit`, async () => {
    await withSeededRecoveryGoogle(async fixture => {
      const { app, stores, peer, email, code, userId } = fixture
      const begun = await bounded(app.beginRecoveryGoogleProof(request(), { email, code }), 16000)
      const state = new URL(begun.url).searchParams.get('state')
      if (!state) throw new Error('Missing native state')
      const original = (await stores.administrator.query('SELECT * FROM recovery_attempt WHERE oauth_state=$1', [state])).rows
      expect(original.length).toBe(1)
      const before = await googleInventory(fixture)
      const providerCode = peer.register(begun.url, fixture.subject, { email })
      observed.directWriteAttack = attack; observed.directWriteTarget = userId; observed.directWriteReached = 0
      const pending = googleCallback(fixture, state, begun.headers, providerCode)
      const cleanupFailures: string[] = []
      try {
        const outcome = await bounded(pending, 16000)
        expect(observed.directWriteReached).toBe(1)
        await assertExactGoogleProof(fixture, original[0])
        const after = await googleInventory(fixture)
        for (const field of ['user', 'account', 'session', 'batch', 'code', 'fact'] as const) expect(after[field]).toBe(before[field])
        expect((await stores.administrator.query('SELECT count(*)::int n FROM verification WHERE identifier=$1',
          ['r1-direct-hook-write'])).rows[0].n).toBe(0)
        expect(peer.evidence().posts).toBe(1)
        expect(outcome.value).toBeUndefined()
        assertFixedRefusal(outcome.error, 'Authentication outcome unconfirmed')
      } finally {
        observed.directWriteAttack = ''; observed.directWriteTarget = ''
        await settleOwnedClose('direct-google-original-callback', () => pending, cleanupFailures)
        assertOwnedCleanup(cleanupFailures)
      }
    })
  }, 300000)
}

for (const mode of ['claim unknown acknowledgement', 'proof unknown acknowledgement', 'proof committed cancellation'] as const) {
  test(`R1 SIMULATED ${mode} withholds Google outcome at real owner settlement`, async () => {
    let inject = false, reached = 0
    const controller = new AbortController()
    await withSeededRecoveryGoogle(async fixture => {
      const { app, stores, peer, email, code, userId } = fixture
      const begun = await bounded(app.beginRecoveryGoogleProof(request(), { email, code }), 16000)
      const state = new URL(begun.url).searchParams.get('state')
      if (!state) throw new Error('Missing native state')
      const original = (await stores.administrator.query('SELECT * FROM recovery_attempt WHERE oauth_state=$1', [state])).rows
      expect(original.length).toBe(1)
      const before = await googleInventory(fixture)
      const providerCode = peer.register(begun.url, fixture.subject, { email })
      inject = true
      const callbackRequest = request(cookies(begun.headers),
        '/api/auth/recovery/google/callback?state=' + state + '&code=' + providerCode, 'GET', controller.signal)
      const pending = app.completeRecoveryGoogleProof(callbackRequest)
        .then(() => ({ accepted: true as const }), (error: unknown) => ({ accepted: false as const, error }))
      const cleanupFailures: string[] = []
      try {
        const outcome = await bounded(pending, 16000)
        expect(reached).toBe(1)
        expect(outcome.accepted).toBe(false)
        if (outcome.accepted) throw new Error('Simulated settlement uncertainty exposed proof result')
        expect(outcome.error instanceof PgTransactionError).toBe(true)
        if (!(outcome.error instanceof PgTransactionError)) throw new Error('Expected classified PostgreSQL outcome')
        expect(outcome.error.phase).toBe('finalize')
        expect(outcome.error.outcome).toBe(mode === 'proof committed cancellation' ? 'committed' : 'unknown')
        expect('headers' in outcome.error).toBe(false)
        const after = await googleInventory(fixture)
        for (const field of ['user', 'account', 'session', 'batch', 'code', 'fact'] as const) expect(after[field]).toBe(before[field])
        const attempt = (await stores.administrator.query('SELECT * FROM recovery_attempt WHERE oauth_state=$1', [state])).rows
        expect(attempt.length).toBe(1)
        expect(hash([{ ...attempt[0], phase: 'PENDING_GOOGLE' }])).toBe(hash(original))
        expect((await stores.administrator.query('SELECT count(*)::int n FROM verification WHERE identifier=$1', [state])).rows[0].n).toBe(0)
        if (mode === 'claim unknown acknowledgement') {
          expect(attempt[0].phase).toBe('EXCHANGING')
          expect(peer.evidence().posts).toBe(0)
          expect((await stores.administrator.query('SELECT count(*)::int n FROM verification WHERE identifier=$1',
            ['application-recovery-google-v1:' + original[0].id])).rows[0].n).toBe(0)
        } else {
          expect(peer.evidence().posts).toBe(1)
          await assertExactGoogleProof(fixture, original[0])
        }
      } finally {
        inject = false
        await settleOwnedClose('simulated-settlement-original-callback', () => pending, cleanupFailures)
        assertOwnedCleanup(cleanupFailures)
      }
    }, (actual, stores, userId) => {
      const wrapped: ReturnType<typeof createTransactions> = { ...actual,
        withAuthPromise: (options, call) => actual.withAuthPromise(options, call).then(async value => {
          if (!inject || reached) return value
          const rows = (await stores.administrator.query('SELECT phase FROM recovery_attempt WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',
            [userId])).rows
          const target = mode === 'claim unknown acknowledgement' ? 'EXCHANGING' : 'PROVED'
          if (rows.length === 1 && rows[0].phase === target) {
            reached++
            if (mode === 'proof committed cancellation') controller.abort()
            throw new PgTransactionError('finalize', mode === 'proof committed cancellation' ? 'committed' : 'unknown', options.correlationId)
          }
          return value
        }),
      }
      return wrapped
    })
  }, 300000)
}

for (const kind of googleInvalidations) for (const phase of ['before claim', 'paused EXCHANGING'] as const) {
  test(`R1 Google ${kind} invalidation ${phase} refuses immutable proof`, async () => {
    await withSeededRecoveryGoogle(async fixture => {
      const { app, stores, peer, email, code, userId } = fixture
      const begun = await bounded(app.beginRecoveryGoogleProof(request(), { email, code }), 16000)
      const state = new URL(begun.url).searchParams.get('state')
      if (!state) throw new Error('Missing native state')
      const providerCode = peer.register(begun.url, fixture.subject, { email })
      const beforeAttempt = (await stores.administrator.query('SELECT * FROM recovery_attempt WHERE oauth_state=$1', [state])).rows
      expect(beforeAttempt.length).toBe(1)
      expect(beforeAttempt[0].phase).toBe('PENDING_GOOGLE')
      let pending: Promise<GoogleCallbackOutcome> | undefined
      const cleanupFailures: string[] = []
      try {
        if (phase === 'paused EXCHANGING') {
          peer.holdHandoff()
          pending = googleCallback(fixture, state, begun.headers, providerCode)
          await waitForPeerHandoff(fixture)
          const claimed = (await stores.administrator.query('SELECT * FROM recovery_attempt WHERE oauth_state=$1', [state])).rows
          expect(claimed.length).toBe(1)
          expect(claimed[0].phase).toBe('EXCHANGING')
          expect(hash([{ ...claimed[0], phase: 'PENDING_GOOGLE' }])).toBe(hash(beforeAttempt))
          expect((await stores.administrator.query('SELECT * FROM verification WHERE identifier=$1', [state])).rows.length).toBe(0)
          expect((await stores.administrator.query('SELECT * FROM verification WHERE identifier=$1',
            ['application-recovery-google-v1:' + beforeAttempt[0].id])).rows.length).toBe(0)
          expect(peer.evidence().posts).toBe(0)
        }
        const preMutation = await googleInventory(fixture)
        await administerGoogleInvalidation(fixture, kind)
        const declaredMutation = await googleInventory(fixture)
        const changed = Object.keys(preMutation).filter(key => preMutation[key as keyof typeof preMutation] !== declaredMutation[key as keyof typeof declaredMutation])
        expect(changed).toEqual(kind === 'generation' ? ['user'] : kind === 'batch' ? ['batch', 'code']
          : kind === 'spent-code' || kind === 'removed-code' ? ['code'] : ['account'])
        expect(declaredMutation.attempt).toBe(preMutation.attempt)
        expect(declaredMutation.verification).toBe(preMutation.verification)
        expect(declaredMutation.session).toBe(preMutation.session)
        expect(declaredMutation.fact).toBe(preMutation.fact)
        if (phase === 'before claim') {
          observed.nativeVerificationLookups = 0; observed.nativeVerificationSweeps = 0; observed.observeRecoveryLookup = true
          pending = googleCallback(fixture, state, begun.headers, providerCode)
        } else peer.releaseHandoff()
        const outcome = await bounded(pending!, 16000)
        expect(outcome.value).toBeUndefined()
        assertFixedRefusal(outcome.error, 'Authentication rejected')
        if (phase === 'before claim') {
          expect(observed.nativeVerificationLookups).toBe(0)
          expect(observed.nativeVerificationSweeps).toBe(0)
          expect(peer.evidence().posts).toBe(0)
        } else expect(peer.evidence().posts).toBe(1)
        expect(await googleInventory(fixture)).toEqual(declaredMutation)
        expect((await stores.administrator.query('SELECT * FROM recovery_attempt WHERE oauth_state=$1', [state])).rows[0].phase)
          .toBe(phase === 'before claim' ? 'PENDING_GOOGLE' : 'EXCHANGING')
        expect((await stores.administrator.query('SELECT count(*)::int n FROM verification WHERE identifier=$1',
          ['application-recovery-google-v1:' + beforeAttempt[0].id])).rows[0].n).toBe(0)
        expect((await stores.administrator.query('SELECT count(*)::int n FROM session WHERE user_id=$1', [userId])).rows[0].n).toBe(0)
      } finally {
        observed.observeRecoveryLookup = false
        peer.releaseHandoff()
        if (pending) await settleOwnedClose('google-invalidation-original-callback', () => pending!, cleanupFailures)
        assertOwnedCleanup(cleanupFailures)
      }
    })
  }, 300000)
}

test('R1 confirmed EXCHANGING claim exclusively owns the token exchange', async () => {
  await withSeededRecoveryGoogle(async fixture => {
    const { app, stores, peer, email, code } = fixture
    const begun = await bounded(app.beginRecoveryGoogleProof(request(), { email, code }), 16000)
    const state = new URL(begun.url).searchParams.get('state')
    if (!state) throw new Error('Missing native state')
    const originalAttempt = (await stores.administrator.query('SELECT * FROM recovery_attempt WHERE oauth_state=$1', [state])).rows
    expect(originalAttempt.length).toBe(1)
    const providerCode = peer.register(begun.url, fixture.subject, { email })
    let first: Promise<GoogleCallbackOutcome> | undefined
    let competitor: Promise<GoogleCallbackOutcome> | undefined
    const cleanupFailures: string[] = []
    try {
      peer.holdHandoff()
      first = googleCallback(fixture, state, begun.headers, providerCode)
      await waitForPeerHandoff(fixture)
      const claimed = (await stores.administrator.query('SELECT * FROM recovery_attempt WHERE oauth_state=$1', [state])).rows
      expect(claimed.length).toBe(1)
      expect(claimed[0].phase).toBe('EXCHANGING')
      expect(peer.evidence().posts).toBe(0)
      const before = await googleInventory(fixture)
      observed.nativeVerificationLookups = 0; observed.nativeVerificationSweeps = 0; observed.observeRecoveryLookup = true
      competitor = googleCallback(fixture, state, begun.headers, providerCode)
      const second = await bounded(competitor, 16000)
      observed.observeRecoveryLookup = false
      expect(second.value).toBeUndefined()
      assertFixedRefusal(second.error, 'Authentication rejected')
      expect(observed.nativeVerificationLookups).toBe(0)
      expect(observed.nativeVerificationSweeps).toBe(0)
      expect(peer.evidence().posts).toBe(0)
      expect(await googleInventory(fixture)).toEqual(before)
      peer.releaseHandoff()
      const original = await bounded(first, 16000)
      expect(original.error).toBeUndefined()
      expect(original.value?.outcome).toBe('proved')
      expect(original.value?.headers.getSetCookie().length).toBe(1)
      expect(peer.evidence().posts).toBe(1)
      const after = await googleInventory(fixture)
      for (const field of ['user', 'account', 'session', 'batch', 'code', 'fact'] as const) expect(after[field]).toBe(before[field])
      const final = (await stores.administrator.query('SELECT * FROM recovery_attempt WHERE oauth_state=$1', [state])).rows
      expect(final.length).toBe(1)
      expect(final[0].phase).toBe('PROVED')
      await assertExactGoogleProof(fixture, originalAttempt[0])
      expect((await stores.administrator.query('SELECT * FROM recovery_code WHERE id=$1', [fixture.codeId])).rows[0].spent_at).toBeNull()
      expect((await stores.administrator.query('SELECT count(*)::int n FROM session WHERE user_id=$1', [fixture.userId])).rows[0].n).toBe(0)
    } finally {
      observed.observeRecoveryLookup = false
      peer.releaseHandoff()
      if (competitor) await settleOwnedClose('exclusive-claim-competitor-callback', () => competitor!, cleanupFailures)
      if (first) await settleOwnedClose('exclusive-claim-original-callback', () => first!, cleanupFailures)
      assertOwnedCleanup(cleanupFailures)
    }
  })
}, 300000)

test('R1 future hold still permits anonymous Google proof collection', async () => {
  await withSeededRecoveryGoogle(async fixture => {
    const { stores, app, peer, userId, email, code } = fixture
    let callback: Promise<GoogleCallbackOutcome> | undefined
    const cleanupFailures: string[] = []
    try {
      await bounded(stores.administrator.query('BEGIN'), 16000)
      try {
        await bounded(stores.administrator.query("SET LOCAL statement_timeout = '1000ms'"), 16000)
        await bounded(stores.administrator.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [userId]), 16000)
        await bounded(stores.administrator.query("UPDATE \"user\" SET hold_until=clock_timestamp()+interval '1 hour' WHERE id=$1", [userId]), 16000)
        await bounded(stores.administrator.query('COMMIT'), 16000)
      } catch (error) { await bounded(stores.administrator.query('ROLLBACK'), 16000); throw error }
      const before = await googleInventory(fixture)
      const begun = await bounded(app.beginRecoveryGoogleProof(request(), { email, code }), 16000)
      const state = new URL(begun.url).searchParams.get('state')
      if (!state) throw new Error('Missing native state')
      const originalAttempt = (await stores.administrator.query('SELECT * FROM recovery_attempt WHERE oauth_state=$1', [state])).rows
      expect(originalAttempt.length).toBe(1)
      const providerCode = peer.register(begun.url, fixture.subject, { email })
      callback = googleCallback(fixture, state, begun.headers, providerCode)
      const outcome = await bounded(callback, 16000)
      expect(outcome.error).toBeUndefined()
      expect(outcome.value?.outcome).toBe('proved')
      expect(peer.evidence().posts).toBe(1)
      const after = await googleInventory(fixture)
      expect(after.user).toBe(before.user)
      expect(after.account).toBe(before.account)
      expect(after.session).toBe(before.session)
      expect(after.batch).toBe(before.batch)
      expect(after.code).toBe(before.code)
      expect(after.fact).toBe(before.fact)
      await assertExactGoogleProof(fixture, originalAttempt[0])
    } finally {
      if (callback) await settleOwnedClose('future-hold-original-callback', () => callback!, cleanupFailures)
      assertOwnedCleanup(cleanupFailures)
    }
  })
}, 300000)

test('R1 independent owners serialize null and current batches on the User row', async () => {
  const markerDirectory = await mkdtemp(join(tmpdir(), 'r1-headless-marker-'))
  let stores: Awaited<ReturnType<typeof startDisposableStores>> | undefined
  let poolA: Pool | undefined, poolB: Pool | undefined
  let limiterA: ReturnType<typeof createAuthRateLimiter> | undefined, limiterB: ReturnType<typeof createAuthRateLimiter> | undefined
  let appA: ReturnType<typeof createApplicationAuth> | undefined, appB: ReturnType<typeof createApplicationAuth> | undefined
  let observer: Client | undefined
  const cleanupFailures: string[] = []
  try {
    await mkdir(join(markerDirectory, 'server'))
    await writeFile(join(markerDirectory, 'server/index.mjs'), '// R1 headless fixture marker; not a built application.\n', { flag: 'wx' })
    const fixture = await startDisposableStores(markerDirectory)
    stores = fixture
    await fixture.migrate()
    await fixture.administrator.query(`GRANT USAGE ON SCHEMA public TO runtime;
      GRANT SELECT,INSERT,UPDATE,DELETE ON public."user",public.account,public.session,public.verification TO runtime;
      GRANT SELECT,INSERT ON public.passkey TO runtime; GRANT UPDATE(counter) ON public.passkey TO runtime;
      GRANT SELECT,INSERT,UPDATE ON public.auth_email_request TO runtime; GRANT SELECT,INSERT ON public.auth_email_command TO runtime;
      GRANT SELECT ON public.email_delivery,public.auth_email_outbox TO runtime;
      GRANT INSERT(id,command_id,state,verifier_hash,key_id,ciphertext,nonce,tag,snapshot_format,snapshot_hash,replay_window_seconds)
        ON public.email_delivery TO runtime;
      GRANT UPDATE(state,verifier_hash,ciphertext,nonce,tag) ON public.email_delivery TO runtime;
      GRANT INSERT(id,delivery_id) ON public.auth_email_outbox TO runtime`)
    poolA = new Pool({ connectionString: fixture.runtimeUrl, max: 3 })
    poolB = new Pool({ connectionString: fixture.directRuntimeUrl, max: 3 })
    const ownerA = createTransactions(poolA, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
    const ownerB = createTransactions(poolB, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
    const limitConfig = readRateLimitConfig({ NODE_ENV: 'test', REDIS_URL: fixture.redisUrl, RATE_LIMIT_HMAC_SECRET: fixture.hmac,
      RATE_LIMIT_KEY_ID: 'r1-cross-owner', TRUSTED_PROXY_IPS: '127.0.0.1' })
    limiterA = createAuthRateLimiter(limitConfig); limiterB = createAuthRateLimiter(limitConfig)
    await Promise.all([limiterA.connect(), limiterB.connect()])
    const config = { ...readAuthConfig({ APP_ORIGIN: origin, AUTH_SECRET: randomBytes(48).toString('hex') })!,
      magic: { envelope: createAuthEmailEnvelope({ currentKeyId: 'fixture', keys: { fixture: randomBytes(32) } }), profile } }
    appA = createApplicationAuth(ownerA, config, limiterA)
    appB = createApplicationAuth(ownerB, config, limiterB)
    observer = new Client({ connectionString: fixture.directRuntimeUrl, connectionTimeoutMillis: 500 })
    await observer.connect()
    const email = 'r1-cross-owner-' + randomUUID() + '@example.test'
    await bounded(appA.requestMagicLink(request(), { email, locale: 'en' }), 16000)
    const enrollment = { token: observed.enrollmentToken, intendedEmail: email }
    const options = await bounded(magicConsumeResponse(request(), enrollment, appA, limiterA), 16000)
    expect(options.status).toBe(200)
    const body = await options.json(), credential = registrationCredentialFixture(body.options, origin)
    const enrolled = await bounded(magicEnrollmentResponse(request(cookies(options.headers)),
      { ...enrollment, response: credential.response }, appA, limiterA), 16000)
    expect(enrolled.status).toBe(200)
    const cookieA = cookies(enrolled.headers)
    const login = await bounded(appB.beginPasskeySignIn(request()), 16000)
    const second = await bounded(appB.finishPasskeySignIn(request(cookies(login.headers)),
      { response: credential.authenticationResponse(login.options, { counter: 0 }) }), 16000)
    const cookieB = cookies(second.headers)
    const principalA = await bounded(appA.requirePrincipal(request(cookieA)), 16000)
    const principalB = await bounded(appB.requirePrincipal(request(cookieB)), 16000)
    expect(principalA.userId === principalB.userId && principalA.sessionId !== principalB.sessionId).toBe(true)
    const userId = principalA.userId
    const userBefore = hash((await fixture.administrator.query('SELECT * FROM "user" WHERE id=$1', [userId])).rows)
    const accountBefore = hash((await fixture.administrator.query('SELECT * FROM account WHERE user_id=$1 ORDER BY id', [userId])).rows)
    const sessionsBefore = hash((await fixture.administrator.query('SELECT * FROM session WHERE user_id=$1 ORDER BY id', [userId])).rows)
    const key = (await fixture.administrator.query('SELECT id,counter FROM passkey WHERE user_id=$1', [userId])).rows
    expect(key.length).toBe(1); expect(key[0].counter).toBe(0)
    const keyBefore = hash((await fixture.administrator.query('SELECT * FROM passkey WHERE id=$1', [key[0].id])).rows)
    const challengeCount = async (id: string) => (await fixture.administrator.query('SELECT count(*)::int n FROM verification WHERE identifier LIKE $1',
      ['application-recovery-rotation-v1:%:' + id])).rows[0].n as number
    const authority = async () => ({
      batch: (await fixture.administrator.query('SELECT * FROM recovery_code_batch WHERE user_id=$1', [userId])).rows,
      codes: (await fixture.administrator.query('SELECT * FROM recovery_code WHERE user_id=$1 ORDER BY id', [userId])).rows,
      facts: (await fixture.administrator.query('SELECT * FROM recovery_code_rotation_fact WHERE actor_user_id=$1 ORDER BY occurred_at,id', [userId])).rows,
      key: (await fixture.administrator.query('SELECT * FROM passkey WHERE id=$1', [key[0].id])).rows,
    })
    async function compete(priorBatchId: string | null, previousFacts: number) {
      const [a, b] = await Promise.all([bounded(appA!.beginRecoveryCodeRotation(request(cookieA)), 16000),
        bounded(appB!.beginRecoveryCodeRotation(request(cookieB)), 16000)])
      expect(await challengeCount(a.challengeId)).toBe(1); expect(await challengeCount(b.challengeId)).toBe(1)
      const challenges = (await fixture.administrator.query('SELECT value FROM verification WHERE identifier LIKE $1 OR identifier LIKE $2',
        ['%:' + a.challengeId, '%:' + b.challengeId])).rows
      expect(challenges.length).toBe(2)
      expect(challenges.every(row => JSON.parse(row.value).currentBatchId === priorBatchId)).toBe(true)
      let lockHeld = false, waitError: unknown
      let finishA: Promise<{ ok: true; codes: readonly string[] } | { ok: false; error: unknown }> | undefined
      let finishB: Promise<{ ok: true; codes: readonly string[] } | { ok: false; error: unknown }> | undefined
      let resultA: Awaited<typeof finishA> | undefined, resultB: Awaited<typeof finishB> | undefined
      let waiting = new Set<number>()
      let observedUserContention = false
      try {
        await fixture.administrator.query('BEGIN')
        lockHeld = true
        expect((await fixture.administrator.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [userId])).rows.length).toBe(1)
        const started = Date.now()
        finishA = appA!.finishRecoveryCodeRotation(request(cookieA), { challengeId: a.challengeId,
          response: credential.authenticationResponse(a.options, { counter: 0 }) })
          .then(value => ({ ok: true as const, codes: value.codes }), (error: unknown) => ({ ok: false as const, error }))
        finishB = appB!.finishRecoveryCodeRotation(request(cookieB), { challengeId: b.challengeId,
          response: credential.authenticationResponse(b.options, { counter: 0 }) })
          .then(value => ({ ok: true as const, codes: value.codes }), (error: unknown) => ({ ok: false as const, error }))
        for (let index = 0; index < 45; index++) {
          const rows = (await observer!.query(
            'SELECT pid FROM pg_stat_activity WHERE usename=$1 AND wait_event_type=$2 AND query ILIKE $3 AND query ILIKE $4',
            ['runtime', 'Lock', '%"user"%', '%for update%'])).rows
          const simultaneous = new Set(rows.map(candidate => Number(candidate.pid)))
          if (simultaneous.size >= 2) { waiting = simultaneous; break }
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        observedUserContention = waiting.size === 2 && Date.now() - started < 850
      } catch (error) { waitError = error }
      finally {
        if (lockHeld) {
          await settleOwnedClose('cross-owner-user-lock-release', () => fixture.administrator.query('COMMIT'), cleanupFailures)
          lockHeld = false
        }
        if (finishA) await settleOwnedClose('cross-owner-finish-A', async () => { resultA = await finishA }, cleanupFailures)
        if (finishB) await settleOwnedClose('cross-owner-finish-B', async () => { resultB = await finishB }, cleanupFailures)
      }
      assertOwnedCleanup(cleanupFailures)
      if (waitError) throw waitError
      if (!resultA || !resultB) throw new Error('Cross-owner finish calls did not settle')
      expect(observedUserContention).toBe(true)
      const outcomes = [resultA, resultB]
      const winners = outcomes.flatMap((result, index) => result.ok ? [{ index, codes: result.codes }] : [])
      const losers = outcomes.flatMap((result, index) => !result.ok ? [{ index, error: result.error }] : [])
      expect(winners.length).toBe(1); expect(losers.length).toBe(1)
      expect(winners[0].codes.length).toBe(8)
      assertFixedRefusal(losers[0].error, 'Authentication rejected')
      const winnerId = winners[0].index === 0 ? a.challengeId : b.challengeId
      const loserId = losers[0].index === 0 ? a.challengeId : b.challengeId
      const winnerSession = winners[0].index === 0 ? principalA.sessionId : principalB.sessionId
      expect(await challengeCount(winnerId)).toBe(0); expect(await challengeCount(loserId)).toBe(1)
      const after = await authority()
      expect(after.batch.length).toBe(1); expect(after.codes.length).toBe(8)
      expect(after.codes.every(row => row.batch_id === after.batch[0].batch_id && row.spent_at === null && /^[0-9a-f]{64}$/.test(row.digest))).toBe(true)
      expect(after.facts.length).toBe(previousFacts + 1)
      const fact = after.facts.find(row => row.challenge_id === winnerId)
      expect(Boolean(fact)).toBe(true)
      if (!fact) throw new Error('Missing cross-owner winner fact')
      expect(fact.authorizing_session_id === winnerSession && fact.authorizing_passkey_id === key[0].id
        && fact.prior_batch_id === priorBatchId && fact.new_batch_id === after.batch[0].batch_id && fact.code_count === 8).toBe(true)
      expect(hash(after.key)).toBe(keyBefore)
      expect(hash((await fixture.administrator.query('SELECT * FROM "user" WHERE id=$1', [userId])).rows)).toBe(userBefore)
      expect(hash((await fixture.administrator.query('SELECT * FROM account WHERE user_id=$1 ORDER BY id', [userId])).rows)).toBe(accountBefore)
      expect(hash((await fixture.administrator.query('SELECT * FROM session WHERE user_id=$1 ORDER BY id', [userId])).rows)).toBe(sessionsBefore)
      return { batchId: String(after.batch[0].batch_id), loserId }
    }
    const first = await compete(null, 0)
    const secondBatch = await compete(first.batchId, 1)
    expect(first.batchId === secondBatch.batchId).toBe(false)
    expect(await challengeCount(first.loserId)).toBe(1)
    const fresh = await bounded(appA.beginRecoveryCodeRotation(request(cookieA)), 16000)
    const beforeWrongSession = hash(await authority())
    const beforeWrongVerification = hash((await fixture.administrator.query('SELECT * FROM verification ORDER BY identifier,id')).rows)
    const wrongSession = await bounded(appB.finishRecoveryCodeRotation(request(cookieB), { challengeId: fresh.challengeId,
      response: credential.authenticationResponse(fresh.options, { counter: 0 }) }).then(() => null, (error: unknown) => error), 16000)
    assertFixedRefusal(wrongSession, 'Authentication rejected')
    expect(await challengeCount(fresh.challengeId)).toBe(1)
    expect(hash(await authority())).toBe(beforeWrongSession)
    expect(hash((await fixture.administrator.query('SELECT * FROM verification ORDER BY identifier,id')).rows)).toBe(beforeWrongVerification)
    expect(hash((await fixture.administrator.query('SELECT * FROM "user" WHERE id=$1', [userId])).rows)).toBe(userBefore)
    expect(hash((await fixture.administrator.query('SELECT * FROM account WHERE user_id=$1 ORDER BY id', [userId])).rows)).toBe(accountBefore)
    expect(hash((await fixture.administrator.query('SELECT * FROM session WHERE user_id=$1 ORDER BY id', [userId])).rows)).toBe(sessionsBefore)
    const rightful = await bounded(appA.finishRecoveryCodeRotation(request(cookieA), { challengeId: fresh.challengeId,
      response: credential.authenticationResponse(fresh.options, { counter: 0 }) }), 16000)
    expect(rightful.codes.length).toBe(8)
    expect(await challengeCount(fresh.challengeId)).toBe(0)
    const final = await authority()
    expect(final.facts.length).toBe(3); expect(final.codes.length).toBe(8)
    expect(hash(final.key)).toBe(keyBefore)
    expect(hash((await fixture.administrator.query('SELECT * FROM "user" WHERE id=$1', [userId])).rows)).toBe(userBefore)
    expect(hash((await fixture.administrator.query('SELECT * FROM account WHERE user_id=$1 ORDER BY id', [userId])).rows)).toBe(accountBefore)
    expect(hash((await fixture.administrator.query('SELECT * FROM session WHERE user_id=$1 ORDER BY id', [userId])).rows)).toBe(sessionsBefore)
  } finally {
    for (const [name, close] of [['appA', () => appA?.close()], ['appB', () => appB?.close()],
      ['limiterA', () => limiterA?.close()], ['limiterB', () => limiterB?.close()],
      ['poolA', () => poolA?.end()], ['poolB', () => poolB?.end()],
      ['observer', () => observer?.end()], ['stores', () => stores?.cleanup()]] as const) await settleOwnedClose(name, close, cleanupFailures)
    try {
      const target = await realpath(markerDirectory), parent = await realpath(tmpdir())
      if (dirname(target) !== parent || !basename(target).startsWith('r1-headless-marker-')) throw new Error('Marker ownership mismatch')
      await settleOwnedClose('marker', () => rm(target, { recursive: true }), cleanupFailures)
    } catch { cleanupFailures.push('marker') }
    assertOwnedCleanup(cleanupFailures)
  }
}, 300000)

test('R1 F1 expiry after native state row lock wait refuses before native lookup', async () => {
  await withSeededRecoveryGoogle(async fixture => {
    const { stores, peer, app, userId, subject, email, code } = fixture
    const begun = await bounded(app.beginRecoveryGoogleProof(request(), { email, code }), 16000)
    const state = new URL(begun.url).searchParams.get('state')
    if (!state) throw new Error('Native state missing')
    const providerCode = peer.register(begun.url, subject, { email })
    await stores.administrator.query("INSERT INTO verification(id,identifier,value,expires_at) VALUES($1,'r1-f1-expired-canary','canary',clock_timestamp()-interval '1 minute')",
      [randomUUID()])
    const observer = new Client({ connectionString: stores.directRuntimeUrl, connectionTimeoutMillis: 500 })
    let stateLocked = false
    let pending: Promise<{ accepted: boolean; error?: unknown }> | undefined
    let outcome: { accepted: boolean; error?: unknown } | undefined
    let reachedWait = false, validWindow = false
    const f1CleanupFailures: string[] = []
    try {
      await observer.connect()
      await stores.administrator.query("UPDATE recovery_attempt SET created_at=clock_timestamp()-interval '4 minutes 55 seconds', expires_at=clock_timestamp()+interval '4 seconds' WHERE oauth_state=$1",
        [state])
      const expiryRows = (await stores.administrator.query('SELECT expires_at FROM recovery_attempt WHERE oauth_state=$1', [state])).rows
      expect(expiryRows.length).toBe(1)
      const deadline = new Date(expiryRows[0].expires_at)
      await stores.administrator.query('BEGIN')
      stateLocked = true
      const locked = (await stores.administrator.query('SELECT id FROM verification WHERE identifier=$1 FOR UPDATE', [state])).rows
      expect(locked.length).toBe(1)
      const inventory = async () => hash({
        users: (await stores.administrator.query('SELECT * FROM "user" WHERE id=$1', [userId])).rows,
        accounts: (await stores.administrator.query('SELECT * FROM account WHERE user_id=$1 ORDER BY id', [userId])).rows,
        sessions: (await stores.administrator.query('SELECT * FROM session WHERE user_id=$1 ORDER BY id', [userId])).rows,
        batches: (await stores.administrator.query('SELECT * FROM recovery_code_batch WHERE user_id=$1', [userId])).rows,
        codes: (await stores.administrator.query('SELECT * FROM recovery_code WHERE user_id=$1 ORDER BY id', [userId])).rows,
        attempts: (await stores.administrator.query('SELECT * FROM recovery_attempt WHERE user_id=$1 ORDER BY id', [userId])).rows,
        verification: (await stores.administrator.query('SELECT * FROM verification ORDER BY identifier,id')).rows,
      })
      // The lock owner reads the pre-callback inventory while its state row
      // remains held. A concurrent runtime callback must not mutate it.
      const before = await inventory()
      const startClock = (await observer.query('SELECT clock_timestamp() AS now')).rows[0].now
      const untilStartMs = deadline.getTime() - new Date(startClock).getTime() - 700
      expect(untilStartMs >= 0 && untilStartMs < 5000).toBe(true)
      if (untilStartMs > 0) await bounded(new Promise(resolve => setTimeout(resolve, untilStartMs)), 6000)
      observed.nativeVerificationLookups = 0; observed.nativeVerificationSweeps = 0; observed.observeRecoveryLookup = true
      pending = app.completeRecoveryGoogleProof(request(cookies(begun.headers),
        '/api/auth/recovery/google/callback?state=' + state + '&code=' + providerCode, 'GET'))
        .then(() => ({ accepted: true }), (error: unknown) => ({ accepted: false, error }))
      for (let index = 0; index < 40; index++) {
        const rows = (await observer.query("SELECT count(*)::int n FROM pg_stat_activity WHERE usename='runtime' AND wait_event_type='Lock' AND query ILIKE '%verification%'")).rows
        if (rows[0].n > 0) { reachedWait = true; break }
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      const clock = (await observer.query('SELECT clock_timestamp() AS now')).rows[0].now
      const remainingMs = deadline.getTime() - new Date(clock).getTime()
      validWindow = reachedWait && remainingMs > 0 && remainingMs < 850
      if (validWindow) await bounded(new Promise(resolve => setTimeout(resolve, remainingMs + 60)), 1000)
      const afterClock = (await observer.query('SELECT clock_timestamp() AS now')).rows[0].now
      validWindow = validWindow && new Date(afterClock).getTime() > deadline.getTime()
      await stores.administrator.query('COMMIT')
      stateLocked = false
      outcome = await bounded(pending, 16000)
      observed.observeRecoveryLookup = false
      expect(reachedWait).toBe(true)
      expect(validWindow).toBe(true)
      expect(outcome.accepted).toBe(false)
      assertFixedRefusal(outcome.error, 'Authentication rejected')
      expect(observed.nativeVerificationLookups).toBe(0)
      expect(observed.nativeVerificationSweeps).toBe(0)
      expect(peer.evidence().posts).toBe(0)
      expect(await inventory()).toBe(before)
    } finally {
      observed.observeRecoveryLookup = false
      if (stateLocked) await settleOwnedClose('f1-locker-rollback', () => stores.administrator.query('ROLLBACK'), f1CleanupFailures)
      if (pending && !outcome) await settleOwnedClose('f1-callback', async () => { outcome = await pending }, f1CleanupFailures)
      await settleOwnedClose('f1-observer', () => observer.end(), f1CleanupFailures)
      assertOwnedCleanup(f1CleanupFailures)
    }
  })
}, 300000)

test('R1 F2 rejects a native state create-before expiry rewrite', async () => {
  await withSeededRecoveryGoogle(async fixture => {
    const { stores, app, userId, accountId, email, code } = fixture
    const beforeVerification = hash((await stores.administrator.query('SELECT * FROM verification ORDER BY identifier,id')).rows)
    const beforeUser = hash((await stores.administrator.query('SELECT * FROM "user" WHERE id=$1', [userId])).rows)
    const beforeAccount = hash((await stores.administrator.query('SELECT * FROM account WHERE id=$1', [accountId])).rows)
    observed.stateExpiryBeforeReached = 0; observed.stateExpiryBefore = true
    const error = await bounded(app.beginRecoveryGoogleProof(request(), { email, code }).then(() => null, (failure: unknown) => failure), 16000)
    observed.stateExpiryBefore = false
    expect(observed.stateExpiryBeforeReached).toBe(1)
    assertFixedRefusal(error, 'Authentication rejected')
    await assertUnchangedRecoveryBeginAfterRefusal(fixture, beforeVerification, beforeUser, beforeAccount)
  })
}, 300000)

test.each(['identifier', 'value'] as const)('R1 F2 rejects a native state return-only %s rewrite', async field => {
  await withSeededRecoveryGoogle(async fixture => {
    const { stores, app, userId, accountId, email, code } = fixture
    const beforeVerification = hash((await stores.administrator.query('SELECT * FROM verification ORDER BY identifier,id')).rows)
    const beforeUser = hash((await stores.administrator.query('SELECT * FROM "user" WHERE id=$1', [userId])).rows)
    const beforeAccount = hash((await stores.administrator.query('SELECT * FROM account WHERE id=$1', [accountId])).rows)
    observed.stateReturnIdentifierReached = 0; observed.stateReturnValueReached = 0
    observed.stateReturnIdentifier = field === 'identifier'; observed.stateReturnValue = field === 'value'
    const error = await bounded(app.beginRecoveryGoogleProof(request(), { email, code }).then(() => null, (failure: unknown) => failure), 16000)
    observed.stateReturnIdentifier = false; observed.stateReturnValue = false
    expect(field === 'identifier' ? observed.stateReturnIdentifierReached : observed.stateReturnValueReached).toBe(1)
    assertFixedRefusal(error, 'Authentication rejected')
    await assertUnchangedRecoveryBeginAfterRefusal(fixture, beforeVerification, beforeUser, beforeAccount)
  })
}, 300000)

test('R1 F3 signed rotation replaces seven or zero bound codes and refuses nine', async () => {
  const markerDirectory = await mkdtemp(join(tmpdir(), 'r1-headless-marker-'))
  let stores: Awaited<ReturnType<typeof startDisposableStores>> | undefined
  let pool: Pool | undefined, limiter: ReturnType<typeof createAuthRateLimiter> | undefined
  let app: ReturnType<typeof createApplicationAuth> | undefined
  const cleanupFailures: string[] = []
  try {
    await mkdir(join(markerDirectory, 'server'))
    await writeFile(join(markerDirectory, 'server/index.mjs'), '// R1 headless fixture marker; not a built application.\n', { flag: 'wx' })
    stores = await startDisposableStores(markerDirectory)
    await stores.migrate()
    await stores.administrator.query(`GRANT USAGE ON SCHEMA public TO runtime;
      GRANT SELECT,INSERT,UPDATE,DELETE ON public."user",public.account,public.session,public.verification TO runtime;
      GRANT SELECT,INSERT ON public.passkey TO runtime; GRANT UPDATE(counter) ON public.passkey TO runtime;
      GRANT SELECT,INSERT,UPDATE ON public.auth_email_request TO runtime; GRANT SELECT,INSERT ON public.auth_email_command TO runtime;
      GRANT SELECT ON public.email_delivery,public.auth_email_outbox TO runtime;
      GRANT INSERT(id,command_id,state,verifier_hash,key_id,ciphertext,nonce,tag,snapshot_format,snapshot_hash,replay_window_seconds)
        ON public.email_delivery TO runtime;
      GRANT UPDATE(state,verifier_hash,ciphertext,nonce,tag) ON public.email_delivery TO runtime;
      GRANT INSERT(id,delivery_id) ON public.auth_email_outbox TO runtime`)
    pool = new Pool({ connectionString: stores.runtimeUrl, max: 3 })
    const owner = createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
    limiter = createAuthRateLimiter(readRateLimitConfig({ NODE_ENV: 'test', REDIS_URL: stores.redisUrl, RATE_LIMIT_HMAC_SECRET: stores.hmac,
      RATE_LIMIT_KEY_ID: 'r1-f3-rotation', TRUSTED_PROXY_IPS: '127.0.0.1' }))
    await limiter.connect()
    app = createApplicationAuth(owner, { ...readAuthConfig({ APP_ORIGIN: origin, AUTH_SECRET: randomBytes(48).toString('hex') })!,
      magic: { envelope: createAuthEmailEnvelope({ currentKeyId: 'fixture', keys: { fixture: randomBytes(32) } }), profile } }, limiter)
    const email = 'r1-f3-' + randomUUID() + '@example.test'
    await bounded(app.requestMagicLink(request(), { email, locale: 'en' }), 16000)
    const enrollment = { token: observed.enrollmentToken, intendedEmail: email }
    const options = await bounded(magicConsumeResponse(request(), enrollment, app, limiter), 16000)
    expect(options.status).toBe(200)
    const body = await options.json(), credential = registrationCredentialFixture(body.options, origin)
    const enrolled = await bounded(magicEnrollmentResponse(request(cookies(options.headers)),
      { ...enrollment, response: credential.response }, app, limiter), 16000)
    expect(enrolled.status).toBe(200)
    const cookie = cookies(enrolled.headers), principal = await bounded(app.requirePrincipal(request(cookie)), 16000)
    const userId = principal.userId, sessionId = principal.sessionId
    const userBefore = hash((await stores.administrator.query('SELECT * FROM "user" WHERE id=$1', [userId])).rows)
    const sessionBefore = hash((await stores.administrator.query('SELECT * FROM session WHERE id=$1', [sessionId])).rows)
    const accountsBefore = hash((await stores.administrator.query('SELECT * FROM account WHERE user_id=$1', [userId])).rows)
    const key = (await stores.administrator.query('SELECT id,counter FROM passkey WHERE user_id=$1', [userId])).rows
    expect(key.length).toBe(1); expect(key[0].counter).toBe(0)
    const authority = async () => ({
      batch: (await stores!.administrator.query('SELECT batch_id FROM recovery_code_batch WHERE user_id=$1', [userId])).rows,
      codes: (await stores!.administrator.query('SELECT id,batch_id,digest,spent_at FROM recovery_code WHERE user_id=$1 ORDER BY id', [userId])).rows,
      facts: (await stores!.administrator.query('SELECT challenge_id,prior_batch_id,new_batch_id,code_count FROM recovery_code_rotation_fact WHERE actor_user_id=$1 ORDER BY occurred_at,id', [userId])).rows,
      counter: (await stores!.administrator.query('SELECT counter FROM passkey WHERE id=$1', [key[0].id])).rows[0].counter as number,
    })
    async function rotate() {
      const challenge = await bounded(app!.beginRecoveryCodeRotation(request(cookie)), 16000)
      const finished = await bounded(app!.finishRecoveryCodeRotation(request(cookie), { challengeId: challenge.challengeId,
        response: credential.authenticationResponse(challenge.options, { counter: 0 }) }), 16000)
      expect(finished.codes.length).toBe(8)
      return { challengeId: challenge.challengeId, state: await authority() }
    }
    const first = await rotate()
    expect(first.state.batch.length).toBe(1); expect(first.state.codes.length).toBe(8)
    expect(first.state.facts.length).toBe(1); expect(first.state.counter).toBe(0)
    const firstBatchId = String(first.state.batch[0].batch_id)
    const removedOne = await stores.administrator.query('DELETE FROM recovery_code WHERE id=$1 AND user_id=$2', [first.state.codes[0].id, userId])
    expect(removedOne.rowCount).toBe(1)
    const seven = await authority()
    expect(seven.codes.length).toBe(7)
    expect(seven.codes.every(row => row.batch_id === firstBatchId && row.spent_at === null)).toBe(true)
    const second = await rotate()
    expect(second.state.codes.length).toBe(8)
    expect(second.state.batch.length).toBe(1)
    expect(second.state.batch[0].batch_id === firstBatchId).toBe(false)
    expect(second.state.codes.every(row => row.batch_id === second.state.batch[0].batch_id && row.spent_at === null
      && !seven.codes.some(prior => prior.id === row.id))).toBe(true)
    expect(second.state.facts.length).toBe(2)
    const secondFact = second.state.facts.find(row => row.challenge_id === second.challengeId)
    expect(Boolean(secondFact)).toBe(true)
    if (!secondFact) throw new Error('Missing second rotation fact')
    expect(secondFact.prior_batch_id === firstBatchId && secondFact.new_batch_id === second.state.batch[0].batch_id
      && secondFact.code_count === 8).toBe(true)
    expect(second.state.counter).toBe(0)
    const removedEight = await stores.administrator.query('DELETE FROM recovery_code WHERE user_id=$1 AND batch_id=$2',
      [userId, second.state.batch[0].batch_id])
    expect(removedEight.rowCount).toBe(8)
    expect((await authority()).codes.length).toBe(0)
    const third = await rotate()
    expect(third.state.codes.length).toBe(8)
    expect(third.state.facts.length).toBe(3)
    const thirdFact = third.state.facts.find(row => row.challenge_id === third.challengeId)
    expect(Boolean(thirdFact)).toBe(true)
    if (!thirdFact) throw new Error('Missing third rotation fact')
    expect(thirdFact.prior_batch_id === second.state.batch[0].batch_id
      && thirdFact.new_batch_id === third.state.batch[0].batch_id && thirdFact.code_count === 8).toBe(true)
    expect(third.state.counter).toBe(0)
    const ninthCode = 'rc1_' + randomBytes(20).toString('base64url')
    await stores.administrator.query('INSERT INTO recovery_code(id,user_id,batch_id,digest) VALUES($1,$2,$3,$4)',
      [randomUUID(), userId, third.state.batch[0].batch_id,
        createHash('sha256').update('recovery-code-v1\0' + ninthCode).digest('hex')])
    const nine = await authority()
    expect(nine.codes.length).toBe(9)
    const challenge = await bounded(app.beginRecoveryCodeRotation(request(cookie)), 16000)
    const rejected = await bounded(app.finishRecoveryCodeRotation(request(cookie), { challengeId: challenge.challengeId,
      response: credential.authenticationResponse(challenge.options, { counter: 0 }) }).then(() => null, (error: unknown) => error), 16000)
    assertFixedRefusal(rejected, 'Authentication rejected')
    expect(hash(await authority())).toBe(hash(nine))
    expect((await stores.administrator.query('SELECT count(*)::int n FROM verification WHERE identifier LIKE $1',
      ['application-recovery-rotation-v1:%:' + challenge.challengeId])).rows[0].n).toBe(1)
    expect(hash((await stores.administrator.query('SELECT * FROM "user" WHERE id=$1', [userId])).rows)).toBe(userBefore)
    expect(hash((await stores.administrator.query('SELECT * FROM session WHERE id=$1', [sessionId])).rows)).toBe(sessionBefore)
    expect(hash((await stores.administrator.query('SELECT * FROM account WHERE user_id=$1', [userId])).rows)).toBe(accountsBefore)
  } finally {
    for (const [name, close] of [['app', () => app?.close()], ['limiter', () => limiter?.close()], ['pool', () => pool?.end()],
      ['stores', () => stores?.cleanup()]] as const) await settleOwnedClose(name, close, cleanupFailures)
    try {
      const target = await realpath(markerDirectory), parent = await realpath(tmpdir())
      if (dirname(target) !== parent || !basename(target).startsWith('r1-headless-marker-')) throw new Error('Marker ownership mismatch')
      await settleOwnedClose('marker', () => rm(target, { recursive: true }), cleanupFailures)
    } catch { cleanupFailures.push('marker') }
    assertOwnedCleanup(cleanupFailures)
  }
}, 300000)

test('R1 real recovery code issuer to linked Google proof', async () => {
  const markerDirectory = await mkdtemp(join(tmpdir(), 'r1-headless-marker-'))
  const markerText = '// R1 headless fixture marker; not a built application.\n'
  const markerHash = createHash('sha256').update(markerText).digest('hex')
  let ownedStores: Awaited<ReturnType<typeof startDisposableStores>> | undefined
  let peer: Awaited<ReturnType<typeof startGoogleProtocolPeer>> | undefined
  let pool: Pool | undefined, limiter: ReturnType<typeof createAuthRateLimiter> | undefined
  let app: ReturnType<typeof createApplicationAuth> | undefined
  const cleanupFailures: string[] = []
  try {
    await mkdir(join(markerDirectory, 'server'))
    await writeFile(join(markerDirectory, 'server/index.mjs'), markerText, { flag: 'wx' })
    const stores = await startDisposableStores(markerDirectory)
    ownedStores = stores
    expect(JSON.stringify(stores.evidence.candidateArtifact)?.includes(markerHash)).toBe(true)
    await stores.migrateRecoveryAdmissionPrefix()
    const priorId = randomUUID(), priorSessionId = randomUUID(), priorKeyId = randomUUID()
    await stores.administrator.query('INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$2,$3,true)', [priorId, 'Pre-R1 fixture', `pre-r1-${priorId}@example.test`])
    await stores.administrator.query('INSERT INTO account(id,user_id,provider_id,account_id) VALUES($1,$2,$3,$4)', [randomUUID(), priorId, 'google', randomUUID()])
    await stores.administrator.query(`INSERT INTO session(id,token,user_id,expires_at,auth_state,auth_method,authenticated_at,last_activity_at,recovery_generation)
      VALUES($1,$2,$3,clock_timestamp()+interval '7 days','ACTIVE','passkey',clock_timestamp(),clock_timestamp(),0)`,
      [priorSessionId, randomBytes(32).toString('hex'), priorId])
    await stores.administrator.query(`INSERT INTO passkey(id,user_id,credential_id,public_key,counter,device_type,backed_up)
      VALUES($1,$2,$3,$4,0,'singleDevice',false)`, [priorKeyId, priorId, randomUUID(), Buffer.from('pre-r1').toString('base64')])
    await stores.administrator.query('INSERT INTO verification(id,identifier,value,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval \'1 hour\')',
      [randomUUID(), 'pre-r1-unrelated', 'pre-r1-value'])
    const auditId = randomUUID()
    await stores.administrator.query(`INSERT INTO auth_session_revocation(id,actor_user_id,authorizing_session_id,target_session_id,workspace_id,correlation_id,occurred_at)
      VALUES($1,$2,$3,$4,$5,$6,clock_timestamp())`, [auditId, priorId, priorSessionId, randomUUID(), randomUUID(), randomUUID()])
    const beforeJournal = (await stores.administrator.query('SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id')).rows
    const beforeRows = (await stores.administrator.query('SELECT * FROM "user" WHERE id=$1', [priorId])).rows
    const beforeAccount = (await stores.administrator.query('SELECT * FROM account WHERE user_id=$1', [priorId])).rows
    const beforeSession = (await stores.administrator.query('SELECT * FROM session WHERE id=$1', [priorSessionId])).rows
    const beforeKey = (await stores.administrator.query('SELECT * FROM passkey WHERE id=$1', [priorKeyId])).rows
    const beforeVerification = (await stores.administrator.query("SELECT * FROM verification WHERE identifier='pre-r1-unrelated'")).rows
    const beforeAudit = (await stores.administrator.query('SELECT * FROM auth_session_revocation WHERE id=$1', [auditId])).rows
    expect([beforeRows, beforeAccount, beforeSession, beforeKey, beforeVerification, beforeAudit].every(rows => rows.length === 1)).toBe(true)
    await stores.migrate(); await stores.migrate()
    const finalJournal = (await stores.administrator.query('SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id')).rows
    expect(finalJournal.length).toBe(13)
    expect(hash(finalJournal.slice(0, 12)) === hash(beforeJournal)).toBe(true)
    expect(hash((await stores.administrator.query('SELECT * FROM "user" WHERE id=$1', [priorId])).rows) === hash(beforeRows)).toBe(true)
    expect(hash((await stores.administrator.query('SELECT * FROM account WHERE user_id=$1', [priorId])).rows) === hash(beforeAccount)).toBe(true)
    expect(hash((await stores.administrator.query('SELECT * FROM session WHERE id=$1', [priorSessionId])).rows) === hash(beforeSession)).toBe(true)
    expect(hash((await stores.administrator.query('SELECT * FROM passkey WHERE id=$1', [priorKeyId])).rows) === hash(beforeKey)).toBe(true)
    expect(hash((await stores.administrator.query("SELECT * FROM verification WHERE identifier='pre-r1-unrelated'")).rows) === hash(beforeVerification)).toBe(true)
    expect(hash((await stores.administrator.query('SELECT * FROM auth_session_revocation WHERE id=$1', [auditId])).rows) === hash(beforeAudit)).toBe(true)

    await stores.administrator.query(`GRANT USAGE ON SCHEMA public TO runtime;
      GRANT SELECT,INSERT,UPDATE,DELETE ON public."user",public.account,public.session,public.verification,public.google_account_intent,public.first_google_passkey_intent TO runtime;
      GRANT SELECT,INSERT ON public.passkey TO runtime; GRANT UPDATE(counter) ON public.passkey TO runtime;
      GRANT SELECT,INSERT,UPDATE ON public.additional_passkey_intent TO runtime;
      GRANT SELECT,INSERT,UPDATE ON public.auth_email_request TO runtime; GRANT SELECT,INSERT ON public.auth_email_command TO runtime;
      GRANT SELECT ON public.email_delivery,public.auth_email_outbox TO runtime;
      GRANT INSERT(id,command_id,state,verifier_hash,key_id,ciphertext,nonce,tag,snapshot_format,snapshot_hash,replay_window_seconds) ON public.email_delivery TO runtime;
      GRANT UPDATE(state,verifier_hash,ciphertext,nonce,tag) ON public.email_delivery TO runtime;
      GRANT INSERT(id,delivery_id) ON public.auth_email_outbox TO runtime`)
    const privilege = new Pool({ connectionString: stores.directRuntimeUrl, max: 1 })
    try {
      const denied = await privilege.query('SELECT id FROM recovery_code_rotation_fact LIMIT 1').then(() => false, (error: { code?: string }) => error.code === '42501')
      expect(denied).toBe(true)
    } finally { await privilege.end() }
    peer = await startGoogleProtocolPeer({ ports: [stores.runtimeUrl, stores.directRuntimeUrl, stores.redisUrl].map(value => Number(new URL(value).port)) })
    pool = new Pool({ connectionString: stores.runtimeUrl, max: 5 })
    const owner = createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
    limiter = createAuthRateLimiter(readRateLimitConfig({ NODE_ENV: 'test', REDIS_URL: stores.redisUrl, RATE_LIMIT_HMAC_SECRET: stores.hmac,
      RATE_LIMIT_KEY_ID: 'r1-native', TRUSTED_PROXY_IPS: '127.0.0.1' }))
    await limiter.connect()
    app = createApplicationAuth(owner, { ...readAuthConfig({ APP_ORIGIN: origin, AUTH_SECRET: randomBytes(48).toString('hex'),
      GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fixture-only' })!,
      magic: { envelope: createAuthEmailEnvelope({ currentKeyId: 'fixture', keys: { fixture: randomBytes(32) } }), profile } }, limiter)

    const email = `r1-${randomUUID()}@example.test`
    await bounded(app.requestMagicLink(request(), { email, locale: 'en' }), 16000)
    const enrollment = { token: observed.enrollmentToken, intendedEmail: email }
    const options = await bounded(magicConsumeResponse(request(), enrollment, app, limiter), 16000)
    expect(options.status).toBe(200)
    const body = await options.json(), credential = registrationCredentialFixture(body.options, origin)
    const enrolled = await bounded(magicEnrollmentResponse(request(cookies(options.headers)), { ...enrollment, response: credential.response }, app, limiter), 16000)
    expect(enrolled.status).toBe(200)
    const sessionCookie = cookies(enrolled.headers), principal = await bounded(app.requirePrincipal(request(sessionCookie)), 16000)
    expect(await bounded(createPersonalWorkspaces(owner).ensurePersonalWorkspace(principal), 16000)).toBeTruthy()
    const subject = randomUUID()
    const linking = await bounded(app.beginGoogleAccountLink(request(sessionCookie), 'en'), 16000)
    const authorized = await bounded(app.authorizeGoogleAccountLink(request(sessionCookie),
      { intentId: linking.intentId, response: credential.authenticationResponse(linking.options, { counter: 1 }) }), 16000)
    const linkedCode = peer.register(authorized.url, subject, { email })
    const linked = await bounded(googleAccountCallbackResponse(request(sessionCookie + '; ' + cookies(authorized.headers),
      '/api/auth/account/google/callback?state=' + new URL(authorized.url).searchParams.get('state') + '&code=' + linkedCode, 'GET'), app, limiter), 16000)
    expect(linked.status).toBe(303)
    const accountBefore = (await stores.administrator.query('SELECT * FROM account WHERE user_id=$1 AND provider_id=\'google\'', [principal.userId])).rows
    expect(accountBefore.length).toBe(1)
    expect(accountBefore[0].account_id === subject).toBe(true)
    const userBefore = hash((await stores.administrator.query('SELECT * FROM "user" WHERE id=$1', [principal.userId])).rows)
    const sessionBefore = hash((await stores.administrator.query('SELECT * FROM session WHERE user_id=$1 ORDER BY id', [principal.userId])).rows)

    const rotation = await bounded(app.beginRecoveryCodeRotation(request(sessionCookie)), 16000)
    expect(rotation.challengeId).toMatch(/^[0-9a-f-]{36}$/)
    const finished = await bounded(app.finishRecoveryCodeRotation(request(sessionCookie),
      { challengeId: rotation.challengeId, response: credential.authenticationResponse(rotation.options, { counter: 2 }) }), 16000)
    expect(finished.codes.length).toBe(8)
    expect(new Set(finished.codes).size).toBe(8)
    const batch = (await stores.administrator.query('SELECT * FROM recovery_code_batch WHERE user_id=$1', [principal.userId])).rows
    const rows = (await stores.administrator.query('SELECT * FROM recovery_code WHERE user_id=$1 ORDER BY id', [principal.userId])).rows
    const fact = (await stores.administrator.query('SELECT * FROM recovery_code_rotation_fact WHERE actor_user_id=$1', [principal.userId])).rows
    expect(batch.length).toBe(1); expect(rows.length).toBe(8); expect(fact.length).toBe(1)
    expect(rows.every(row => row.batch_id === batch[0].batch_id && row.spent_at === null && /^[0-9a-f]{64}$/.test(row.digest))).toBe(true)
    expect(fact[0].code_count).toBe(8)
    expect(fact[0].challenge_id === rotation.challengeId).toBe(true)
    expect((await stores.administrator.query('SELECT count(*)::int n FROM verification WHERE identifier LIKE $1',
      [`application-recovery-rotation-v1:%:${rotation.challengeId}`])).rows[0].n).toBe(0)

    const begun = await bounded(app.beginRecoveryGoogleProof(request(), { email, code: finished.codes[0] }), 16000)
    expect(begun.headers.getSetCookie().length).toBe(1)
    const state = new URL(begun.url).searchParams.get('state')
    expect(Boolean(state)).toBe(true)
    const proofCode = peer.register(begun.url, subject, { email })
    const completed = await bounded(app.completeRecoveryGoogleProof(request(cookies(begun.headers),
      '/api/auth/recovery/google/callback?state=' + state + '&code=' + proofCode, 'GET')), 16000)
    expect(completed.outcome).toBe('proved')
    expect(completed.headers.getSetCookie().length).toBe(1)
    const attempt = (await stores.administrator.query('SELECT * FROM recovery_attempt WHERE user_id=$1', [principal.userId])).rows
    expect(attempt.length).toBe(1)
    expect(attempt[0].phase).toBe('PROVED')
    expect(attempt[0].batch_id === batch[0].batch_id && attempt[0].code_id === rows.find(row => row.digest === createHash('sha256').update('recovery-code-v1\0' + finished.codes[0]).digest('hex'))?.id).toBe(true)
    expect(attempt[0].google_account_id === accountBefore[0].id && attempt[0].subject === subject).toBe(true)
    const proof = (await stores.administrator.query('SELECT * FROM verification WHERE identifier=$1', [`application-recovery-google-v1:${attempt[0].id}`])).rows
    expect(proof.length).toBe(1)
    expect(new Date(proof[0].expires_at).getTime()).toBe(new Date(attempt[0].expires_at).getTime())
    expect((await stores.administrator.query('SELECT count(*)::int n FROM verification WHERE identifier=$1', [state])).rows[0].n).toBe(0)
    expect((await stores.administrator.query('SELECT count(*)::int n FROM recovery_code WHERE user_id=$1 AND spent_at IS NOT NULL', [principal.userId])).rows[0].n).toBe(0)
    expect(hash((await stores.administrator.query('SELECT * FROM "user" WHERE id=$1', [principal.userId])).rows)).toBe(userBefore)
    expect(hash((await stores.administrator.query('SELECT * FROM session WHERE user_id=$1 ORDER BY id', [principal.userId])).rows)).toBe(sessionBefore)
    expect(hash((await stores.administrator.query('SELECT * FROM account WHERE user_id=$1 AND provider_id=\'google\'', [principal.userId])).rows)).toBe(hash(accountBefore))
    expect((await stores.administrator.query('SELECT counter FROM passkey WHERE user_id=$1', [principal.userId])).rows.map(row => row.counter)).toEqual([2])
    expect(peer.evidence().posts).toBe(2)
  } finally {
    for (const [name, close] of [['app', () => app?.close()], ['limiter', () => limiter?.close()], ['pool', () => pool?.end()],
      ['peer', () => peer?.close()], ['stores', () => ownedStores?.cleanup()]] as const) {
      await settleOwnedClose(name, close, cleanupFailures)
    }
    try {
      const target = await realpath(markerDirectory), parent = await realpath(tmpdir())
      if (dirname(target) !== parent || !basename(target).startsWith('r1-headless-marker-')) throw new Error('Marker ownership mismatch')
      await settleOwnedClose('marker', () => rm(target, { recursive: true }), cleanupFailures)
    } catch { cleanupFailures.push('marker') }
    assertOwnedCleanup(cleanupFailures)
  }
}, 300000)

test('R1 Google claim proof publication and native/provider failures keep phase and secrets bounded', async () => {
  const markerDirectory = await mkdtemp(join(tmpdir(), 'r1-headless-marker-'))
  let ownedStores: Awaited<ReturnType<typeof startDisposableStores>> | undefined
  let peer: Awaited<ReturnType<typeof startGoogleProtocolPeer>> | undefined
  let pool: Pool | undefined, limiter: ReturnType<typeof createAuthRateLimiter> | undefined
  let app: ReturnType<typeof createApplicationAuth> | undefined
  let logs: ReturnType<typeof captureSecretLogs> | undefined
  const cleanupFailures: string[] = []
  try {
    await mkdir(join(markerDirectory, 'server'))
    await writeFile(join(markerDirectory, 'server/index.mjs'), '// R1 headless fixture marker; not a built application.\n', { flag: 'wx' })
    const stores = await startDisposableStores(markerDirectory)
    ownedStores = stores
    await stores.migrate()
    await stores.administrator.query('GRANT USAGE ON SCHEMA public TO runtime')
    await stores.administrator.query('GRANT SELECT,INSERT,UPDATE,DELETE ON public."user",public.account,public.session,public.verification TO runtime')
    const userId = randomUUID(), batchId = randomUUID(), codeId = randomUUID(), accountId = randomUUID(), subject = randomUUID()
    const email = 'r1-a4-' + userId + '@example.test', code = 'rc1_' + randomBytes(20).toString('base64url')
    const digest = createHash('sha256').update('recovery-code-v1\0' + code).digest('hex')
    await stores.administrator.query('INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$2,$3,true)', [userId, 'R1 A4 fixture', email])
    await stores.administrator.query('INSERT INTO account(id,user_id,provider_id,account_id) VALUES($1,$2,$3,$4)', [accountId, userId, 'google', subject])
    await stores.administrator.query('INSERT INTO recovery_code_batch(user_id,batch_id,format_version,recovery_generation,issued_at) VALUES($1,$2,1,0,clock_timestamp())', [userId, batchId])
    await stores.administrator.query('INSERT INTO recovery_code(id,user_id,batch_id,digest) VALUES($1,$2,$3,$4)', [codeId, userId, batchId, digest])
    const unchangedUser = hash((await stores.administrator.query('SELECT * FROM "user" WHERE id=$1', [userId])).rows)
    const unchangedAccount = hash((await stores.administrator.query('SELECT * FROM account WHERE id=$1', [accountId])).rows)
    const unchangedSessions = hash((await stores.administrator.query('SELECT * FROM session WHERE user_id=$1 ORDER BY id', [userId])).rows)
    peer = await startGoogleProtocolPeer({ ports: [stores.runtimeUrl, stores.directRuntimeUrl, stores.redisUrl].map(value => Number(new URL(value).port)) })
    pool = new Pool({ connectionString: stores.runtimeUrl, max: 3 })
    const owner = createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
    limiter = createAuthRateLimiter(readRateLimitConfig({ NODE_ENV: 'test', REDIS_URL: stores.redisUrl, RATE_LIMIT_HMAC_SECRET: stores.hmac,
      RATE_LIMIT_KEY_ID: 'r1-a4-a6', TRUSTED_PROXY_IPS: '127.0.0.1' }))
    await limiter.connect()
    app = createApplicationAuth(owner, readAuthConfig({ APP_ORIGIN: origin, AUTH_SECRET: randomBytes(48).toString('hex'),
      GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fixture-only' })!, limiter)
    logs = captureSecretLogs()
    console.error({ nested: { error: new Error(sentinel) } })
    expect(logs.leaked).toEqual(['error'])
    logs.leaked.length = 0
    const begin = () => bounded(app!.beginRecoveryGoogleProof(request(), { email, code }), 16000)
    const complete = (url: string, stateHeaders: Headers, providerCode: string, cookieOverride?: string) =>
      bounded(app!.completeRecoveryGoogleProof(request(cookieOverride ?? cookies(stateHeaders),
        '/api/auth/recovery/google/callback?state=' + new URL(url).searchParams.get('state') + '&code=' + providerCode, 'GET')), 16000)
    const attempt = async (url: string) => {
      const state = new URL(url).searchParams.get('state')
      if (!state) throw new Error('Native state missing')
      const rows = (await stores.administrator.query('SELECT id,phase FROM recovery_attempt WHERE oauth_state=$1', [state])).rows
      expect(rows.length).toBe(1)
      return { id: String(rows[0].id), phase: String(rows[0].phase), state }
    }
    const proofCount = async (attemptId: string) => (await stores.administrator.query('SELECT count(*)::int n FROM verification WHERE identifier=$1',
      ['application-recovery-google-v1:' + attemptId])).rows[0].n
    const stateCount = async (state: string) => (await stores.administrator.query('SELECT count(*)::int n FROM verification WHERE identifier=$1', [state])).rows[0].n

    observed.lateBegin = true; observed.lateBeginReached = 0
    await fixedFailure(begin(), 'Authentication outcome unconfirmed')
    observed.lateBegin = false
    expect(observed.lateBeginReached).toBe(1)
    const pending = (await stores.administrator.query('SELECT id,phase,oauth_state FROM recovery_attempt WHERE user_id=$1', [userId])).rows
    expect(pending.length).toBe(1)
    expect(pending[0].phase).toBe('PENDING_GOOGLE')
    expect(await stateCount(String(pending[0].oauth_state))).toBe(1)
    expect(await proofCount(String(pending[0].id))).toBe(0)
    expect(peer.evidence().posts).toBe(0)

    const parsedFailure = await begin(), parseCode = peer.register(parsedFailure.url, subject, { email })
    await fixedFailure(complete(parsedFailure.url, parsedFailure.headers, parseCode,
      '__Secure-better-auth.state=' + sentinel), 'Authentication unavailable')
    const parseAttempt = await attempt(parsedFailure.url)
    expect(parseAttempt.phase).toBe('PENDING_GOOGLE')
    expect(await stateCount(parseAttempt.state)).toBe(1)
    expect(await proofCount(parseAttempt.id)).toBe(0)
    expect(peer.evidence().posts).toBe(0)

    const exchangeFailure = await begin(), failedCode = peer.register(exchangeFailure.url, subject, { email, fields: { error: sentinel } })
    await fixedFailure(complete(exchangeFailure.url, exchangeFailure.headers, failedCode), 'Authentication unavailable')
    const exchanged = await attempt(exchangeFailure.url)
    expect(exchanged.phase).toBe('EXCHANGING')
    expect(await stateCount(exchanged.state)).toBe(0)
    expect(await proofCount(exchanged.id)).toBe(0)
    expect(peer.evidence().posts).toBe(1)

    observed.proofCreateFailure = true; observed.proofCreateReached = 0
    const rollback = await begin(), rollbackCode = peer.register(rollback.url, subject, { email })
    await fixedFailure(complete(rollback.url, rollback.headers, rollbackCode), 'Authentication unavailable')
    observed.proofCreateFailure = false
    expect(observed.proofCreateReached).toBe(1)
    const rolledBack = await attempt(rollback.url)
    expect(rolledBack.phase).toBe('EXCHANGING')
    expect(await stateCount(rolledBack.state)).toBe(0)
    expect(await proofCount(rolledBack.id)).toBe(0)
    expect(peer.evidence().posts).toBe(2)

    observed.lateComplete = true; observed.lateCompleteReached = 0
    const published = await begin(), publishedCode = peer.register(published.url, subject, { email })
    await fixedFailure(complete(published.url, published.headers, publishedCode), 'Authentication outcome unconfirmed')
    observed.lateComplete = false
    expect(observed.lateCompleteReached).toBe(1)
    const proved = await attempt(published.url)
    expect(proved.phase).toBe('PROVED')
    expect(await stateCount(proved.state)).toBe(0)
    expect(await proofCount(proved.id)).toBe(1)
    expect(peer.evidence().posts).toBe(3)
    expect((await stores.administrator.query('SELECT spent_at FROM recovery_code WHERE id=$1', [codeId])).rows[0].spent_at).toBeNull()
    expect(hash((await stores.administrator.query('SELECT * FROM "user" WHERE id=$1', [userId])).rows)).toBe(unchangedUser)
    expect(hash((await stores.administrator.query('SELECT * FROM account WHERE id=$1', [accountId])).rows)).toBe(unchangedAccount)
    const finalSessions = (await stores.administrator.query('SELECT * FROM session WHERE user_id=$1 ORDER BY id', [userId])).rows
    expect(finalSessions.length).toBe(0)
    expect(hash(finalSessions)).toBe(unchangedSessions)
    expect(logs.leaked.length).toBe(0)
  } finally {
    observed.lateBegin = false; observed.lateComplete = false; observed.proofCreateFailure = false
    logs?.restore()
    for (const [name, close] of [['app', () => app?.close()], ['limiter', () => limiter?.close()], ['pool', () => pool?.end()],
      ['peer', () => peer?.close()], ['stores', () => ownedStores?.cleanup()]] as const) await settleOwnedClose(name, close, cleanupFailures)
    try {
      const target = await realpath(markerDirectory), parent = await realpath(tmpdir())
      if (dirname(target) !== parent || !basename(target).startsWith('r1-headless-marker-')) throw new Error('Marker ownership mismatch')
      await settleOwnedClose('marker', () => rm(target, { recursive: true }), cleanupFailures)
    } catch { cleanupFailures.push('marker') }
    assertOwnedCleanup(cleanupFailures)
  }
}, 300000)

test('R1 ordinary callback refuses an expired recovery attempt before native state lookup', async () => {
  const markerDirectory = await mkdtemp(join(tmpdir(), 'r1-headless-marker-'))
  let ownedStores: Awaited<ReturnType<typeof startDisposableStores>> | undefined
  let peer: Awaited<ReturnType<typeof startGoogleProtocolPeer>> | undefined
  let pool: Pool | undefined, limiter: ReturnType<typeof createAuthRateLimiter> | undefined
  let app: ReturnType<typeof createApplicationAuth> | undefined
  const cleanupFailures: string[] = []
  try {
    await mkdir(join(markerDirectory, 'server'))
    await writeFile(join(markerDirectory, 'server/index.mjs'), '// R1 headless fixture marker; not a built application.\n', { flag: 'wx' })
    const stores = await startDisposableStores(markerDirectory)
    ownedStores = stores
    await stores.migrate()
    await stores.administrator.query(`GRANT USAGE ON SCHEMA public TO runtime;
      GRANT SELECT,INSERT,UPDATE,DELETE ON public."user",public.account,public.session,public.verification TO runtime`)
    const userId = randomUUID(), batchId = randomUUID(), codeId = randomUUID(), accountId = randomUUID(), subject = randomUUID()
    const email = `r1-ordinary-${userId}@example.test`, code = 'rc1_' + randomBytes(20).toString('base64url')
    const digest = createHash('sha256').update('recovery-code-v1\0' + code).digest('hex')
    await stores.administrator.query('INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$2,$3,true)', [userId, 'R1 ordinary fixture', email])
    await stores.administrator.query('INSERT INTO account(id,user_id,provider_id,account_id) VALUES($1,$2,$3,$4)', [accountId, userId, 'google', subject])
    await stores.administrator.query('INSERT INTO recovery_code_batch(user_id,batch_id,format_version,recovery_generation,issued_at) VALUES($1,$2,1,0,clock_timestamp())', [userId, batchId])
    await stores.administrator.query('INSERT INTO recovery_code(id,user_id,batch_id,digest) VALUES($1,$2,$3,$4)', [codeId, userId, batchId, digest])
    peer = await startGoogleProtocolPeer({ ports: [stores.runtimeUrl, stores.directRuntimeUrl, stores.redisUrl].map(value => Number(new URL(value).port)) })
    pool = new Pool({ connectionString: stores.runtimeUrl, max: 2 })
    const owner = createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
    limiter = createAuthRateLimiter(readRateLimitConfig({ NODE_ENV: 'test', REDIS_URL: stores.redisUrl, RATE_LIMIT_HMAC_SECRET: stores.hmac,
      RATE_LIMIT_KEY_ID: 'r1-ordinary-state', TRUSTED_PROXY_IPS: '127.0.0.1' }))
    await limiter.connect()
    app = createApplicationAuth(owner, readAuthConfig({ APP_ORIGIN: origin, AUTH_SECRET: randomBytes(48).toString('hex'),
      GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fixture-only' })!, limiter)
    const begun = await bounded(app.beginRecoveryGoogleProof(request(), { email, code }), 16000)
    const state = new URL(begun.url).searchParams.get('state')
    if (!state) throw new Error('Missing native state')
    const providerCode = peer.register(begun.url, subject, { email })
    await stores.administrator.query(`UPDATE recovery_attempt SET created_at=clock_timestamp()-interval '5 minutes',
      expires_at=clock_timestamp()-interval '1 minute' WHERE oauth_state=$1`, [state])
    const expired = (await stores.administrator.query('SELECT phase,expires_at FROM recovery_attempt WHERE oauth_state=$1', [state])).rows
    expect(expired.length).toBe(1)
    expect(new Date(expired[0].expires_at).getTime() < Date.now()).toBe(true)
    const nativeState = (await stores.administrator.query('SELECT expires_at FROM verification WHERE identifier=$1', [state])).rows
    expect(nativeState.length).toBe(1)
    expect(new Date(nativeState[0].expires_at).getTime() > Date.now()).toBe(true)
    await stores.administrator.query(`INSERT INTO verification(id,identifier,value,expires_at)
      VALUES($1,'r1-expired-native-canary','canary',clock_timestamp()-interval '1 minute')`, [randomUUID()])
    const before = hash((await stores.administrator.query('SELECT * FROM verification ORDER BY identifier,id')).rows)
    observed.nativeVerificationLookups = 0; observed.nativeVerificationSweeps = 0; observed.observeOrdinary = true
    const ordinary = await bounded(app.callback(request(cookies(begun.headers),
      '/api/auth/callback/google?state=' + state + '&code=' + providerCode, 'GET')), 16000)
    observed.observeOrdinary = false
    expect(ordinary.status).toBe(401)
    expect(ordinary.headers.getSetCookie().length).toBe(0)
    expect(observed.nativeVerificationLookups).toBe(0)
    expect(observed.nativeVerificationSweeps).toBe(0)
    expect(peer.evidence().posts).toBe(0)
    expect(hash((await stores.administrator.query('SELECT * FROM verification ORDER BY identifier,id')).rows)).toBe(before)
    expect((await stores.administrator.query('SELECT phase FROM recovery_attempt WHERE oauth_state=$1', [state])).rows[0].phase).toBe('PENDING_GOOGLE')
    const normal = await bounded(app.beginGoogleSignIn(request()), 16000)
    const normalState = new URL(normal.url).searchParams.get('state')
    if (!normalState) throw new Error('Missing ordinary state')
    const normalCode = peer.register(normal.url, subject, { email })
    const positive = await bounded(app.callback(request(cookies(normal.headers),
      '/api/auth/callback/google?state=' + normalState + '&code=' + normalCode, 'GET')), 16000)
    expect(positive.status).toBe(302)
    expect((await bounded(app.requirePrincipal(request(cookies(positive.headers))), 16000)).userId).toBe(userId)
    expect(peer.evidence().posts).toBe(1)
  } finally {
    observed.observeOrdinary = false
    for (const [name, close] of [['app', () => app?.close()], ['limiter', () => limiter?.close()], ['pool', () => pool?.end()],
      ['peer', () => peer?.close()], ['stores', () => ownedStores?.cleanup()]] as const) {
      await settleOwnedClose(name, close, cleanupFailures)
    }
    try {
      const target = await realpath(markerDirectory), parent = await realpath(tmpdir())
      if (dirname(target) !== parent || !basename(target).startsWith('r1-headless-marker-')) throw new Error('Marker ownership mismatch')
      await settleOwnedClose('marker', () => rm(target, { recursive: true }), cleanupFailures)
    } catch { cleanupFailures.push('marker') }
    assertOwnedCleanup(cleanupFailures)
  }
}, 300000)

test('R1 rotation outer native endpoint enters before hooks outside checkout', async () => {
  const markerDirectory = await mkdtemp(join(tmpdir(), 'r1-headless-marker-'))
  let ownedStores: Awaited<ReturnType<typeof startDisposableStores>> | undefined
  let pool: Pool | undefined, limiter: ReturnType<typeof createAuthRateLimiter> | undefined
  let app: ReturnType<typeof createApplicationAuth> | undefined
  const cleanupFailures: string[] = []
  try {
    await mkdir(join(markerDirectory, 'server'))
    await writeFile(join(markerDirectory, 'server/index.mjs'), '// R1 headless fixture marker; not a built application.\n', { flag: 'wx' })
    const stores = await startDisposableStores(markerDirectory)
    ownedStores = stores
    await stores.migrate()
    await stores.administrator.query(`GRANT USAGE ON SCHEMA public TO runtime;
      GRANT SELECT,INSERT,UPDATE,DELETE ON public."user",public.account,public.session,public.verification TO runtime;
      GRANT SELECT,INSERT ON public.passkey TO runtime; GRANT UPDATE(counter) ON public.passkey TO runtime;
      GRANT SELECT,INSERT,UPDATE ON public.auth_email_request TO runtime; GRANT SELECT,INSERT ON public.auth_email_command TO runtime;
      GRANT SELECT ON public.email_delivery,public.auth_email_outbox TO runtime;
      GRANT INSERT(id,command_id,state,verifier_hash,key_id,ciphertext,nonce,tag,snapshot_format,snapshot_hash,replay_window_seconds)
        ON public.email_delivery TO runtime;
      GRANT UPDATE(state,verifier_hash,ciphertext,nonce,tag) ON public.email_delivery TO runtime;
      GRANT INSERT(id,delivery_id) ON public.auth_email_outbox TO runtime`)
    pool = new Pool({ connectionString: stores.runtimeUrl, max: 2 })
    const owner = createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
    limiter = createAuthRateLimiter(readRateLimitConfig({ NODE_ENV: 'test', REDIS_URL: stores.redisUrl, RATE_LIMIT_HMAC_SECRET: stores.hmac,
      RATE_LIMIT_KEY_ID: 'r1-outer-rotation', TRUSTED_PROXY_IPS: '127.0.0.1' }))
    await limiter.connect()
    app = createApplicationAuth(owner, { ...readAuthConfig({ APP_ORIGIN: origin, AUTH_SECRET: randomBytes(48).toString('hex') })!,
      magic: { envelope: createAuthEmailEnvelope({ currentKeyId: 'fixture', keys: { fixture: randomBytes(32) } }), profile } }, limiter)
    const email = `r1-outer-${randomUUID()}@example.test`
    await bounded(app.requestMagicLink(request(), { email, locale: 'en' }), 16000)
    const enrollment = { token: observed.enrollmentToken, intendedEmail: email }
    const options = await bounded(magicConsumeResponse(request(), enrollment, app, limiter), 16000)
    expect(options.status).toBe(200)
    const body = await options.json(), credential = registrationCredentialFixture(body.options, origin)
    const enrolled = await bounded(magicEnrollmentResponse(request(cookies(options.headers)),
      { ...enrollment, response: credential.response }, app, limiter), 16000)
    expect(enrolled.status).toBe(200)
    observed.rotationOuterEntries = 0; observed.rotationOuterOutside = false; observed.observeRotationOuter = true
    const rotation = await bounded(app.beginRecoveryCodeRotation(request(cookies(enrolled.headers))), 16000)
    observed.observeRotationOuter = false
    expect(Boolean(rotation.challengeId)).toBe(true)
    expect(observed.rotationOuterEntries).toBe(1)
    expect(observed.rotationOuterOutside).toBe(true)
  } finally {
    observed.observeRotationOuter = false
    for (const [name, close] of [['app', () => app?.close()], ['limiter', () => limiter?.close()], ['pool', () => pool?.end()],
      ['stores', () => ownedStores?.cleanup()]] as const) await settleOwnedClose(name, close, cleanupFailures)
    try {
      const target = await realpath(markerDirectory), parent = await realpath(tmpdir())
      if (dirname(target) !== parent || !basename(target).startsWith('r1-headless-marker-')) throw new Error('Marker ownership mismatch')
      await settleOwnedClose('marker', () => rm(target, { recursive: true }), cleanupFailures)
    } catch { cleanupFailures.push('marker') }
    assertOwnedCleanup(cleanupFailures)
  }
}, 300000)

test('R1 committed code rotation with late native hook failure withholds codes', async () => {
  const markerDirectory = await mkdtemp(join(tmpdir(), 'r1-headless-marker-'))
  let ownedStores: Awaited<ReturnType<typeof startDisposableStores>> | undefined
  let pool: Pool | undefined, limiter: ReturnType<typeof createAuthRateLimiter> | undefined
  let app: ReturnType<typeof createApplicationAuth> | undefined
  let logs: ReturnType<typeof captureSecretLogs> | undefined
  const cleanupFailures: string[] = []
  try {
    await mkdir(join(markerDirectory, 'server'))
    await writeFile(join(markerDirectory, 'server/index.mjs'), '// R1 headless fixture marker; not a built application.\n', { flag: 'wx' })
    const stores = await startDisposableStores(markerDirectory)
    ownedStores = stores
    await stores.migrate()
    await stores.administrator.query(`GRANT USAGE ON SCHEMA public TO runtime;
      GRANT SELECT,INSERT,UPDATE,DELETE ON public."user",public.account,public.session,public.verification TO runtime;
      GRANT SELECT,INSERT ON public.passkey TO runtime; GRANT UPDATE(counter) ON public.passkey TO runtime;
      GRANT SELECT,INSERT,UPDATE ON public.auth_email_request TO runtime; GRANT SELECT,INSERT ON public.auth_email_command TO runtime;
      GRANT SELECT ON public.email_delivery,public.auth_email_outbox TO runtime;
      GRANT INSERT(id,command_id,state,verifier_hash,key_id,ciphertext,nonce,tag,snapshot_format,snapshot_hash,replay_window_seconds)
        ON public.email_delivery TO runtime;
      GRANT UPDATE(state,verifier_hash,ciphertext,nonce,tag) ON public.email_delivery TO runtime;
      GRANT INSERT(id,delivery_id) ON public.auth_email_outbox TO runtime`)
    pool = new Pool({ connectionString: stores.runtimeUrl, max: 2 })
    const owner = createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
    limiter = createAuthRateLimiter(readRateLimitConfig({ NODE_ENV: 'test', REDIS_URL: stores.redisUrl, RATE_LIMIT_HMAC_SECRET: stores.hmac,
      RATE_LIMIT_KEY_ID: 'r1-a4-rotation', TRUSTED_PROXY_IPS: '127.0.0.1' }))
    await limiter.connect()
    app = createApplicationAuth(owner, { ...readAuthConfig({ APP_ORIGIN: origin, AUTH_SECRET: randomBytes(48).toString('hex') })!,
      magic: { envelope: createAuthEmailEnvelope({ currentKeyId: 'fixture', keys: { fixture: randomBytes(32) } }), profile } }, limiter)
    const email = 'r1-a4-rotation-' + randomUUID() + '@example.test'
    await bounded(app.requestMagicLink(request(), { email, locale: 'en' }), 16000)
    const enrollment = { token: observed.enrollmentToken, intendedEmail: email }
    const options = await bounded(magicConsumeResponse(request(), enrollment, app, limiter), 16000)
    expect(options.status).toBe(200)
    const body = await options.json(), credential = registrationCredentialFixture(body.options, origin)
    const enrolled = await bounded(magicEnrollmentResponse(request(cookies(options.headers)),
      { ...enrollment, response: credential.response }, app, limiter), 16000)
    expect(enrolled.status).toBe(200)
    const cookie = cookies(enrolled.headers), principal = await bounded(app.requirePrincipal(request(cookie)), 16000)
    const rotation = await bounded(app.beginRecoveryCodeRotation(request(cookie)), 16000)
    const userBefore = hash((await stores.administrator.query('SELECT * FROM "user" WHERE id=$1', [principal.userId])).rows)
    const sessionBefore = hash((await stores.administrator.query('SELECT * FROM session WHERE id=$1', [principal.sessionId])).rows)
    const keyBefore = (await stores.administrator.query('SELECT id,counter FROM passkey WHERE user_id=$1', [principal.userId])).rows
    expect(keyBefore.length).toBe(1)
    logs = captureSecretLogs()
    console.debug({ nested: { error: new Error(sentinel) } })
    expect(logs.leaked).toEqual(['debug'])
    logs.leaked.length = 0
    observed.lateRotation = true; observed.lateRotationReached = 0
    await fixedFailure(bounded(app.finishRecoveryCodeRotation(request(cookie), {
      challengeId: rotation.challengeId, response: credential.authenticationResponse(rotation.options, { counter: 1 }),
    }), 16000), 'Authentication outcome unconfirmed')
    observed.lateRotation = false
    expect(observed.lateRotationReached).toBe(1)
    const batch = (await stores.administrator.query('SELECT batch_id FROM recovery_code_batch WHERE user_id=$1', [principal.userId])).rows
    const codes = (await stores.administrator.query('SELECT digest,spent_at,batch_id FROM recovery_code WHERE user_id=$1', [principal.userId])).rows
    const facts = (await stores.administrator.query('SELECT challenge_id,code_count,prior_batch_id,new_batch_id FROM recovery_code_rotation_fact WHERE actor_user_id=$1', [principal.userId])).rows
    expect(batch.length).toBe(1); expect(codes.length).toBe(8); expect(facts.length).toBe(1)
    expect(codes.every(row => row.batch_id === batch[0].batch_id && row.spent_at === null && /^[0-9a-f]{64}$/.test(row.digest))).toBe(true)
    expect(facts[0].challenge_id === rotation.challengeId && facts[0].code_count === 8
      && facts[0].prior_batch_id === null && facts[0].new_batch_id === batch[0].batch_id).toBe(true)
    expect((await stores.administrator.query('SELECT count(*)::int n FROM verification WHERE identifier LIKE $1', ['%:' + rotation.challengeId])).rows[0].n).toBe(0)
    expect((await stores.administrator.query('SELECT counter FROM passkey WHERE id=$1', [keyBefore[0].id])).rows[0].counter).toBe(1)
    expect(hash((await stores.administrator.query('SELECT * FROM "user" WHERE id=$1', [principal.userId])).rows)).toBe(userBefore)
    expect(hash((await stores.administrator.query('SELECT * FROM session WHERE id=$1', [principal.sessionId])).rows)).toBe(sessionBefore)
    expect(logs.leaked.length).toBe(0)
  } finally {
    observed.lateRotation = false
    logs?.restore()
    for (const [name, close] of [['app', () => app?.close()], ['limiter', () => limiter?.close()], ['pool', () => pool?.end()],
      ['stores', () => ownedStores?.cleanup()]] as const) await settleOwnedClose(name, close, cleanupFailures)
    try {
      const target = await realpath(markerDirectory), parent = await realpath(tmpdir())
      if (dirname(target) !== parent || !basename(target).startsWith('r1-headless-marker-')) throw new Error('Marker ownership mismatch')
      await settleOwnedClose('marker', () => rm(target, { recursive: true }), cleanupFailures)
    } catch { cleanupFailures.push('marker') }
    assertOwnedCleanup(cleanupFailures)
  }
}, 300000)

test('R1 rotation races, hold, fixed deadline and expired native session stay bound', async () => {
  const markerDirectory = await mkdtemp(join(tmpdir(), 'r1-headless-marker-'))
  let ownedStores: Awaited<ReturnType<typeof startDisposableStores>> | undefined
  let pool: Pool | undefined, limiter: ReturnType<typeof createAuthRateLimiter> | undefined
  let app: ReturnType<typeof createApplicationAuth> | undefined
  let releaseHeld = () => {}
  const cleanupFailures: string[] = []
  try {
    await mkdir(join(markerDirectory, 'server'))
    await writeFile(join(markerDirectory, 'server/index.mjs'), '// R1 headless fixture marker; not a built application.\n', { flag: 'wx' })
    const stores = await startDisposableStores(markerDirectory)
    ownedStores = stores
    await stores.migrate()
    await stores.administrator.query(`GRANT USAGE ON SCHEMA public TO runtime;
      GRANT SELECT,INSERT,UPDATE,DELETE ON public."user",public.account,public.session,public.verification TO runtime;
      GRANT SELECT,INSERT ON public.passkey TO runtime; GRANT UPDATE(counter) ON public.passkey TO runtime;
      GRANT SELECT,INSERT,UPDATE ON public.auth_email_request TO runtime; GRANT SELECT,INSERT ON public.auth_email_command TO runtime;
      GRANT SELECT ON public.email_delivery,public.auth_email_outbox TO runtime;
      GRANT INSERT(id,command_id,state,verifier_hash,key_id,ciphertext,nonce,tag,snapshot_format,snapshot_hash,replay_window_seconds)
        ON public.email_delivery TO runtime;
      GRANT UPDATE(state,verifier_hash,ciphertext,nonce,tag) ON public.email_delivery TO runtime;
      GRANT INSERT(id,delivery_id) ON public.auth_email_outbox TO runtime`)
    pool = new Pool({ connectionString: stores.runtimeUrl, max: 5 })
    const owner = createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
    limiter = createAuthRateLimiter(readRateLimitConfig({ NODE_ENV: 'test', REDIS_URL: stores.redisUrl, RATE_LIMIT_HMAC_SECRET: stores.hmac,
      RATE_LIMIT_KEY_ID: 'r1-rotation-matrix', TRUSTED_PROXY_IPS: '127.0.0.1' }))
    await limiter.connect()
    app = createApplicationAuth(owner, { ...readAuthConfig({ APP_ORIGIN: origin, AUTH_SECRET: randomBytes(48).toString('hex') })!,
      magic: { envelope: createAuthEmailEnvelope({ currentKeyId: 'fixture', keys: { fixture: randomBytes(32) } }), profile } }, limiter)
    const email = 'r1-rotation-matrix-' + randomUUID() + '@example.test'
    await bounded(app.requestMagicLink(request(), { email, locale: 'en' }), 16000)
    const enrollment = { token: observed.enrollmentToken, intendedEmail: email }
    const options = await bounded(magicConsumeResponse(request(), enrollment, app, limiter), 16000)
    expect(options.status).toBe(200)
    const body = await options.json(), credential = registrationCredentialFixture(body.options, origin)
    const enrolled = await bounded(magicEnrollmentResponse(request(cookies(options.headers)),
      { ...enrollment, response: credential.response }, app, limiter), 16000)
    expect(enrolled.status).toBe(200)
    const cookie = cookies(enrolled.headers), principal = await bounded(app.requirePrincipal(request(cookie)), 16000)
    const userId = principal.userId, sessionId = principal.sessionId
    const initialUser = hash((await stores.administrator.query('SELECT * FROM "user" WHERE id=$1', [userId])).rows)
    const initialSession = hash((await stores.administrator.query('SELECT * FROM session WHERE id=$1', [sessionId])).rows)
    const initialAccounts = hash((await stores.administrator.query('SELECT * FROM account WHERE user_id=$1', [userId])).rows)
    const keyRows = (await stores.administrator.query('SELECT id,counter FROM passkey WHERE user_id=$1', [userId])).rows
    expect(keyRows.length).toBe(1); expect(keyRows[0].counter).toBe(0)
    const challengeCount = async (challengeId: string) => (await stores.administrator.query('SELECT count(*)::int n FROM verification WHERE identifier LIKE $1',
      ['application-recovery-rotation-v1:%:' + challengeId])).rows[0].n as number
    const inventory = async () => ({
      batch: (await stores.administrator.query('SELECT batch_id FROM recovery_code_batch WHERE user_id=$1', [userId])).rows,
      codes: (await stores.administrator.query('SELECT id,batch_id,digest,spent_at FROM recovery_code WHERE user_id=$1 ORDER BY id', [userId])).rows,
      facts: (await stores.administrator.query('SELECT challenge_id,prior_batch_id,new_batch_id,code_count FROM recovery_code_rotation_fact WHERE actor_user_id=$1 ORDER BY occurred_at,id', [userId])).rows,
      counter: (await stores.administrator.query('SELECT counter FROM passkey WHERE id=$1', [keyRows[0].id])).rows[0].counter as number,
    })
    const challengeInventory = async () => hash((await stores.administrator.query(
      "SELECT * FROM verification WHERE identifier LIKE 'application-recovery-rotation-v1:%' ORDER BY identifier,id")).rows)
    async function race(priorBatchId: string | null, previousFacts: number) {
      const [a, b] = await Promise.all([bounded(app!.beginRecoveryCodeRotation(request(cookie)), 16000),
        bounded(app!.beginRecoveryCodeRotation(request(cookie)), 16000)])
      expect(await challengeCount(a.challengeId)).toBe(1)
      expect(await challengeCount(b.challengeId)).toBe(1)
      const physical = (await stores.administrator.query('SELECT identifier,value FROM verification WHERE identifier LIKE $1 OR identifier LIKE $2',
        ['%:' + a.challengeId, '%:' + b.challengeId])).rows
      expect(physical.length).toBe(2)
      expect(physical.every(row => JSON.parse(row.value).currentBatchId === priorBatchId)).toBe(true)
      const result = await Promise.allSettled([
        bounded(app!.finishRecoveryCodeRotation(request(cookie), { challengeId: a.challengeId,
          response: credential.authenticationResponse(a.options, { counter: 0 }) }), 16000),
        bounded(app!.finishRecoveryCodeRotation(request(cookie), { challengeId: b.challengeId,
          response: credential.authenticationResponse(b.options, { counter: 0 }) }), 16000),
      ])
      const winners = result.flatMap((value, index) => value.status === 'fulfilled' ? [{ index, codes: value.value.codes }] : [])
      const losers = result.flatMap((value, index) => value.status === 'rejected' ? [{ index, reason: value.reason }] : [])
      expect(winners.length).toBe(1); expect(losers.length).toBe(1)
      expect(winners[0].codes.length).toBe(8)
      expect(new Set(winners[0].codes).size).toBe(8)
      expect(losers[0].reason instanceof Error).toBe(true)
      if (!(losers[0].reason instanceof Error)) throw new Error('Expected bounded rotation refusal')
      expect(losers[0].reason.message).toBe('Authentication rejected')
      const winnerId = winners[0].index === 0 ? a.challengeId : b.challengeId
      const loserId = losers[0].index === 0 ? a.challengeId : b.challengeId
      expect(await challengeCount(winnerId)).toBe(0)
      expect(await challengeCount(loserId)).toBe(1)
      const after = await inventory()
      expect(after.batch.length).toBe(1)
      expect(after.codes.length).toBe(8)
      expect(after.codes.every(row => row.batch_id === after.batch[0].batch_id && row.spent_at === null && /^[0-9a-f]{64}$/.test(row.digest))).toBe(true)
      expect(after.facts.length).toBe(previousFacts + 1)
      const fact = after.facts.find(row => row.challenge_id === winnerId)
      expect(Boolean(fact)).toBe(true)
      expect(fact.prior_batch_id === priorBatchId && fact.new_batch_id === after.batch[0].batch_id && fact.code_count === 8).toBe(true)
      expect(after.counter).toBe(0)
      return { batchId: String(after.batch[0].batch_id), loserId, codes: after.codes.map(row => String(row.digest)) }
    }

    const first = await race(null, 0)
    const second = await race(first.batchId, 1)
    expect(second.batchId === first.batchId).toBe(false)
    expect(second.codes.every(digest => !first.codes.includes(digest))).toBe(true)
    expect(await challengeCount(first.loserId)).toBe(1)
    expect(hash((await stores.administrator.query('SELECT * FROM "user" WHERE id=$1', [userId])).rows)).toBe(initialUser)
    expect(hash((await stores.administrator.query('SELECT * FROM session WHERE id=$1', [sessionId])).rows)).toBe(initialSession)
    expect(hash((await stores.administrator.query('SELECT * FROM account WHERE user_id=$1', [userId])).rows)).toBe(initialAccounts)

    const heldChallenge = await bounded(app.beginRecoveryCodeRotation(request(cookie)), 16000)
    await stores.administrator.query("UPDATE \"user\" SET hold_until=clock_timestamp()+interval '1 day' WHERE id=$1", [userId])
    const heldUser = hash((await stores.administrator.query('SELECT * FROM "user" WHERE id=$1', [userId])).rows)
    const heldVerification = await challengeInventory(), heldState = await inventory()
    const beginDuringHold = await bounded(app.beginRecoveryCodeRotation(request(cookie)).then(() => false, () => true), 16000)
    const finishDuringHold = await bounded(app.finishRecoveryCodeRotation(request(cookie), { challengeId: heldChallenge.challengeId,
      response: credential.authenticationResponse(heldChallenge.options, { counter: 0 }) }).then(() => false, () => true), 16000)
    expect(beginDuringHold).toBe(true); expect(finishDuringHold).toBe(true)
    expect(await challengeCount(heldChallenge.challengeId)).toBe(1)
    expect(await challengeInventory()).toBe(heldVerification)
    expect(hash(await inventory())).toBe(hash(heldState))
    expect(hash((await stores.administrator.query('SELECT * FROM "user" WHERE id=$1', [userId])).rows)).toBe(heldUser)
    expect(hash((await stores.administrator.query('SELECT * FROM session WHERE id=$1', [sessionId])).rows)).toBe(initialSession)
    await stores.administrator.query('UPDATE "user" SET hold_until=null WHERE id=$1', [userId])
    const clearedUser = hash((await stores.administrator.query('SELECT * FROM "user" WHERE id=$1', [userId])).rows)
    const released = await bounded(app.finishRecoveryCodeRotation(request(cookie), { challengeId: heldChallenge.challengeId,
      response: credential.authenticationResponse(heldChallenge.options, { counter: 0 }) }), 16000)
    expect(released.codes.length).toBe(8)
    expect(await challengeCount(heldChallenge.challengeId)).toBe(0)
    expect((await inventory()).facts.length).toBe(3)

    await stores.administrator.query("UPDATE session SET last_activity_at=clock_timestamp()-interval '11 hours 59 minutes 54 seconds' WHERE id=$1", [sessionId])
    const beforeWait = hash(await inventory()), beforeWaitProofs = await challengeInventory()
    const beforeWaitSession = hash((await stores.administrator.query('SELECT * FROM session WHERE id=$1', [sessionId])).rows)
    const beforeWaitUser = hash((await stores.administrator.query('SELECT * FROM "user" WHERE id=$1', [userId])).rows)
    const beforeWaitAccounts = hash((await stores.administrator.query('SELECT * FROM account WHERE user_id=$1', [userId])).rows)
    let enter = () => {}, release = () => {}
    const entered = new Promise<void>(resolve => { enter = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    releaseHeld = release
    observed.rotationCreateEntered = enter; observed.rotationCreateGate = gate
    observed.rotationCreatedExpiresAtMs = 0; observed.rotationCreateReached = 0; observed.holdRotationCreate = true
    const heldStartMs = Date.now()
    const delayed = app.beginRecoveryCodeRotation(request(cookie)).then(() => ({ accepted: true as const }),
      (error: unknown) => ({ accepted: false as const, error }))
    let gateValid = true
    try {
      await bounded(entered, 6000)
      expect(observed.rotationCreateReached).toBe(1)
      const waitMs = Math.max(0, observed.rotationCreatedExpiresAtMs - Date.now() + 100)
      expect(waitMs > 0 && waitMs < 12000).toBe(true)
      await bounded(new Promise(resolve => setTimeout(resolve, waitMs)), 12000)
      expect(Date.now() >= observed.rotationCreatedExpiresAtMs).toBe(true)
      expect(Date.now() - heldStartMs < 12000).toBe(true)
    } catch { gateValid = false }
    finally { release(); observed.holdRotationCreate = false }
    const delayedOutcome = await bounded(delayed, 16000)
    expect(gateValid).toBe(true)
    expect(delayedOutcome.accepted).toBe(false)
    if (delayedOutcome.accepted) throw new Error('Expired native challenge was accepted')
    expect(delayedOutcome.error instanceof Error).toBe(true)
    if (!(delayedOutcome.error instanceof Error)) throw new Error('Expected domain refusal')
    expect(delayedOutcome.error.message).toBe('Authentication rejected')
    expect(hash(await inventory())).toBe(beforeWait)
    expect(await challengeInventory()).toBe(beforeWaitProofs)
    expect(hash((await stores.administrator.query('SELECT * FROM session WHERE id=$1', [sessionId])).rows)).toBe(beforeWaitSession)
    expect(hash((await stores.administrator.query('SELECT * FROM "user" WHERE id=$1', [userId])).rows)).toBe(beforeWaitUser)
    expect(hash((await stores.administrator.query('SELECT * FROM account WHERE user_id=$1', [userId])).rows)).toBe(beforeWaitAccounts)

    await stores.administrator.query("UPDATE session SET last_activity_at=clock_timestamp()-interval '11 hours 59 minutes 51 seconds' WHERE id=$1", [sessionId])
    const capped = await bounded(app.beginRecoveryCodeRotation(request(cookie)), 16000)
    const priorActivity = (await stores.administrator.query('SELECT last_activity_at FROM session WHERE id=$1', [sessionId])).rows[0].last_activity_at
    expect(await challengeCount(capped.challengeId)).toBe(1)
    expect(Date.parse(capped.expiresAt) > Date.now() && Date.parse(capped.expiresAt) - Date.now() < 10000).toBe(true)
    expect((await bounded(app.requirePrincipal(request(cookie)), 16000)).userId).toBe(userId)
    const freshActivity = (await stores.administrator.query('SELECT last_activity_at FROM session WHERE id=$1', [sessionId])).rows[0].last_activity_at
    expect(new Date(freshActivity).getTime() > new Date(priorActivity).getTime()).toBe(true)
    const afterActivitySession = hash((await stores.administrator.query('SELECT * FROM session WHERE id=$1', [sessionId])).rows)
    const afterActivityAuthority = hash(await inventory())
    const untilCap = Math.max(0, Date.parse(capped.expiresAt) - Date.now() + 100)
    await bounded(new Promise(resolve => setTimeout(resolve, untilCap)), 12000)
    const cappedAccepted = await bounded(app.finishRecoveryCodeRotation(request(cookie), { challengeId: capped.challengeId,
      response: credential.authenticationResponse(capped.options, { counter: 0 }) }).then(() => true, () => false), 16000)
    expect(cappedAccepted).toBe(false)
    expect(await challengeCount(capped.challengeId)).toBe(1)
    expect(hash(await inventory())).toBe(afterActivityAuthority)
    expect(hash((await stores.administrator.query('SELECT * FROM session WHERE id=$1', [sessionId])).rows)).toBe(afterActivitySession)

    await stores.administrator.query("UPDATE session SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [sessionId])
    const expiredSession = hash((await stores.administrator.query('SELECT * FROM session WHERE id=$1', [sessionId])).rows)
    const expiredAuthority = hash(await inventory()), expiredChallenges = await challengeInventory()
    const expiredAccepted = await bounded(app.beginRecoveryCodeRotation(request(cookie)).then(() => true, () => false), 16000)
    expect(expiredAccepted).toBe(false)
    expect(hash((await stores.administrator.query('SELECT * FROM session WHERE id=$1', [sessionId])).rows)).toBe(expiredSession)
    expect(hash(await inventory())).toBe(expiredAuthority)
    expect(await challengeInventory()).toBe(expiredChallenges)
    expect(hash((await stores.administrator.query('SELECT * FROM "user" WHERE id=$1', [userId])).rows)).toBe(clearedUser)
    expect(hash((await stores.administrator.query('SELECT * FROM account WHERE user_id=$1', [userId])).rows)).toBe(initialAccounts)
  } finally {
    releaseHeld(); observed.holdRotationCreate = false
    observed.rotationCreateEntered = () => {}; observed.rotationCreateGate = Promise.resolve()
    for (const [name, close] of [['app', () => app?.close()], ['limiter', () => limiter?.close()], ['pool', () => pool?.end()],
      ['stores', () => ownedStores?.cleanup()]] as const) await settleOwnedClose(name, close, cleanupFailures)
    try {
      const target = await realpath(markerDirectory), parent = await realpath(tmpdir())
      if (dirname(target) !== parent || !basename(target).startsWith('r1-headless-marker-')) throw new Error('Marker ownership mismatch')
      await settleOwnedClose('marker', () => rm(target, { recursive: true }), cleanupFailures)
    } catch { cleanupFailures.push('marker') }
    assertOwnedCleanup(cleanupFailures)
  }
}, 300000)

test('R1 native precommit state-cookie fault rolls back state and attempt', async () => {
  const markerDirectory = await mkdtemp(join(tmpdir(), 'r1-headless-marker-'))
  let ownedStores: Awaited<ReturnType<typeof startDisposableStores>> | undefined
  let pool: Pool | undefined, limiter: ReturnType<typeof createAuthRateLimiter> | undefined
  let app: ReturnType<typeof createApplicationAuth> | undefined
  const cleanupFailures: string[] = []
  try {
    await mkdir(join(markerDirectory, 'server'))
    await writeFile(join(markerDirectory, 'server/index.mjs'), '// R1 headless fixture marker; not a built application.\n', { flag: 'wx' })
    const stores = await startDisposableStores(markerDirectory)
    ownedStores = stores
    await stores.migrate()
    await stores.administrator.query(`GRANT USAGE ON SCHEMA public TO runtime;
      GRANT SELECT,INSERT,UPDATE,DELETE ON public."user",public.account,public.session,public.verification TO runtime`)
    const userId = randomUUID(), batchId = randomUUID(), codeId = randomUUID(), accountId = randomUUID()
    const email = `r1-fault-${userId}@example.test`, code = 'rc1_' + randomBytes(20).toString('base64url')
    const digest = createHash('sha256').update('recovery-code-v1\0' + code).digest('hex')
    await stores.administrator.query('INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$2,$3,false)', [userId, 'R1 fault fixture', email])
    await stores.administrator.query('INSERT INTO account(id,user_id,provider_id,account_id) VALUES($1,$2,$3,$4)', [accountId, userId, 'google', randomUUID()])
    await stores.administrator.query('INSERT INTO recovery_code_batch(user_id,batch_id,format_version,recovery_generation,issued_at) VALUES($1,$2,1,0,clock_timestamp())', [userId, batchId])
    await stores.administrator.query('INSERT INTO recovery_code(id,user_id,batch_id,digest) VALUES($1,$2,$3,$4)', [codeId, userId, batchId, digest])
    pool = new Pool({ connectionString: stores.runtimeUrl, max: 2 })
    const owner = createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
    limiter = createAuthRateLimiter(readRateLimitConfig({ NODE_ENV: 'test', REDIS_URL: stores.redisUrl, RATE_LIMIT_HMAC_SECRET: stores.hmac,
      RATE_LIMIT_KEY_ID: 'r1-cookie-fault', TRUSTED_PROXY_IPS: '127.0.0.1' }))
    await limiter.connect()
    app = createApplicationAuth(owner, readAuthConfig({ APP_ORIGIN: origin, AUTH_SECRET: randomBytes(48).toString('hex'),
      GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fixture-only' })!, limiter)
    observed.injectHeader = true; observed.injected = 0
    const refused = await bounded(app.beginRecoveryGoogleProof(request(), { email, code }).then(() => false, () => true), 16000)
    observed.injectHeader = false
    expect(refused).toBe(true)
    expect(observed.injected).toBe(1)
    expect((await stores.administrator.query('SELECT count(*)::int n FROM recovery_attempt WHERE user_id=$1', [userId])).rows[0].n).toBe(0)
    expect((await stores.administrator.query("SELECT count(*)::int n FROM verification WHERE identifier LIKE 'application-recovery-google-v1:%' OR value LIKE '%recovery-google-proof%' ")).rows[0].n).toBe(0)
    expect((await stores.administrator.query('SELECT spent_at FROM recovery_code WHERE id=$1', [codeId])).rows[0].spent_at).toBeNull()
  } finally {
    observed.injectHeader = false
    for (const [name, close] of [['app', () => app?.close()], ['limiter', () => limiter?.close()], ['pool', () => pool?.end()],
      ['stores', () => ownedStores?.cleanup()]] as const) {
      await settleOwnedClose(name, close, cleanupFailures)
    }
    try {
      const target = await realpath(markerDirectory), parent = await realpath(tmpdir())
      if (dirname(target) !== parent || !basename(target).startsWith('r1-headless-marker-')) throw new Error('Marker ownership mismatch')
      await settleOwnedClose('marker', () => rm(target, { recursive: true }), cleanupFailures)
    } catch { cleanupFailures.push('marker') }
    assertOwnedCleanup(cleanupFailures)
  }
}, 300000)
