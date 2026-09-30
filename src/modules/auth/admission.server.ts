import { Schema } from 'effect'
import { and, eq, sql } from 'drizzle-orm'
import type { AuthContext, BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthEndpoint, createAuthMiddleware, getSessionFromCtx, getOAuthState } from 'better-auth/api'
import { setSessionCookie } from 'better-auth/cookies'
import type { OAuthProvider } from 'better-auth/oauth2'
import type { AuthTransactions } from '../../platform/db/transactions.server'
import { account, recoveryAttempt, user, verification } from './schema.server'
import type { MagicInvocation } from './magic.server'
import type { InitialEnrollmentInvocation } from './initial-enrollment.server'
import type { PasskeyLoginInvocation } from './passkey-login.server'
import type { AdditionalPasskeyInvocation } from './additional-passkey.server'
import { firstGoogleEndpoints, type FirstGoogleInvocation } from './first-google-passkey-native.server'
import { firstGooglePurpose } from './first-google-passkey.server'
import { googleAccountEndpoints, type GoogleAccountInvocation } from './google-account-native.server'
import { googleAccountPurpose } from './google-account.server'
import { sessionManagementEndpoints, type SessionManagementInvocation } from './session-management-native.server'
import { recoveryGoogleEndpoints, recoveryRotationEndpoints, type RecoveryGoogleInvocation, type RecoveryRotationInvocation } from './recovery-native.server'
import { recoveryGooglePurpose } from './recovery.server'

const issuer = 'https://accounts.google.com'
const subjectSchema = Schema.Union([Schema.String, Schema.Number.check(Schema.isFinite())])
const nonblank = Schema.String.check(Schema.isMinLength(1), Schema.isPattern(/\S/))
const storedStatePurpose = Schema.Struct({ serverContext: Schema.optional(Schema.Struct({ purpose: Schema.optional(Schema.Unknown) })) })
type SelectedGoogle = Readonly<{ subject: string; userId?: string; generation: number }>
function rejected(): never { throw new APIError('UNAUTHORIZED', { message: 'Authentication rejected' }) }
function confinedRecoveryDirectAdapter(adapter: AuthContext['adapter']): AuthContext['adapter'] {
  const deny = async (): Promise<never> => rejected()
  return Object.freeze({ ...adapter,
    create: deny, findOne: deny, findMany: deny, count: deny, update: deny, updateMany: deny,
    delete: deny, deleteMany: deny, consumeOne: deny, incrementOne: deny, transaction: deny, createSchema: deny,
  })
}

export function googleAdmission(owner: AuthTransactions, decorateGoogle: (provider: OAuthProvider, request: Request | undefined) => OAuthProvider,
  magic?: (request: Request | undefined) => MagicInvocation,
  enrollment?: (request: Request | undefined) => InitialEnrollmentInvocation,
  passkeyLogin?: (request: Request | undefined) => PasskeyLoginInvocation,
  additional?: (request: Request | undefined) => AdditionalPasskeyInvocation | undefined,
  first?: (request: Request | undefined) => FirstGoogleInvocation | undefined,
  googleAccount?: (request: Request | undefined) => GoogleAccountInvocation | undefined,
  sessionManagement?: (request: Request | undefined) => SessionManagementInvocation | undefined,
  recoveryRotation?: (request: Request | undefined) => RecoveryRotationInvocation | undefined,
  recoveryGoogle?: (request: Request | undefined) => RecoveryGoogleInvocation | undefined) {
  return {
    id: 'application-session-admission',
    endpoints: { ...recoveryRotationEndpoints(request => recoveryRotation?.(request)), ...recoveryGoogleEndpoints(request => recoveryGoogle?.(request)),
      ...sessionManagementEndpoints(request => sessionManagement?.(request)), ...googleAccountEndpoints(request => googleAccount?.(request)), ...firstGoogleEndpoints(request => first?.(request)), consumeApplicationMagic: createAuthEndpoint('/application/magic/consume', { method: 'POST', metadata: { SERVER_ONLY: true } }, async ctx => {
      const authority = magic?.(ctx.request)
      if (!authority) return rejected()
      authority.assert()
      const proof = await authority.establish(); authority.assert()
      let nativeUser = await ctx.context.internalAdapter.findUserById(proof.user.id); authority.assert()
      if (!nativeUser || nativeUser.id !== proof.user.id) return rejected()
      if (!nativeUser.emailVerified) {
        nativeUser = await ctx.context.internalAdapter.updateUser(proof.user.id, { emailVerified: true }); authority.assert()
        if (!nativeUser) return rejected()
      }
      const session = await ctx.context.internalAdapter.createSession(proof.user.id); authority.assert()
      if (!session) return rejected()
      await setSessionCookie(ctx, { session, user: nativeUser }); authority.assert()
      return { authenticated: true as const }
    }) },
    hooks: { before: [{ matcher: () => true, handler: createAuthMiddleware(async ctx => {
      if (ctx.path === '/callback/:id' && ctx.params?.id === 'google' && ctx.request) {
        const states = new URL(ctx.request.url).searchParams.getAll('state')
        if (states.length === 1 && states[0] && states[0].length <= 1024) {
          const recoveryState = await owner.withAuthPromise(owner.invocationOptions(), async ({ db }) => {
            const rows = await db.select({ value: verification.value }).from(verification).where(eq(verification.identifier, states[0])).limit(2)
            const attempts = await db.select({ id: recoveryAttempt.id }).from(recoveryAttempt).where(eq(recoveryAttempt.oauthState, states[0])).limit(2)
            if (rows.length > 1 || attempts.length > 1) return true
            if (attempts.length === 1) return true
            if (!rows.length) return false
            try { return Schema.decodeUnknownSync(storedStatePurpose)(JSON.parse(rows[0].value)).serverContext?.purpose === recoveryGooglePurpose }
            catch { return true }
          })
          if (recoveryState) return rejected()
        }
      }
      const rotating = recoveryRotation?.(ctx.request)
      if (rotating || ctx.path === '/application/recovery/codes/rotate') {
        if (!rotating || ctx.path !== '/get-session' && ctx.path !== '/application/recovery/codes/rotate') return rejected()
        const operation = ctx.path === '/get-session' ? 'session' : 'outer'
        rotating.assert(operation, ctx.request)
        return { context: { context: { socialProviders: ctx.context.socialProviders,
          adapter: confinedRecoveryDirectAdapter(ctx.context.adapter),
          internalAdapter: rotating.constrain(ctx.context.internalAdapter, operation, ctx.request) } } }
      }
      const recoveringGoogle = recoveryGoogle?.(ctx.request)
      if (recoveringGoogle || ctx.path === '/application/recovery/google/begin' || ctx.path === '/application/recovery/google/complete') {
        if (!recoveringGoogle || ctx.path !== '/application/recovery/google/begin' && ctx.path !== '/application/recovery/google/complete') return rejected()
        recoveringGoogle.assert('oauth', ctx.request)
        owner.assertNoActiveAuthTransaction()
        return { context: { context: { socialProviders: ctx.context.socialProviders.map(provider => provider.id === 'google' ? decorateGoogle(provider, ctx.request) : provider),
          adapter: confinedRecoveryDirectAdapter(ctx.context.adapter),
          internalAdapter: recoveringGoogle.constrain(ctx.context.internalAdapter, ctx.request) } } }
      }
      const managing = sessionManagement?.(ctx.request)
      if (managing || ctx.path === '/application/session-management') {
        if (!managing || ctx.path !== '/get-session' && ctx.path !== '/application/session-management') return rejected()
        const operation = ctx.path === '/get-session' ? 'session' : 'execute'
        managing.assert(operation, ctx.request)
        return { context: { context: { socialProviders: ctx.context.socialProviders,
          internalAdapter: managing.constrain(ctx.context.internalAdapter, operation, ctx.request) } } }
      }
      if (ctx.path === '/get-session') {
        const authority = googleAccount?.(ctx.request) ?? first?.(ctx.request) ?? additional?.(ctx.request)
        if (authority) {
          authority.assert('session', ctx.request)
          return { context: { context: { socialProviders: ctx.context.socialProviders, internalAdapter: ctx.context.internalAdapter } } }
        }
      }
      if (ctx.path === '/application/account/google/authorize' || ctx.path === '/application/account/google/complete' || ctx.path === '/application/account/google/mutate') {
        const authority = googleAccount?.(ctx.request)
        if (!authority) return rejected()
        const operation = ctx.path === '/application/account/google/mutate' ? 'mutation' : 'oauth'
        authority.assert(operation, ctx.request)
        if (operation === 'oauth') owner.assertNoActiveAuthTransaction()
        const original = ctx.context.internalAdapter
        const createSession: typeof original.createSession = async () => rejected()
        const updateSession: typeof original.updateSession = async () => rejected()
        const deleteSession: typeof original.deleteSession = async () => rejected()
        const createUser: typeof original.createUser = async () => rejected()
        const updateUser: typeof original.updateUser = async () => rejected()
        const deleteUser: typeof original.deleteUser = async () => rejected()
        const createOAuthUser: typeof original.createOAuthUser = async () => rejected()
        const linkAccount: typeof original.linkAccount = async () => rejected()
        const deleteAccounts: typeof original.deleteAccounts = async () => rejected()
        const updateUserByEmail: typeof original.updateUserByEmail = async () => rejected()
        const updatePassword: typeof original.updatePassword = async () => rejected()
        const deleteUserSessions: typeof original.deleteUserSessions = async () => rejected()
        const deleteSessions: typeof original.deleteSessions = async () => rejected()
        const updateAccount: typeof original.updateAccount = async () => rejected()
        const createAccount: typeof original.createAccount = async data => {
          authority.admitCreate(data, ctx.request)
          const value = await original.createAccount(data); authority.assert('mutation', ctx.request); return value
        }
        const deleteAccount: typeof original.deleteAccount = async id => {
          authority.admitDelete(id, ctx.request)
          await original.deleteAccount(id); authority.assert('mutation', ctx.request)
        }
        return { context: { context: {
          socialProviders: operation === 'oauth' ? ctx.context.socialProviders.map(provider => provider.id === 'google' ? decorateGoogle(provider, ctx.request) : provider) : ctx.context.socialProviders,
          internalAdapter: { ...original, createSession, updateSession, deleteSession, createUser, updateUser, deleteUser, createAccount, updateAccount, deleteAccount,
            createOAuthUser, linkAccount, deleteAccounts, updateUserByEmail, updatePassword, deleteUserSessions, deleteSessions },
        } } }
      }
      if (ctx.path === '/passkey/generate-authenticate-options' || ctx.path === '/passkey/verify-authentication') {
        const authority = passkeyLogin?.(ctx.request)
        if (!authority) return rejected()
        const operation = ctx.path === '/passkey/generate-authenticate-options' ? 'options' : 'complete'
        authority.assert(operation, ctx.request)
        const original = ctx.context.internalAdapter
        const createVerificationValue: typeof original.createVerificationValue = async data => {
          authority.assert('options', ctx.request)
          const result = await original.createVerificationValue(data)
          authority.assert('options', ctx.request)
          authority.preparedChallenge(data.expiresAt)
          return result
        }
        const consumeVerificationValue: typeof original.consumeVerificationValue = async identifier => {
          authority.assert('complete', ctx.request)
          const result = await original.consumeVerificationValue(identifier)
          authority.assert('complete', ctx.request)
          if (result) authority.consumedChallenge(result.expiresAt)
          return result
        }
        const createSession: typeof original.createSession = async (userId, remember, override, overrideAll, storage) => {
          authority.assert('complete', ctx.request)
          if (remember !== undefined || override !== undefined || overrideAll !== undefined || storage !== undefined) return rejected()
          const proof = await authority.take(userId)
          authority.assert('complete', ctx.request)
          const created = await original.createSession(userId, undefined, { authState: 'ACTIVE', authMethod: 'passkey',
            authenticatedAt: proof.now, lastActivityAt: proof.now, recoveryGeneration: proof.recoveryGeneration }, false)
          authority.assert('complete', ctx.request)
          if (!created) return rejected()
          authority.created(created)
          return created
        }
        return { context: { context: { socialProviders: ctx.context.socialProviders,
          internalAdapter: { ...original, createSession, createVerificationValue, consumeVerificationValue } } } }
      }
      if (ctx.path === '/passkey/generate-register-options' || ctx.path === '/passkey/verify-registration') {
        const extra = first?.(ctx.request) ?? additional?.(ctx.request)
        if (extra) {
          const operation = ctx.path === '/passkey/generate-register-options' ? 'options' : 'complete'
          extra.assert(operation, ctx.request)
          const ambient = await getSessionFromCtx(ctx, { disableCookieCache: true, disableRefresh: true })
          await extra.checkAmbient(ambient)
          extra.assert(operation, ctx.request)
          const original = ctx.context.internalAdapter
          const createSession: typeof original.createSession = async () => rejected()
          const updateSession: typeof original.updateSession = async () => rejected()
          const deleteSession: typeof original.deleteSession = async () => rejected()
          const createVerificationValue: typeof original.createVerificationValue = async data => {
            extra.assert('options', ctx.request)
            const prepared = await extra.prepareChallenge(data)
            const result = await original.createVerificationValue(prepared)
            extra.assert('options', ctx.request)
            if (!result || result.identifier !== prepared.identifier || result.value !== prepared.value
              || result.expiresAt.getTime() !== prepared.expiresAt.getTime()) return rejected()
            return result
          }
          const consumeVerificationValue: typeof original.consumeVerificationValue = async identifier => {
            extra.assert('complete', ctx.request)
            await extra.beforeConsume(identifier)
            const result = await original.consumeVerificationValue(identifier)
            extra.assert('complete', ctx.request)
            if (!result) return rejected()
            await extra.consumedChallenge(result)
            return result
          }
          return { context: { context: { socialProviders: ctx.context.socialProviders,
            internalAdapter: { ...original, createSession, updateSession, deleteSession, createVerificationValue, consumeVerificationValue } } } }
        }
        const authority = enrollment?.(ctx.request)
        if (!authority) return rejected()
        const operation = ctx.path === '/passkey/generate-register-options' ? 'options' : 'complete'
        authority.assert(operation, ctx.request)
        const original = ctx.context.internalAdapter
        const createSession: typeof original.createSession = async (userId, remember, override, overrideAll, storage) => {
          authority.assert('complete', ctx.request)
          if (remember !== undefined || override !== undefined || overrideAll !== undefined
            || storage?.deferSecondaryStorageWrites !== true || Object.keys(storage).length !== 1) return rejected()
          const proof = await authority.take(userId); authority.assert('complete', ctx.request)
          const result = await original.createSession(userId, undefined, { authState: 'ACTIVE', authMethod: 'magic-link',
            authenticatedAt: proof.now, lastActivityAt: proof.now, recoveryGeneration: proof.user.recoveryGeneration }, false, storage)
          authority.assert('complete', ctx.request); return result
        }
        const createVerificationValue: typeof original.createVerificationValue = async data => {
          authority.assert('options', ctx.request)
          const result = await original.createVerificationValue(authority.prepareChallenge(data))
          authority.assert('options', ctx.request); return result
        }
        const consumeVerificationValue: typeof original.consumeVerificationValue = async identifier => {
          authority.assert('complete', ctx.request)
          const result = await original.consumeVerificationValue(identifier)
          authority.assert('complete', ctx.request)
          if (result) authority.consumedChallenge(result.expiresAt)
          return result
        }
        return { context: { context: { socialProviders: ctx.context.socialProviders, internalAdapter: { ...original, createSession, createVerificationValue, consumeVerificationValue } } } }
      }
      if (ctx.path === '/application/magic/consume') {
        const authority = magic?.(ctx.request)
        if (!authority) return rejected()
        authority.assert()
        const original: AuthContext['internalAdapter']['createSession'] = ctx.context.internalAdapter.createSession
        const createSession: typeof original = async (userId, remember, override, overrideAll, storage) => {
          authority.assert()
          if (remember !== undefined || override !== undefined || overrideAll !== undefined || storage !== undefined) return rejected()
          const proof = await authority.take(userId); authority.assert()
          const result = await original(userId, undefined, { authState: 'ACTIVE', authMethod: 'magic-link',
            authenticatedAt: proof.now, lastActivityAt: proof.now, recoveryGeneration: proof.user.recoveryGeneration }, false)
          authority.assert(); return result
        }
        return { context: { context: { socialProviders: ctx.context.socialProviders, internalAdapter: { ...ctx.context.internalAdapter, createSession } } } }
      }
      if (ctx.path === '/application/first-passkey/google/begin' || ctx.path === '/application/first-passkey/google/complete') {
        const authority = first?.(ctx.request)
        if (!authority) return rejected()
        authority.assert('oauth', ctx.request)
        owner.assertNoActiveAuthTransaction()
        const original = ctx.context.internalAdapter
        const createSession: typeof original.createSession = async () => rejected()
        const updateSession: typeof original.updateSession = async () => rejected()
        const deleteSession: typeof original.deleteSession = async () => rejected()
        const createUser: typeof original.createUser = async () => rejected()
        const updateUser: typeof original.updateUser = async () => rejected()
        const createAccount: typeof original.createAccount = async () => rejected()
        const updateAccount: typeof original.updateAccount = async () => rejected()
        return { context: { context: { socialProviders: ctx.context.socialProviders.map(provider => provider.id === 'google' ? decorateGoogle(provider, ctx.request) : provider),
          internalAdapter: { ...original, createSession, updateSession, deleteSession, createUser, updateUser, createAccount, updateAccount } } } }
      }
      owner.assertNoActiveAuthTransaction()
      let selected: SelectedGoogle | undefined
      let captures = 0
      let issued = false
      const callback = ctx.path === '/callback/:id' && ctx.params?.id === 'google'
      const socialProviders = ctx.context.socialProviders.map(provider => {
        if (provider.id !== 'google') return provider
        const original = provider.accountSubject
        if (!original) return rejected()
        const accountSubject: typeof original = async input => {
          if (!callback || ++captures !== 1 || issued) return rejected()
          const result = await original(input)
          let subject: string
          try { subject = Schema.decodeUnknownSync(nonblank)(String(Schema.decodeUnknownSync(subjectSchema)(result))) }
          catch { return rejected() }
          selected = await owner.withAuthPromise(owner.invocationOptions(), async ({ db }) => {
            const [prior] = await db.select({ userId: user.id, generation: user.recoveryGeneration, recovering: user.recovering })
              .from(account).innerJoin(user, eq(account.userId, user.id)).where(and(eq(account.providerId, 'google'), eq(account.accountId, subject)))
            if (prior?.recovering) return rejected()
            return { subject, userId: prior?.userId, generation: prior?.generation ?? 0 }
          })
          return result
        }
        const copy = { ...provider, accountSubject }
        const decorated = callback || ctx.path === '/sign-in/social' && ctx.body?.provider === 'google' ? decorateGoogle(copy, ctx.request) : copy
        return callback ? { ...decorated, async validateAuthorizationCode(input: Parameters<typeof decorated.validateAuthorizationCode>[0]) {
          const purpose = (await getOAuthState())?.serverContext?.purpose
          if (purpose === firstGooglePurpose || purpose === googleAccountPurpose || purpose === recoveryGooglePurpose) return rejected()
          return decorated.validateAuthorizationCode(input)
        } } : decorated
      })
      const nativeStateLookup = ctx.context.internalAdapter.findVerificationValue
      const findVerificationValue: typeof nativeStateLookup = async identifier => {
        const value = await nativeStateLookup(identifier)
        if (value) {
          let purpose: unknown
          try { purpose = Schema.decodeUnknownSync(storedStatePurpose)(JSON.parse(value.value)).serverContext?.purpose }
          catch { return rejected() }
          // Refuse foreign state before native parseState expires its cookie or
          // deletes verification. Native signature/correlation checks stay native.
          if (purpose === firstGooglePurpose || purpose === googleAccountPurpose || purpose === recoveryGooglePurpose) return rejected()
        }
        return value
      }
      const original: AuthContext['internalAdapter']['createSession'] = ctx.context.internalAdapter.createSession
      const createSession: typeof original = async (userId, remember, override, overrideAll, storage) => {
        owner.assertNoActiveAuthTransaction()
        if (!callback || !selected || captures !== 1 || issued || remember !== undefined || override !== undefined || overrideAll !== undefined
          || storage?.deferSecondaryStorageWrites !== false || Object.keys(storage).length !== 1) return rejected()
        issued = true
        const key = selected
        return owner.withAuthPromise(owner.invocationOptions(), async ({ db }) => {
          const [current] = await db.select({ id: user.id, recovering: user.recovering, generation: user.recoveryGeneration }).from(user).where(eq(user.id, userId)).for('update')
          if (!current || current.recovering || current.generation !== key.generation || key.userId !== undefined && key.userId !== userId) return rejected()
          const [binding] = await db.select({ userId: account.userId }).from(account).where(and(eq(account.providerId, 'google'), eq(account.accountId, key.subject), eq(account.userId, userId))).for('update')
          if (!binding) return rejected()
          const [clock] = await db.select({ now: sql<Date>`clock_timestamp()` }).from(user).where(eq(user.id, userId))
          if (!clock) return rejected()
          // No TOTP enrollment exists until its own consumer adds that policy.
          // Additional fields have no defaults; Better Auth retains all token ownership.
          return original(userId, remember, { authState: 'ACTIVE', authMethod: 'google', authenticatedAt: clock.now,
            lastActivityAt: clock.now, recoveryGeneration: current.generation, providerIdentity: { issuer, subject: key.subject } }, false, storage)
        })
      }
      return { context: { context: { socialProviders, internalAdapter: { ...ctx.context.internalAdapter, createSession,
        ...(callback ? { findVerificationValue } : {}) } } } }
    }) }] },
  } satisfies BetterAuthPlugin
}
