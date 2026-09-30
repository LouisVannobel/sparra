import { Schema } from 'effect'
import { and, eq } from 'drizzle-orm'
import { APIError, addOAuthServerContext, createAuthEndpoint } from 'better-auth/api'
import { generateIdTokenNonce, generateState, parseState } from 'better-auth/oauth2'
import type { AuthTransactions } from '../../platform/db/transactions.server'
import { requestAuthDeadlineAtMs } from '../../platform/resources.server'
import type { createAuthRateLimiter } from './rate-limit.server'
import { account, googleAccountIntent } from './schema.server'
import { advanceGoogleAccountKey, beginGoogleAccountIntent, GoogleAccountRejected, googleAccountCallbackPath, googleAccountDatabaseTime,
  googleAccountPurpose, googleAccountStatus, googleAccountTerminalMaterial, invalidateGoogleAccountIntent, lockGoogleAccountState,
  recheckGoogleAccountState, validateGoogleAccountAssertion, validateGoogleAccountTarget, validateGoogleAccountUnlink,
  type GoogleAccountLease, type GoogleAccountState } from './google-account.server'

type NativeContext = Parameters<typeof generateState>[0]
type Command = 'beginGoogleAccountLink' | 'authorizeGoogleAccountLink' | 'completeGoogleAccountLinkOAuth' | 'beginGoogleAccountUnlink'
  | 'finishGoogleAccountUnlink' | 'readGoogleAccountIntent' | 'cancelGoogleAccountIntent'
type Operation = 'session' | 'oauth' | 'mutation'
export type GoogleAccountInvocation = Readonly<{
  assert(operation: Operation, request?: Request): void
  oauth(ctx: NativeContext): Promise<{ url: string }>
  mutate(ctx: NativeContext): Promise<{ id: string }>
  admitCreate(data: Parameters<NativeContext['context']['internalAdapter']['createAccount']>[0], request?: Request): void
  admitDelete(id: string, request?: Request): void
}>
export function googleAccountEndpoints(bound: (request?: Request) => GoogleAccountInvocation | undefined) {
  const oauth = async (ctx: NativeContext) => {
    const authority = bound(ctx.request)
    if (!authority) throw new GoogleAccountRejected()
    authority.assert('oauth', ctx.request)
    return authority.oauth(ctx)
  }
  return {
    authorizeApplicationGoogleAccount: createAuthEndpoint('/application/account/google/authorize', { method: 'POST', metadata: { SERVER_ONLY: true } }, oauth),
    completeApplicationGoogleAccount: createAuthEndpoint('/application/account/google/complete', { method: 'GET', metadata: { SERVER_ONLY: true } }, oauth),
    mutateApplicationGoogleAccount: createAuthEndpoint('/application/account/google/mutate', { method: 'POST', metadata: { SERVER_ONLY: true } }, async ctx => {
      const authority = bound(ctx.request)
      if (!authority) throw new GoogleAccountRejected()
      authority.assert('mutation', ctx.request)
      return authority.mutate(ctx)
    }),
  }
}
type NativeCalls = {
  session(request: Request): Promise<{ user: { id: string }; session: { id: string } } | null>
  authorize(request: Request): Promise<{ response: { url: string }; headers: Headers }>
  complete(request: Request): Promise<{ response: { url: string }; headers: Headers }>
  mutate(request: Request): Promise<{ response: { id: string }; headers: Headers }>
}
const contextSchema = Schema.Struct({ purpose: Schema.Literal('google-account-link'), intentId: Schema.NonEmptyString })
const opaqueSubject = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024), Schema.isPattern(/\S/))
const safeHeaders = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }

export function createGoogleAccountCommands(owner: AuthTransactions, origin: string, configured: boolean, limiter: ReturnType<typeof createAuthRateLimiter>,
  invoke: <A>(request: Request, call: () => Promise<A>) => Promise<A>, native: NativeCalls) {
  const key = Symbol('Google account invocation')
  function bound(request?: Request): GoogleAccountInvocation | undefined {
    const descriptor = request && Object.getOwnPropertyDescriptor(request, key)
    if (!descriptor) return undefined
    if (descriptor.enumerable || descriptor.writable || !descriptor.configurable || !('value' in descriptor)) throw new GoogleAccountRejected()
    return (request as Request & { [key]: GoogleAccountInvocation })[key]
  }
  async function command(request: Request, name: Command, input?: unknown, locale: unknown = 'fr') {
    owner.assertNoActiveAuthTransaction(); requestAuthDeadlineAtMs(request)
    const callback = name === 'completeGoogleAccountLinkOAuth', canonical = origin + googleAccountCallbackPath
    if (callback ? request.method !== 'GET' || !(request.url === canonical || request.url.startsWith(canonical + '?'))
      : request.method !== 'POST' || request.headers.get('origin') !== origin || request.headers.get('sec-fetch-site') === 'cross-site') throw new GoogleAccountRejected()
    await limiter.consumeAuthAttempt(name, limiter.trustedClientContext(request))
    if (!configured && (name === 'beginGoogleAccountLink' || name === 'authorizeGoogleAccountLink' || callback)) throw new GoogleAccountRejected()
    let language: 'fr' | 'en'
    try { language = Schema.decodeUnknownSync(Schema.Literals(['fr', 'en']))(locale) } catch { throw new GoogleAccountRejected() }
    const assertion = name === 'authorizeGoogleAccountLink' || name === 'finishGoogleAccountUnlink' ? validateGoogleAccountAssertion(input) : undefined
    const unlink = name === 'beginGoogleAccountUnlink' ? validateGoogleAccountUnlink(input) : undefined
    const target = name === 'readGoogleAccountIntent' || name === 'cancelGoogleAccountIntent' ? validateGoogleAccountTarget(input) : assertion
    return invoke(request, async () => {
      if (!Object.isExtensible(request) || Object.hasOwn(request, key)) throw new GoogleAccountRejected()
      const invocation = owner.invocationOptions()
      let active = true, phase: Operation = 'oauth', lease: GoogleAccountLease | undefined, state: GoogleAccountState | undefined
      let leaseInvocation: ReturnType<AuthTransactions['invocationOptions']> | undefined
      let oauthUsed = false, mutationUsed = false, writeUsed = false, subject: string | undefined
      const assert = (operation: Operation, candidate = request) => {
        const descriptor = Object.getOwnPropertyDescriptor(request, key)
        if (!active || candidate !== request || operation !== phase || owner.invocationOptions() !== (operation === 'oauth' ? invocation : leaseInvocation)
          || !descriptor || descriptor.value !== cell || descriptor.enumerable || descriptor.writable || !descriptor.configurable
          || operation !== 'oauth' && (!lease || owner.currentDb() !== lease.db)) throw new GoogleAccountRejected()
      }
      async function protectedState<A>(intentId: string | undefined, receipt: boolean, work: () => Promise<A>, credentialId?: string): Promise<A> {
        return owner.withAuthPromise(invocation, async current => {
          lease = current; leaseInvocation = owner.invocationOptions(); phase = 'session'
          try {
            const ambient = await native.session(request); assert('session')
            state = await lockGoogleAccountState(current, ambient, intentId ? { intentId, credentialId } : undefined, receipt)
            assert('session')
            return await work()
          } finally { lease = undefined; leaseInvocation = undefined; phase = 'oauth' }
        })
      }
      async function revalidateAfterNative() {
        phase = 'session'
        const ambient = await native.session(request); assert('session')
        if (!state || !lease || !ambient || ambient.user.id !== state.user.id || ambient.session.id !== state.session.id) throw new GoogleAccountRejected()
        await recheckGoogleAccountState(lease, state); assert('session')
      }
      async function finalize() {
        if (!lease || !state?.intent || !state.key) throw new GoogleAccountRejected()
        const intent = state.intent
        if (intent.action === 'LINK' ? intent.phase !== 'EXCHANGING' || !subject : intent.phase !== 'CHALLENGE') throw new GoogleAccountRejected()
        if (intent.action === 'LINK') {
          const existing = await lease.db.select({ id: account.id }).from(account).where(and(eq(account.providerId, 'google'), eq(account.accountId, subject!)))
          if (existing.length) throw new GoogleAccountRejected()
        }
        phase = 'mutation'
        const result = await native.mutate(request); assert('mutation')
        if (!mutationUsed || !writeUsed || !result.response.id) throw new GoogleAccountRejected()
        const rows = await lease.db.select().from(account).where(and(eq(account.userId, state.user.id), eq(account.providerId, 'google')))
        if (intent.action === 'LINK') {
          const a = rows[0]
          if (rows.length !== 1 || a.id !== result.response.id || a.accountId !== subject || a.userId !== state.user.id || a.providerId !== 'google'
            || [a.accessToken, a.refreshToken, a.idToken, a.accessTokenExpiresAt, a.refreshTokenExpiresAt, a.scope, a.password].some(value => value !== null)) throw new GoogleAccountRejected()
        } else {
          const exact = await lease.db.select({ id: account.id }).from(account).where(eq(account.id, intent.targetAccountId!))
          if (rows.length !== 0 || exact.length !== 0 || result.response.id !== intent.targetAccountId) throw new GoogleAccountRejected()
        }
        await revalidateAfterNative()
        const [consumed] = await lease.db.update(googleAccountIntent).set({ phase: 'CONSUMED', ...googleAccountTerminalMaterial,
          nativeAccountId: result.response.id, providerSubject: intent.action === 'LINK' ? subject : intent.targetSubject,
          outcome: intent.action === 'LINK' ? 'linked' : 'unlinked' }).where(and(eq(googleAccountIntent.id, intent.id), eq(googleAccountIntent.phase, intent.phase))).returning()
        if (!consumed) throw new GoogleAccountRejected()
        state.intent = consumed
        await recheckGoogleAccountState(lease, state, true)
        if (intent.expiresAt.getTime() <= (await googleAccountDatabaseTime(lease)).getTime()) throw new GoogleAccountRejected('expired')
        assert('session')
        return googleAccountStatus(consumed, await googleAccountDatabaseTime(lease))
      }
      const cell: GoogleAccountInvocation = Object.freeze({ assert,
        admitCreate(data, candidate) {
          assert('mutation', candidate)
          if (!mutationUsed || writeUsed || state?.intent?.action !== 'LINK' || !subject || Object.keys(data).sort().join(',') !== 'accountId,providerId,userId'
            || data.userId !== state.user.id || data.providerId !== 'google' || data.accountId !== subject) throw new GoogleAccountRejected()
          writeUsed = true
        },
        admitDelete(id, candidate) {
          assert('mutation', candidate)
          if (!mutationUsed || writeUsed || state?.intent?.action !== 'UNLINK' || state.intent.targetAccountId !== id) throw new GoogleAccountRejected()
          writeUsed = true
        },
        async mutate(ctx) {
          assert('mutation', ctx.request)
          if (mutationUsed || !state?.intent) throw new GoogleAccountRejected()
          mutationUsed = true
          if (state.intent.action === 'LINK') {
            if (!subject) throw new GoogleAccountRejected()
            const created = await ctx.context.internalAdapter.createAccount({ userId: state.user.id, providerId: 'google', accountId: subject })
            assert('mutation', ctx.request)
            if (!created?.id) throw new GoogleAccountRejected()
            return { id: created.id }
          }
          const id = state.intent.targetAccountId
          if (!id) throw new GoogleAccountRejected()
          await ctx.context.internalAdapter.deleteAccount(id); assert('mutation', ctx.request)
          return { id }
        },
        async oauth(ctx) {
          assert('oauth', ctx.request)
          if (oauthUsed || name !== 'authorizeGoogleAccountLink' && !callback) throw new GoogleAccountRejected()
          oauthUsed = true
          const provider = ctx.context.socialProviders.find(item => item.id === 'google')
          if (!provider) throw new GoogleAccountRejected()
          if (!callback) {
            if (!assertion) throw new GoogleAccountRejected()
            const nonce = generateIdTokenNonce(provider)
            if (!nonce) throw new GoogleAccountRejected()
            const generated = await protectedState(assertion.intentId, false, async () => {
              if (!lease || !state?.intent || !state.key || state.intent.action !== 'LINK') throw new GoogleAccountRejected()
              await advanceGoogleAccountKey(lease, state, assertion, origin)
              await addOAuthServerContext({ purpose: googleAccountPurpose, intentId: state.intent.id })
              ctx.body = { callbackURL: origin + '/account?lang=' + state.intent.locale }
              const issued = await generateState(ctx, { idTokenNonce: nonce })
              const [authorized] = await lease.db.update(googleAccountIntent).set({ phase: 'AUTHORIZED', authenticationChallenge: null,
                authorizingKeyId: state.key.id, authorizingCredentialId: state.key.credentialID, authorizingPublicKey: state.key.publicKey, oauthState: issued.state })
                .where(and(eq(googleAccountIntent.id, state.intent.id), eq(googleAccountIntent.phase, 'CHALLENGE'))).returning()
              if (!authorized) throw new GoogleAccountRejected()
              state.intent = authorized; await recheckGoogleAccountState(lease, state); assert('session')
              return issued
            }, assertion.response.id)
            assert('oauth'); owner.assertNoActiveAuthTransaction()
            const url = await provider.createAuthorizationURL({ state: generated.state, codeVerifier: generated.codeVerifier, redirectURI: canonical,
              idTokenNonce: nonce, additionalParams: { prompt: 'select_account' } })
            assert('oauth'); return { url: url.toString() }
          }
          const params = new URL(request.url).searchParams
          if (request.url.length > 8192 || params.getAll('state').length !== 1 || params.getAll('code').length > 1 || params.getAll('error').length > 1
            || !params.get('state') || params.get('state')!.length > 1024) throw new GoogleAccountRejected()
          ctx.query = { state: params.get('state')! }
          let parsed: Awaited<ReturnType<typeof parseState>> | undefined
          await owner.withAuthPromise(invocation, async current => {
            lease = current; leaseInvocation = owner.invocationOptions(); phase = 'session'
            try {
              const ambient = await native.session(request); assert('session')
              parsed = await parseState(ctx)
              let reference: typeof contextSchema.Type
              try { reference = Schema.decodeUnknownSync(contextSchema)(parsed.serverContext, { onExcessProperty: 'error' }) } catch { throw new GoogleAccountRejected() }
              state = await lockGoogleAccountState(current, ambient, validateGoogleAccountTarget({ intentId: reference.intentId }))
              if (!state.intent || state.intent.action !== 'LINK' || state.intent.phase !== 'AUTHORIZED' || state.intent.oauthState !== params.get('state')
                || parsed.link || !parsed.idTokenNonce || !parsed.codeVerifier || parsed.callbackURL !== origin + '/account?lang=' + state.intent.locale) throw new GoogleAccountRejected()
              const [claimed] = await current.db.update(googleAccountIntent).set({ phase: 'EXCHANGING' })
                .where(and(eq(googleAccountIntent.id, state.intent.id), eq(googleAccountIntent.phase, 'AUTHORIZED'))).returning()
              if (!claimed) throw new GoogleAccountRejected()
              state.intent = claimed; await recheckGoogleAccountState(current, state); assert('session')
            } finally { lease = undefined; leaseInvocation = undefined; phase = 'oauth' }
          })
          const intent = state?.intent, oauthState = parsed
          if (!intent || !oauthState) throw new GoogleAccountRejected()
          const returnURL = origin + '/account?lang=' + intent.locale + '&googleAccount=' + intent.id
          try {
            assert('oauth'); owner.assertNoActiveAuthTransaction()
            const code = params.get('code')
            if (params.has('error') || !code || code.length > 4096) throw new GoogleAccountRejected()
            const tokens = await provider.validateAuthorizationCode({ code, codeVerifier: oauthState.codeVerifier, redirectURI: canonical }); assert('oauth')
            if (!tokens) throw new GoogleAccountRejected()
            const profile = await provider.getUserInfo({ ...tokens, expectedIdTokenNonce: oauthState.idTokenNonce }); assert('oauth')
            if (!profile) throw new GoogleAccountRejected()
            const selected = await provider.accountSubject({ tokens, profile: profile.data }); assert('oauth')
            try { subject = Schema.decodeUnknownSync(opaqueSubject)(selected) } catch { throw new GoogleAccountRejected() }
            await protectedState(intent.id, false, finalize)
          } catch (error) {
            // Never reopen EXCHANGING or retry a provider exchange. A committed
            // result remains historical success even when its response was lost.
            await protectedState(intent.id, true, async () => {
              if (!lease || !state?.intent) throw new GoogleAccountRejected()
              await invalidateGoogleAccountIntent(lease, state, error instanceof GoogleAccountRejected ? error.reason : 'unavailable')
            })
          }
          assert('oauth'); return { url: returnURL }
        },
      })
      try {
        Object.defineProperty(request, key, { value: cell, enumerable: false, writable: false, configurable: true })
        if (name === 'authorizeGoogleAccountLink' || callback) {
          const result = await (callback ? native.complete(request) : native.authorize(request)); assert('oauth')
          if (!oauthUsed || !state?.intent || !(result.headers instanceof Headers)) throw new GoogleAccountRejected()
          const intentId = state.intent.id
          // The outer native OAuth API can await hooks after its inner leases.
          // Revalidate before publication; committed callback history is read as
          // a receipt, without restoring proof authority or compensating a commit.
          await protectedState(intentId, callback, async () => {
            if (!lease || !state) throw new GoogleAccountRejected()
            await recheckGoogleAccountState(lease, state, callback); assert('session')
          })
          const headers = new Headers(safeHeaders)
          for (const cookie of result.headers.getSetCookie()) if (/^(?:__Secure-)?better-auth\.(?:oauth_state|state)=/.test(cookie)) headers.append('set-cookie', cookie)
          return { kind: 'oauth' as const, value: { intentId, url: result.response.url, headers } }
        }
        const receipt = name === 'readGoogleAccountIntent' || name === 'cancelGoogleAccountIntent'
        return await protectedState(target?.intentId, receipt, async () => {
          if (!lease || !state) throw new GoogleAccountRejected()
          if (name === 'beginGoogleAccountLink' || name === 'beginGoogleAccountUnlink') {
            return { kind: 'begin' as const, value: await beginGoogleAccountIntent(lease, state, unlink ? 'UNLINK' : 'LINK', language, origin, unlink?.accountId) }
          }
          if (!state.intent) throw new GoogleAccountRejected()
          if (receipt) {
            if (name === 'cancelGoogleAccountIntent') await invalidateGoogleAccountIntent(lease, state, 'cancelled')
            await recheckGoogleAccountState(lease, state, true)
            return { kind: 'status' as const, value: googleAccountStatus(state.intent, await googleAccountDatabaseTime(lease)) }
          }
          if (!assertion || state.intent.action !== 'UNLINK') throw new GoogleAccountRejected()
          await advanceGoogleAccountKey(lease, state, assertion, origin)
          return { kind: 'status' as const, value: await finalize() }
        }, assertion?.response.id)
      } finally { active = false; if (!Reflect.deleteProperty(request, key)) throw new GoogleAccountRejected() }
    })
  }
  return {
    bound,
    async beginGoogleAccountLink(request: Request, locale: unknown = 'fr') { const result = await command(request, 'beginGoogleAccountLink', undefined, locale); if (result.kind !== 'begin') throw new GoogleAccountRejected(); return result.value },
    async authorizeGoogleAccountLink(request: Request, input: unknown) { const result = await command(request, 'authorizeGoogleAccountLink', input); if (result.kind !== 'oauth') throw new GoogleAccountRejected(); return result.value },
    async completeGoogleAccountLinkOAuth(request: Request) { const result = await command(request, 'completeGoogleAccountLinkOAuth'); if (result.kind !== 'oauth') throw new GoogleAccountRejected(); return result.value },
    async beginGoogleAccountUnlink(request: Request, input: unknown) { const result = await command(request, 'beginGoogleAccountUnlink', input); if (result.kind !== 'begin') throw new GoogleAccountRejected(); return result.value },
    async finishGoogleAccountUnlink(request: Request, input: unknown) { const result = await command(request, 'finishGoogleAccountUnlink', input); if (result.kind !== 'status') throw new GoogleAccountRejected(); return result.value },
    async readGoogleAccountIntent(request: Request, input: unknown) { const result = await command(request, 'readGoogleAccountIntent', input); if (result.kind !== 'status') throw new GoogleAccountRejected(); return result.value },
    async cancelGoogleAccountIntent(request: Request, input: unknown) { const result = await command(request, 'cancelGoogleAccountIntent', input); if (result.kind !== 'status') throw new GoogleAccountRejected(); return result.value },
    googleAccountErrorResponse(error: unknown) {
      if (error instanceof GoogleAccountRejected) return new Response('Authentication rejected', { status: error.principalRefused ? 401 : 400, headers: safeHeaders })
      if (error instanceof APIError && (error.statusCode === 400 || error.statusCode === 401)) return new Response('Authentication rejected', { status: error.statusCode, headers: safeHeaders })
      return undefined
    },
  }
}
