import { randomUUID } from 'node:crypto'
import { Schema } from 'effect'
import { and, eq, sql } from 'drizzle-orm'
import { boolean, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core'
import { generateAuthenticationOptions, type PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/server'
import { passkey as nativePasskey } from '@better-auth/passkey'
import type { AuthContext, BetterAuthOptions } from 'better-auth'
import { APIError, createAuthEndpoint, createAuthMiddleware, dispatchAuthEndpoint, getAuthoritativeSessionFromCtx } from 'better-auth/api'
import { createCookieGetter, deleteSessionCookie, expireCookie, getCookies, parseCookies, setSessionCookie } from 'better-auth/cookies'
import type { AuthTransactions } from '../../src/platform/db/transactions.server'
import type { googleAdmission } from '../../src/modules/auth/admission.server'
import type { assertEndpointClassification } from '../../src/modules/auth/http-boundary.server'
import { account, passkey, session, user, verification } from '../../src/modules/auth/schema.server'
import { readPrivatePrincipal } from '../../src/modules/auth/session.server'
import { validatePasskeyFinishInput } from '../../src/modules/auth/passkey-login.server'
import { verifyPasskeyAssertion } from '../../src/modules/auth/passkey-assertion.server'

// MODELED AUTHORITY ONLY. These tables exist solely in a fresh owned test store.
// They model already-established proofs and one code; they implement no recovery proof.
type Attempt = { selector: string; sessionId: string; preparedUntil: number; expiresAt: number }
type Q2Witness = { selector: string; sessionId: string; generation: number; registrationId: string | null;
  keyId: string | null; assertionId: string | null; tested: boolean }
export const qualificationWitness = pgTable('qualification_recovery_witness', {
  userId: text('user_id').primaryKey(), remainingCode: integer('remaining_code').notNull(),
  winner: text('winner'), finished: boolean('finished').notNull(),
  attempts: jsonb('attempts').$type<Attempt[]>().notNull(),
  q2: jsonb('q2').$type<Q2Witness | null>(),
})
export const qualificationPath = '/application/qualification/recovery-native'
export const qualificationEndpointName = 'qualifyRecoveryNative'
export const qualificationWindows = Object.freeze({ preparationMs: 300000, restrictedMs: 1200000, namespaces: 2 })
export type QualificationAction = 'prepare' | 'status' | 'activate' | 'clear-error' | 'finish-modeled' | 'seed-expired'
  | 'q2-register-options' | 'q2-register' | 'q2-assert-options' | 'q2-assert' | 'q3-finish'
export type QualificationFault = 'none' | 'update-veto' | 'update-token' | 'update-lifetime' | 'delete-veto' | 'update-after' | 'delete-after' | 'before-commit'
type NativeContext = Parameters<typeof setSessionCookie>[0]
type Lease = Parameters<Parameters<AuthTransactions['withAuthPromise']>[1]>[0]
type Admission = ReturnType<typeof googleAdmission>
type Classifier = typeof assertEndpointClassification
const actionSchema = Schema.Literals(['prepare', 'status', 'activate', 'clear-error', 'finish-modeled', 'seed-expired',
  'q2-register-options', 'q2-register', 'q2-assert-options', 'q2-assert', 'q3-finish'])
const selectorSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/))
const receiptSchema = Schema.Struct({ ok: Schema.Boolean, selector: Schema.optional(selectorSchema),
  phase: Schema.optional(Schema.Literals(['prepared', 'recovering', 'finished', 'refused'])), nativePrivateRefused: Schema.optional(Schema.Boolean),
  options: Schema.optional(Schema.Unknown), keyId: Schema.optional(Schema.String), challengeId: Schema.optional(Schema.String),
  tested: Schema.optional(Schema.Boolean) })
const registrationInput = Schema.Struct({ response: Schema.Struct({ id: Schema.NonEmptyString, rawId: Schema.NonEmptyString,
  type: Schema.Literal('public-key'), response: Schema.Struct({ clientDataJSON: Schema.NonEmptyString,
    attestationObject: Schema.NonEmptyString, transports: Schema.Array(Schema.String) }),
  clientExtensionResults: Schema.Record(Schema.String, Schema.Unknown),
  authenticatorAttachment: Schema.optional(Schema.Literals(['platform', 'cross-platform'])) }),
  createSession: Schema.Literal(false), fault: Schema.optional(Schema.Literals(['registration-after', 'expire-after-verify'])) })
const assertionInput = Schema.Struct({ challengeId: selectorSchema, response: Schema.Unknown,
  fault: Schema.optional(Schema.Literals(['assert-after-writes', 'expire-after-verify'])) })
const finishInput = Schema.Struct({ fault: Schema.optional(Schema.Literals(['key-delete-noop', 'finish-after'])) })
const nativeDeleteResult = Schema.Struct({ status: Schema.Literal(true) })
const registrationOptions = Schema.Struct({ challenge: Schema.NonEmptyString,
  rp: Schema.Struct({ id: Schema.NonEmptyString, name: Schema.NonEmptyString }),
  user: Schema.Struct({ id: Schema.NonEmptyString, name: Schema.NonEmptyString, displayName: Schema.NonEmptyString }) })
const registrationResult = Schema.Struct({ id: Schema.NonEmptyString, userId: Schema.NonEmptyString,
  credentialID: Schema.NonEmptyString })
const nativeRegistrationValue = Schema.Struct({ type: Schema.Literal('registration'), expectedChallenge: Schema.NonEmptyString,
  userData: Schema.Struct({ id: Schema.NonEmptyString, name: Schema.NonEmptyString,
    displayName: Schema.optional(Schema.String) }), context: Schema.NonEmptyString })
const assertionValue = Schema.Struct({ purpose: Schema.Literal('q2-recovery-new-key'), selector: selectorSchema,
  sessionId: Schema.NonEmptyString, generation: Schema.Int, keyId: Schema.NonEmptyString,
  challenge: Schema.NonEmptyString, expiresAt: Schema.Int })
export type QualificationReceipt = typeof receiptSchema.Type
function refuse(): never { throw new APIError('UNAUTHORIZED', { message: 'Qualification refused' }) }
function invariant(condition: unknown): asserts condition { if (!condition) throw new Error('Native qualification invariant failed') }

// Deeply own every cookie-related option and descriptor. No auth instance context
// is obtained or retained: the argument is the currently executing native endpoint.
export function qualificationCookieContext(context: AuthContext, namespace: string): AuthContext {
  const options: BetterAuthOptions = { ...context.options,
    session: { ...context.options.session, expiresIn: qualificationWindows.restrictedMs / 1000,
      cookieCache: { ...context.options.session?.cookieCache } },
    advanced: { ...context.options.advanced, cookiePrefix: namespace,
      defaultCookieAttributes: { ...context.options.advanced?.defaultCookieAttributes },
      cookies: Object.fromEntries(Object.entries(context.options.advanced?.cookies ?? {}).map(([key, cookie]) =>
        [key, { ...cookie, name: `${namespace}.${key}`, attributes: { ...cookie?.attributes } }])) },
  }
  return { ...context, options, authCookies: getCookies(options), createAuthCookie: createCookieGetter(options),
    sessionConfig: { ...context.sessionConfig, expiresIn: qualificationWindows.restrictedMs / 1000 }, session: null, newSession: null }
}

export function classifyQualificationEndpoint(original: Classifier, ...args: Parameters<Classifier>) {
  const [api, ...flags] = args
  const extension = api[qualificationEndpointName]
  invariant(extension && extension.path === qualificationPath && extension.options.method === 'POST' && extension.options.metadata?.SERVER_ONLY === true)
  const ordinary = { ...api }; delete ordinary[qualificationEndpointName]
  original(ordinary, ...flags)
}

export function createRecoveryNativeQualification(owner: AuthTransactions, origin: string, mode: 'shared-control' | 'isolated') {
  type Q3Cell = { request: Request; selector: string; sessionId: string; generation: number; expiresAt: number;
    retained: typeof passkey.$inferSelect; keys: (typeof passkey.$inferSelect)[]; accounts: (typeof account.$inferSelect)[];
    oldSessions: (typeof session.$inferSelect)[]; user: typeof user.$inferSelect; witness: typeof qualificationWitness.$inferSelect;
    deletionId?: string; deleteCalls: number; omitted: boolean;
    phase: 'keys' | 'session-revocation' | 'after-revocation' | 'ordinary-create' | 'effects-complete';
    finishTime?: Date; holdUntil?: Date; ordinary?: { id: string; token: string; expiresAt: Date;
      authenticatedAt: Date; lastActivityAt: Date } }
  const q3Revocations = new WeakMap<object, Q3Cell>()
  let userId: string | undefined
  let fault: QualificationFault = 'none'
  let nativeCalls = 0, admitted = 0, forwarded = 0, authoritativeReads = 0, afterHooks = 0
  let nestedOptionsAdmitted = 0, nestedRegistrationAdmitted = 0
  let nestedDeletionAdmitted = 0
  let ordinaryCookieSnapshot: string | undefined
  let ordinaryCookieObjects: AuthContext['authCookies'] | undefined
  let ordinaryCookieFactory: AuthContext['createAuthCookie'] | undefined
  let ordinaryAuxiliary: string | undefined
  let capturedAmbient: AuthContext['session'] = null
  let capturedPasskey: ReturnType<typeof nativePasskey> | undefined
  const calls = new WeakMap<Request, { action: QualificationAction; selector?: string; seedAmbient: boolean;
    input?: unknown; lease: Lease; invocation: ReturnType<AuthTransactions['invocationOptions']>; active: boolean;
    q2?: { path: '/passkey/generate-register-options' | '/passkey/verify-registration'; selector: string;
      sessionId: string; generation: number; registrationId?: string; context: string; expiresAt: number;
      nativeCreate?: number; nativeConsume?: number; callback?: number; consumedExpiresAt?: number };
    q3?: Q3Cell }>()
  const events: string[] = []
  const namespace = (selector: string) => mode === 'shared-control' ? 'q1-recovery.shared' : `q1-recovery.${selector}`
  function binding(request: Request | undefined) {
    const value = request && calls.get(request)
    if (!request || !value?.active || request.method !== 'POST' || request.headers.get('origin') !== origin
      || new URL(request.url).origin !== origin || request.headers.get('sec-fetch-site') === 'cross-site'
      || owner.currentDb() !== value.lease.db || owner.invocationOptions() !== value.invocation) return refuse()
    return value
  }
  async function clock(lease: Lease) {
    // The pg adapter returns raw TIMESTAMPTZ strings for SQL expressions.
    // Reuse the real timestamp column decoder, then reject an invalid result.
    const [value] = await lease.db.select({ now: sql`clock_timestamp()`.mapWith(user.createdAt) }).from(user).where(eq(user.id, userId!))
    invariant(value && value.now instanceof Date && Number.isFinite(value.now.getTime())); return value.now
  }
  const exactRows = (left: readonly unknown[], right: readonly unknown[]) =>
    JSON.stringify(left.map(value => JSON.stringify(value)).sort()) === JSON.stringify(right.map(value => JSON.stringify(value)).sort())
  async function verifyQ3Final(cell: Q3Cell, lease: Lease, native: Pick<NativeContext, 'context'>, headers: Headers) {
    binding(cell.request)
    invariant(cell.phase === 'effects-complete' && cell.ordinary && cell.finishTime && cell.holdUntil)
    const [liveUser] = await lease.db.select().from(user).where(eq(user.id, userId!))
    const [liveWitness] = await lease.db.select().from(qualificationWitness).where(eq(qualificationWitness.userId, userId!))
    const keys = await lease.db.select().from(passkey).where(eq(passkey.userId, userId!))
    const accounts = await lease.db.select().from(account).where(eq(account.userId, userId!))
    const sessions = await lease.db.select().from(session).where(eq(session.userId, userId!))
    const finishClock = await clock(lease)
    invariant(finishClock.getTime() < cell.expiresAt && exactRows(keys, [cell.retained]) && exactRows(accounts, cell.accounts)
      && sessions.length === 1 && sessions[0].id === cell.ordinary.id && sessions[0].token === cell.ordinary.token
      && cell.oldSessions.every(old => old.id !== sessions[0].id && old.token !== sessions[0].token)
      && sessions[0].authState === 'ACTIVE' && sessions[0].authMethod === 'recovery'
      && sessions[0].recoveryGeneration === cell.generation
      && sessions[0].authenticatedAt.getTime() === cell.finishTime.getTime()
      && sessions[0].lastActivityAt.getTime() === cell.finishTime.getTime()
      && sessions[0].expiresAt.getTime() === cell.ordinary.expiresAt.getTime()
      && liveUser && !liveUser.recovering && liveUser.recoveryGeneration === cell.generation
      && liveUser.holdUntil?.getTime() === cell.holdUntil.getTime()
      && JSON.stringify({ ...liveUser, recovering: cell.user.recovering, holdUntil: cell.user.holdUntil,
        updatedAt: cell.user.updatedAt }) === JSON.stringify(cell.user)
      && liveWitness && JSON.stringify(liveWitness) === JSON.stringify({ ...cell.witness, finished: true }))
    invariant(native.context.newSession?.session.id === cell.ordinary.id
      && native.context.newSession.session.token === cell.ordinary.token)
    const raw = headers.getSetCookie()
    invariant(raw.length === 1 && raw[0].startsWith(`${native.context.authCookies.sessionToken.name}=`))
    const ordinary = JSON.stringify({ cookies: native.context.authCookies, advanced: native.context.options.advanced,
      session: native.context.options.session, sessionConfig: native.context.sessionConfig })
    invariant(ordinaryCookieSnapshot === ordinary && ordinaryCookieObjects === native.context.authCookies
      && ordinaryCookieFactory === native.context.createAuthCookie
      && ordinaryAuxiliary === JSON.stringify(native.context.createAuthCookie('qualification_ordinary_aux', { maxAge: 17 })))
  }
  const endpoint = createAuthEndpoint(qualificationPath, { method: 'POST', metadata: { SERVER_ONLY: true } }, async ctx => {
    const call = binding(ctx.request), { lease } = call
    invariant(userId)
    nativeCalls++
    const [current] = await lease.db.select().from(user).where(eq(user.id, userId)).for('update')
    const [witness] = await lease.db.select().from(qualificationWitness).where(eq(qualificationWitness.userId, userId)).for('update')
    invariant(current && witness)
    const now = await clock(lease)
    const assertBound = () => { binding(ctx.request) }
    const original = ctx.context.internalAdapter
    let permittedCreate: Parameters<typeof original.createSession> | undefined
    let permittedUpdate: Parameters<typeof original.updateSession> | undefined
    let permittedDelete: string[] | undefined
    const deny = async (): Promise<never> => refuse()
    const adapter: AuthContext['internalAdapter'] = { ...original,
      createUser: deny, updateUser: deny, deleteUser: deny, updateUserByEmail: deny, updatePassword: deny,
      createOAuthUser: deny, createAccount: deny, updateAccount: deny, deleteAccount: deny, deleteAccounts: deny, linkAccount: deny,
      deleteUserSessions: deny, refreshUserSessions: deny,
      async createSession(...args) {
        assertBound(); invariant(permittedCreate && args[0] === userId && args[1] === undefined && args[3] === true && args[4] === undefined
          && JSON.stringify(args[2]) === JSON.stringify(permittedCreate[2]) && !Object.hasOwn(args[2] ?? {}, 'token') && !Object.hasOwn(args[2] ?? {}, 'id'))
        permittedCreate = undefined
        if (call.action === 'q3-finish') {
          invariant(call.q3?.phase === 'ordinary-create' && args[2]?.authState === 'ACTIVE')
          events.push('q3-ordinary-session-create-entry')
        }
        const value = await original.createSession(...args); assertBound(); return value
      },
      async updateSession(...args) {
        assertBound(); invariant(permittedUpdate && args[0] === permittedUpdate[0] && JSON.stringify(args[1]) === JSON.stringify(permittedUpdate[1]))
        permittedUpdate = undefined
        const value = await original.updateSession(...args); assertBound(); return value
      },
      async deleteSessions(tokens) {
        assertBound(); invariant(permittedDelete && JSON.stringify(tokens) === JSON.stringify(permittedDelete)); permittedDelete = undefined
        await original.deleteSessions(tokens); assertBound()
      },
      // Expired native reads may request native deletion of their own selected row.
      async deleteSession(token) {
        assertBound()
        const [row] = await lease.db.select().from(session).where(and(eq(session.token, token), eq(session.userId, userId!)))
        invariant(row && row.expiresAt.getTime() <= (await clock(lease)).getTime())
        await original.deleteSession(token); assertBound()
      },
    }
    ctx.context.internalAdapter = adapter
    function selectedContext(selector: string): NativeContext {
      Schema.decodeUnknownSync(selectorSchema)(selector)
      const selected = { ...ctx, context: qualificationCookieContext(ctx.context, namespace(selector)), query: { disableCookieCache: true, disableRefresh: true } }
      if (call.seedAmbient) selected.context.session = capturedAmbient
      return selected
    }
    async function authoritative(attempt: Attempt) {
      const selected = selectedContext(attempt.selector)
      const read = await getAuthoritativeSessionFromCtx(selected)
      authoritativeReads++; assertBound()
      if (!read || read.user.id !== userId || read.session.id !== attempt.sessionId) return null
      const [persisted] = await lease.db.select().from(session).where(and(eq(session.id, read.session.id), eq(session.userId, userId!)))
      const [liveUser] = await lease.db.select().from(user).where(eq(user.id, userId!))
      if (!persisted || persisted.expiresAt.getTime() !== attempt.expiresAt || persisted.expiresAt.getTime() <= now.getTime()
        || persisted.authState !== 'RECOVERY_RESTRICTED' || persisted.authMethod !== 'recovery'
        || !liveUser || persisted.recoveryGeneration !== liveUser.recoveryGeneration) return null
      if (call.seedAmbient) invariant(capturedAmbient && capturedAmbient.session.id !== persisted.id && capturedAmbient.user.id === userId)
      invariant(await readPrivatePrincipal(owner, read) === null)
      return { selected, persisted, read }
    }
    async function nativeCreate(expiresAt: Date, state: 'ACTIVE' | 'RECOVERY_RESTRICTED', issuedAt: Date = now) {
      const override = { authState: state, authMethod: 'recovery', recoveryGeneration: current.recoveryGeneration,
        authenticatedAt: issuedAt, lastActivityAt: issuedAt, expiresAt }
      permittedCreate = [userId!, undefined, override, true]
      const created = await adapter.createSession(...permittedCreate)
      invariant(created && created.userId === userId && created.expiresAt.getTime() === expiresAt.getTime())
      const [row] = await lease.db.select().from(session).where(eq(session.id, created.id))
      invariant(row && row.token === created.token && row.authState === state && row.authMethod === 'recovery'
        && row.recoveryGeneration === current.recoveryGeneration && row.expiresAt.getTime() === expiresAt.getTime()
        && row.authenticatedAt.getTime() === issuedAt.getTime() && row.lastActivityAt.getTime() === issuedAt.getTime())
      const nativeUser = await adapter.findUserById(userId!)
      invariant(nativeUser?.id === userId)
      return { session: created, user: nativeUser }
    }
    if (call.action === 'seed-expired') {
      await nativeCreate(new Date(now.getTime() - 1000), 'RECOVERY_RESTRICTED')
      return { ok: true }
    }
    if (call.action === 'prepare') {
      // Count modeled attempts through their native DB deadline, including revoked
      // rows. This does not bound browser retention or safe namespace re-admission
      // when a delayed transport retains HTTP Date and the browser adjusts Expires.
      if (witness.finished || current.recovering || witness.attempts.filter(a => a.expiresAt > now.getTime()).length >= qualificationWindows.namespaces) return refuse()
      const selector = randomUUID(), expiresAt = now.getTime() + qualificationWindows.restrictedMs
      const value = await nativeCreate(new Date(expiresAt), 'RECOVERY_RESTRICTED')
      const selected = selectedContext(selector)
      // Declare absolute expiry without arrival-relative Max-Age. Native signing
      // authenticates the token, not cookie attributes; retained HTTP Date may
      // still extend browser retention. The isolated case measures that limit.
      await setSessionCookie(selected, value, false, { maxAge: undefined, expires: new Date(expiresAt) })
      const auxiliary = selected.context.createAuthCookie('qualification_aux', {
        maxAge: undefined, expires: new Date(now.getTime() + qualificationWindows.preparationMs) })
      selected.setCookie(auxiliary.name, 'qualification-only', auxiliary.attributes)
      await lease.db.update(qualificationWitness).set({ attempts: [...witness.attempts, { selector, sessionId: value.session.id,
        preparedUntil: now.getTime() + qualificationWindows.preparationMs, expiresAt }] }).where(eq(qualificationWitness.userId, userId))
      invariant(await readPrivatePrincipal(owner, value) === null)
      return { ok: true, selector, phase: 'prepared', nativePrivateRefused: true }
    }
    if (call.action === 'status' && !call.selector) {
      const cookies = parseCookies(ctx.headers?.get('cookie') ?? '')
      for (const attempt of witness.attempts) {
        if (!cookies.has(selectedContext(attempt.selector).context.authCookies.sessionToken.name)) continue
        if (witness.winner === attempt.selector && !witness.finished && await authoritative(attempt))
          return { ok: true, selector: attempt.selector, phase: 'recovering', nativePrivateRefused: true }
      }
      return refuse()
    }
    const attempt = witness.attempts.find(value => value.selector === call.selector)
    if (!attempt || witness.finished) return refuse()
    if (call.action === 'clear-error') {
      const selected = selectedContext(attempt.selector)
      deleteSessionCookie(selected)
      expireCookie(selected, selected.context.createAuthCookie('qualification_aux'))
      throw new APIError('UNAUTHORIZED', { message: 'Qualification native clear refusal' })
    }
    const valid = await authoritative(attempt)
    if (!valid) return refuse()
    if (call.action === 'status') {
      if (witness.winner && witness.winner !== attempt.selector || !witness.winner && attempt.preparedUntil <= now.getTime()) return refuse()
      return { ok: true, selector: attempt.selector, phase: witness.winner ? 'recovering' : 'prepared', nativePrivateRefused: true }
    }
    if (call.action === 'activate') {
      if (witness.winner === attempt.selector && current.recovering && valid.persisted.recoveryGeneration === current.recoveryGeneration)
        return { ok: true, selector: attempt.selector, phase: 'recovering', nativePrivateRefused: true }
      if (witness.winner || witness.remainingCode !== 1 || current.recovering || attempt.preparedUntil <= now.getTime()
        || valid.persisted.recoveryGeneration !== current.recoveryGeneration) return refuse()
      const before = valid.persisted, generation = current.recoveryGeneration + 1
      const complement = await lease.db.select().from(session).where(eq(session.userId, userId))
      await lease.db.update(user).set({ recovering: true, recoveryGeneration: generation }).where(eq(user.id, userId))
      await lease.db.update(qualificationWitness).set({ remainingCode: 0, winner: attempt.selector }).where(eq(qualificationWitness.userId, userId))
      permittedUpdate = [before.token, { recoveryGeneration: generation }]
      const updated = await adapter.updateSession(...permittedUpdate)
      invariant(updated && updated.id === before.id && updated.token === before.token && updated.userId === before.userId
        && updated.expiresAt.getTime() === before.expiresAt.getTime())
      permittedDelete = complement.filter(row => row.id !== before.id).map(row => row.token)
      if (permittedDelete.length) await adapter.deleteSessions(permittedDelete)
      const remaining = await lease.db.select().from(session).where(eq(session.userId, userId))
      invariant(remaining.length === 1 && JSON.stringify({ ...remaining[0], recoveryGeneration: before.recoveryGeneration, updatedAt: before.updatedAt }) === JSON.stringify(before))
      const [latest] = await lease.db.select().from(user).where(eq(user.id, userId))
      invariant(latest.recovering && latest.recoveryGeneration === generation)
      invariant(await authoritative(attempt))
      if (fault === 'before-commit') throw new Error('Qualification before physical commit')
      events.push('activation-checked-before-physical-commit')
      return { ok: true, selector: attempt.selector, phase: 'recovering', nativePrivateRefused: true }
    }
    if (call.action.startsWith('q2-')) {
      if (mode !== 'isolated' || witness.winner !== attempt.selector || !current.recovering
        || valid.persisted.recoveryGeneration !== current.recoveryGeneration || !capturedPasskey) return refuse()
      const selected = valid.selected
      invariant(selected.context.session?.session.id === attempt.sessionId && selected.context.session.user.id === userId)
      const active = async () => {
        assertBound()
        const [liveUser] = await lease.db.select().from(user).where(eq(user.id, userId!))
        const [liveSession] = await lease.db.select().from(session).where(eq(session.id, attempt.sessionId))
        const [liveWitness] = await lease.db.select().from(qualificationWitness).where(eq(qualificationWitness.userId, userId!))
        const time = await clock(lease)
        if (!liveUser?.recovering || liveUser.recoveryGeneration !== current.recoveryGeneration || !liveSession
          || liveSession.userId !== userId || liveSession.authState !== 'RECOVERY_RESTRICTED'
          || liveSession.authMethod !== 'recovery' || liveSession.recoveryGeneration !== current.recoveryGeneration
          || liveSession.expiresAt.getTime() !== attempt.expiresAt || liveSession.expiresAt.getTime() <= time.getTime()
          || liveWitness?.winner !== attempt.selector || liveWitness.finished) return refuse()
        return { liveWitness, time }
      }
      const q2Context = `q2-registration:${attempt.selector}:${current.recoveryGeneration}:${attempt.sessionId}`
      function inspectNestedCookies(result: Response, path: 'options' | 'register') {
        const raw = result.headers.getSetCookie()
        const expected = selected.context.createAuthCookie('better-auth-passkey').name
        const names = raw.map(value => value.slice(0, value.indexOf('=')))
        const categories = names.map(name => name === expected ? 'namespaced-challenge' :
          name.includes('session_token') ? 'session-cookie' : 'unexpected-cookie')
        events.push(`q2-${path}-raw-cookie-names:${categories.join(',') || 'none'}`)
        const valid = path === 'options' && result.ok ? names.length === 1 && names[0] === expected : names.length === 0
        if (!valid) {
          events.push(`q2-${path}-raw-cookie-invariant-violation`)
          throw new Error('Q2 native raw cookie invariant failed')
        }
        return raw
      }
      if (call.action === 'q2-register-options') {
        if (witness.q2) return refuse()
        call.q2 = { path: '/passkey/generate-register-options', selector: attempt.selector,
          sessionId: attempt.sessionId, generation: current.recoveryGeneration, context: q2Context, expiresAt: attempt.expiresAt }
        const result = await dispatchAuthEndpoint(capturedPasskey.endpoints.generatePasskeyRegistrationOptions, {
          context: selected.context, request: ctx.request, headers: ctx.request?.headers, method: 'GET',
          query: { context: q2Context }, asResponse: true })
        if (!(result instanceof Response)) return refuse()
        const headers = inspectNestedCookies(result, 'options')
        if (!result.ok) {
          events.push('q2-options-native-failed-response-owner-abort')
          return refuse()
        }
        const challengeCookie = headers[0]
        invariant(challengeCookie)
        const rawOptions: unknown = await result.clone().json()
        const options: Pick<PublicKeyCredentialCreationOptionsJSON, 'challenge' | 'rp' | 'user'> =
          Schema.decodeUnknownSync(registrationOptions)(rawOptions)
        if (options.rp.id !== new URL(origin).hostname || call.q2.nativeCreate !== 1
          || !call.q2.registrationId) return refuse()
        const { liveWitness } = await active()
        if (liveWitness.q2) return refuse()
        await lease.db.update(qualificationWitness).set({ q2: { selector: attempt.selector, sessionId: attempt.sessionId,
          generation: current.recoveryGeneration, registrationId: call.q2.registrationId,
          keyId: null, assertionId: null, tested: false } }).where(eq(qualificationWitness.userId, userId!))
        events.push('q2-native-registration-options-created')
        ctx.setHeader('set-cookie', challengeCookie)
        const outerCookies = ctx.responseHeaders.getSetCookie()
        invariant(outerCookies.length === 1 && outerCookies[0] === challengeCookie)
        events.push('q2-options-outer-header-queued-exact-native-challenge')
        return ctx.json({ ok: true, options: rawOptions })
      }
      const q2 = witness.q2
      if (!q2 || q2.selector !== attempt.selector || q2.sessionId !== attempt.sessionId
        || q2.generation !== current.recoveryGeneration || !q2.registrationId) return refuse()
      if (call.action === 'q2-register') {
        if (q2.keyId) return refuse()
        const input = Schema.decodeUnknownSync(registrationInput, { onExcessProperty: 'error' })(call.input)
        call.q2 = { path: '/passkey/verify-registration', selector: attempt.selector, sessionId: attempt.sessionId,
          generation: current.recoveryGeneration, registrationId: q2.registrationId, context: q2Context, expiresAt: attempt.expiresAt }
        const result = await dispatchAuthEndpoint(capturedPasskey.endpoints.verifyPasskeyRegistration, {
          context: selected.context, request: ctx.request, headers: ctx.request?.headers, method: 'POST',
          body: { response: input.response, createSession: false }, asResponse: true })
        if (!(result instanceof Response)) return refuse()
        inspectNestedCookies(result, 'register')
        if (!result.ok) {
          events.push('q2-register-native-failed-response-owner-abort')
          return refuse()
        }
        const native = Schema.decodeUnknownSync(registrationResult)(await result.clone().json())
        const [row] = await lease.db.select().from(passkey).where(eq(passkey.id, native.id))
        if (call.q2.nativeConsume !== 1 || call.q2.callback !== 1 || native.userId !== userId
          || native.credentialID !== input.response.id || !row || row.userId !== userId
          || row.credentialID !== native.credentialID) return refuse()
        await active()
        if (call.q2.consumedExpiresAt === undefined) return refuse()
        if (call.q2.consumedExpiresAt <= (await clock(lease)).getTime()) {
          events.push('q2-registration-final-live-expiry-refused')
          return refuse()
        }
        events.push('q2-native-registration-verified-and-persisted')
        return { ok: true, keyId: native.id }
      }
      if (!q2.keyId || q2.tested) return refuse()
      const [key] = await lease.db.select().from(passkey).where(and(eq(passkey.id, q2.keyId), eq(passkey.userId, userId!))).for('update')
      if (!key) return refuse()
      if (call.action === 'q2-assert-options') {
        if (q2.assertionId) return refuse()
        const options = await generateAuthenticationOptions({ rpID: new URL(origin).hostname, userVerification: 'required',
          allowCredentials: [{ id: key.credentialID }], timeout: qualificationWindows.preparationMs })
        const challengeId = randomUUID(), expiresAt = Math.min(attempt.expiresAt, now.getTime() + qualificationWindows.preparationMs)
        await original.createVerificationValue({ identifier: challengeId,
          value: JSON.stringify({ purpose: 'q2-recovery-new-key', selector: attempt.selector, sessionId: attempt.sessionId,
            generation: current.recoveryGeneration, keyId: key.id, challenge: options.challenge, expiresAt }), expiresAt: new Date(expiresAt) })
        await active()
        await lease.db.update(qualificationWitness).set({ q2: { ...q2, assertionId: challengeId } })
          .where(eq(qualificationWitness.userId, userId!))
        events.push('q2-exact-key-assertion-options-created')
        return { ok: true, challengeId, options }
      }
      if (call.action === 'q2-assert') {
        const input = Schema.decodeUnknownSync(assertionInput, { onExcessProperty: 'error' })(call.input)
        if (input.challengeId !== q2.assertionId) return refuse()
        const [stored] = await lease.db.select().from(verification).where(eq(verification.identifier, input.challengeId)).for('update')
        if (!stored || stored.expiresAt.getTime() <= (await clock(lease)).getTime()) return refuse()
        const proof = Schema.decodeUnknownSync(assertionValue, { onExcessProperty: 'error' })(JSON.parse(stored.value))
        if (proof.purpose !== 'q2-recovery-new-key' || proof.selector !== attempt.selector
          || proof.sessionId !== attempt.sessionId || proof.generation !== current.recoveryGeneration
          || proof.keyId !== key.id || stored.expiresAt.getTime() > proof.expiresAt) return refuse()
        const response = validatePasskeyFinishInput({ response: input.response }).response
        if (response.id !== key.credentialID) return refuse()
        const newCounter = await verifyPasskeyAssertion(key, proof.challenge, response, origin)
        if (input.fault === 'expire-after-verify') {
          events.push('q2-assert-real-verification-before-await-expiry')
          const deadline = performance.now() + 3000
          while (stored.expiresAt.getTime() > (await clock(lease)).getTime()) {
            if (performance.now() >= deadline) throw new Error('Q2 expiry observation timed out')
            await new Promise<void>(resolve => setTimeout(resolve, 10))
          }
        }
        await active()
        if (stored.expiresAt.getTime() <= (await clock(lease)).getTime()) {
          events.push('q2-assert-post-await-live-expiry-refused')
          return refuse()
        }
        const consumed = await original.consumeVerificationValue(input.challengeId)
        if (!consumed || consumed.identifier !== input.challengeId) return refuse()
        events.push('q2-assert-native-verification-consumed')
        const updated = await lease.db.update(passkey).set({ counter: newCounter })
          .where(and(eq(passkey.id, key.id), eq(passkey.userId, userId!), eq(passkey.credentialID, key.credentialID),
            eq(passkey.counter, key.counter))).returning({ id: passkey.id })
        if (updated.length !== 1 || updated[0].id !== key.id) return refuse()
        await lease.db.update(qualificationWitness).set({ q2: { ...q2, tested: true } })
          .where(eq(qualificationWitness.userId, userId!))
        const [afterKey] = await lease.db.select().from(passkey).where(eq(passkey.id, key.id))
        const [afterWitness] = await lease.db.select().from(qualificationWitness).where(eq(qualificationWitness.userId, userId!))
        const remaining = await lease.db.select().from(verification).where(eq(verification.identifier, input.challengeId))
        if (!afterKey || afterKey.counter !== newCounter || !afterWitness?.q2?.tested
          || remaining.length !== 0) return refuse()
        events.push('q2-assert-consumed-counter-tested-in-owner')
        if (input.fault === 'assert-after-writes') {
          if (newCounter <= key.counter) return refuse()
          await Promise.resolve(); events.push('fault:q2-assert-after-writes'); throw new Error('Q2 assertion awaited write fault')
        }
        await active()
        events.push('q2-exact-key-tested-before-owner-commit')
        return { ok: true, tested: true, keyId: key.id }
      }
    }
    if (call.action === 'q3-finish') {
      const input = Schema.decodeUnknownSync(finishInput, { onExcessProperty: 'error' })(call.input ?? {})
      if (mode !== 'isolated' || !capturedPasskey || witness.winner !== attempt.selector || !current.recovering
        || valid.persisted.recoveryGeneration !== current.recoveryGeneration || !witness.q2?.tested
        || witness.q2.selector !== attempt.selector || witness.q2.sessionId !== attempt.sessionId
        || witness.q2.generation !== current.recoveryGeneration || !witness.q2.keyId) return refuse()
      const retainedId = witness.q2.keyId
      const [retained] = await lease.db.select().from(passkey)
        .where(and(eq(passkey.id, retainedId), eq(passkey.userId, userId))).for('update')
      if (!retained) return refuse()
      const selected = valid.selected
      invariant(selected.context.session?.session.id === attempt.sessionId
        && selected.context.session.user.id === userId)
      const liveBefore = async () => {
        assertBound()
        const [liveUser] = await lease.db.select().from(user).where(eq(user.id, userId!))
        const [liveSession] = await lease.db.select().from(session).where(eq(session.id, attempt.sessionId))
        const [liveWitness] = await lease.db.select().from(qualificationWitness).where(eq(qualificationWitness.userId, userId!))
        const time = await clock(lease)
        if (!liveUser?.recovering || liveUser.recoveryGeneration !== current.recoveryGeneration || !liveSession
          || liveSession.userId !== userId || liveSession.authState !== 'RECOVERY_RESTRICTED'
          || liveSession.authMethod !== 'recovery' || liveSession.recoveryGeneration !== current.recoveryGeneration
          || liveSession.expiresAt.getTime() !== attempt.expiresAt || liveSession.expiresAt.getTime() <= time.getTime()
          || liveWitness?.winner !== attempt.selector || liveWitness.finished || !liveWitness.q2?.tested
          || liveWitness.q2.keyId !== retained.id || liveWitness.q2.selector !== attempt.selector
          || liveWitness.q2.sessionId !== attempt.sessionId || liveWitness.q2.generation !== current.recoveryGeneration)
          return refuse()
        return time
      }
      await liveBefore()
      const keys = await lease.db.select().from(passkey).where(eq(passkey.userId, userId))
      const accounts = await lease.db.select().from(account).where(eq(account.userId, userId))
      const complement = keys.filter(key => key.id !== retained.id).sort((a, b) => a.id.localeCompare(b.id))
      if (complement.length < 2 || !exactRows(keys.filter(key => key.id === retained.id), [retained]) || accounts.length !== 1) return refuse()
      const cell: Q3Cell = { request: ctx.request!, selector: attempt.selector, sessionId: attempt.sessionId,
        generation: current.recoveryGeneration, expiresAt: attempt.expiresAt, retained, keys, accounts,
        oldSessions: [], user: current, witness, deleteCalls: 0, omitted: false, phase: 'keys' }
      call.q3 = cell
      for (const [index, key] of complement.entries()) {
        await liveBefore()
        cell.deletionId = key.id
        let result: unknown
        try {
          result = await dispatchAuthEndpoint(capturedPasskey.endpoints.deletePasskey, {
            context: selected.context, request: ctx.request, headers: ctx.request?.headers, method: 'POST',
            body: { id: key.id }, asResponse: true })
        } finally { cell.deletionId = undefined }
        assertBound()
        if (!(result instanceof Response) || result.status !== 200 || !result.ok) return refuse()
        if (result.headers.getSetCookie().length !== 0) return refuse()
        const raw: unknown = await result.clone().json()
        Schema.decodeUnknownSync(nativeDeleteResult, { onExcessProperty: 'error' })(raw)
        events.push('q3-native-delete-status-true')
        if (cell.deleteCalls !== index + 1) return refuse()
        const survivors = await lease.db.select().from(passkey).where(eq(passkey.userId, userId!))
        const removed = new Set(complement.slice(0, index + 1).map(value => value.id))
        const expected = keys.filter(value => !removed.has(value.id))
        if (!exactRows(survivors, expected)) {
          events.push('q3-key-inventory-refused')
          return refuse()
        }
        await liveBefore()
        events.push('q3-native-key-deleted')
      }
      const remainingKeys = await lease.db.select().from(passkey).where(eq(passkey.userId, userId))
      if (!exactRows(remainingKeys, [retained])) return refuse()
      events.push('q3-native-key-retirement-complete')
      await liveBefore()
      cell.oldSessions = await lease.db.select().from(session).where(eq(session.userId, userId))
      if (cell.oldSessions.length < 2 || !cell.oldSessions.some(row => row.id === attempt.sessionId)) return refuse()
      cell.phase = 'session-revocation'
      permittedDelete = cell.oldSessions.map(row => row.token)
      q3Revocations.set(call.invocation, cell)
      try { await adapter.deleteSessions(permittedDelete) }
      finally { q3Revocations.delete(call.invocation) }
      const zeroSessions = await lease.db.select().from(session).where(eq(session.userId, userId))
      if (zeroSessions.length !== 0) {
        events.push('q3-session-inventory-refused')
        return refuse()
      }
      events.push('q3-empty-session-barrier-passed')
      cell.phase = 'after-revocation'
      const afterRevocationTime = await clock(lease)
      if (afterRevocationTime.getTime() >= attempt.expiresAt) return refuse()
      const [beforeFinalUser] = await lease.db.select().from(user).where(eq(user.id, userId))
      const [beforeFinalWitness] = await lease.db.select().from(qualificationWitness).where(eq(qualificationWitness.userId, userId))
      if (!beforeFinalUser?.recovering || beforeFinalUser.recoveryGeneration !== current.recoveryGeneration
        || beforeFinalWitness?.finished || beforeFinalWitness?.winner !== attempt.selector
        || !beforeFinalWitness.q2?.tested || beforeFinalWitness.q2.keyId !== retained.id) return refuse()
      const finishTime = await clock(lease)
      if (finishTime.getTime() >= attempt.expiresAt) return refuse()
      const holdUntil = new Date(Math.max(current.holdUntil?.getTime() ?? 0, finishTime.getTime() + 24 * 60 * 60 * 1000))
      cell.finishTime = finishTime; cell.holdUntil = holdUntil
      await lease.db.update(user).set({ recovering: false, holdUntil }).where(eq(user.id, userId))
      await lease.db.update(qualificationWitness).set({ finished: true }).where(eq(qualificationWitness.userId, userId))
      if (input.fault === 'finish-after' && current.holdUntil === null
        && holdUntil.getTime() === finishTime.getTime() + 24 * 60 * 60 * 1000)
        events.push('q3-finish-after-hold-from-fresh-db-time')
      if ((await clock(lease)).getTime() >= attempt.expiresAt) return refuse()
      cell.phase = 'ordinary-create'
      const ordinary = await nativeCreate(new Date(finishTime.getTime() + ctx.context.sessionConfig.expiresIn * 1000), 'ACTIVE', finishTime)
      cell.ordinary = { id: ordinary.session.id, token: ordinary.session.token, expiresAt: ordinary.session.expiresAt,
        authenticatedAt: finishTime, lastActivityAt: finishTime }
      cell.phase = 'effects-complete'
      if ((await clock(lease)).getTime() >= attempt.expiresAt) return refuse()
      await setSessionCookie(ctx, ordinary, false)
      events.push('q3-ordinary-cookie-staged')
      await verifyQ3Final(cell, lease, ctx, ctx.responseHeaders)
      return { ok: true, phase: 'finished', keyId: retained.id }
    }
    if (call.action === 'finish-modeled') {
      if (witness.winner !== attempt.selector || !current.recovering) return refuse()
      const all = await lease.db.select().from(session).where(eq(session.userId, userId))
      permittedDelete = all.map(row => row.token); await adapter.deleteSessions(permittedDelete)
      await lease.db.update(user).set({ recovering: false }).where(eq(user.id, userId))
      await lease.db.update(qualificationWitness).set({ finished: true }).where(eq(qualificationWitness.userId, userId))
      const ordinary = await nativeCreate(new Date(now.getTime() + ctx.context.sessionConfig.expiresIn * 1000), 'ACTIVE')
      // MODELED finish, ordinary native cookie only. No key enrollment/retirement claim.
      await setSessionCookie(ctx, ordinary, false)
      return { ok: true, selector: attempt.selector, phase: 'finished' }
    }
    return refuse()
  })
  function registration(options: Parameters<typeof nativePasskey>[0]): Parameters<typeof nativePasskey>[0] {
    const original = options?.registration
    return { ...options, registration: { ...original,
      async afterVerification(args) {
        const call = args.ctx.request && calls.get(args.ctx.request)
        if (!call?.q2 || call.q2.path !== '/passkey/verify-registration')
          return original?.afterVerification?.(args)
        binding(args.ctx.request)
        const q2 = call.q2
        if (args.context !== q2.context || args.user.id !== userId || args.ctx.context.session?.session.id !== q2.sessionId
          || owner.currentDb() !== call.lease.db || owner.invocationOptions() !== call.invocation
          || args.verification.verified !== true || !args.verification.registrationInfo) return refuse()
        const [witness] = await call.lease.db.select().from(qualificationWitness)
          .where(eq(qualificationWitness.userId, userId!))
        if (!witness?.q2 || witness.winner !== q2.selector || witness.q2.registrationId !== q2.registrationId
          || witness.q2.sessionId !== q2.sessionId || witness.q2.generation !== q2.generation
          || witness.q2.keyId || witness.q2.tested) return refuse()
        if (args.verification.registrationInfo.userVerified !== true) {
          events.push('q2-registration-uv-rejected-after-native-verify'); return refuse()
        }
        if (q2.consumedExpiresAt === undefined) return refuse()
        const input = Schema.decodeUnknownSync(registrationInput, { onExcessProperty: 'error' })(call.input)
        if (input.fault === 'expire-after-verify') {
          events.push('q2-registration-real-verification-before-await-expiry')
          const deadline = performance.now() + 5000
          while (q2.consumedExpiresAt > (await clock(call.lease)).getTime()) {
            if (performance.now() >= deadline) throw new Error('Q2 registration expiry observation timed out')
            await new Promise<void>(resolve => setTimeout(resolve, 10))
          }
        }
        const [liveUser] = await call.lease.db.select().from(user).where(eq(user.id, userId!))
        const [liveSession] = await call.lease.db.select().from(session).where(eq(session.id, q2.sessionId))
        const [liveWitness] = await call.lease.db.select().from(qualificationWitness).where(eq(qualificationWitness.userId, userId!))
        const time = await clock(call.lease)
        if (!liveUser?.recovering || liveUser.recoveryGeneration !== q2.generation || !liveSession
          || liveSession.userId !== userId || liveSession.authState !== 'RECOVERY_RESTRICTED'
          || liveSession.authMethod !== 'recovery' || liveSession.recoveryGeneration !== q2.generation
          || liveSession.expiresAt.getTime() !== q2.expiresAt || liveSession.expiresAt.getTime() <= time.getTime()
          || liveWitness?.winner !== q2.selector || liveWitness.finished) return refuse()
        if (q2.consumedExpiresAt <= time.getTime()) {
          events.push('q2-registration-post-await-live-expiry-refused')
          return refuse()
        }
        q2.callback = (q2.callback ?? 0) + 1
        events.push('q2-registration-callback-verified-uv')
        return { userId: userId! }
      },
    } }
  }
  function capturePasskey(plugin: ReturnType<typeof nativePasskey>) {
    invariant(!capturedPasskey && plugin.id === 'passkey')
    capturedPasskey = plugin
  }
  function admission(plugin: Admission) {
    const before = plugin.hooks.before[0]
    return { ...plugin, hooks: { ...plugin.hooks, before: [{ ...before, handler: createAuthMiddleware(async ctx => {
      if (ctx.path === qualificationPath) {
        binding(ctx.request); admitted++
        return { context: { context: { socialProviders: ctx.context.socialProviders, internalAdapter: ctx.context.internalAdapter } } }
      }
      if (ctx.path === '/passkey/generate-register-options' || ctx.path === '/passkey/verify-registration') {
        const call = ctx.request && calls.get(ctx.request)
        if (call?.q2) {
          binding(ctx.request)
          const q2 = call.q2
          if (q2.path !== ctx.path || mode !== 'isolated' || ctx.context.session?.session.id !== q2.sessionId
            || ctx.context.session.user.id !== userId
            || ctx.context.authCookies.sessionToken.name !== `__Secure-${namespace(q2.selector)}.session_token`
            || ctx.context.createAuthCookie('better-auth-passkey').name !== `__Secure-${namespace(q2.selector)}.better-auth-passkey`
            || owner.currentDb() !== call.lease.db) return refuse()
          if (ctx.path === '/passkey/generate-register-options' && (ctx.method !== 'GET' || ctx.query?.context !== q2.context)) return refuse()
          if (ctx.path === '/passkey/verify-registration' && (ctx.method !== 'POST' || ctx.body?.createSession !== false)) return refuse()
          const original = ctx.context.internalAdapter
          const wrapped: AuthContext['internalAdapter'] = { ...original,
            async createSession() { return refuse() }, async updateSession() { return refuse() },
            async deleteSession() { return refuse() }, async deleteSessions() { return refuse() },
            async createVerificationValue(value) {
              binding(ctx.request)
              if (q2.path !== '/passkey/generate-register-options') return refuse()
              const proof = Schema.decodeUnknownSync(nativeRegistrationValue, { onExcessProperty: 'error' })(JSON.parse(value.value))
              if (proof.context !== q2.context || proof.userData.id !== userId) return refuse()
              const cappedAt = Math.min(value.expiresAt.getTime(), q2.expiresAt)
              if (!Number.isFinite(cappedAt) || cappedAt <= (await clock(call.lease)).getTime()) return refuse()
              const capped = { ...value, expiresAt: new Date(cappedAt) }
              const result = await original.createVerificationValue(capped)
              binding(ctx.request)
              const rows = await call.lease.db.select().from(verification).where(eq(verification.identifier, value.identifier))
              if (rows.length !== 1 || rows[0].expiresAt.getTime() !== capped.expiresAt.getTime()) return refuse()
              q2.registrationId = value.identifier; q2.nativeCreate = (q2.nativeCreate ?? 0) + 1
              events.push('q2-native-registration-verification-created')
              return result
            },
            async consumeVerificationValue(identifier) {
              binding(ctx.request)
              if (q2.path !== '/passkey/verify-registration' || identifier !== q2.registrationId) return refuse()
              const rows = await call.lease.db.select().from(verification).where(eq(verification.identifier, identifier))
              if (rows.length !== 1 || rows[0].expiresAt.getTime() <= (await clock(call.lease)).getTime()) return refuse()
              const proof = Schema.decodeUnknownSync(nativeRegistrationValue, { onExcessProperty: 'error' })(JSON.parse(rows[0].value))
              if (proof.context !== q2.context || proof.userData.id !== userId) return refuse()
              const result = await original.consumeVerificationValue(identifier)
              binding(ctx.request)
              if (!result || (await call.lease.db.select().from(verification).where(eq(verification.identifier, identifier))).length !== 0)
                return refuse()
              q2.nativeConsume = (q2.nativeConsume ?? 0) + 1
              q2.consumedExpiresAt = rows[0].expiresAt.getTime()
              events.push('q2-native-registration-verification-consumed')
              return result
            },
          }
          if (ctx.path === '/passkey/generate-register-options') nestedOptionsAdmitted++
          else nestedRegistrationAdmitted++
          return { context: { context: { internalAdapter: wrapped, socialProviders: ctx.context.socialProviders } } }
        }
      }
      if (ctx.path === '/passkey/delete-passkey') {
        const call = ctx.request && calls.get(ctx.request)
        if (!call?.q3 || call.action !== 'q3-finish') return refuse()
        binding(ctx.request)
        const cell = call.q3
        const expected = cell.deletionId
        if (cell.phase !== 'keys' || !expected || ctx.method !== 'POST' || ctx.body?.id !== expected
          || ctx.context.session?.session.id !== cell.sessionId || ctx.context.session.user.id !== userId
          || ctx.context.authCookies.sessionToken.name !== `__Secure-${namespace(cell.selector)}.session_token`
          || ctx.context.createAuthCookie('better-auth-passkey').name !== `__Secure-${namespace(cell.selector)}.better-auth-passkey`
          || owner.currentDb() !== call.lease.db || owner.invocationOptions() !== call.invocation) return refuse()
        const originalInternal = ctx.context.internalAdapter
        const internal: AuthContext['internalAdapter'] = { ...originalInternal,
          async createSession() { return refuse() }, async updateSession() { return refuse() },
          async deleteSession() { return refuse() }, async deleteSessions() { return refuse() },
          async createUser() { return refuse() }, async updateUser() { return refuse() }, async deleteUser() { return refuse() },
          async createAccount() { return refuse() }, async updateAccount() { return refuse() },
          async deleteAccount() { return refuse() }, async deleteAccounts() { return refuse() },
        }
        const originalGeneric = ctx.context.adapter
        const generic: AuthContext['adapter'] = { ...originalGeneric,
          async create() { return refuse() }, async update() { return refuse() },
          async updateMany() { return refuse() }, async deleteMany() { return refuse() },
          async consumeOne() { return refuse() }, async incrementOne() { return refuse() },
          async transaction() { return refuse() },
          async delete(...args) {
            binding(ctx.request)
            const target = args[0]
            if (cell.phase !== 'keys' || cell.deletionId !== expected || cell.deleteCalls >= cell.keys.length - 1
              || args.length !== 1 || target.model !== 'passkey' || Object.keys(target).length !== 2
              || target.where.length !== 1 || Object.keys(target.where[0]).length !== 2
              || target.where[0].field !== 'id' || target.where[0].value !== expected
              || Object.hasOwn(target.where[0], 'operator')) return refuse()
            cell.deleteCalls++; cell.deletionId = undefined
            if (Schema.decodeUnknownSync(finishInput, { onExcessProperty: 'error' })(call.input ?? {}).fault === 'key-delete-noop'
              && !cell.omitted) {
              cell.omitted = true; events.push('q3-native-key-delete-effect-omitted'); return
            }
            const value = await originalGeneric.delete(...args)
            binding(ctx.request)
            return value
          },
        }
        nestedDeletionAdmitted++
        return { context: { context: { internalAdapter: internal, adapter: generic,
          session: ctx.context.session, authCookies: ctx.context.authCookies,
          createAuthCookie: ctx.context.createAuthCookie, socialProviders: ctx.context.socialProviders } } }
      }
      forwarded++
      const snapshot = JSON.stringify({ cookies: ctx.context.authCookies, advanced: ctx.context.options.advanced,
        session: ctx.context.options.session, sessionConfig: ctx.context.sessionConfig })
      if (ordinaryCookieSnapshot === undefined) {
        ordinaryCookieSnapshot = snapshot; ordinaryCookieObjects = ctx.context.authCookies
        ordinaryCookieFactory = ctx.context.createAuthCookie
        ordinaryAuxiliary = JSON.stringify(ctx.context.createAuthCookie('qualification_ordinary_aux', { maxAge: 17 }))
      }
      invariant(ordinaryCookieSnapshot === snapshot && ordinaryCookieObjects === ctx.context.authCookies
        && ordinaryCookieFactory === ctx.context.createAuthCookie
        && ordinaryAuxiliary === JSON.stringify(ctx.context.createAuthCookie('qualification_ordinary_aux', { maxAge: 17 })))
      return before.handler({ ...ctx, returnHeaders: false })
    }) }], after: [{ matcher: (ctx: { path?: string }) => ctx.path === '/passkey/verify-registration', handler: createAuthMiddleware(async ctx => {
      const call = ctx.request && calls.get(ctx.request)
      if (!call?.q2 || call.q2.path !== '/passkey/verify-registration') return
      binding(ctx.request)
      if (ctx.context.returned instanceof APIError || ctx.context.returned instanceof Response && !ctx.context.returned.ok) return
      const native = Schema.decodeUnknownSync(registrationResult)(ctx.context.returned)
      const [row] = await call.lease.db.select().from(passkey).where(eq(passkey.id, native.id))
      const remaining = await call.lease.db.select().from(verification).where(eq(verification.identifier, call.q2.registrationId!))
      if (!row || native.userId !== userId || row.userId !== userId || row.credentialID !== native.credentialID
        || remaining.length !== 0 || call.q2.nativeConsume !== 1 || call.q2.callback !== 1) return refuse()
      await call.lease.db.update(qualificationWitness).set({ q2: {
        selector: call.q2.selector, sessionId: call.q2.sessionId, generation: call.q2.generation,
        registrationId: call.q2.registrationId!, keyId: native.id, assertionId: null, tested: false,
      } }).where(eq(qualificationWitness.userId, userId!))
      events.push('q2-registration-after-observed-consume-and-row')
      const input = Schema.decodeUnknownSync(registrationInput, { onExcessProperty: 'error' })(call.input)
      if (input.fault === 'registration-after') {
        await Promise.resolve(); events.push('fault:q2-registration-after'); throw new Error('Q2 awaited registration after-hook fault')
      }
    }) }, { matcher: (ctx: { path?: string }) => ctx.path === qualificationPath, handler: createAuthMiddleware(async ctx => {
      const call = ctx.request && calls.get(ctx.request)
      if (call?.action !== 'q3-finish' || !call.q3) return
      binding(ctx.request)
      if (ctx.context.returned instanceof APIError || ctx.context.returned instanceof Response && !ctx.context.returned.ok) return
      const receipt = Schema.decodeUnknownSync(receiptSchema, { onExcessProperty: 'error' })(ctx.context.returned)
      if (!receipt.ok || receipt.phase !== 'finished' || receipt.keyId !== call.q3.retained.id) return refuse()
      const queued = ctx.context.responseHeaders
      invariant(queued)
      await verifyQ3Final(call.q3, call.lease, ctx, queued)
      events.push('q3-finish-after-all-effects-verified')
      const input = Schema.decodeUnknownSync(finishInput, { onExcessProperty: 'error' })(call.input ?? {})
      if (input.fault === 'finish-after') {
        await Promise.resolve()
        events.push('fault:q3-finish-after-all-effects')
        throw new Error('Q3 awaited finish after-hook fault')
      }
    }) }] } }
  }
  function databaseHooks(): NonNullable<BetterAuthOptions['databaseHooks']> {
    return { session: { update: {
      before: async data => {
        if (fault === 'update-veto') return false
        if (fault === 'update-token') return { data: { ...data, token: randomUUID() } }
        if (fault === 'update-lifetime') return { data: { ...data, expiresAt: new Date(Date.now() + 60000) } }
      }, after: async () => { afterHooks++; events.push('update-after'); if (fault === 'update-after') {
        await Promise.resolve(); events.push('fault:update-after'); throw new Error('Qualification awaited update hook')
      } },
    }, delete: {
      before: async data => {
        if (fault !== 'delete-veto') return undefined
        const cell = q3Revocations.get(owner.invocationOptions())
        if (cell) {
          binding(cell.request)
          invariant(cell.phase === 'session-revocation' && cell.oldSessions.some(row => row.id === data.id
            && row.token === data.token && row.userId === data.userId))
          events.push('q3-native-session-delete-before-veto-reached')
        }
        return false
      },
      after: async () => { afterHooks++; events.push('delete-after'); if (fault === 'delete-after') {
        await Promise.resolve(); events.push('fault:delete-after'); throw new Error('Qualification awaited delete hook')
      } },
    } } }
  }
  async function invoke(request: Request, action: QualificationAction, native: (request: Request) => Promise<unknown>, selector?: string,
    settings: { seedAmbient?: boolean; deadlineAtMs?: number; afterCommitFailure?: boolean; input?: unknown } = {}) {
    Schema.decodeUnknownSync(actionSchema)(action)
    if (selector !== undefined) Schema.decodeUnknownSync(selectorSchema)(selector)
    if (request.method !== 'POST' || request.headers.get('origin') !== origin || new URL(request.url).origin !== origin
      || request.headers.get('sec-fetch-site') === 'cross-site') return refuse()
    const result = await owner.runAuthInvocation({ deadlineAtMs: settings.deadlineAtMs ?? Date.now() + 15000,
      statementTimeoutMs: 1000, cleanupTimeoutMs: 1000, correlationId: randomUUID(), signal: request.signal }, () =>
      owner.withAuthPromise(owner.invocationOptions(), async lease => {
        const call = { action, selector, seedAmbient: settings.seedAmbient ?? false, input: settings.input,
          lease, invocation: owner.invocationOptions(), active: true,
          q2: undefined as { path: '/passkey/generate-register-options' | '/passkey/verify-registration'; selector: string;
            sessionId: string; generation: number; registrationId?: string; context: string; expiresAt: number;
          nativeCreate?: number; nativeConsume?: number; callback?: number; consumedExpiresAt?: number } | undefined,
          q3: undefined as Q3Cell | undefined }
        invariant(!calls.has(request)); calls.set(request, call)
        try {
          const result = await native(request)
          if (!(result instanceof Response) || !result.ok && !(action === 'clear-error' && result.status === 401)) throw new Error('Qualification native dispatch refused')
          try {
            if (action === 'clear-error') {
              Schema.decodeUnknownSync(Schema.Struct({ message: Schema.Literal('Qualification native clear refusal') }), { onExcessProperty: 'error' })(await result.clone().json())
            } else {
              const receipt = Schema.decodeUnknownSync(receiptSchema, { onExcessProperty: 'error' })(await result.clone().json())
              invariant(receipt.ok)
            }
          } catch { throw new Error('Qualification native receipt refused') }
          binding(request)
          return result
        } finally { call.active = false; calls.delete(request) }
      }))
    events.push('physical-owner-committed')
    if (settings.afterCommitFailure) { events.push('response-failed-after-physical-commit'); throw new Error('Qualification response failed after commit') }
    return result
  }
  return { plugin: { id: 'qualification-recovery-native', endpoints: { qualifyRecoveryNative: endpoint } }, admission,
    registration, capturePasskey, databaseHooks, invoke,
    bindUser(id: string) { invariant(!userId); userId = id }, setFault(value: QualificationFault) { fault = value },
    captureAmbient(value: AuthContext['session']) { invariant(value && value.session.id && value.user.id); capturedAmbient = value },
    evidence: () => ({ mode, nativeCalls, admitted, forwarded, authoritativeReads, afterHooks,
      nestedAdmissions: { options: nestedOptionsAdmitted, registration: nestedRegistrationAdmitted, deletion: nestedDeletionAdmitted }, events: [...events] }),
  }
}
export type RecoveryNativeQualification = ReturnType<typeof createRecoveryNativeQualification>
