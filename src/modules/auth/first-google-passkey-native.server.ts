import { Schema } from 'effect'
import { and, eq, inArray } from 'drizzle-orm'
import { APIError, addOAuthServerContext, createAuthEndpoint } from 'better-auth/api'
import { generateIdTokenNonce, generateState, parseState } from 'better-auth/oauth2'
import type { AuthTransactions } from '../../platform/db/transactions.server'
import { requestAuthDeadlineAtMs } from '../../platform/resources.server'
import type { createAuthRateLimiter } from './rate-limit.server'
import type { AdditionalPasskeyInvocation, AdditionalPasskeyAuthorized, AdditionalPasskeyFinishInput } from './additional-passkey.server'
import { firstGooglePasskeyIntent, passkey, verification } from './schema.server'
import { beginFirstGoogleIntent, checkFirstGoogleChallenge, FirstGooglePasskeyRejected, firstGoogleCallbackPath, firstGoogleDatabaseTime,
  firstGoogleProofWindow, firstGooglePurpose, firstGoogleStatus, lockFirstGoogleState, lockFirstGoogleVerification,
  recheckFirstGoogleState, validateFirstGoogleFinish, validateFirstGoogleTarget, type FirstGoogleLease, type FirstGoogleState } from './first-google-passkey.server'

type NativeContext = Parameters<typeof generateState>[0]
type Command = 'beginFirstGooglePasskey' | 'completeFirstGooglePasskeyOAuth' | 'readFirstGooglePasskey' | 'prepareFirstGooglePasskey' | 'finishFirstGooglePasskey' | 'cancelFirstGooglePasskey'
type Ambient = { user: { id: string }; session: { id: string } } | null
type RegistrationHooks = Omit<AdditionalPasskeyInvocation, 'command' | 'assert'>
export type FirstGoogleInvocation = RegistrationHooks & {
  command: Command
  assert(operation: 'session' | 'options' | 'complete' | 'oauth', request?: Request): void
  oauth(ctx: NativeContext): Promise<{ url: string }>
}
export function firstGoogleEndpoints(bound: (request?: Request) => FirstGoogleInvocation | undefined) {
  async function handler(ctx: NativeContext) {
    const authority = bound(ctx.request)
    if (!authority) throw new FirstGooglePasskeyRejected()
    authority.assert('oauth', ctx.request)
    return authority.oauth(ctx)
  }
  return {
    beginApplicationFirstGooglePasskey: createAuthEndpoint('/application/first-passkey/google/begin', { method: 'POST', metadata: { SERVER_ONLY: true } }, handler),
    completeApplicationFirstGooglePasskey: createAuthEndpoint('/application/first-passkey/google/complete', { method: 'GET', metadata: { SERVER_ONLY: true } }, handler),
  }
}
type NativeCalls = {
  session(request: Request): Promise<Ambient>
  begin(request: Request): Promise<{ response: { url: string }; headers: Headers }>
  complete(request: Request): Promise<{ response: { url: string }; headers: Headers }>
  options(request: Request, context: string): Promise<{ response: AdditionalPasskeyAuthorized['options']; headers: Headers }>
  finish(request: Request, response: AdditionalPasskeyFinishInput['response']): Promise<{ response: unknown; headers: Headers }>
}
const bindingSchema = Schema.Struct({ id: Schema.NonEmptyString, userId: Schema.NonEmptyString, credentialID: Schema.NonEmptyString })
const stateContext = Schema.Struct({ purpose: Schema.Literal('first-google-passkey'), intentId: Schema.NonEmptyString })
const safeHeaders = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }

export function createFirstGooglePasskey(owner: AuthTransactions, origin: string, configured: boolean, limiter: ReturnType<typeof createAuthRateLimiter>,
  invoke: <A>(request: Request, call: () => Promise<A>) => Promise<A>, native: NativeCalls) {
  const key = Symbol('first Google passkey invocation')
  function bound(request?: Request): FirstGoogleInvocation | undefined {
    const descriptor = request && Object.getOwnPropertyDescriptor(request, key)
    if (!descriptor) return undefined
    if (descriptor.enumerable || descriptor.writable || !descriptor.configurable || !('value' in descriptor)) throw new FirstGooglePasskeyRejected()
    return (request as Request & { [key]: FirstGoogleInvocation })[key]
  }
  async function command(request: Request, name: Command, input?: unknown, locale: unknown = 'fr') {
    owner.assertNoActiveAuthTransaction(); requestAuthDeadlineAtMs(request)
    const callback = name === 'completeFirstGooglePasskeyOAuth', canonical = origin + firstGoogleCallbackPath
    if (callback ? request.method !== 'GET' || !(request.url === canonical || request.url.startsWith(canonical + '?'))
      : request.method !== 'POST' || request.headers.get('origin') !== origin || request.headers.get('sec-fetch-site') === 'cross-site') throw new FirstGooglePasskeyRejected()
    await limiter.consumeAuthAttempt(name, limiter.trustedClientContext(request))
    if (!configured) throw new FirstGooglePasskeyRejected()
    let language: 'fr' | 'en'
    try { language = Schema.decodeUnknownSync(Schema.Literals(['fr', 'en']))(locale) } catch { throw new FirstGooglePasskeyRejected() }
    const finish = name === 'finishFirstGooglePasskey' ? validateFirstGoogleFinish(input) : undefined
    const target = name === 'beginFirstGooglePasskey' || callback ? undefined : finish ?? validateFirstGoogleTarget(input)
    return invoke(request, async () => {
      if (!Object.isExtensible(request) || Object.hasOwn(request, key)) throw new FirstGooglePasskeyRejected()
      const invocation = owner.invocationOptions()
      let active = true, phase: 'session' | 'options' | 'complete' | 'oauth' = 'oauth'
      let lease: FirstGoogleLease | undefined, state: FirstGoogleState | undefined
      let leaseInvocation: ReturnType<AuthTransactions['invocationOptions']> | undefined
      let prepared: { identifier: string; expiresAt: Date } | undefined
      let locked: Awaited<ReturnType<typeof lockFirstGoogleVerification>> | undefined
      let consumed = false, verifiedCredential: string | undefined, oauthUsed = false
      const assert = (operation: typeof phase, candidate = request) => {
        const descriptor = Object.getOwnPropertyDescriptor(request, key)
        if (!active || candidate !== request || operation !== phase || owner.invocationOptions() !== (operation === 'oauth' ? invocation : leaseInvocation)
          || !descriptor || descriptor.value !== cell || descriptor.enumerable || descriptor.writable || !descriptor.configurable
          || (operation !== 'oauth' && (!lease || owner.currentDb() !== lease.db))) throw new FirstGooglePasskeyRejected()
      }
      async function protectedState<A>(intentId: string | undefined, expected: 'zero' | 'receipt', work: () => Promise<A>): Promise<A> {
        return owner.withAuthPromise(invocation, async current => {
          lease = current; leaseInvocation = owner.invocationOptions(); phase = 'session'
          try {
            const ambient = await native.session(request); assert('session')
            state = await lockFirstGoogleState(current, ambient, intentId, expected); assert('session')
            return await work()
          } finally { lease = undefined; leaseInvocation = undefined; phase = 'oauth' }
        })
      }
      const cell: FirstGoogleInvocation = Object.freeze({ command: name, assert,
        async checkAmbient(ambient) {
          assert(phase)
          if (!lease || !state || !ambient || ambient.user.id !== state.user.id || ambient.session.id !== state.session.id) throw new FirstGooglePasskeyRejected()
          await recheckFirstGoogleState(lease, state); assert(phase)
        },
        async prepareChallenge(data) {
          assert('options')
          if (!lease || !state?.intent || state.intent.phase !== 'AUTHORIZED' || prepared || !data.identifier) throw new FirstGooglePasskeyRejected()
          checkFirstGoogleChallenge(data, state)
          const expiresAt = new Date(Math.min(data.expiresAt.getTime(), state.intent.expiresAt.getTime(), state.session.expiresAt.getTime(),
            state.session.authenticatedAt.getTime() + 604800000, state.session.lastActivityAt.getTime() + 43200000))
          await recheckFirstGoogleState(lease, state)
          if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= (await firstGoogleDatabaseTime(lease)).getTime()) throw new FirstGooglePasskeyRejected()
          prepared = { identifier: data.identifier, expiresAt }; assert('options')
          return { ...data, expiresAt }
        },
        async beforeConsume(identifier) {
          assert('complete')
          if (!lease || !state || locked || consumed) throw new FirstGooglePasskeyRejected()
          locked = await lockFirstGoogleVerification(lease, state, identifier); assert('complete')
        },
        async consumedChallenge(value) {
          assert('complete')
          if (!lease || !state || !locked || consumed || value.id !== locked.id || value.identifier !== locked.identifier
            || value.value !== locked.value || value.expiresAt.getTime() !== locked.expiresAt.getTime()) throw new FirstGooglePasskeyRejected()
          await recheckFirstGoogleState(lease, state); assert('complete'); consumed = true
        },
        async verified(args) {
          assert('complete', args.ctx.request)
          if (!lease || !state?.intent || state.intent.phase !== 'AUTHORIZED' || !locked || !consumed || verifiedCredential
            || args.verification.verified !== true || args.verification.registrationInfo?.userVerified !== true
            || args.user.id !== state.user.id || args.ctx.context.session?.user.id !== state.user.id
            || args.ctx.context.session?.session.id !== state.session.id || args.context !== firstGooglePurpose + ':' + state.intent.id) throw new FirstGooglePasskeyRejected()
          await recheckFirstGoogleState(lease, state)
          if (locked.expiresAt.getTime() <= (await firstGoogleDatabaseTime(lease)).getTime()) throw new FirstGooglePasskeyRejected()
          const changed = await lease.db.update(firstGooglePasskeyIntent).set({ phase: 'CONSUMED' })
            .where(and(eq(firstGooglePasskeyIntent.id, state.intent.id), eq(firstGooglePasskeyIntent.phase, 'AUTHORIZED'))).returning()
          if (changed.length !== 1) throw new FirstGooglePasskeyRejected()
          state.intent = changed[0]; verifiedCredential = args.verification.registrationInfo.credential.id; assert('complete')
        },
        async oauth(ctx) {
          assert('oauth', ctx.request)
          if (oauthUsed || (name !== 'beginFirstGooglePasskey' && !callback)) throw new FirstGooglePasskeyRejected()
          oauthUsed = true
          const provider = ctx.context.socialProviders.find(item => item.id === 'google')
          if (!provider) throw new FirstGooglePasskeyRejected()
          if (!callback) {
            const nonce = generateIdTokenNonce(provider)
            if (!nonce) throw new FirstGooglePasskeyRejected()
            const generated = await protectedState(undefined, 'zero', async () => {
              const intent = await beginFirstGoogleIntent(lease!, state!)
              await addOAuthServerContext({ purpose: firstGooglePurpose, intentId: intent.id })
              ctx.body = { callbackURL: origin + '/account?lang=' + language }
              const value = await generateState(ctx, { idTokenNonce: nonce })
              await recheckFirstGoogleState(lease!, state!); assert('session')
              return { ...value, subject: intent.subject }
            })
            assert('oauth'); owner.assertNoActiveAuthTransaction()
            const url = await provider.createAuthorizationURL({ state: generated.state, codeVerifier: generated.codeVerifier,
              redirectURI: canonical, idTokenNonce: nonce, loginHint: generated.subject,
              additionalParams: { claims: JSON.stringify({ id_token: { auth_time: { essential: true } } }) } })
            assert('oauth'); return { url: url.toString() }
          }
          const params = new URL(request.url).searchParams
          if (request.url.length > 8192 || params.getAll('state').length !== 1 || params.getAll('code').length > 1
            || params.getAll('error').length > 1 || !params.get('state') || params.get('state')!.length > 1024) throw new FirstGooglePasskeyRejected()
          ctx.query = { state: params.get('state')! }
          let parsed: Awaited<ReturnType<typeof parseState>> | undefined
          // Native parse/delete and signed-session expiry effects must roll back on rejection.
          await owner.withAuthPromise(invocation, async current => {
            lease = current; leaseInvocation = owner.invocationOptions(); phase = 'session'
            try {
              const ambient = await native.session(request); assert('session')
              parsed = await parseState(ctx)
              let reference: typeof stateContext.Type
              try { reference = Schema.decodeUnknownSync(stateContext)(parsed.serverContext, { onExcessProperty: 'error' }) }
              catch { throw new FirstGooglePasskeyRejected() }
              state = await lockFirstGoogleState(current, ambient, validateFirstGoogleTarget({ intentId: reference.intentId }).intentId)
              if (!state.intent || state.intent.phase !== 'PENDING_GOOGLE' || parsed.link || !parsed.idTokenNonce || !parsed.codeVerifier) throw new FirstGooglePasskeyRejected()
              const changed = await current.db.update(firstGooglePasskeyIntent).set({ phase: 'EXCHANGING' })
                .where(and(eq(firstGooglePasskeyIntent.id, state.intent.id), eq(firstGooglePasskeyIntent.phase, 'PENDING_GOOGLE'))).returning()
              if (changed.length !== 1) throw new FirstGooglePasskeyRejected()
              state.intent = changed[0]; await recheckFirstGoogleState(current, state); assert('session')
            } finally { lease = undefined; leaseInvocation = undefined; phase = 'oauth' }
          })
          const intent = state?.intent, oauthState = parsed
          if (!intent || !oauthState) throw new FirstGooglePasskeyRejected()
          if (![origin + '/account?lang=fr', origin + '/account?lang=en'].includes(oauthState.callbackURL)) throw new FirstGooglePasskeyRejected()
          const returnURL = oauthState.callbackURL + '&firstPasskey=' + intent.id
          try {
            assert('oauth'); owner.assertNoActiveAuthTransaction()
            const code = params.get('code')
            if (params.has('error') || !code || code.length > 4096) throw new FirstGooglePasskeyRejected('proof_unavailable')
            const tokens = await provider.validateAuthorizationCode({ code, codeVerifier: oauthState.codeVerifier, redirectURI: canonical })
            assert('oauth')
            if (!tokens) throw new FirstGooglePasskeyRejected('proof_unavailable')
            const profile = await provider.getUserInfo({ ...tokens, expectedIdTokenNonce: oauthState.idTokenNonce })
            assert('oauth')
            if (!profile) throw new FirstGooglePasskeyRejected('proof_unavailable')
            const subject = await provider.accountSubject({ tokens, profile: profile.data })
            assert('oauth')
            await protectedState(intent.id, 'zero', async () => {
              if (!state?.intent || state.intent.phase !== 'EXCHANGING' || String(subject) !== state.intent.subject) throw new FirstGooglePasskeyRejected()
              const proof = firstGoogleProofWindow(profile.data, await firstGoogleDatabaseTime(lease!), state.intent.createdAt)
              const changed = await lease!.db.update(firstGooglePasskeyIntent).set({ phase: 'AUTHORIZED', authenticatedAt: proof.authenticatedAt, expiresAt: proof.expiresAt })
                .where(and(eq(firstGooglePasskeyIntent.id, intent.id), eq(firstGooglePasskeyIntent.phase, 'EXCHANGING'))).returning()
              if (changed.length !== 1) throw new FirstGooglePasskeyRejected()
              state.intent = changed[0]; await recheckFirstGoogleState(lease!, state); assert('session')
            })
          } catch (error) {
            // A durable claimed attempt cannot be exchanged again. A separate protected
            // finalization records only a safe refusal, never success through an error.
            const reason = error instanceof FirstGooglePasskeyRejected ? error.reason : 'proof_unavailable'
            await protectedState(intent.id, 'receipt', async () => {
              if (state?.intent?.phase === 'EXCHANGING') await lease!.db.update(firstGooglePasskeyIntent).set({ phase: 'INVALIDATED', reason })
                .where(and(eq(firstGooglePasskeyIntent.id, intent.id), eq(firstGooglePasskeyIntent.phase, 'EXCHANGING')))
            })
          }
          assert('oauth'); return { url: returnURL }
        },
      })
      try {
        Object.defineProperty(request, key, { value: cell, enumerable: false, writable: false, configurable: true })
        if (name === 'beginFirstGooglePasskey' || callback) {
          const result = await (callback ? native.complete(request) : native.begin(request)); assert('oauth')
          if (!oauthUsed || !(result.headers instanceof Headers) || !state?.intent) throw new FirstGooglePasskeyRejected()
          const headers = new Headers(safeHeaders)
          // Native state cookie only; never publish session cookies from verify-only work.
          for (const cookie of result.headers.getSetCookie()) if (/^(?:__Secure-)?better-auth\.(?:oauth_state|state)=/.test(cookie)) headers.append('set-cookie', cookie)
          return { kind: 'oauth' as const, value: { url: result.response.url, intentId: state.intent.id, headers } }
        }
        return await protectedState(target!.intentId, name === 'readFirstGooglePasskey' || name === 'cancelFirstGooglePasskey' ? 'receipt' : 'zero', async () => {
          if (!lease || !state?.intent) throw new FirstGooglePasskeyRejected()
          if (name === 'readFirstGooglePasskey' || name === 'cancelFirstGooglePasskey') {
            if (name === 'cancelFirstGooglePasskey' && state.intent.phase !== 'CONSUMED' && state.intent.phase !== 'INVALIDATED') {
              if (state.intent.registrationVerificationIdentifier) await lease.db.delete(verification).where(eq(verification.identifier, state.intent.registrationVerificationIdentifier))
              const [cancelled] = await lease.db.update(firstGooglePasskeyIntent).set({ phase: 'INVALIDATED', reason: 'cancelled' }).where(eq(firstGooglePasskeyIntent.id, state.intent.id)).returning()
              state.intent = cancelled
            }
            return { kind: 'status' as const, value: await firstGoogleStatus(lease, state) }
          }
          if (state.intent.phase !== 'AUTHORIZED') throw new FirstGooglePasskeyRejected()
          if (name === 'prepareFirstGooglePasskey') {
            if (state.intent.registrationVerificationIdentifier) await lease.db.delete(verification).where(eq(verification.identifier, state.intent.registrationVerificationIdentifier))
            phase = 'options'
            const result = await native.options(request, firstGooglePurpose + ':' + state.intent.id); assert('options')
            if (!prepared) throw new FirstGooglePasskeyRejected()
            const [updated] = await lease.db.update(firstGooglePasskeyIntent).set({ registrationVerificationIdentifier: prepared.identifier }).where(eq(firstGooglePasskeyIntent.id, state.intent.id)).returning()
            state.intent = updated
            await recheckFirstGoogleState(lease, state); assert('options')
            const headers = new Headers(safeHeaders)
            for (const cookie of result.headers.getSetCookie()) if (/^(?:__Secure-)?better-auth\.better-auth-passkey=/.test(cookie)) headers.append('set-cookie', cookie)
            return { kind: 'options' as const, value: { intentId: state.intent!.id, expiresAt: state.intent!.expiresAt.toISOString(), options: result.response, headers } }
          }
          if (!finish) throw new FirstGooglePasskeyRejected()
          phase = 'complete'
          const result = await native.finish(request, finish.response); assert('complete')
          if (!verifiedCredential || !locked) throw new FirstGooglePasskeyRejected()
          let resultBinding: typeof bindingSchema.Type
          try { resultBinding = Schema.decodeUnknownSync(bindingSchema)(result.response) } catch { throw new FirstGooglePasskeyRejected() }
          if (resultBinding.userId !== state.user.id || resultBinding.credentialID !== verifiedCredential) throw new FirstGooglePasskeyRejected()
          const [persisted] = await lease.db.select().from(passkey).where(eq(passkey.id, resultBinding.id))
          if (!persisted || persisted.userId !== state.user.id || persisted.credentialID !== verifiedCredential) throw new FirstGooglePasskeyRejected()
          const [receipt] = await lease.db.update(firstGooglePasskeyIntent).set({ passkeyId: persisted.id }).where(eq(firstGooglePasskeyIntent.id, state.intent!.id)).returning()
          state.intent = receipt
          await recheckFirstGoogleState(lease, state, 'one')
          if (locked.expiresAt.getTime() <= (await firstGoogleDatabaseTime(lease)).getTime()) throw new FirstGooglePasskeyRejected()
          await lease.db.update(firstGooglePasskeyIntent).set({ phase: 'INVALIDATED', reason: 'superseded' }).where(and(
            eq(firstGooglePasskeyIntent.userId, state.user.id), inArray(firstGooglePasskeyIntent.phase, ['PENDING_GOOGLE', 'EXCHANGING', 'AUTHORIZED'])))
          assert('complete')
          return { kind: 'finished' as const, value: { added: true as const } }
        })
      } finally { active = false; if (!Reflect.deleteProperty(request, key)) throw new FirstGooglePasskeyRejected() }
    })
  }
  return {
    bound,
    async beginFirstGooglePasskey(request: Request, locale: unknown = 'fr') { const result = await command(request, 'beginFirstGooglePasskey', undefined, locale); if (result.kind !== 'oauth') throw new FirstGooglePasskeyRejected(); return result.value },
    async completeFirstGooglePasskeyOAuth(request: Request) { const result = await command(request, 'completeFirstGooglePasskeyOAuth'); if (result.kind !== 'oauth') throw new FirstGooglePasskeyRejected(); return result.value },
    async readFirstGooglePasskey(request: Request, input: unknown) { const result = await command(request, 'readFirstGooglePasskey', input); if (result.kind !== 'status') throw new FirstGooglePasskeyRejected(); return result.value },
    async cancelFirstGooglePasskey(request: Request, input: unknown) { const result = await command(request, 'cancelFirstGooglePasskey', input); if (result.kind !== 'status') throw new FirstGooglePasskeyRejected(); return result.value },
    async prepareFirstGooglePasskey(request: Request, input: unknown) { const result = await command(request, 'prepareFirstGooglePasskey', input); if (result.kind !== 'options') throw new FirstGooglePasskeyRejected(); return result.value },
    async finishFirstGooglePasskey(request: Request, input: unknown) { const result = await command(request, 'finishFirstGooglePasskey', input); if (result.kind !== 'finished') throw new FirstGooglePasskeyRejected(); return result.value },
    firstGooglePasskeyErrorResponse(error: unknown) {
      if (error instanceof FirstGooglePasskeyRejected || error instanceof APIError && (error.statusCode === 400 || error.statusCode === 401)) return new Response('Authentication rejected', { status: 401, headers: safeHeaders })
      return undefined
    },
  }
}
