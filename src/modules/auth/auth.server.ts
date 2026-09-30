import { randomUUID } from 'node:crypto'
import { Redacted, Schema } from 'effect'
import { betterAuth, type BetterAuthOptions } from 'better-auth'
import { passkey } from '@better-auth/passkey'
import { APIError } from 'better-auth/api'
import { and, eq } from 'drizzle-orm'
import { ConfigurationError, readWebConfig } from '../../platform/config.server'
import type { AuthTransactions } from '../../platform/db/transactions.server'
import type { createAuthRateLimiter } from './rate-limit.server'
import { createAuthAdapter } from './adapter.server'
import { authSchemaOptions } from './schema-options.server'
import { googleAdmission } from './admission.server'
import { createFirstGooglePasskey } from './first-google-passkey-native.server'
import { createGoogleAccountCommands } from './google-account-native.server'
import { createSessionManagementCommands } from './session-management-native.server'
import { createRecoveryGoogleCommands, createRecoveryRotationCommands } from './recovery-native.server'
import { googleAccountConnection } from './google-account.server'
import { FirstGooglePasskeyRejected } from './first-google-passkey.server'
import { readPrivatePrincipal } from './session.server'
import { assertEndpointClassification, isPublicAuthRequest } from './http-boundary.server'
import { requestAuthDeadlineAtMs } from '../../platform/resources.server'
import { createGoogleTransport } from './google-transport.server'
import { createGoogleProtocol, type GoogleProtocolLifetime } from './google-protocol.server'
import { readAuthEmailEnvelope } from './auth-email-envelope.server'
import { validateMailProfile } from './mail-snapshot.server'
import { establishMagicProof, finishMagicProof, magicDatabaseTime, MagicProofRejected, MagicSessionConflict, requestMagicProof, validateMagicConsume, validateMagicRequest,
  type MagicConsumeInput, type MagicInvocation, type MagicProof, type MagicRequestInput } from './magic.server'
import { findMagicCommand, initialContext, proveInitialMagic, validateMagicEnrollment, type InitialEnrollmentInvocation } from './initial-enrollment.server'
import { account as storedAccount, additionalPasskeyIntent, passkey as storedPasskey, user } from './schema.server'
import { PgTransactionError } from '../../platform/db/auth-pg-lease.server'
import { AdditionalPasskeyRejected, additionalDatabaseTime, beginAdditionalIntent, checkAdditionalChallenge,
  lockAdditionalState, lockAdditionalVerification, recheckAdditionalState, validateAdditionalPasskeyAuthorizeInput,
  validateAdditionalPasskeyFinishInput, verifyAdditionalAssertion,
  type AdditionalPasskeyInvocation, type AdditionalPasskeyState } from './additional-passkey.server'
import { lockPasskeyLoginCandidate, passkeyDatabaseTime, PasskeyLoginRejected, PasskeyLoginSessionConflict,
  recheckLockedPasskeyLogin, validatePasskeyAuthenticationOptions, validatePasskeyFinishInput, validatePersistedPasskeySession,
  type LockedPasskeyLogin, type PasskeyLoginInvocation } from './passkey-login.server'

// The installed native API's declaration returns Passkey even when the
// characterized createSession branch also returns session/user. Decode only
// the identity bindings needed here and drop all token-bearing extra fields.
const registrationResult = Schema.Struct({ userId: Schema.NonEmptyString,
  session: Schema.Struct({ userId: Schema.NonEmptyString }), user: Schema.Struct({ id: Schema.NonEmptyString }) })
const authenticationResult = Schema.Struct({ session: Schema.Struct({ id: Schema.NonEmptyString, userId: Schema.NonEmptyString }),
  user: Schema.Struct({ id: Schema.NonEmptyString }) })

export function readAuthConfig(env: Readonly<Record<string, string | undefined>>) {
  const magicKeys = ['AUTH_MAIL_KEY_ID', 'AUTH_MAIL_KEYS_JSON', 'AUTH_MAIL_PROFILE_JSON']
  if (['AUTH_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', ...magicKeys].every(key => env[key] === undefined)) return null
  function secret(key: string, minimum: number) {
    try { return Redacted.make(Schema.decodeUnknownSync(Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(minimum)))(env[key])) }
    catch { throw new ConfigurationError([key]) }
  }
  const origin = readWebConfig(env).origin
  const google = env.GOOGLE_CLIENT_ID !== undefined || env.GOOGLE_CLIENT_SECRET !== undefined
    ? { clientId: secret('GOOGLE_CLIENT_ID', 1), clientSecret: secret('GOOGLE_CLIENT_SECRET', 1) } : null
  const magic = (() => {
    if (magicKeys.every(key => env[key] === undefined)) return null
    try {
      const profile = validateMailProfile(JSON.parse(env.AUTH_MAIL_PROFILE_JSON ?? ''))
      if (profile.appOrigin !== origin) throw new Error()
      return { envelope: readAuthEmailEnvelope(env), profile }
    } catch { throw new ConfigurationError(magicKeys) }
  })()
  return Object.freeze({ origin, secret: secret('AUTH_SECRET', 32), google, magic })
}

export function createApplicationAuth(owner: AuthTransactions, config: NonNullable<ReturnType<typeof readAuthConfig>>, limiter: ReturnType<typeof createAuthRateLimiter>) {
  let closed = false
  function assertOpen() { if (closed) throw new Error('Authentication unavailable') }
  const key = Symbol('application Google invocation')
  const magicKey = Symbol('application magic invocation')
  const enrollmentKey = Symbol('application initial enrollment invocation')
  const passkeyLoginKey = Symbol('application passkey login invocation')
  const additionalKey = Symbol('application additional passkey invocation')
  const transport = config.google ? createGoogleTransport() : null
  const protocol = config.google && transport ? createGoogleProtocol(owner, transport, Redacted.value(config.google.clientId)) : null
  function bound(request: Request | undefined) {
    const descriptor = request && Object.getOwnPropertyDescriptor(request, key)
    if (!descriptor || descriptor.enumerable || descriptor.writable || !descriptor.configurable || !('value' in descriptor)) throw new Error('Authentication unavailable')
    const cell = (request as Request & { [key]: GoogleProtocolLifetime })[key]
    cell.assert(); return cell
  }
  function boundMagic(request: Request | undefined) {
    const descriptor = request && Object.getOwnPropertyDescriptor(request, magicKey)
    if (!descriptor || descriptor.enumerable || descriptor.writable || !descriptor.configurable || !('value' in descriptor)) throw new MagicProofRejected()
    const cell = (request as Request & { [magicKey]: MagicInvocation })[magicKey]
    cell.assert(request); return cell
  }
  function boundEnrollment(request: Request | undefined) {
    const descriptor = request && Object.getOwnPropertyDescriptor(request, enrollmentKey)
    if (!descriptor || descriptor.enumerable || descriptor.writable || !descriptor.configurable || !('value' in descriptor)) throw new MagicProofRejected()
    return (request as Request & { [enrollmentKey]: InitialEnrollmentInvocation })[enrollmentKey]
  }
  function boundPasskeyLogin(request: Request | undefined) {
    const descriptor = request && Object.getOwnPropertyDescriptor(request, passkeyLoginKey)
    if (!descriptor || descriptor.enumerable || descriptor.writable || !descriptor.configurable || !('value' in descriptor)) throw new PasskeyLoginRejected()
    return (request as Request & { [passkeyLoginKey]: PasskeyLoginInvocation })[passkeyLoginKey]
  }
  function boundAdditional(request: Request | undefined) {
    const descriptor = request && Object.getOwnPropertyDescriptor(request, additionalKey)
    if (!descriptor) return undefined
    if (descriptor.enumerable || descriptor.writable || !descriptor.configurable || !('value' in descriptor)
      || Object.hasOwn(request!, enrollmentKey) || Object.hasOwn(request!, passkeyLoginKey)) throw new AdditionalPasskeyRejected()
    return (request as Request & { [additionalKey]: AdditionalPasskeyInvocation })[additionalKey]
  }
  let first: ReturnType<typeof createFirstGooglePasskey>
  let googleAccount: ReturnType<typeof createGoogleAccountCommands>
  let sessionManagement: ReturnType<typeof createSessionManagementCommands>
  let recoveryRotation: ReturnType<typeof createRecoveryRotationCommands>
  let recoveryGoogle: ReturnType<typeof createRecoveryGoogleCommands>
  const auth = betterAuth({
    ...authSchemaOptions,
    baseURL: config.origin, basePath: '/api/auth', secret: Redacted.value(config.secret),
    database: (options: BetterAuthOptions) => createAuthAdapter(owner, options),
    socialProviders: config.google ? { google: { clientId: Redacted.value(config.google.clientId), clientSecret: Redacted.value(config.google.clientSecret) } } : {},
    session: { ...authSchemaOptions.session, expiresIn: 604800, disableSessionRefresh: true, cookieCache: { enabled: false } },
    account: { accountLinking: { disableImplicitLinking: true } },
    advanced: { useSecureCookies: true, defaultCookieAttributes: { httpOnly: true, secure: true, sameSite: 'lax', path: '/' } },
    rateLimit: { enabled: true, customStorage: limiter.customStorage },
    logger: { disabled: true }, onAPIError: { throw: true, errorURL: config.origin + '/login' },
    plugins: [googleAdmission(owner, (provider, request) => bound(request).decorate(provider), boundMagic, boundEnrollment, boundPasskeyLogin, boundAdditional, request => first?.bound(request), request => googleAccount?.bound(request), request => sessionManagement?.bound(request),
      request => recoveryRotation?.bound(request), request => recoveryGoogle?.bound(request)),
      passkey({ rpID: new URL(config.origin).hostname, origin: config.origin,
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        registration: { requireSession: false,
          resolveUser: ({ ctx, context }) => { const authority = boundEnrollment(ctx.request); authority.assert('options', ctx.request); return authority.resolve(context) },
          afterVerification: async args => {
            try {
              const extra = first?.bound(args.ctx.request) ?? boundAdditional(args.ctx.request)
              if (extra) { extra.assert('complete', args.ctx.request); await extra.verified(args); return }
              const authority = boundEnrollment(args.ctx.request); authority.assert('complete', args.ctx.request); return await authority.verified(args)
            }
            catch (error) {
              // The native endpoint wraps non-API errors as500. Deliberate
              // app proof/UV refusals retain their input-failure classification.
              if (error instanceof MagicProofRejected || error instanceof AdditionalPasskeyRejected || error instanceof FirstGooglePasskeyRejected) throw new APIError('UNAUTHORIZED', { message: 'Authentication rejected' })
              throw error
            }
          },
        },
        authentication: { afterVerification: async args => {
          try {
            const authority = boundPasskeyLogin(args.ctx.request)
            authority.assert('complete', args.ctx.request)
            await authority.verified(args)
          } catch (error) {
            if (error instanceof PasskeyLoginRejected) throw new APIError('UNAUTHORIZED', { message: 'Authentication rejected' })
            throw error
          }
        } },
      })],
  })
  assertEndpointClassification(auth.api, true, true, true, true, true, true)
  recoveryRotation = createRecoveryRotationCommands(owner, config.origin, limiter, invoke, {
    session: request => auth.api.getSession({ request, headers: request.headers, asResponse: false, returnHeaders: true,
      query: { disableCookieCache: true, disableRefresh: true } }),
    execute: request => auth.api.rotateApplicationRecoveryCodes({ request, headers: request.headers, asResponse: false, returnHeaders: true }),
  })
  recoveryGoogle = createRecoveryGoogleCommands(owner, config.origin, config.google !== null, limiter, invoke, {
    begin: request => auth.api.beginApplicationRecoveryGoogleProof({ request, headers: request.headers, asResponse: false, returnHeaders: true }),
    complete: request => auth.api.completeApplicationRecoveryGoogleProof({ request, headers: request.headers, asResponse: false, returnHeaders: true }),
  })
  sessionManagement = createSessionManagementCommands(owner, config.origin, limiter, invoke, {
    session: request => auth.api.getSession({ request, headers: request.headers, asResponse: false, query: { disableCookieCache: true, disableRefresh: true } }),
    execute: request => auth.api.manageApplicationSessions({ request, headers: request.headers, asResponse: false, returnHeaders: true }),
  })
  googleAccount = createGoogleAccountCommands(owner, config.origin, config.google !== null, limiter, invoke, {
    session: request => auth.api.getSession({ request, headers: request.headers, asResponse: false, query: { disableCookieCache: true, disableRefresh: true } }),
    authorize: request => auth.api.authorizeApplicationGoogleAccount({ request, headers: request.headers, asResponse: false, returnHeaders: true }),
    complete: request => auth.api.completeApplicationGoogleAccount({ request, headers: request.headers, asResponse: false, returnHeaders: true }),
    mutate: request => auth.api.mutateApplicationGoogleAccount({ request, headers: request.headers, asResponse: false, returnHeaders: true }),
  })
  first = createFirstGooglePasskey(owner, config.origin, config.google !== null, limiter, invoke, {
    session: request => auth.api.getSession({ request, headers: request.headers, asResponse: false, query: { disableCookieCache: true, disableRefresh: true } }),
    begin: request => auth.api.beginApplicationFirstGooglePasskey({ request, headers: request.headers, asResponse: false, returnHeaders: true }),
    complete: request => auth.api.completeApplicationFirstGooglePasskey({ request, headers: request.headers, asResponse: false, returnHeaders: true }),
    options: (request, context) => auth.api.generatePasskeyRegistrationOptions({ request, headers: request.headers, asResponse: false, returnHeaders: true, query: { context } }),
    finish: (request, response) => auth.api.verifyPasskeyRegistration({ request, headers: request.headers, asResponse: false, returnHeaders: true, body: { response, createSession: false } }),
  })
  function invoke<A>(request: Request, call: () => Promise<A>) {
    assertOpen()
    owner.assertNoActiveAuthTransaction()
    return owner.runAuthInvocation({ deadlineAtMs: requestAuthDeadlineAtMs(request), statementTimeoutMs: 1000, cleanupTimeoutMs: 1000, correlationId: randomUUID(), signal: request.signal }, async () => {
      if (!protocol || !transport) {
        const result = await call(); assertOpen(); owner.invocationOptions(); return result
      }
      transport.assertOpen()
      if (Object.hasOwn(request, key) || !Object.isExtensible(request)) throw new Error('Authentication unavailable')
      const cell = protocol.lifetime()
      try {
        Object.defineProperty(request, key, { value: cell, enumerable: false, writable: false, configurable: true })
        const result = await call(); assertOpen(); cell.assert(); return result
      } finally {
        cell.revoke()
        try { if (!Reflect.deleteProperty(request, key)) throw new Error('Authentication unavailable') }
        finally { await cell.join() }
      }
    })
  }
  async function beginGoogleSignIn(request: Request, locale: 'fr' | 'en' = 'fr') {
    assertOpen()
    if (!config.google) throw new Response('Service Unavailable', { status: 503 })
    owner.assertNoActiveAuthTransaction()
    requestAuthDeadlineAtMs(request)
    await limiter.consumeAuthAttempt('beginGoogleSignIn', limiter.trustedClientContext(request))
    return invoke(request, async () => {
      const query = locale === 'en' ? '?lang=en' : ''
      const result = await auth.api.signInSocial({ request, asResponse: false, headers: request.headers, body: { provider: 'google', callbackURL: config.origin + '/account' + query, errorCallbackURL: config.origin + '/login' + query, disableRedirect: true }, returnHeaders: true })
      if (!result.response.url) throw new Error('Authentication unavailable')
      return { url: result.response.url, headers: result.headers }
    })
  }
  function passkeyIngress(request: Request) {
    assertOpen()
    owner.assertNoActiveAuthTransaction()
    requestAuthDeadlineAtMs(request)
    if (request.method !== 'POST' || request.headers.get('origin') !== config.origin
      || request.headers.get('sec-fetch-site') === 'cross-site') throw new PasskeyLoginRejected()
  }
  async function assertAnonymousPasskeyRequest(request: Request) {
    const ambient = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true, disableRefresh: true } })
    if (ambient) throw new PasskeyLoginSessionConflict()
  }
  async function withPasskeyAuthority<A>(request: Request, operation: 'options' | 'complete',
    lease: Parameters<Parameters<AuthTransactions['withAuthPromise']>[1]>[0], locked: LockedPasskeyLogin | undefined,
    call: () => Promise<A>): Promise<A> {
    if (Object.hasOwn(request, passkeyLoginKey) || !Object.isExtensible(request)) throw new PasskeyLoginRejected()
    const invocation = owner.invocationOptions()
    let active = true, prepared = false, consumed = false, captured = false, issued = false, sessionCreated = false, returned = false
    let challengeExpiry: Date | undefined, newCounter: number | undefined, sessionId: string | undefined
    const assert = (expected: 'options' | 'complete', candidate = request) => {
      assertOpen()
      const descriptor = Object.getOwnPropertyDescriptor(request, passkeyLoginKey)
      if (!active || operation !== expected || candidate !== request || owner.currentDb() !== lease.db || owner.invocationOptions() !== invocation
        || !descriptor || descriptor.value !== cell || descriptor.enumerable || descriptor.writable || !descriptor.configurable) throw new PasskeyLoginRejected()
    }
    const cell: PasskeyLoginInvocation = Object.freeze({ assert,
      preparedChallenge(expiresAt) {
        assert('options')
        if (prepared || !(expiresAt instanceof Date) || !Number.isFinite(expiresAt.getTime())) throw new PasskeyLoginRejected()
        prepared = true; challengeExpiry = expiresAt
      },
      consumedChallenge(expiresAt) {
        assert('complete')
        if (consumed || !(expiresAt instanceof Date) || !Number.isFinite(expiresAt.getTime())) throw new PasskeyLoginRejected()
        consumed = true; challengeExpiry = expiresAt
      },
      async verified(args) {
        assert('complete')
        const counter = args.verification.authenticationInfo.newCounter
        if (!locked || !consumed || !challengeExpiry || captured || args.verification.verified !== true
          || args.verification.authenticationInfo.userVerified !== true
          || args.verification.authenticationInfo.credentialID !== locked.key.credentialID
          || !Number.isSafeInteger(counter) || counter < 0) throw new PasskeyLoginRejected()
        captured = true; newCounter = counter
        const now = await passkeyDatabaseTime(lease); assert('complete')
        if (challengeExpiry.getTime() <= now.getTime()) throw new PasskeyLoginRejected()
      },
      async take(userId) {
        assert('complete')
        if (!locked || !captured || newCounter === undefined || !challengeExpiry || issued || userId !== locked.user.id) throw new PasskeyLoginRejected()
        issued = true
        await recheckLockedPasskeyLogin(lease, locked, newCounter); assert('complete')
        const now = await passkeyDatabaseTime(lease); assert('complete')
        if (challengeExpiry.getTime() <= now.getTime()) throw new PasskeyLoginRejected()
        return { now, newCounter, recoveryGeneration: locked.user.recoveryGeneration }
      },
      created(value) {
        assert('complete')
        if (!locked || !issued || sessionCreated || value.userId !== locked.user.id || value.authState !== 'ACTIVE'
          || value.authMethod !== 'passkey' || value.recoveryGeneration !== locked.user.recoveryGeneration
          || !(value.authenticatedAt instanceof Date) || !(value.lastActivityAt instanceof Date)
          || value.authenticatedAt.getTime() !== value.lastActivityAt.getTime()) throw new PasskeyLoginRejected()
        sessionCreated = true; sessionId = value.id
      },
      returned(candidateSessionId, userId) {
        assert('complete')
        if (!locked || !sessionCreated || returned || candidateSessionId !== sessionId || userId !== locked.user.id) throw new PasskeyLoginRejected()
        returned = true
      },
    })
    try {
      Object.defineProperty(request, passkeyLoginKey, { value: cell, enumerable: false, writable: false, configurable: true })
      const result = await call(); assert(operation)
      if (operation === 'options') {
        if (!prepared || !challengeExpiry) throw new PasskeyLoginRejected()
        const now = await passkeyDatabaseTime(lease); assert('options')
        if (challengeExpiry.getTime() <= now.getTime()) throw new PasskeyLoginRejected()
      } else {
        if (!locked || !consumed || !captured || !issued || !sessionCreated || !returned || !challengeExpiry || newCounter === undefined || !sessionId) {
          throw new PasskeyLoginRejected()
        }
        await validatePersistedPasskeySession(lease, locked, sessionId, challengeExpiry, newCounter); assert('complete')
      }
      return result
    } finally {
      active = false
      if (!Reflect.deleteProperty(request, passkeyLoginKey)) throw new PasskeyLoginRejected()
    }
  }
  async function beginPasskeySignIn(request: Request) {
    passkeyIngress(request)
    await limiter.consumeAuthAttempt('beginPasskeySignIn', limiter.trustedClientContext(request))
    return invoke(request, async () => {
      await assertAnonymousPasskeyRequest(request)
      return owner.withAuthPromise(owner.invocationOptions(), async lease => withPasskeyAuthority(request, 'options', lease, undefined, async () => {
        const result = await auth.api.generatePasskeyAuthenticationOptions({ request, headers: request.headers, asResponse: false, returnHeaders: true })
        const options = validatePasskeyAuthenticationOptions(result.response)
        if (!(result.headers instanceof Headers)) throw new PasskeyLoginRejected()
        return { options, headers: result.headers }
      }))
    })
  }
  async function finishPasskeySignIn(request: Request, input: unknown) {
    passkeyIngress(request)
    await limiter.consumeAuthAttempt('finishPasskeySignIn', limiter.trustedClientContext(request))
    const value = validatePasskeyFinishInput(input)
    return invoke(request, async () => {
      await assertAnonymousPasskeyRequest(request)
      return owner.withAuthPromise(owner.invocationOptions(), async lease => {
        const locked = await lockPasskeyLoginCandidate(lease, value.response.id)
        return withPasskeyAuthority(request, 'complete', lease, locked, async () => {
          const result = await auth.api.verifyPasskeyAuthentication({ request, headers: request.headers, asResponse: false,
            returnHeaders: true, body: { response: value.response } })
          let bindings: typeof authenticationResult.Type
          try { bindings = Schema.decodeUnknownSync(authenticationResult)(result.response) } catch { throw new PasskeyLoginRejected() }
          const authority = boundPasskeyLogin(request)
          if (bindings.session.userId !== locked.user.id || bindings.user.id !== locked.user.id
            || !(result.headers instanceof Headers)) throw new PasskeyLoginRejected()
          authority.returned(bindings.session.id, bindings.user.id)
          authority.assert('complete', request)
          return { authenticated: true as const, headers: result.headers }
        })
      })
    })
  }
  async function additionalCommand(request: Request, command: AdditionalPasskeyInvocation['command'], input?: unknown) {
    assertOpen(); owner.assertNoActiveAuthTransaction(); requestAuthDeadlineAtMs(request)
    if (request.method !== 'POST' || request.headers.get('origin') !== config.origin
      || request.headers.get('sec-fetch-site') === 'cross-site') throw new AdditionalPasskeyRejected()
    await limiter.consumeAuthAttempt(command, limiter.trustedClientContext(request))
    const authorize = command === 'authorizeAdditionalPasskey' ? validateAdditionalPasskeyAuthorizeInput(input) : undefined
    const finish = command === 'finishAdditionalPasskey' ? validateAdditionalPasskeyFinishInput(input) : undefined
    return invoke(request, () => owner.withAuthPromise(owner.invocationOptions(), async lease => {
      if (Object.hasOwn(request, additionalKey) || !Object.isExtensible(request)) throw new AdditionalPasskeyRejected()
      const invocation = owner.invocationOptions()
      let active = true, phase: 'session' | 'options' | 'complete' = 'session'
      let state: AdditionalPasskeyState | undefined
      let prepared: { identifier: string; expiresAt: Date } | undefined
      let consumed = false, verified = false, verifiedCredential: string | undefined
      let lockedVerification: Awaited<ReturnType<typeof lockAdditionalVerification>> | undefined
      const assert = (operation: 'session' | 'options' | 'complete', candidate = request) => {
        assertOpen()
        const descriptor = Object.getOwnPropertyDescriptor(request, additionalKey)
        if (!active || candidate !== request || phase !== operation || owner.currentDb() !== lease.db
          || owner.invocationOptions() !== invocation || !descriptor || descriptor.value !== cell
          || descriptor.enumerable || descriptor.writable || !descriptor.configurable || cell.command !== command
          || operation === 'options' && command !== 'authorizeAdditionalPasskey'
          || operation === 'complete' && command !== 'finishAdditionalPasskey') throw new AdditionalPasskeyRejected()
      }
      const cell: AdditionalPasskeyInvocation = Object.freeze({ command, assert,
        async checkAmbient(ambient) {
          assert(phase)
          if (!state || !ambient || ambient.user.id !== state.user.id || ambient.session.id !== state.session.id) throw new AdditionalPasskeyRejected()
          await recheckAdditionalState(lease, state); assert(phase)
        },
        async prepareChallenge(data) {
          assert('options')
          if (!state?.intent || prepared || !data.identifier || !Number.isFinite(data.expiresAt.getTime())) throw new AdditionalPasskeyRejected()
          checkAdditionalChallenge(data, state)
          const expiresAt = new Date(Math.min(data.expiresAt.getTime(), state.intent.expiresAt.getTime()))
          await recheckAdditionalState(lease, state); assert('options')
          if (expiresAt.getTime() <= (await additionalDatabaseTime(lease)).getTime()) throw new AdditionalPasskeyRejected()
          prepared = { identifier: data.identifier, expiresAt }
          return { ...data, expiresAt }
        },
        async beforeConsume(identifier) {
          assert('complete')
          if (!state || lockedVerification || consumed) throw new AdditionalPasskeyRejected()
          lockedVerification = await lockAdditionalVerification(lease, state, identifier); assert('complete')
        },
        async consumedChallenge(value) {
          assert('complete')
          if (!state || !lockedVerification || consumed || value.id !== lockedVerification.id
            || value.identifier !== lockedVerification.identifier || value.value !== lockedVerification.value
            || value.expiresAt.getTime() !== lockedVerification.expiresAt.getTime()) throw new AdditionalPasskeyRejected()
          consumed = true
          await recheckAdditionalState(lease, state); assert('complete')
          if (value.expiresAt.getTime() <= (await additionalDatabaseTime(lease)).getTime()) throw new AdditionalPasskeyRejected()
        },
        async verified(args) {
          assert('complete', args.ctx.request)
          if (!state?.intent || !state.key || !consumed || verified || args.verification.verified !== true
            || args.verification.registrationInfo?.userVerified !== true || args.user.id !== state.user.id
            || args.ctx.context.session?.user.id !== state.user.id || args.ctx.context.session?.session.id !== state.session.id
            || args.context !== 'additional-passkey:' + state.intent.id
            || args.verification.registrationInfo.credential.id === state.key.credentialID
            || !lockedVerification) throw new AdditionalPasskeyRejected()
          await recheckAdditionalState(lease, state); assert('complete')
          if (lockedVerification.expiresAt.getTime() <= (await additionalDatabaseTime(lease)).getTime()) throw new AdditionalPasskeyRejected()
          const changed = await lease.db.update(additionalPasskeyIntent).set({ phase: 'CONSUMED' })
            .where(and(eq(additionalPasskeyIntent.id, state.intent.id), eq(additionalPasskeyIntent.phase, 'AUTHORIZED'))).returning({ id: additionalPasskeyIntent.id })
          if (changed.length !== 1) throw new AdditionalPasskeyRejected()
          verified = true; verifiedCredential = args.verification.registrationInfo.credential.id
        },
      })
      try {
        Object.defineProperty(request, additionalKey, { value: cell, enumerable: false, writable: false, configurable: true })
        const ambient = await auth.api.getSession({ request, headers: request.headers, asResponse: false,
          query: { disableCookieCache: true, disableRefresh: true } })
        assert('session')
        if (!ambient) throw new AdditionalPasskeyRejected()
        state = await lockAdditionalState(lease, ambient, authorize ? { intentId: authorize.intentId, phase: 'CHALLENGE', credentialId: authorize.response.id }
          : finish ? { intentId: finish.intentId, phase: 'AUTHORIZED' } : undefined)
        assert('session')
        if (command === 'beginAdditionalPasskey') {
          const value = await beginAdditionalIntent(lease, state, new URL(config.origin).hostname)
          assert('session'); return { kind: 'begin' as const, value }
        }
        if (!state.intent || !state.key) throw new AdditionalPasskeyRejected()
        if (authorize) {
          await verifyAdditionalAssertion(lease, state, authorize, config.origin)
          phase = 'options'
          const result = await auth.api.generatePasskeyRegistrationOptions({ request, headers: request.headers, asResponse: false,
            returnHeaders: true, query: { context: 'additional-passkey:' + state.intent.id } })
          assert('options')
          if (!prepared || !(result.headers instanceof Headers)) throw new AdditionalPasskeyRejected()
          const changed = await lease.db.update(additionalPasskeyIntent).set({ phase: 'AUTHORIZED', authenticationChallenge: null,
            authorizingKeyId: state.key.id, authorizingCredentialId: state.key.credentialID, authorizingPublicKey: state.key.publicKey,
            registrationVerificationIdentifier: prepared.identifier })
            .where(and(eq(additionalPasskeyIntent.id, state.intent.id), eq(additionalPasskeyIntent.phase, 'CHALLENGE'))).returning()
          if (changed.length !== 1) throw new AdditionalPasskeyRejected()
          state.intent = changed[0]
          await recheckAdditionalState(lease, state); assert('options')
          if (prepared.expiresAt.getTime() <= (await additionalDatabaseTime(lease)).getTime()) throw new AdditionalPasskeyRejected()
          return { kind: 'authorize' as const, value: { intentId: state.intent.id, expiresAt: state.intent.expiresAt.toISOString(),
            options: result.response, headers: result.headers } }
        }
        if (!finish) throw new AdditionalPasskeyRejected()
        phase = 'complete'
        const result = await auth.api.verifyPasskeyRegistration({ request, headers: request.headers, asResponse: false,
          returnHeaders: true, body: { response: finish.response, createSession: false } })
        assert('complete')
        if (!verified || !verifiedCredential || !lockedVerification) throw new AdditionalPasskeyRejected()
        let binding: { id: string; userId: string; credentialID: string }
        try { binding = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.NonEmptyString, userId: Schema.NonEmptyString,
          credentialID: Schema.NonEmptyString }))(result.response) } catch { throw new AdditionalPasskeyRejected() }
        if (binding.userId !== state.user.id || binding.credentialID !== verifiedCredential) throw new AdditionalPasskeyRejected()
        const [persisted] = await lease.db.select().from(storedPasskey).where(eq(storedPasskey.id, binding.id))
        if (!persisted || persisted.userId !== state.user.id || persisted.credentialID !== verifiedCredential) throw new AdditionalPasskeyRejected()
        await recheckAdditionalState(lease, state); assert('complete')
        if (lockedVerification.expiresAt.getTime() <= (await additionalDatabaseTime(lease)).getTime()) throw new AdditionalPasskeyRejected()
        return { kind: 'finish' as const, value: { added: true as const } }
      } finally {
        active = false
        if (!Reflect.deleteProperty(request, additionalKey)) throw new AdditionalPasskeyRejected()
      }
    }))
  }
  async function beginAdditionalPasskey(request: Request) {
    const result = await additionalCommand(request, 'beginAdditionalPasskey')
    if (result.kind !== 'begin') throw new AdditionalPasskeyRejected()
    return result.value
  }
  async function authorizeAdditionalPasskey(request: Request, input: unknown) {
    const result = await additionalCommand(request, 'authorizeAdditionalPasskey', input)
    if (result.kind !== 'authorize') throw new AdditionalPasskeyRejected()
    return result.value
  }
  async function finishAdditionalPasskey(request: Request, input: unknown) {
    const result = await additionalCommand(request, 'finishAdditionalPasskey', input)
    if (result.kind !== 'finish') throw new AdditionalPasskeyRejected()
    return result.value
  }
  function additionalPasskeyErrorResponse(error: unknown): Response | undefined {
    const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }
    if (error instanceof AdditionalPasskeyRejected || error instanceof APIError && (error.statusCode === 400 || error.statusCode === 401)) {
      return new Response('Authentication rejected', { status: 401, headers })
    }
    if (error instanceof PgTransactionError && error.phase === 'finalize' && error.outcome === 'unknown') {
      return new Response('Addition outcome unconfirmed', { status: 409, headers })
    }
    return undefined
  }
  function magicIngress(request: Request) {
    assertOpen()
    owner.assertNoActiveAuthTransaction()
    requestAuthDeadlineAtMs(request)
    if (request.method !== 'POST' || request.headers.get('origin') !== config.origin
      || request.headers.get('sec-fetch-site') === 'cross-site') throw new MagicProofRejected()
    if (!config.magic) throw new Response('Service Unavailable', { status: 503 })
    return config.magic
  }
  async function requestMagicLink(request: Request, input: MagicRequestInput) {
    const producer = magicIngress(request)
    await limiter.consumeAuthAttempt('requestMagicLink', limiter.trustedClientContext(request))
    const value = validateMagicRequest(input)
    await invoke(request, () => owner.withAuthPromise(owner.invocationOptions(), lease => requestMagicProof(lease, value, producer)))
    return { accepted: true as const }
  }
  async function consumeMagicLink(request: Request, input: unknown) {
    magicIngress(request)
    await limiter.consumeAuthAttempt('consumeMagicLink', limiter.trustedClientContext(request))
    const value = validateMagicConsume(input)
    return invoke(request, async () => {
      // The native reader remains on its unrelated no-outer path. Its opaque
      // cookie validation, rather than a posted identity, establishes ambient state.
      const ambient = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true, disableRefresh: true } })
      return owner.withAuthPromise(owner.invocationOptions(), async lease => {
        const candidate = await findMagicCommand(lease, value)
        if (candidate.userId === null) {
          if (ambient) throw new MagicSessionConflict()
          return initialEnrollment(request, value, lease, 'options')
        }
        if (Object.hasOwn(request, magicKey) || !Object.isExtensible(request)) throw new MagicProofRejected()
        const invocation = owner.invocationOptions()
        let active = true, established = false, issued = false, proof: MagicProof | undefined
        const assert = (candidate = request) => {
          assertOpen()
          const descriptor = Object.getOwnPropertyDescriptor(request, magicKey)
          if (!active || candidate !== request || owner.currentDb() !== lease.db || owner.invocationOptions() !== invocation
            || !descriptor || descriptor.value !== cell || descriptor.enumerable || descriptor.writable || !descriptor.configurable) throw new MagicProofRejected()
        }
        const cell: MagicInvocation = Object.freeze({ assert,
          async establish() {
            assert(); if (established) throw new MagicProofRejected(); established = true
            proof = await establishMagicProof(lease, value, ambient?.user.id); assert(); return proof
          },
          async take(userId: string) {
            assert(); if (!proof || issued || proof.user.id !== userId) throw new MagicProofRejected(); issued = true
            const now = await magicDatabaseTime(lease); assert()
            if (proof.command.expiresAt.getTime() <= now.getTime()) throw new MagicProofRejected()
            return { ...proof, now }
          },
        })
        try {
          Object.defineProperty(request, magicKey, { value: cell, enumerable: false, writable: false, configurable: true })
          const result = await auth.api.consumeApplicationMagic({ request, headers: request.headers, asResponse: false, returnHeaders: true })
          assert()
          if (!issued || !proof || !result.response || result.response.authenticated !== true || Object.keys(result.response).length !== 1
            || !(result.headers instanceof Headers)) throw new MagicProofRejected()
          await finishMagicProof(lease, proof); assert()
          return { authenticated: true as const, headers: result.headers }
        } finally {
          active = false
          if (!Reflect.deleteProperty(request, magicKey)) throw new MagicProofRejected()
        }
      })
    })
  }
  async function completeMagicEnrollment(request: Request, input: unknown) {
    magicIngress(request)
    await limiter.consumeAuthAttempt('completeMagicEnrollment', limiter.trustedClientContext(request))
    const value = validateMagicEnrollment(input)
    return invoke(request, async () => {
      const ambient = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true, disableRefresh: true } })
      if (ambient) throw new MagicSessionConflict()
      return owner.withAuthPromise(owner.invocationOptions(), lease => initialEnrollment(request, value, lease, 'complete', value.response))
    })
  }
  async function initialEnrollment(request: Request, value: MagicConsumeInput,
    lease: Parameters<Parameters<AuthTransactions['withAuthPromise']>[1]>[0], operation: 'options' | 'complete', response?: unknown) {
    const initial = await proveInitialMagic(lease, value)
    const context = initialContext(initial.command), prospectiveId = initial.command.id, invocation = owner.invocationOptions()
    if (Object.hasOwn(request, enrollmentKey) || !Object.isExtensible(request)) throw new MagicProofRejected()
    let active = true, resolved = false, verified = false, issued = false, challengePrepared = false
    let proof: MagicProof | undefined, challengeExpiry: Date | undefined
    const assert = (expected: 'options' | 'complete', candidate = request) => {
      assertOpen()
      const descriptor = Object.getOwnPropertyDescriptor(request, enrollmentKey)
      if (!active || operation !== expected || candidate !== request || owner.currentDb() !== lease.db || owner.invocationOptions() !== invocation
        || !descriptor || descriptor.value !== cell || descriptor.enumerable || descriptor.writable || !descriptor.configurable) throw new MagicProofRejected()
    }
    async function deadline() {
      const now = await magicDatabaseTime(lease); assert(operation)
      if (!challengeExpiry || Math.min(initial.command.expiresAt.getTime(), challengeExpiry.getTime()) <= now.getTime()) throw new MagicProofRejected()
      return now
    }
    const cell: InitialEnrollmentInvocation = Object.freeze({ assert,
      resolve(storedContext) {
        assert('options'); if (resolved || storedContext !== context) throw new MagicProofRejected(); resolved = true
        return { id: prospectiveId, name: initial.command.recipient, displayName: initial.command.recipient }
      },
      prepareChallenge(data) {
        assert('options'); if (!resolved || challengePrepared) throw new MagicProofRejected(); challengePrepared = true
        return { ...data, expiresAt: new Date(Math.min(data.expiresAt.getTime(), initial.command.expiresAt.getTime())) }
      },
      consumedChallenge(expiresAt) {
        assert('complete'); if (challengeExpiry) throw new MagicProofRejected(); challengeExpiry = expiresAt
      },
      async verified(args) {
        assert('complete')
        // UV is checked on the native verified result before any identity write.
        if (args.verification.registrationInfo?.userVerified !== true || verified || args.context !== context
          || args.user.id !== prospectiveId || args.user.name !== initial.command.recipient || args.user.displayName !== initial.command.recipient) throw new MagicProofRejected()
        verified = true
        await deadline()
        await proveInitialMagic(lease, value); assert('complete')
        const created = await args.ctx.context.internalAdapter.createUser({ name: initial.command.recipient, email: initial.command.recipient, emailVerified: true }, { method: 'magic-link' })
        assert('complete')
        if (!created || created.email !== initial.command.recipient || !created.emailVerified) throw new MagicProofRejected()
        const final = await proveInitialMagic(lease, value, created.id); assert('complete')
        if (initialContext(final.command) !== context) throw new MagicProofRejected()
        const [bound] = await lease.db.select().from(user).where(eq(user.id, created.id)).for('update')
        if (!bound) throw new MagicProofRejected()
        proof = { ...final, user: bound }
        await deadline(); return { userId: created.id }
      },
      async take(userId) {
        assert('complete')
        if (!verified || !proof || issued || proof.user.id !== userId) throw new MagicProofRejected()
        issued = true
        return { ...proof, now: await deadline() }
      },
    })
    try {
      Object.defineProperty(request, enrollmentKey, { value: cell, enumerable: false, writable: false, configurable: true })
      if (operation === 'options') {
        const result = await auth.api.generatePasskeyRegistrationOptions({ request, headers: request.headers, asResponse: false, returnHeaders: true, query: { context } })
        assert('options')
        if (!resolved || !challengePrepared || !(result.headers instanceof Headers)) throw new MagicProofRejected()
        await proveInitialMagic(lease, value); assert('options')
        return { enrollmentRequired: true as const, options: result.response, headers: result.headers }
      }
      const result = await auth.api.verifyPasskeyRegistration({ request, headers: request.headers, asResponse: false, returnHeaders: true, body: { response, createSession: true } })
      assert('complete')
      let bindings: typeof registrationResult.Type
      try { bindings = Schema.decodeUnknownSync(registrationResult)(result.response) } catch { throw new MagicProofRejected() }
      if (!issued || !proof || bindings.user.id !== proof.user.id || bindings.userId !== proof.user.id
        || bindings.session.userId !== proof.user.id || !(result.headers instanceof Headers)) throw new MagicProofRejected()
      await deadline(); await finishMagicProof(lease, proof); assert('complete')
      return { authenticated: true as const, headers: result.headers }
    } finally {
      active = false
      if (!Reflect.deleteProperty(request, enrollmentKey)) throw new MagicProofRejected()
    }
  }
  async function readPrincipal(request: Request) {
    return invoke(request, async () => {
      const valid = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true, disableRefresh: true } })
      return valid ? readPrivatePrincipal(owner, valid) : null
    })
  }
  async function requirePrincipal(request: Request) {
    const principal = await readPrincipal(request)
    if (!principal) throw new Response('Unauthorized', { status: 401 })
    return principal
  }
  async function readAccount(request: Request) {
    return invoke(request, async () => {
      const valid = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true, disableRefresh: true } })
      if (!valid) throw new Response('Unauthorized', { status: 401 })
      return owner.withAuthPromise(owner.invocationOptions(), async lease => {
        const principal = await readPrivatePrincipal(owner, valid)
        if (!principal) throw new Response('Unauthorized', { status: 401 })
        const [current] = await lease.db.select().from(user).where(eq(user.id, principal.userId)).for('update')
        if (!current || current.recovering) throw new Response('Unauthorized', { status: 401 })
        const workspaceId = await lease.resolveAdditionalPasskeyWorkspace(principal)
        const keys = await lease.db.select({ id: storedPasskey.id, name: storedPasskey.name, createdAt: storedPasskey.createdAt })
          .from(storedPasskey).where(eq(storedPasskey.userId, principal.userId))
        const now = await additionalDatabaseTime(lease)
        const additionalPasskey = current.holdUntil && current.holdUntil.getTime() > now.getTime() ? 'unavailable' as const
          : !workspaceId ? 'workspace-required' as const : !keys.length ? 'existing-key-required' as const : 'available' as const
        const googleAccounts = await lease.db.select({ id: storedAccount.id }).from(storedAccount)
          .where(and(eq(storedAccount.userId, principal.userId), eq(storedAccount.providerId, 'google')))
        const firstGooglePasskey = config.google !== null && !!workspaceId && keys.length === 0 && googleAccounts.length === 1
          && (!current.holdUntil || current.holdUntil.getTime() <= now.getTime())
        return { userId: principal.userId, name: principal.name, email: principal.email, additionalPasskey, firstGooglePasskey,
          sessionManagement: !!workspaceId && keys.length > 0,
          googleAccount: googleAccountConnection(googleAccounts, additionalPasskey === 'available', config.google !== null),
          passkeys: keys.map(key => ({ id: key.id, name: key.name, createdAt: key.createdAt?.toISOString() ?? null })) }
      })
    })
  }
  async function logout(request: Request) {
    await requirePrincipal(request)
    return invoke(request, () => auth.api.signOut({ headers: request.headers, returnHeaders: true }))
  }
  async function callback(request: Request) {
    if (!isPublicAuthRequest(request, config.origin)) return new Response('Not Found', { status: 404 })
    try { return await invoke(request, () => auth.handler(request)) }
    catch (error) {
      // BA's throw option bypasses better-call's raw defect logger. Native
      // APIError/FOUND responses still follow its normal protocol conversion.
      return limiter.errorResponse(error) ?? new Response('Internal Server Error', { status: 500 })
    }
  }
  function magicErrorResponse(error: unknown): Response | undefined {
    // Keep class identity with this factory across Nitro/SSR module copies.
    const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }
    if (error instanceof MagicProofRejected) return new Response('Authentication rejected', { status: 401, headers })
    if (error instanceof MagicSessionConflict) return new Response('Sign out before using this link', { status: 409, headers })
    if (error instanceof APIError && (error.statusCode === 400 || error.statusCode === 401)) return new Response('Authentication rejected', { status: 401, headers })
    return undefined
  }
  function passkeyErrorResponse(error: unknown): Response | undefined {
    const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }
    if (error instanceof PasskeyLoginRejected) return new Response('Authentication rejected', { status: 401, headers })
    if (error instanceof PasskeyLoginSessionConflict) return new Response('Sign out before using a passkey', { status: 409, headers })
    if (error instanceof APIError && (error.statusCode === 400 || error.statusCode === 401)) return new Response('Authentication rejected', { status: 401, headers })
    return undefined
  }
  const { bound: _firstBinding, ...firstCommands } = first
  const { bound: _googleAccountBinding, ...googleAccountCommands } = googleAccount
  const { bound: _sessionManagementBinding, ...sessionManagementCommands } = sessionManagement
  const { bound: _recoveryRotationBinding, ...recoveryRotationCommands } = recoveryRotation
  const { bound: _recoveryGoogleBinding, ...recoveryGoogleCommands } = recoveryGoogle
  return { ...firstCommands, ...googleAccountCommands, ...sessionManagementCommands, ...recoveryRotationCommands, ...recoveryGoogleCommands,
    beginGoogleSignIn, beginPasskeySignIn, finishPasskeySignIn, beginAdditionalPasskey, authorizeAdditionalPasskey, finishAdditionalPasskey,
    additionalPasskeyErrorResponse, requestMagicLink, consumeMagicLink, completeMagicEnrollment,
    readPrincipal, requirePrincipal, readAccount, logout, callback, magicErrorResponse, passkeyErrorResponse,
    availability: Object.freeze({ google: config.google !== null, magic: config.magic !== null, magicSignup: config.magic !== null, passkey: true }),
    close: () => { closed = true; return transport?.close() ?? Promise.resolve() } }
}
