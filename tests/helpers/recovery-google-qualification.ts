import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { Schema } from 'effect'
import type { AuthContext } from 'better-auth'
import { APIError, addOAuthServerContext, createAuthEndpoint, createAuthMiddleware } from 'better-auth/api'
import { generateIdTokenNonce, generateState, parseState, type OAuthProvider } from 'better-auth/oauth2'
import type { AuthTransactions } from '../../src/platform/db/transactions.server'
import type { createGoogleProtocol } from '../../src/modules/auth/google-protocol.server'
import type { assertEndpointClassification } from '../../src/modules/auth/http-boundary.server'
import { account, user, verification } from '../../src/modules/auth/schema.server'

// Disposable modeled attempt relation; the test creates it only in its owned
// database. It is neither a product migration nor recovery-code authority.
export const recoveryGoogleAttempt = pgTable('qualification_recovery_google_attempt', {
  id: uuid('id').primaryKey(), userId: text('user_id').notNull(), generation: integer('generation').notNull(),
  accountId: text('account_id').notNull(), providerId: text('provider_id').notNull(),
  accountSubject: text('account_subject').notNull(), issuer: text('issuer').notNull(),
  oauthState: text('oauth_state'), expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }).notNull(),
  phase: text('phase').$type<'PENDING' | 'EXCHANGING' | 'PROVED' | 'PREPARED'>().notNull(),
}, table => [uniqueIndex('qualification_recovery_google_state_unique').on(table.oauthState).where(sql`${table.oauthState} is not null`)])

const purpose = 'qualification-recovery-google'
const issuer = 'https://accounts.google.com'
const stateMs = 300000
const paths = {
  begin: '/application/qualification/recovery/google/begin',
  callback: '/application/qualification/recovery/google/callback',
  consume: '/application/qualification/recovery/google/consume',
  activation: '/application/qualification/recovery/google/activation',
} as const
export const qualificationGooglePaths: ReadonlySet<string> = new Set(Object.values(paths))
type Action = keyof typeof paths
type Admission = Readonly<{ userId: string; generation: number; attemptId?: string }>
type Settings = Readonly<{ afterClaim?: () => Promise<void>; afterSubject?: () => Promise<void>; afterPreparedFault?: boolean }>
type Receipt = {
  begin: { attemptId: string; url: string; expiresAt: number }
  callback: { proved: true }
  consume: { prepared: true }
  activation: { eligible: true }
}
type NativeResult<A extends Action> = { response: Receipt[A]; headers: Headers }
export type RecoveryGoogleNativeCalls = { [A in Action]: (request: Request) => Promise<NativeResult<A>> }
type Protocol = ReturnType<typeof createGoogleProtocol>
type Lifetime = ReturnType<Protocol['lifetime']>
type Lease = Parameters<Parameters<AuthTransactions['withAuthPromise']>[1]>[0]
type Db = Lease['db']
type Cell = {
  readonly request: Request; readonly action: Action; readonly admission?: Admission; readonly options: ReturnType<AuthTransactions['invocationOptions']>
  readonly lifetime: Lifetime; readonly settings: Settings; active: boolean; phase: 'outer' | 'transaction'
  stage: 'entry' | 'begin-state' | 'locator' | 'claim' | 'exchange' | 'proof' | 'consume' | 'activation'
  transactionDb?: Db; transactionOptions?: ReturnType<AuthTransactions['invocationOptions']>
  provider?: OAuthProvider; proofAttemptId?: string; stagedStateCookie?: string
  nativeStateCreates: number; proofCreates: number; proofConsumes: number; parseCalls: number
}
const uuidSchema = Schema.String.check(Schema.isUUID(4))
const serverContext = Schema.Struct({ purpose: Schema.Literal(purpose), attemptId: uuidSchema })
const proofValue = Schema.Struct({ purpose: Schema.Literal(purpose), userId: Schema.NonEmptyString,
  attemptId: uuidSchema, generation: Schema.Int, accountId: Schema.NonEmptyString,
  providerId: Schema.Literal('google'), issuer: Schema.Literal(issuer), subject: Schema.NonEmptyString,
  expiresAt: Schema.Int })
const subjectSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024), Schema.isPattern(/\S/))
function refuse(): never { throw new APIError('UNAUTHORIZED', { message: 'G3 qualification refused' }) }
function requireValue(value: unknown): asserts value { if (!value) refuse() }
function sameVerification(a: typeof verification.$inferSelect, b: typeof verification.$inferSelect) {
  return a.id === b.id && a.identifier === b.identifier && a.value === b.value
    && a.expiresAt.getTime() === b.expiresAt.getTime()
    && a.createdAt.getTime() === b.createdAt.getTime()
    && a.updatedAt.getTime() === b.updatedAt.getTime()
}

export function classifyRecoveryGoogleQualification(original: typeof assertEndpointClassification,
  ...args: Parameters<typeof assertEndpointClassification>) {
  const [api, ...flags] = args
  const copy = { ...api }
  for (const [action, path] of Object.entries(paths)) {
    const key = 'qualifyRecoveryGoogle' + action[0].toUpperCase() + action.slice(1)
    const endpoint = copy[key]
    if (!endpoint || endpoint.path !== path || endpoint.options.method !== (action === 'callback' ? 'GET' : 'POST')
      || endpoint.options.metadata?.SERVER_ONLY !== true) throw new Error('G3 endpoint classification mismatch')
    delete copy[key]
  }
  original(copy, ...flags)
}

export function createRecoveryGoogleQualification(owner: AuthTransactions, origin: string, protocol: () => Protocol | undefined) {
  const key = Symbol('test-only recovery Google invocation')
  const cells = new WeakMap<Request, Cell>()
  const returnURI = origin + '/qualification/recovery/google'
  const redirectURI = origin + '/qualification/recovery/google/callback'
  let parseEntries = 0, profileMappings = 0, subjects = 0, phaseRefusals = 0
  let proofCreates = 0, proofConsumes = 0, nativeMutationAttempts = 0, nativeStateCreates = 0
  let nativeStateDeletes = 0, deadlineRefusals = 0, consumeFaultReached = 0, modeledAdmissionRefusals = 0
  const proofIdentifier = (attemptId: string) => `qualification:recovery:google:proof:${Schema.decodeUnknownSync(uuidSchema)(attemptId)}`

  function descriptor(cell: Cell, request?: Request) {
    const found = Object.getOwnPropertyDescriptor(cell.request, key)
    if (!cell.active || request !== cell.request || !found || !('value' in found) || found.value !== cell
      || found.enumerable || found.writable || !found.configurable || cells.get(cell.request) !== cell) refuse()
    if (new URL(cell.request.url).origin !== origin || cell.request.headers.get('sec-fetch-site') === 'cross-site'
      || cell.request.method !== (cell.action === 'callback' ? 'GET' : 'POST')
      || cell.action !== 'callback' && cell.request.headers.get('origin') !== origin) refuse()
  }
  function outer(cell: Cell, request: Request) {
    descriptor(cell, request)
    if (cell.phase !== 'outer' || owner.invocationOptions() !== cell.options || cell.options.signal?.aborted
      || Date.now() >= cell.options.deadlineAtMs) refuse()
    cell.lifetime.assert()
  }
  function transaction(cell: Cell, request: Request) {
    descriptor(cell, request)
    if (cell.phase !== 'transaction' || !cell.transactionDb || owner.currentDb() !== cell.transactionDb
      || owner.invocationOptions() !== cell.transactionOptions || cell.transactionOptions?.signal?.aborted
      || Date.now() >= cell.options.deadlineAtMs) refuse()
  }
  function isBound(request: Request | undefined, path: string | undefined) {
    if (!request || !path || !qualificationGooglePaths.has(path)) return false
    const cell = cells.get(request)
    if (!cell || paths[cell.action] !== path) return false
    outer(cell, request)
    return true
  }
  async function inTransaction<A>(cell: Cell, work: (db: Db) => Promise<A>): Promise<A> {
    outer(cell, cell.request)
    const result = await owner.withAuthPromise(cell.options, async lease => {
      cell.phase = 'transaction'; cell.transactionDb = lease.db; cell.transactionOptions = owner.invocationOptions()
      try {
        transaction(cell, cell.request)
        const value = await work(lease.db)
        transaction(cell, cell.request)
        return value
      } finally {
        cell.phase = 'outer'; cell.transactionDb = undefined; cell.transactionOptions = undefined
      }
    })
    outer(cell, cell.request)
    return result
  }
  async function clock(db: Db, userId: string) {
    const [row] = await db.select({ now: sql`clock_timestamp()`.mapWith(user.createdAt) }).from(user).where(eq(user.id, userId))
    requireValue(row?.now instanceof Date && Number.isFinite(row.now.getTime()))
    return row.now
  }
  function assertDeadline(expiresAt: Date, now: Date) {
    if (expiresAt.getTime() <= now.getTime()) { deadlineRefusals++; refuse() }
  }
  async function freshDeadline(cell: Cell, db: Db, attempt: typeof recoveryGoogleAttempt.$inferSelect) {
    const now = await clock(db, attempt.userId)
    transaction(cell, cell.request)
    assertDeadline(attempt.expiresAt, now)
  }
  function stagedCookie(ctx: Parameters<typeof generateState>[0], cell: Cell, kind: 'begin' | 'claim' | 'same' | 'none') {
    transaction(cell, ctx.request!)
    const cookies = ctx.responseHeaders.getSetCookie()
    if (kind === 'none') { if (cookies.length !== 0) refuse(); return }
    const name = ctx.context.createAuthCookie('state').name
    if (cookies.length !== 1 || !cookies[0].startsWith(name + '=')) refuse()
    const expired = /;\s*Max-Age=0(?:;|$)/i.test(cookies[0])
    if (kind === 'begin' && expired || kind === 'claim' && !expired) refuse()
    if (kind === 'same') { if (cookies[0] !== cell.stagedStateCookie) refuse() }
    else if (cell.stagedStateCookie === undefined) cell.stagedStateCookie = cookies[0]
    else if (cell.stagedStateCookie !== cookies[0]) refuse()
  }
  async function locked(cell: Cell, db: Db, userId: string, attemptId: string, expectedPhase: string) {
    transaction(cell, cell.request)
    const [current] = await db.select().from(user).where(eq(user.id, userId)).for('update')
    transaction(cell, cell.request)
    if (!current) refuse()
    const [attempt] = await db.select().from(recoveryGoogleAttempt).where(eq(recoveryGoogleAttempt.id, attemptId)).for('update')
    transaction(cell, cell.request)
    if (!attempt || attempt.userId !== current.id || attempt.phase !== expectedPhase || attempt.generation !== current.recoveryGeneration
      || cell.admission && (cell.admission.userId !== current.id || cell.admission.generation !== current.recoveryGeneration
        || cell.admission.attemptId !== undefined && cell.admission.attemptId !== attempt.id)) {
      if (attempt?.phase !== expectedPhase) phaseRefusals++
      refuse()
    }
    const [link] = await db.select().from(account).where(and(eq(account.id, attempt.accountId), eq(account.userId, current.id))).for('update')
    transaction(cell, cell.request)
    if (!link || link.providerId !== 'google' || link.accountId !== attempt.accountSubject || attempt.providerId !== 'google'
      || attempt.issuer !== issuer) refuse()
    const now = await clock(db, current.id)
    transaction(cell, cell.request)
    assertDeadline(attempt.expiresAt, now)
    return { current, attempt, link, now }
  }
  function admission(cell: Cell, expected: 'begin' | 'consume' | 'activation') {
    const value = cell.admission
    if (cell.action !== expected || !value || !value.userId || !Number.isSafeInteger(value.generation)
      || expected !== 'begin' && (!value.attemptId || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.attemptId))) {
      modeledAdmissionRefusals++; refuse()
    }
    return value
  }
  function provider(ctx: Parameters<typeof generateState>[0], cell: Cell) {
    const selected = ctx.context.socialProviders.find(value => value.id === 'google')
    if (!selected || selected !== cell.provider) refuse()
    return selected
  }
  async function begin(ctx: Parameters<typeof generateState>[0], cell: Cell): Promise<Receipt['begin']> {
    outer(cell, ctx.request!)
    const target = admission(cell, 'begin')
    const google = provider(ctx, cell)
    const nonce = generateIdTokenNonce(google)
    if (!nonce) refuse()
    cell.stage = 'begin-state'
    const generated = await inTransaction(cell, async db => {
      const [current] = await db.select().from(user).where(eq(user.id, target.userId)).for('update')
      transaction(cell, ctx.request!)
      if (!current || current.recoveryGeneration !== target.generation) refuse()
      const links = await db.select().from(account).where(and(eq(account.userId, current.id), eq(account.providerId, 'google'))).limit(2).for('update')
      transaction(cell, ctx.request!)
      if (links.length !== 1 || !links[0].id || !links[0].accountId) refuse()
      const link = links[0]
      const now = await clock(db, current.id)
      const attemptId = randomUUID(), expiresAt = new Date(now.getTime() + stateMs)
      await db.insert(recoveryGoogleAttempt).values({ id: attemptId, userId: current.id, generation: current.recoveryGeneration,
        accountId: link.id, providerId: 'google', accountSubject: link.accountId, issuer, oauthState: null, expiresAt, phase: 'PENDING' })
      transaction(cell, ctx.request!)
      await addOAuthServerContext({ purpose, attemptId })
      transaction(cell, ctx.request!)
      ctx.body = { callbackURL: returnURI }
      const state = await generateState(ctx, { idTokenNonce: nonce })
      transaction(cell, ctx.request!)
      stagedCookie(ctx, cell, 'begin')
      if (cell.nativeStateCreates !== 1) refuse()
      const [saved] = await db.update(recoveryGoogleAttempt).set({ oauthState: state.state })
        .where(and(eq(recoveryGoogleAttempt.id, attemptId), eq(recoveryGoogleAttempt.phase, 'PENDING'))).returning()
      transaction(cell, ctx.request!)
      if (!saved || saved.oauthState !== state.state || saved.expiresAt.getTime() !== expiresAt.getTime()) refuse()
      await freshDeadline(cell, db, saved)
      stagedCookie(ctx, cell, 'same')
      return { attemptId, expiresAt, state }
    })
    cell.stage = 'exchange'
    outer(cell, ctx.request!)
    const url = await google.createAuthorizationURL({ state: generated.state.state, codeVerifier: generated.state.codeVerifier,
      redirectURI, idTokenNonce: nonce })
    outer(cell, ctx.request!)
    if (url.origin !== 'https://accounts.google.com' || url.searchParams.get('state') !== generated.state.state
      || url.searchParams.get('redirect_uri') !== redirectURI || url.searchParams.get('nonce') !== nonce) refuse()
    return { attemptId: generated.attemptId, url: url.toString(), expiresAt: generated.expiresAt.getTime() }
  }
  function callbackFields(cell: Cell) {
    const received = cell.request.url
    if (received.length > 8192 || !received.startsWith(redirectURI + '?')) refuse()
    const query = new URL(received).searchParams
    const states = query.getAll('state'), codes = query.getAll('code')
    if (states.length !== 1 || codes.length !== 1 || query.has('error') || !states[0] || !codes[0]
      || states[0].length > 1024 || codes[0].length > 4096) refuse()
    return { state: states[0], code: codes[0] }
  }
  async function callback(ctx: Parameters<typeof generateState>[0], cell: Cell): Promise<Receipt['callback']> {
    outer(cell, ctx.request!)
    const google = provider(ctx, cell), fields = callbackFields(cell)
    cell.stage = 'locator'
    const locator = await inTransaction(cell, async db => {
      stagedCookie(ctx, cell, 'none')
      const rows = await db.select({ id: recoveryGoogleAttempt.id, userId: recoveryGoogleAttempt.userId })
        .from(recoveryGoogleAttempt).where(eq(recoveryGoogleAttempt.oauthState, fields.state)).limit(2)
      transaction(cell, ctx.request!)
      if (rows.length !== 1) refuse()
      stagedCookie(ctx, cell, 'none')
      return rows[0]
    })
    cell.stage = 'claim'
    ctx.query = { state: fields.state }
    const claimed = await inTransaction(cell, async db => {
      stagedCookie(ctx, cell, 'none')
      // The lookup is a locator only. User is locked first and every value is
      // freshly reread after it, before native parse or code exchange.
      const [current] = await db.select().from(user).where(eq(user.id, locator.userId)).for('update')
      transaction(cell, ctx.request!)
      if (!current) refuse()
      const [attempt] = await db.select().from(recoveryGoogleAttempt).where(eq(recoveryGoogleAttempt.id, locator.id)).for('update')
      transaction(cell, ctx.request!)
      if (!attempt || attempt.userId !== locator.userId || attempt.id !== locator.id || attempt.oauthState !== fields.state
        || attempt.generation !== current.recoveryGeneration || attempt.phase !== 'PENDING') {
        if (attempt?.phase !== 'PENDING') phaseRefusals++
        refuse()
      }
      const [link] = await db.select().from(account).where(and(eq(account.id, attempt.accountId), eq(account.userId, current.id))).for('update')
      transaction(cell, ctx.request!)
      const now = await clock(db, current.id)
      if (!link || link.providerId !== 'google' || link.accountId !== attempt.accountSubject || attempt.providerId !== 'google'
        || attempt.issuer !== issuer) refuse()
      assertDeadline(attempt.expiresAt, now)
      parseEntries++; cell.parseCalls++
      const parsed = await parseState(ctx)
      transaction(cell, ctx.request!)
      stagedCookie(ctx, cell, 'claim')
      let reference: typeof serverContext.Type
      try { reference = Schema.decodeUnknownSync(serverContext, { onExcessProperty: 'error' })(parsed.serverContext) }
      catch { return refuse() }
      if (reference.attemptId !== attempt.id || parsed.callbackURL !== returnURI || parsed.link || parsed.requestSignUp
        || !parsed.idTokenNonce || !parsed.codeVerifier || attempt.oauthState !== fields.state) refuse()
      const [changed] = await db.update(recoveryGoogleAttempt).set({ phase: 'EXCHANGING' })
        .where(and(eq(recoveryGoogleAttempt.id, attempt.id), eq(recoveryGoogleAttempt.phase, 'PENDING'))).returning()
      transaction(cell, ctx.request!)
      if (!changed) refuse()
      await freshDeadline(cell, db, changed)
      stagedCookie(ctx, cell, 'same')
      return { attempt: changed, parsed }
    })
    // This hook pauses only after confirmed claim settlement, so a competitor
    // uses a distinct Request/lifetime and sees the durable phase refusal.
    outer(cell, ctx.request!)
    if (cell.settings.afterClaim) { await cell.settings.afterClaim(); outer(cell, ctx.request!) }
    cell.stage = 'exchange'
    const tokens = await google.validateAuthorizationCode({ code: fields.code, codeVerifier: claimed.parsed.codeVerifier, redirectURI })
    outer(cell, ctx.request!)
    requireValue(tokens)
    const profile = await google.getUserInfo({ ...tokens, expectedIdTokenNonce: claimed.parsed.idTokenNonce })
    outer(cell, ctx.request!)
    requireValue(profile)
    const raw = await google.accountSubject({ tokens, profile: profile.data })
    outer(cell, ctx.request!)
    let subject: string
    try { subject = Schema.decodeUnknownSync(subjectSchema)(raw) } catch { return refuse() }
    if (cell.settings.afterSubject) { await cell.settings.afterSubject(); outer(cell, ctx.request!) }
    cell.stage = 'proof'
    await inTransaction(cell, async db => {
      stagedCookie(ctx, cell, 'same')
      const { attempt } = await locked(cell, db, claimed.attempt.userId, claimed.attempt.id, 'EXCHANGING')
      if (subject !== attempt.accountSubject) refuse()
      cell.proofAttemptId = attempt.id
      const identifier = proofIdentifier(attempt.id)
      const existing = await db.select().from(verification).where(eq(verification.identifier, identifier)).limit(2).for('update')
      transaction(cell, ctx.request!)
      if (existing.length) refuse()
      const value = JSON.stringify({ purpose, userId: attempt.userId, attemptId: attempt.id, generation: attempt.generation,
        accountId: attempt.accountId, providerId: 'google', issuer, subject, expiresAt: attempt.expiresAt.getTime() })
      const created = await ctx.context.internalAdapter.createVerificationValue({ identifier, value, expiresAt: attempt.expiresAt })
      transaction(cell, ctx.request!)
      if (!created || created.identifier !== identifier || created.value !== value
        || created.expiresAt.getTime() !== attempt.expiresAt.getTime() || cell.proofCreates !== 1) refuse()
      const rows = await db.select().from(verification).where(eq(verification.identifier, identifier)).limit(2).for('update')
      transaction(cell, ctx.request!)
      if (rows.length !== 1 || !sameVerification(rows[0], created)) refuse()
      await freshDeadline(cell, db, attempt)
      stagedCookie(ctx, cell, 'same')
      const [proved] = await db.update(recoveryGoogleAttempt).set({ phase: 'PROVED' })
        .where(and(eq(recoveryGoogleAttempt.id, attempt.id), eq(recoveryGoogleAttempt.phase, 'EXCHANGING'))).returning()
      transaction(cell, ctx.request!)
      if (!proved) refuse()
      await freshDeadline(cell, db, proved)
      stagedCookie(ctx, cell, 'same')
    })
    return { proved: true }
  }
  async function consume(ctx: Parameters<typeof generateState>[0], cell: Cell): Promise<Receipt['consume']> {
    outer(cell, ctx.request!)
    const target = admission(cell, 'consume')
    cell.stage = 'consume'
    await inTransaction(cell, async db => {
      stagedCookie(ctx, cell, 'none')
      const { attempt } = await locked(cell, db, target.userId, target.attemptId!, 'PROVED')
      const identifier = proofIdentifier(attempt.id)
      // Limit two is intentional: it detects a duplicate before native consume
      // can delete every sibling sharing this non-unique identifier.
      const rows = await db.select().from(verification).where(eq(verification.identifier, identifier)).limit(2).for('update')
      transaction(cell, ctx.request!)
      if (rows.length !== 1) refuse()
      const row = rows[0]
      let value: typeof proofValue.Type
      try { value = Schema.decodeUnknownSync(proofValue, { onExcessProperty: 'error' })(JSON.parse(row.value)) }
      catch { return refuse() }
      if (value.userId !== attempt.userId || value.attemptId !== attempt.id || value.generation !== attempt.generation
        || value.accountId !== attempt.accountId || value.subject !== attempt.accountSubject
        || value.expiresAt !== attempt.expiresAt.getTime() || row.expiresAt.getTime() !== value.expiresAt) refuse()
      const consumed = await ctx.context.internalAdapter.consumeVerificationValue(identifier)
      transaction(cell, ctx.request!)
      if (!consumed || cell.proofConsumes !== 1 || consumed.id !== row.id || consumed.identifier !== row.identifier
        || consumed.value !== row.value || consumed.expiresAt.getTime() !== row.expiresAt.getTime()
        || consumed.createdAt.getTime() !== row.createdAt.getTime()
        || consumed.updatedAt.getTime() !== row.updatedAt.getTime()) refuse()
      const remaining = await db.select({ id: verification.id }).from(verification).where(eq(verification.identifier, identifier)).limit(1)
      transaction(cell, ctx.request!)
      if (remaining.length) refuse()
      await freshDeadline(cell, db, attempt)
      stagedCookie(ctx, cell, 'none')
      const [prepared] = await db.update(recoveryGoogleAttempt).set({ phase: 'PREPARED' })
        .where(and(eq(recoveryGoogleAttempt.id, attempt.id), eq(recoveryGoogleAttempt.phase, 'PROVED'))).returning()
      transaction(cell, ctx.request!)
      if (!prepared) refuse()
      await freshDeadline(cell, db, prepared)
      stagedCookie(ctx, cell, 'none')
      if (cell.settings.afterPreparedFault) {
        const [observed] = await db.select().from(recoveryGoogleAttempt).where(eq(recoveryGoogleAttempt.id, attempt.id))
        const absent = await db.select({ id: verification.id }).from(verification).where(eq(verification.identifier, identifier)).limit(1)
        transaction(cell, ctx.request!)
        if (observed?.phase !== 'PREPARED' || absent.length) refuse()
        await freshDeadline(cell, db, prepared)
        stagedCookie(ctx, cell, 'none')
        consumeFaultReached++
        throw new Error('G3 modeled consume settlement fault')
      }
    })
    return { prepared: true }
  }
  async function activation(ctx: Parameters<typeof generateState>[0], cell: Cell): Promise<Receipt['activation']> {
    outer(cell, ctx.request!)
    const target = admission(cell, 'activation')
    cell.stage = 'activation'
    await inTransaction(cell, async db => {
      stagedCookie(ctx, cell, 'none')
      const { attempt } = await locked(cell, db, target.userId, target.attemptId!, 'PREPARED')
      await freshDeadline(cell, db, attempt)
      stagedCookie(ctx, cell, 'none')
    })
    return { eligible: true }
  }

  const endpoint = {
    qualifyRecoveryGoogleBegin: createAuthEndpoint(paths.begin, { method: 'POST', metadata: { SERVER_ONLY: true } }, async ctx => {
      const cell = cells.get(ctx.request!)
      if (!cell || cell.action !== 'begin') refuse()
      return begin(ctx, cell)
    }),
    qualifyRecoveryGoogleCallback: createAuthEndpoint(paths.callback, { method: 'GET', metadata: { SERVER_ONLY: true } }, async ctx => {
      const cell = cells.get(ctx.request!)
      if (!cell || cell.action !== 'callback') refuse()
      return callback(ctx, cell)
    }),
    qualifyRecoveryGoogleConsume: createAuthEndpoint(paths.consume, { method: 'POST', metadata: { SERVER_ONLY: true } }, async ctx => {
      const cell = cells.get(ctx.request!)
      if (!cell || cell.action !== 'consume') refuse()
      return consume(ctx, cell)
    }),
    qualifyRecoveryGoogleActivation: createAuthEndpoint(paths.activation, { method: 'POST', metadata: { SERVER_ONLY: true } }, async ctx => {
      const cell = cells.get(ctx.request!)
      if (!cell || cell.action !== 'activation') refuse()
      return activation(ctx, cell)
    }),
  }
  const plugin = { id: 'qualification-recovery-google', endpoints: endpoint,
    hooks: { before: [{ matcher: (ctx: { path?: string }) => qualificationGooglePaths.has(ctx.path ?? ''),
      handler: createAuthMiddleware(async ctx => {
        const cell = ctx.request && cells.get(ctx.request)
        if (!cell || paths[cell.action] !== ctx.path) refuse()
        outer(cell, ctx.request!)
        const selected = ctx.context.socialProviders.find(provider => provider.id === 'google')
        if (!selected || cell.provider) refuse()
        const originalProfile = selected.getUserInfo
        const instrumented: OAuthProvider = { ...selected,
          async getUserInfo(tokens) { profileMappings++; return originalProfile(tokens) },
          async accountSubject(input) { subjects++; return selected.accountSubject(input) },
        }
        const decorated = cell.lifetime.decorate(instrumented)
        cell.provider = decorated
        const original = ctx.context.internalAdapter
        const deny = async (): Promise<never> => { nativeMutationAttempts++; return refuse() }
        const guarded: AuthContext['internalAdapter'] = { ...original,
          createUser: deny, updateUser: deny, deleteUser: deny, updateUserByEmail: deny, updatePassword: deny,
          createOAuthUser: deny, createAccount: deny, updateAccount: deny, deleteAccount: deny,
          deleteAccounts: deny, linkAccount: deny, createSession: deny, updateSession: deny, deleteSession: deny,
          deleteSessions: deny, deleteUserSessions: deny, refreshUserSessions: deny,
          async createVerificationValue(data) {
            transaction(cell, ctx.request!)
            if (cell.stage === 'begin-state') { cell.nativeStateCreates++; nativeStateCreates++ }
            else if (cell.stage === 'proof' && cell.proofAttemptId && data.identifier === proofIdentifier(cell.proofAttemptId)) {
              cell.proofCreates++; proofCreates++
            } else refuse()
            const result = await original.createVerificationValue(data)
            transaction(cell, ctx.request!)
            return result
          },
          async consumeVerificationValue(identifier) {
            transaction(cell, ctx.request!)
            if (cell.stage !== 'consume' || identifier !== proofIdentifier(cell.admission?.attemptId ?? '')) refuse()
            cell.proofConsumes++; proofConsumes++
            const result = await original.consumeVerificationValue(identifier)
            transaction(cell, ctx.request!)
            return result
          },
          async deleteVerificationByIdentifier(identifier) {
            transaction(cell, ctx.request!)
            if (cell.stage !== 'claim') refuse()
            nativeStateDeletes++
            const result = await original.deleteVerificationByIdentifier(identifier)
            transaction(cell, ctx.request!)
            return result
          },
        }
        return { context: { context: { socialProviders: ctx.context.socialProviders.map(value => value.id === 'google' ? decorated : value),
          internalAdapter: guarded } } }
      }),
    }] },
  }

  async function invoke<A extends Action>(action: A, request: Request, modeled: Admission | undefined,
    native: RecoveryGoogleNativeCalls[A], settings: Settings = {}): Promise<NativeResult<A>> {
    if (request.url !== origin + '/qualification/recovery/google/' + action && action !== 'callback') refuse()
    if (action === 'callback' && !request.url.startsWith(redirectURI + '?')) refuse()
    if (request.method !== (action === 'callback' ? 'GET' : 'POST') || new URL(request.url).origin !== origin
      || action !== 'callback' && request.headers.get('origin') !== origin || request.headers.get('sec-fetch-site') === 'cross-site') refuse()
    if (modeled && (modeled.userId.length === 0 || !Number.isSafeInteger(modeled.generation))) refuse()
    return owner.runAuthInvocation({ deadlineAtMs: Date.now() + 15000, statementTimeoutMs: 1000,
      cleanupTimeoutMs: 1000, correlationId: randomUUID(), signal: request.signal }, async () => {
      const selected = protocol()
      if (!selected || !Object.isExtensible(request) || Object.hasOwn(request, key) || cells.has(request)) refuse()
      const lifetime = selected.lifetime()
      const cell: Cell = { request, action, admission: modeled, options: owner.invocationOptions(), lifetime, settings,
        active: true, phase: 'outer', stage: 'entry', nativeStateCreates: 0, proofCreates: 0, proofConsumes: 0, parseCalls: 0 }
      Object.defineProperty(request, key, { value: cell, enumerable: false, writable: false, configurable: true })
      cells.set(request, cell)
      try {
        outer(cell, request)
        const result = await native(request)
        outer(cell, request)
        if (!(result.headers instanceof Headers) || result.response instanceof Response || !result.response
          || action === 'begin' && (cell.nativeStateCreates !== 1 || typeof (result.response as Receipt['begin']).url !== 'string')
          || action === 'callback' && (cell.parseCalls !== 1 || cell.proofCreates !== 1)
          || action === 'consume' && cell.proofConsumes !== 1) refuse()
        const cookies = result.headers.getSetCookie()
        if (cookies.some(value => !/^(?:__Secure-)?better-auth\.(?:state|oauth_state)=/.test(value))
          || action === 'begin' && cookies.length !== 1
          || action === 'callback' && cookies.length !== 1
          || (action === 'consume' || action === 'activation') && cookies.length !== 0
          || (action === 'begin' || action === 'callback') && cookies[0] !== cell.stagedStateCookie
          || (action === 'consume' || action === 'activation') && cell.stagedStateCookie !== undefined) refuse()
        return result
      } finally {
        cell.active = false
        lifetime.revoke()
        cells.delete(request)
        try { if (!Reflect.deleteProperty(request, key)) refuse() }
        finally { await lifetime.join() }
      }
    })
  }
  return { plugin, invoke, isBound, proofIdentifier,
    evidence: () => ({ parseEntries, profileMappings, subjects, phaseRefusals, proofCreates, proofConsumes,
      nativeMutationAttempts, nativeStateCreates, nativeStateDeletes, deadlineRefusals, consumeFaultReached, modeledAdmissionRefusals }) }
}
export type RecoveryGoogleQualification = ReturnType<typeof createRecoveryGoogleQualification>
