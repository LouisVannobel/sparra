import type { AuthContext } from 'better-auth'
import { addOAuthServerContext, createAuthEndpoint } from 'better-auth/api'
import { generateIdTokenNonce, generateState, parseState } from 'better-auth/oauth2'
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { Schema } from 'effect'
import { PgTransactionError } from '../../platform/db/auth-pg-lease.server'
import type { AuthTransactions } from '../../platform/db/transactions.server'
import { requestAuthDeadlineAtMs } from '../../platform/resources.server'
import type { createAuthRateLimiter } from './rate-limit.server'
import { recoveryAttempt, verification } from './schema.server'
import { RecoveryRejected, advanceRecoveryRotationKey, cleanupRecoveryRotationChallenges, finishRecoveryRotation,
  lockRotationState, prepareRecoveryRotation, recheckRotationState, validateRecoveryRotationFinish, type RotationState } from './recovery.server'
import { cleanupRecoveryGoogleAttempts, lockRecoveryGoogleByCode, lockRecoveryGoogleAttempt, recheckRecoveryGoogle, recoveryDatabaseTime, recoveryGoogleCallbackPath,
  recoveryGooglePurpose, recoveryIssuer, recoveryProofIdentifier, validateRecoveryGoogleBegin, type GoogleState, type RecoveryLease } from './recovery.server'

class RecoveryUnavailable extends Error { constructor() { super('Authentication unavailable') } }
class RecoveryUnconfirmed extends Error { constructor() { super('Authentication outcome unconfirmed') } }
export function classifyRecoveryFailure(error: unknown, stage: 'before-commit' | 'after-confirmed-commit'): Error {
  if (stage === 'after-confirmed-commit') return new RecoveryUnconfirmed()
  if (error instanceof PgTransactionError || error instanceof RecoveryRejected) return error
  return new RecoveryUnavailable()
}

type Adapter = AuthContext['internalAdapter']
type RotationPhase = 'outer' | 'session' | 'write'
export type RecoveryRotationInvocation = Readonly<{
  assert(operation: RotationPhase, request?: Request): void
  constrain(adapter: Adapter, operation: RotationPhase, request?: Request): Adapter
  execute(adapter: Adapter, headers: Headers, request?: Request): Promise<{ completed: true }>
}>
export function recoveryRotationEndpoints(bound: (request?: Request) => RecoveryRotationInvocation | undefined) {
  return { rotateApplicationRecoveryCodes: createAuthEndpoint('/application/recovery/codes/rotate',
    { method: 'POST', metadata: { SERVER_ONLY: true } }, async ctx => {
      const authority = bound(ctx.request)
      if (!authority) throw new RecoveryRejected()
      authority.assert('outer', ctx.request)
      return authority.execute(ctx.context.internalAdapter, ctx.responseHeaders, ctx.request)
    }) }
}
type RotationNative = {
  session(request: Request): Promise<{ response: { user: { id: string }; session: { id: string } } | null; headers: Headers }>
  execute(request: Request): Promise<{ response: { completed: true }; headers: Headers }>
}
export function validateRecoverySessionResult(value: unknown): { user: { id: string }; session: { id: string } } {
  if (!value || typeof value !== 'object' || value instanceof Response || !('response' in value) || !('headers' in value)
    || !(value.headers instanceof Headers) || value.headers.getSetCookie().length || value.headers.has('location')
    || !value.response || typeof value.response !== 'object' || !('user' in value.response) || !('session' in value.response)
    || !value.response.user || typeof value.response.user !== 'object' || !('id' in value.response.user)
    || typeof value.response.user.id !== 'string' || !value.response.user.id
    || !value.response.session || typeof value.response.session !== 'object' || !('id' in value.response.session)
    || typeof value.response.session.id !== 'string' || !value.response.session.id) throw new RecoveryUnavailable()
  return { user: { id: value.response.user.id }, session: { id: value.response.session.id } }
}
function validateRotationResult(value: unknown) {
  if (!value || typeof value !== 'object' || !('response' in value) || !('headers' in value)
    || !(value.headers instanceof Headers) || !value.response || typeof value.response !== 'object'
    || Object.keys(value.response).length !== 1 || !('completed' in value.response) || value.response.completed !== true
    || value.headers.getSetCookie().length || value.headers.has('location')) throw new Error('Authentication unavailable')
}
function validateRotationHeaders(headers: Headers) {
  if (!(headers instanceof Headers) || headers.getSetCookie().length || headers.has('location')) throw new RecoveryUnavailable()
}
export function createRecoveryRotationCommands(owner: AuthTransactions, origin: string, limiter: ReturnType<typeof createAuthRateLimiter>,
  invoke: <A>(request: Request, call: () => Promise<A>) => Promise<A>, native: RotationNative) {
  const key = Symbol('recovery rotation invocation')
  function bound(request?: Request): RecoveryRotationInvocation | undefined {
    const descriptor = request && Object.getOwnPropertyDescriptor(request, key)
    if (!descriptor) return undefined
    if (descriptor.enumerable || descriptor.writable || !descriptor.configurable || !('value' in descriptor)) throw new RecoveryRejected()
    return (request as Request & { [key]: RecoveryRotationInvocation })[key]
  }
  async function command(request: Request, name: 'beginRecoveryCodeRotation' | 'finishRecoveryCodeRotation', input?: unknown) {
    owner.assertNoActiveAuthTransaction(); requestAuthDeadlineAtMs(request)
    if (request.method !== 'POST' || request.headers.get('origin') !== origin || request.headers.get('sec-fetch-site') === 'cross-site') throw new RecoveryRejected()
    await limiter.consumeAuthAttempt(name, limiter.trustedClientContext(request))
    const selected = name === 'finishRecoveryCodeRotation' ? validateRecoveryRotationFinish(input) : undefined
    let committed = false
    try { return await invoke(request, async () => {
      if (!Object.isExtensible(request) || Object.hasOwn(request, key)) throw new RecoveryRejected()
      const invocation = owner.invocationOptions()
      let active = true, phase: RotationPhase = 'outer', used = false
      let lease: RecoveryLease | undefined, leaseInvocation: ReturnType<AuthTransactions['invocationOptions']> | undefined
      let outcome: { kind: 'begin'; value: { challengeId: string; expiresAt: string; options: Awaited<ReturnType<typeof prepareRecoveryRotation>>['options'] } }
        | { kind: 'finish'; value: { codes: readonly string[] } } | undefined
      let state: RotationState | undefined, prepared: Awaited<ReturnType<typeof prepareRecoveryRotation>> | undefined
      let allowance: 'create' | 'consume' | 'cleanup' | undefined, cleanupIdentifier: string | undefined
      let readToken: string | undefined
      const assert = (operation: RotationPhase, candidate = request) => {
        const descriptor = Object.getOwnPropertyDescriptor(request, key)
        if (!active || candidate !== request || operation !== phase
          || owner.invocationOptions() !== (operation === 'outer' ? invocation : leaseInvocation)
          || operation !== 'outer' && (!lease || owner.currentDb() !== lease.db)
          || !descriptor || descriptor.value !== cell || descriptor.enumerable || descriptor.writable || !descriptor.configurable) throw new RecoveryRejected()
        if (operation === 'outer') {
          try { owner.assertNoActiveAuthTransaction() } catch { throw new RecoveryRejected() }
        }
      }
      const deny = async (): Promise<never> => { throw new RecoveryRejected() }
      const cell: RecoveryRotationInvocation = Object.freeze({ assert,
        constrain(original, operation, candidate) {
          assert(operation, candidate)
          return { ...original,
            createSession: deny, updateSession: deny, deleteSessions: deny, deleteUserSessions: deny, refreshUserSessions: deny,
            createUser: deny, updateUser: deny, deleteUser: deny, updateUserByEmail: deny, updatePassword: deny, createOAuthUser: deny,
            createAccount: deny, updateAccount: deny, deleteAccount: deny, deleteAccounts: deny, linkAccount: deny,
            findVerificationValue: deny, updateVerificationByIdentifier: deny, reserveVerificationValue: deny,
            async findSession(token) {
              assert('session', candidate)
              if (readToken !== undefined) throw new RecoveryRejected()
              readToken = token
              const value = await original.findSession(token); assert('session', candidate); return value
            },
            deleteSession: deny,
            async createVerificationValue(data) {
              assert('write', candidate)
              if (allowance !== 'create' || !prepared || JSON.stringify(data) !== JSON.stringify(prepared.data)) throw new RecoveryRejected()
              allowance = undefined
              const value = await original.createVerificationValue(data); assert('write', candidate); return value
            },
            async consumeVerificationValue(identifier) {
              assert('write', candidate)
              if (allowance !== 'consume' || identifier !== state?.verification?.identifier) throw new RecoveryRejected()
              allowance = undefined
              const value = await original.consumeVerificationValue(identifier); assert('write', candidate); return value
            },
            async deleteVerificationByIdentifier(identifier) {
              assert('write', candidate)
              if (allowance !== 'cleanup' || identifier !== cleanupIdentifier) throw new RecoveryRejected()
              allowance = undefined
              await original.deleteVerificationByIdentifier(identifier); assert('write', candidate)
            },
          }
        },
        async execute(adapter, headers, candidate) {
          assert('outer', candidate)
          if (used) throw new RecoveryRejected()
          used = true
          const settled = await owner.withAuthPromise(invocation, async current => {
            lease = current; leaseInvocation = owner.invocationOptions(); phase = 'session'
            try {
              const ambient = validateRecoverySessionResult(await native.session(request)); assert('session', candidate)
              const locked = await lockRotationState(current, ambient, selected)
              state = locked
              if (selected) await advanceRecoveryRotationKey(current, locked, selected.response, origin)
              else prepared = await prepareRecoveryRotation(current, locked, origin)
              phase = 'write'
              if (prepared) {
                await cleanupRecoveryRotationChallenges(current, locked.user.id, async identifier => {
                  allowance = 'cleanup'; cleanupIdentifier = identifier
                  await adapter.deleteVerificationByIdentifier(identifier); assert('write', candidate)
                  if (allowance !== undefined) throw new RecoveryRejected()
                  cleanupIdentifier = undefined
                })
                allowance = 'create'
                const created = await adapter.createVerificationValue(prepared.data); assert('write', candidate)
                if (!created || created.identifier !== prepared.data.identifier || created.value !== prepared.data.value
                  || created.expiresAt.getTime() !== prepared.data.expiresAt.getTime()) throw new RecoveryRejected()
                const rows = await current.db.select().from(verification).where(eq(verification.identifier, prepared.data.identifier)).limit(2)
                if (rows.length !== 1 || rows[0].id !== created.id || rows[0].value !== created.value
                  || rows[0].expiresAt.getTime() !== created.expiresAt.getTime()
                  || rows[0].createdAt.getTime() !== created.createdAt.getTime()
                  || rows[0].updatedAt.getTime() !== created.updatedAt.getTime()) throw new RecoveryRejected()
              } else {
                const row = locked.verification
                if (!row) throw new RecoveryRejected()
                allowance = 'consume'
                const consumed = await adapter.consumeVerificationValue(row.identifier); assert('write', candidate)
                if (!consumed || consumed.id !== row.id || consumed.identifier !== row.identifier || consumed.value !== row.value
                  || consumed.expiresAt.getTime() !== row.expiresAt.getTime() || consumed.createdAt.getTime() !== row.createdAt.getTime()
                  || consumed.updatedAt.getTime() !== row.updatedAt.getTime()) throw new RecoveryRejected()
                const remaining = await current.db.select({ id: verification.id }).from(verification).where(eq(verification.identifier, row.identifier)).limit(1)
                if (remaining.length) throw new RecoveryRejected()
              }
              if (allowance !== undefined) throw new RecoveryRejected()
              validateRotationHeaders(headers); assert('write', candidate)
              phase = 'session'; readToken = undefined
              const reread = validateRecoverySessionResult(await native.session(request)); assert('session', candidate)
              if (reread.user.id !== locked.user.id || reread.session.id !== locked.session.id) throw new RecoveryRejected()
              await recheckRotationState(current, locked); assert('session', candidate)
              if (prepared) {
                if (Date.parse(prepared.expiresAt) <= (await recoveryDatabaseTime(current)).getTime()) throw new RecoveryRejected()
                validateRotationHeaders(headers); assert('session', candidate)
                return { kind: 'begin' as const, value: { challengeId: prepared.challengeId, expiresAt: prepared.expiresAt, options: prepared.options } }
              }
              if (!selected) throw new RecoveryRejected()
              const codes = await finishRecoveryRotation(current, locked, selected.challengeId, invocation.correlationId); assert('session', candidate)
              validateRotationHeaders(headers); assert('session', candidate)
              return { kind: 'finish' as const, value: { codes } }
            } finally {
              lease = undefined; leaseInvocation = undefined; phase = 'outer'
              readToken = undefined; allowance = undefined; cleanupIdentifier = undefined
            }
          })
          committed = true
          outcome = settled
          assert('outer', candidate)
          return { completed: true }
        },
      })
      try {
        Object.defineProperty(request, key, { value: cell, enumerable: false, writable: false, configurable: true })
        const result = await native.execute(request); assert('outer')
        validateRotationResult(result)
        if (!used || !outcome) throw new RecoveryUnavailable()
        return outcome
      } finally { active = false; if (!Reflect.deleteProperty(request, key)) throw new RecoveryRejected() }
    }) } catch (error) { throw classifyRecoveryFailure(error, committed ? 'after-confirmed-commit' : 'before-commit') }
  }
  return { bound,
    async beginRecoveryCodeRotation(request: Request) {
      const result = await command(request, 'beginRecoveryCodeRotation')
      if (result.kind !== 'begin') throw new RecoveryRejected()
      return result.value
    },
    async finishRecoveryCodeRotation(request: Request, input: unknown) {
      const result = await command(request, 'finishRecoveryCodeRotation', input)
      if (result.kind !== 'finish') throw new RecoveryRejected()
      return result.value
    },
  }
}

type OAuthContext = Parameters<typeof generateState>[0]
type GooglePhase = 'oauth' | 'state' | 'claim' | 'proof'
export type RecoveryGoogleInvocation = Readonly<{
  assert(operation: GooglePhase, request?: Request): void
  constrain(adapter: Adapter, request?: Request): Adapter
  oauth(ctx: OAuthContext): Promise<{ url: string } | { outcome: 'proved' }>
}>
export function recoveryGoogleEndpoints(bound: (request?: Request) => RecoveryGoogleInvocation | undefined) {
  const handler = async (ctx: OAuthContext) => {
    const authority = bound(ctx.request)
    if (!authority) throw new RecoveryRejected()
    authority.assert('oauth', ctx.request)
    return authority.oauth(ctx)
  }
  return {
    beginApplicationRecoveryGoogleProof: createAuthEndpoint('/application/recovery/google/begin',
      { method: 'POST', metadata: { SERVER_ONLY: true } }, handler),
    completeApplicationRecoveryGoogleProof: createAuthEndpoint('/application/recovery/google/complete',
      { method: 'GET', metadata: { SERVER_ONLY: true } }, handler),
  }
}
type GoogleNative = {
  begin(request: Request): Promise<{ response: { url: string } | { outcome: 'proved' }; headers: Headers }>
  complete(request: Request): Promise<{ response: { url: string } | { outcome: 'proved' }; headers: Headers }>
}
const googleContext = Schema.Struct({ purpose: Schema.Literal('recovery-google-proof'), attemptId: Schema.String })
const googleState = Schema.Struct({ oauthState: Schema.String, callbackURL: Schema.String, errorURL: Schema.String,
  codeVerifier: Schema.String, idTokenNonce: Schema.String, expiresAt: Schema.Number, serverContext: googleContext })
const proofValue = Schema.Struct({ version: Schema.Literal(1), purpose: Schema.Literal('recovery-google-proof'), userId: Schema.String,
  attemptId: Schema.String, recoveryGeneration: Schema.Int, batchId: Schema.String, codeId: Schema.String,
  googleAccountId: Schema.String, issuer: Schema.Literal('https://accounts.google.com'), subject: Schema.String,
  expiresAt: Schema.String })
export function validateRecoveryStateHeaders(headers: Headers, cookieName: string, phase: 'begin' | 'complete'): Headers {
  if (!(headers instanceof Headers) || !cookieName || !/^__Secure-better-auth\.state$/.test(cookieName)) throw new RecoveryUnavailable()
  const released = new Headers()
  if (headers.has('location')) throw new RecoveryUnavailable()
  const cookies = headers.getSetCookie()
  if (cookies.length !== 1) throw new RecoveryUnavailable()
  const cookie = cookies[0], first = cookie.split(';', 1)[0]
  if (!first.startsWith(cookieName + '=') || phase === 'begin' && first.length <= cookieName.length + 1
    || phase === 'complete' && first !== cookieName + '='
    || !/(?:^|;\s*)Path=\/(?:;|$)/i.test(cookie) || !/(?:^|;\s*)HttpOnly(?:;|$)/i.test(cookie)
    || !/(?:^|;\s*)Secure(?:;|$)/i.test(cookie) || !/(?:^|;\s*)SameSite=Lax(?:;|$)/i.test(cookie)
    || /(?:^|;\s*)Domain=/i.test(cookie) || !(phase === 'begin'
      ? /(?:^|;\s*)Max-Age=300(?:;|$)/i.test(cookie)
      : /(?:^|;\s*)Max-Age=0(?:;|$)/i.test(cookie))) throw new RecoveryUnavailable()
  for (const cookie of cookies) released.append('set-cookie', cookie)
  return released
}
function validateGoogleNative(value: unknown, cookieName: string, phase: 'begin' | 'complete') {
  if (!value || typeof value !== 'object' || !('response' in value) || !('headers' in value)
    || !(value.headers instanceof Headers) || !value.response || typeof value.response !== 'object'
    || Object.keys(value.response).length !== 1) throw new Error('Authentication unavailable')
  const response = value.response
  if (phase === 'begin' ? !('url' in response) || typeof response.url !== 'string' || !response.url
    : !('outcome' in response) || response.outcome !== 'proved') throw new Error('Authentication unavailable')
  return { response, headers: validateRecoveryStateHeaders(value.headers, cookieName, phase) }
}
export function createRecoveryGoogleCommands(owner: AuthTransactions, origin: string, configured: boolean,
  limiter: ReturnType<typeof createAuthRateLimiter>, invoke: <A>(request: Request, call: () => Promise<A>) => Promise<A>, native: GoogleNative) {
  const key = Symbol('recovery Google invocation'), canonical = origin + recoveryGoogleCallbackPath
  function bound(request?: Request): RecoveryGoogleInvocation | undefined {
    const descriptor = request && Object.getOwnPropertyDescriptor(request, key)
    if (!descriptor) return undefined
    if (descriptor.enumerable || descriptor.writable || !descriptor.configurable || !('value' in descriptor)) throw new RecoveryRejected()
    return (request as Request & { [key]: RecoveryGoogleInvocation })[key]
  }
  async function command(request: Request, name: 'beginRecoveryGoogleProof' | 'completeRecoveryGoogleProof', input?: unknown) {
    owner.assertNoActiveAuthTransaction(); requestAuthDeadlineAtMs(request)
    const callback = name === 'completeRecoveryGoogleProof'
    if (callback ? request.method !== 'GET' || !(request.url === canonical || request.url.startsWith(canonical + '?'))
      : request.method !== 'POST' || request.headers.get('origin') !== origin || request.headers.get('sec-fetch-site') === 'cross-site')
      throw new RecoveryRejected()
    await limiter.consumeAuthAttempt(name, limiter.trustedClientContext(request))
    if (!configured) throw new RecoveryRejected()
    const selected = callback ? undefined : validateRecoveryGoogleBegin(input)
    const params = callback ? new URL(request.url).searchParams : undefined
    const oauthState = callback ? params?.get('state') : undefined
    const code = callback ? params?.get('code') : undefined
    if (callback && (request.url.length > 8192 || params!.getAll('state').length !== 1 || params!.getAll('code').length !== 1
      || params!.has('error') || !oauthState || oauthState.length > 1024 || !code || code.length > 4096
      || [...params!.keys()].some(key => key !== 'state' && key !== 'code'))) throw new RecoveryRejected()
    let stateCommitted = false, claimConfirmed = false, proofCommitted = false
    try { return await invoke(request, async () => {
      if (!Object.isExtensible(request) || Object.hasOwn(request, key)) throw new RecoveryRejected()
      const invocation = owner.invocationOptions()
      let active = true, phase: GooglePhase = 'oauth', lease: RecoveryLease | undefined
      let leaseInvocation: ReturnType<AuthTransactions['invocationOptions']> | undefined
      let state: GoogleState | undefined, originalAttempt: typeof recoveryAttempt.$inferSelect | undefined
      let exchangeUsed = false, proofUsed = false, cookieName: string | undefined
      let expectedState: string | undefined, expectedStateValue: string | undefined, expectedStateExpiresAtMs: number | undefined
      let expectedProof: { identifier: string; value: string; expiresAt: Date } | undefined
      let createdStateRow: Awaited<ReturnType<Adapter['createVerificationValue']>> | undefined
      let createdProofRow: Awaited<ReturnType<Adapter['createVerificationValue']>> | undefined
      let stateCreated = false, stateRead = false, stateDeleted = false
      let cleanupIdentifier: string | undefined
      let lockedStateRow: typeof verification.$inferSelect | undefined
      const assert = (operation: GooglePhase, candidate = request) => {
        const descriptor = Object.getOwnPropertyDescriptor(request, key)
        if (!active || candidate !== request || operation !== phase
          || owner.invocationOptions() !== (operation === 'oauth' ? invocation : leaseInvocation)
          || operation !== 'oauth' && (!lease || owner.currentDb() !== lease.db)
          || !descriptor || descriptor.value !== cell || descriptor.enumerable || descriptor.writable || !descriptor.configurable) throw new RecoveryRejected()
      }
      const deny = async (): Promise<never> => { throw new RecoveryRejected() }
      const cell: RecoveryGoogleInvocation = Object.freeze({ assert,
        constrain(original, candidate) {
          assert('oauth', candidate)
          return { ...original,
            createSession: deny, updateSession: deny, deleteSession: deny, deleteSessions: deny, deleteUserSessions: deny, refreshUserSessions: deny,
            createUser: deny, updateUser: deny, deleteUser: deny, updateUserByEmail: deny, updatePassword: deny, createOAuthUser: deny,
            createAccount: deny, updateAccount: deny, deleteAccount: deny, deleteAccounts: deny, linkAccount: deny,
            updateVerificationByIdentifier: deny, reserveVerificationValue: deny, consumeVerificationValue: deny,
            async createVerificationValue(data) {
              if (phase !== 'state' && phase !== 'proof') throw new RecoveryRejected()
              assert(phase, candidate)
              let requestedState: { identifier: string; value: string; expiresAtMs: number } | undefined
              if (phase === 'state') {
                if (stateCreated || !state || !state.attempt || !data.identifier) throw new RecoveryRejected()
                let payload: typeof googleState.Type
                try { payload = Schema.decodeUnknownSync(googleState)(JSON.parse(data.value), { onExcessProperty: 'error' }) }
                catch { throw new RecoveryRejected() }
                if (payload.oauthState !== data.identifier || payload.callbackURL !== origin + '/login' || payload.errorURL !== origin + '/login'
                  || !payload.codeVerifier || !payload.idTokenNonce || payload.serverContext.attemptId !== state.attempt?.id
                  || data.expiresAt.getTime() <= state.attempt.expiresAt.getTime())
                  throw new RecoveryRejected()
                requestedState = { identifier: data.identifier, value: data.value, expiresAtMs: data.expiresAt.getTime() }
                expectedState = requestedState.identifier; expectedStateValue = requestedState.value
                expectedStateExpiresAtMs = requestedState.expiresAtMs; stateCreated = true
              } else {
                if (proofUsed || !state?.attempt || !expectedProof || data.identifier !== expectedProof.identifier
                  || data.value !== expectedProof.value || data.expiresAt.getTime() !== expectedProof.expiresAt.getTime()) throw new RecoveryRejected()
                proofUsed = true
              }
              const result = await original.createVerificationValue(data); assert(phase, candidate)
              if (phase === 'state') {
                if (!requestedState || !result || result.identifier !== requestedState.identifier || result.value !== requestedState.value
                  || result.expiresAt.getTime() !== requestedState.expiresAtMs) throw new RecoveryRejected()
                createdStateRow = result
              }
              else createdProofRow = result
              return result
            },
            async findVerificationValue(identifier) {
              assert('claim', candidate)
              if (stateRead || identifier !== expectedState) throw new RecoveryRejected()
              stateRead = true
              const value = await original.findVerificationValue(identifier); assert('claim', candidate)
              if (!value || !lockedStateRow || value.id !== lockedStateRow.id || value.identifier !== lockedStateRow.identifier
                || value.value !== lockedStateRow.value || value.expiresAt.getTime() !== lockedStateRow.expiresAt.getTime()
                || value.createdAt.getTime() !== lockedStateRow.createdAt.getTime()
                || value.updatedAt.getTime() !== lockedStateRow.updatedAt.getTime()) throw new RecoveryRejected()
              return value
            },
            async deleteVerificationByIdentifier(identifier) {
              if (phase === 'state') {
                assert('state', candidate)
                if (!cleanupIdentifier || identifier !== cleanupIdentifier) throw new RecoveryRejected()
                cleanupIdentifier = undefined
                await original.deleteVerificationByIdentifier(identifier); assert('state', candidate)
                return
              }
              assert('claim', candidate)
              if (stateDeleted || !stateRead || identifier !== expectedState) throw new RecoveryRejected()
              stateDeleted = true
              await original.deleteVerificationByIdentifier(identifier); assert('claim', candidate)
            },
          }
        },
        async oauth(ctx) {
          assert('oauth', ctx.request)
          cookieName = ctx.context.createAuthCookie('state').name
          const provider = ctx.context.socialProviders.find(item => item.id === 'google')
          if (!provider) throw new RecoveryRejected()
          if (!callback) {
            const nonce = generateIdTokenNonce(provider)
            if (!nonce || !selected) throw new RecoveryRejected()
            const generated = await owner.withAuthPromise(invocation, async current => {
              lease = current; leaseInvocation = owner.invocationOptions(); phase = 'state'
              try {
                state = await lockRecoveryGoogleByCode(current, selected.email, selected.code)
                await cleanupRecoveryGoogleAttempts(current, state.user.id, origin, async identifier => {
                  cleanupIdentifier = identifier
                  await ctx.context.internalAdapter.deleteVerificationByIdentifier(identifier); assert('state')
                  if (cleanupIdentifier !== undefined) throw new RecoveryRejected()
                })
                const now = await recoveryDatabaseTime(current)
                const attemptId = randomUUID()
                const expiresAt = new Date(now.getTime() + 300000)
                state.attempt = { id: attemptId, userId: state.user.id, recoveryGeneration: state.user.recoveryGeneration,
                  batchId: state.batch.batchId, codeId: state.code.id, googleAccountId: state.account.id, issuer: recoveryIssuer,
                  subject: state.account.accountId, oauthState: '', createdAt: now, expiresAt, phase: 'PENDING_GOOGLE' }
                await addOAuthServerContext({ purpose: recoveryGooglePurpose, attemptId })
                ctx.body = { callbackURL: origin + '/login', errorCallbackURL: origin + '/login' }
                // generateState chooses the native state. Its adapter write is
                // confined to this owner; the generated spelling is captured
                // by the adapter only after native validation has created it.
                const minted = await generateState(ctx, { idTokenNonce: nonce })
                if (!stateCreated || !minted.state || expectedState !== minted.state) throw new RecoveryRejected()
                validateRecoveryStateHeaders(ctx.responseHeaders, cookieName!, 'begin'); assert('state')
                const rows = await current.db.select().from(verification).where(eq(verification.identifier, minted.state)).limit(2)
                if (!createdStateRow || rows.length !== 1 || rows[0].id !== createdStateRow.id || rows[0].identifier !== minted.state
                  || rows[0].value !== expectedStateValue || rows[0].expiresAt.getTime() !== expectedStateExpiresAtMs
                  || rows[0].expiresAt.getTime() !== createdStateRow.expiresAt.getTime()
                  || rows[0].createdAt.getTime() !== createdStateRow.createdAt.getTime()
                  || rows[0].updatedAt.getTime() !== createdStateRow.updatedAt.getTime()) throw new RecoveryRejected()
                state.attempt.oauthState = minted.state
                const inserted = await current.db.insert(recoveryAttempt).values(state.attempt).returning()
                if (inserted.length !== 1) throw new RecoveryRejected()
                state.attempt = inserted[0]
                originalAttempt = { ...inserted[0], createdAt: new Date(inserted[0].createdAt), expiresAt: new Date(inserted[0].expiresAt) }
                await recheckRecoveryGoogle(current, state, originalAttempt, 'PENDING_GOOGLE')
                validateRecoveryStateHeaders(ctx.responseHeaders, cookieName!, 'begin'); assert('state')
                return minted
              } finally { lease = undefined; leaseInvocation = undefined; phase = 'oauth' }
            })
            stateCommitted = true
            assert('oauth'); owner.assertNoActiveAuthTransaction()
            const url = await provider.createAuthorizationURL({ state: generated.state, codeVerifier: generated.codeVerifier,
              redirectURI: canonical, idTokenNonce: nonce, additionalParams: { prompt: 'select_account' } })
            assert('oauth'); return { url: url.toString() }
          }
          if (!oauthState || !code) throw new RecoveryRejected()
          let parsed: Awaited<ReturnType<typeof parseState>> | undefined
          await owner.withAuthPromise(invocation, async current => {
            lease = current; leaseInvocation = owner.invocationOptions(); phase = 'claim'
            try {
              state = await lockRecoveryGoogleAttempt(current, oauthState)
              if (!state.attempt || state.attempt.phase !== 'PENDING_GOOGLE') throw new RecoveryRejected()
              originalAttempt = { ...state.attempt, createdAt: new Date(state.attempt.createdAt), expiresAt: new Date(state.attempt.expiresAt) }
              expectedState = oauthState
              const rows = await current.db.select().from(verification).where(eq(verification.identifier, oauthState)).limit(2).for('update')
              if (rows.length !== 1) throw new RecoveryRejected()
              lockedStateRow = rows[0]
              let stored: typeof googleState.Type
              try { stored = Schema.decodeUnknownSync(googleState)(JSON.parse(rows[0].value), { onExcessProperty: 'error' }) }
              catch { throw new RecoveryRejected() }
              if (stored.oauthState !== oauthState || stored.serverContext.attemptId !== state.attempt.id
                || stored.callbackURL !== origin + '/login' || stored.errorURL !== origin + '/login'
                || !stored.idTokenNonce || !stored.codeVerifier) throw new RecoveryRejected()
              const afterStateLock = await recoveryDatabaseTime(current); assert('claim')
              if (state.attempt.expiresAt.getTime() <= afterStateLock.getTime()) throw new RecoveryRejected()
              ctx.query = { state: oauthState }
              parsed = await parseState(ctx)
              validateRecoveryStateHeaders(ctx.responseHeaders, cookieName!, 'complete'); assert('claim')
              if (!stateRead || !stateDeleted || !parsed || parsed.oauthState !== oauthState
                || parsed.callbackURL !== origin + '/login' || parsed.link || !parsed.idTokenNonce || !parsed.codeVerifier
                || JSON.stringify(parsed.serverContext) !== JSON.stringify(stored.serverContext)) throw new RecoveryRejected()
              const remaining = await current.db.select({ id: verification.id }).from(verification).where(eq(verification.identifier, oauthState)).limit(1)
              if (remaining.length) throw new RecoveryRejected()
              const [claimed] = await current.db.update(recoveryAttempt).set({ phase: 'EXCHANGING' })
                .where(and(eq(recoveryAttempt.id, state.attempt.id), eq(recoveryAttempt.phase, 'PENDING_GOOGLE'))).returning()
              if (!claimed) throw new RecoveryRejected()
              state.attempt = claimed
              await recheckRecoveryGoogle(current, state, originalAttempt, 'EXCHANGING')
              validateRecoveryStateHeaders(ctx.responseHeaders, cookieName!, 'complete'); assert('claim')
            } finally { lease = undefined; leaseInvocation = undefined; phase = 'oauth' }
          })
          claimConfirmed = true
          assert('oauth'); owner.assertNoActiveAuthTransaction()
          if (!parsed || exchangeUsed) throw new RecoveryRejected()
          exchangeUsed = true
          const tokens = await provider.validateAuthorizationCode({ code, codeVerifier: parsed.codeVerifier, redirectURI: canonical })
          assert('oauth')
          if (!tokens) throw new RecoveryRejected()
          const profile = await provider.getUserInfo({ ...tokens, expectedIdTokenNonce: parsed.idTokenNonce })
          assert('oauth')
          if (!profile) throw new RecoveryRejected()
          const subject = await provider.accountSubject({ tokens, profile: profile.data })
          assert('oauth')
          if (!state?.attempt || subject !== state.attempt.subject) throw new RecoveryRejected()
          await owner.withAuthPromise(invocation, async current => {
            lease = current; leaseInvocation = owner.invocationOptions(); phase = 'proof'
            try {
              if (!claimConfirmed || !state?.attempt || !originalAttempt) throw new RecoveryRejected()
              await recheckRecoveryGoogle(current, state, originalAttempt, 'EXCHANGING')
              if (state.attempt.phase !== 'EXCHANGING') throw new RecoveryRejected()
              const attempt = state.attempt
              const proof = { version: 1 as const, purpose: recoveryGooglePurpose as 'recovery-google-proof', userId: attempt.userId,
                attemptId: attempt.id, recoveryGeneration: attempt.recoveryGeneration, batchId: attempt.batchId, codeId: attempt.codeId,
                googleAccountId: attempt.googleAccountId, issuer: recoveryIssuer as 'https://accounts.google.com',
                subject: attempt.subject, expiresAt: attempt.expiresAt.toISOString() }
              Schema.decodeUnknownSync(proofValue)(proof)
              expectedProof = { identifier: recoveryProofIdentifier(attempt.id), value: JSON.stringify(proof), expiresAt: attempt.expiresAt }
              const created = await ctx.context.internalAdapter.createVerificationValue(expectedProof)
              assert('proof')
              if (!proofUsed || !created || created.identifier !== expectedProof.identifier || created.value !== expectedProof.value
                || created.expiresAt.getTime() !== expectedProof.expiresAt.getTime()) throw new RecoveryRejected()
              const rows = await current.db.select().from(verification).where(eq(verification.identifier, expectedProof.identifier)).limit(2)
              if (rows.length !== 1 || rows[0].id !== created.id || rows[0].value !== created.value
                || rows[0].expiresAt.getTime() !== created.expiresAt.getTime()
                || rows[0].createdAt.getTime() !== created.createdAt.getTime()
                || rows[0].updatedAt.getTime() !== created.updatedAt.getTime()) throw new RecoveryRejected()
              const [proved] = await current.db.update(recoveryAttempt).set({ phase: 'PROVED' })
                .where(and(eq(recoveryAttempt.id, attempt.id), eq(recoveryAttempt.phase, 'EXCHANGING'))).returning()
              if (!proved) throw new RecoveryRejected()
              state.attempt = proved
              await recheckRecoveryGoogle(current, state, originalAttempt, 'PROVED')
              validateRecoveryStateHeaders(ctx.responseHeaders, cookieName!, 'complete'); assert('proof')
            } finally { lease = undefined; leaseInvocation = undefined; phase = 'oauth' }
          })
          proofCommitted = true
          assert('oauth'); return { outcome: 'proved' }
        },
      })
      try {
        Object.defineProperty(request, key, { value: cell, enumerable: false, writable: false, configurable: true })
        const raw = await (callback ? native.complete(request) : native.begin(request)); assert('oauth')
        const result = validateGoogleNative(raw, cookieName!, callback ? 'complete' : 'begin')
        if (!state?.attempt || callback && (!claimConfirmed || !proofUsed || state.attempt.phase !== 'PROVED')
          || !callback && (!stateCreated || state.attempt.phase !== 'PENDING_GOOGLE')) throw new RecoveryRejected()
        await owner.withAuthPromise(invocation, async lease => {
          if (!originalAttempt) throw new RecoveryRejected()
          await recheckRecoveryGoogle(lease, state!, originalAttempt, callback ? 'PROVED' : 'PENDING_GOOGLE')
          const identifier = callback ? expectedProof?.identifier : expectedState
          const expectedValue = callback ? expectedProof?.value : expectedStateValue
          if (!identifier || !expectedValue) throw new RecoveryRejected()
          const rows = await lease.db.select().from(verification).where(eq(verification.identifier, identifier)).limit(2)
          if (rows.length !== 1 || rows[0].value !== expectedValue
            || callback && (!createdProofRow || rows[0].id !== createdProofRow.id
              || rows[0].expiresAt.getTime() !== state!.attempt!.expiresAt.getTime())
            || !callback && (!createdStateRow || rows[0].id !== createdStateRow.id
              || rows[0].expiresAt.getTime() !== expectedStateExpiresAtMs
              || rows[0].expiresAt.getTime() !== createdStateRow.expiresAt.getTime())) throw new RecoveryRejected()
          if (callback) {
            const used = await lease.db.select({ id: verification.id }).from(verification).where(eq(verification.identifier, oauthState!)).limit(1)
            if (used.length) throw new RecoveryRejected()
          }
        })
        assert('oauth')
        if (callback) return { kind: 'complete' as const, value: { outcome: 'proved' as const, headers: result.headers } }
        if (!('url' in result.response) || typeof result.response.url !== 'string') throw new RecoveryRejected()
        return { kind: 'begin' as const, value: { url: result.response.url, headers: result.headers } }
      } finally { active = false; if (!Reflect.deleteProperty(request, key)) throw new RecoveryRejected() }
    }) } catch (error) { throw classifyRecoveryFailure(error, !callback && stateCommitted || proofCommitted ? 'after-confirmed-commit' : 'before-commit') }
  }
  return { bound,
    async beginRecoveryGoogleProof(request: Request, input: unknown) {
      const result = await command(request, 'beginRecoveryGoogleProof', input)
      if (result.kind !== 'begin') throw new RecoveryRejected()
      return result.value
    },
    async completeRecoveryGoogleProof(request: Request) {
      const result = await command(request, 'completeRecoveryGoogleProof')
      if (result.kind !== 'complete') throw new RecoveryRejected()
      return result.value
    },
  }
}
