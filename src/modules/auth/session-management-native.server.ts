import type { AuthContext } from 'better-auth'
import { APIError, createAuthEndpoint } from 'better-auth/api'
import { eq } from 'drizzle-orm'
import type { AuthTransactions } from '../../platform/db/transactions.server'
import { requestAuthDeadlineAtMs } from '../../platform/resources.server'
import type { createAuthRateLimiter } from './rate-limit.server'
import { verification } from './schema.server'
import { SessionManagementRejected, advanceSessionManagementKey, cleanupSessionManagementChallenges, completeSessionList, completeSessionRevocation, lockSessionManagementState,
  prepareSessionManagement, recheckSessionManagementState, validateSessionManagementFinish, validateSessionManagementNativeResult,
  validateSessionList, validateSessionRevocation } from './session-management.server'

type Adapter = AuthContext['internalAdapter']
type Operation = 'session' | 'execute'
type Command = 'beginSessionList' | 'finishSessionList' | 'beginSessionRevocation' | 'finishSessionRevocation'
export type SessionManagementInvocation = Readonly<{
  assert(operation: Operation, request?: Request): void
  constrain(adapter: Adapter, operation: Operation, request?: Request): Adapter
  execute(adapter: Adapter, request?: Request): Promise<{ completed: true }>
}>
export function sessionManagementEndpoints(bound: (request?: Request) => SessionManagementInvocation | undefined) {
  return { manageApplicationSessions: createAuthEndpoint('/application/session-management', { method: 'POST', metadata: { SERVER_ONLY: true } }, async ctx => {
    const authority = bound(ctx.request)
    if (!authority) throw new SessionManagementRejected()
    authority.assert('execute', ctx.request)
    return authority.execute(ctx.context.internalAdapter, ctx.request)
  }) }
}
type NativeCalls = {
  session(request: Request): Promise<{ user: { id: string }; session: { id: string } } | null>
  execute(request: Request): Promise<{ response: { completed: true }; headers: Headers }>
}
const privateHeaders = { 'cache-control': 'no-store', pragma: 'no-cache', 'referrer-policy': 'no-referrer' }
export function createSessionManagementCommands(owner: AuthTransactions, origin: string, limiter: ReturnType<typeof createAuthRateLimiter>,
  invoke: <A>(request: Request, call: () => Promise<A>) => Promise<A>, native: NativeCalls) {
  const key = Symbol('session management invocation')
  function bound(request?: Request): SessionManagementInvocation | undefined {
    const descriptor = request && Object.getOwnPropertyDescriptor(request, key)
    if (!descriptor) return undefined
    if (descriptor.enumerable || descriptor.writable || !descriptor.configurable || !('value' in descriptor)) throw new SessionManagementRejected()
    return (request as Request & { [key]: SessionManagementInvocation })[key]
  }
  async function command(request: Request, name: Command, input: unknown) {
    owner.assertNoActiveAuthTransaction(); requestAuthDeadlineAtMs(request)
    if (request.method !== 'POST' || request.headers.get('origin') !== origin || request.headers.get('sec-fetch-site') === 'cross-site') throw new SessionManagementRejected()
    await limiter.consumeAuthAttempt(name, limiter.trustedClientContext(request))
    const action = name === 'beginSessionList' || name === 'finishSessionList' ? 'LIST' : 'REVOKE'
    const beginning = name === 'beginSessionList' || name === 'beginSessionRevocation'
    const selected = beginning ? action === 'LIST' ? validateSessionList(input) : validateSessionRevocation(input) : validateSessionManagementFinish(input)
    return invoke(request, () => owner.withAuthPromise(owner.invocationOptions(), async lease => {
      if (!Object.isExtensible(request) || Object.hasOwn(request, key)) throw new SessionManagementRejected()
      const invocation = owner.invocationOptions()
      let active = true, phase: Operation = 'session', used = false
      let state: Awaited<ReturnType<typeof lockSessionManagementState>> | undefined
      let prepared: Awaited<ReturnType<typeof prepareSessionManagement>> | undefined
      let allowance: 'create' | 'consume' | 'delete' | 'cleanup' | undefined
      let cleanupIdentifier: string | undefined
      let readToken: string | undefined
      const assert = (operation: Operation, candidate = request) => {
        const descriptor = Object.getOwnPropertyDescriptor(request, key)
        if (!active || candidate !== request || operation !== phase || owner.invocationOptions() !== invocation || owner.currentDb() !== lease.db
          || !descriptor || descriptor.value !== cell || descriptor.enumerable || descriptor.writable || !descriptor.configurable) throw new SessionManagementRejected()
      }
      const deny = async (): Promise<never> => { throw new SessionManagementRejected() }
      const cell: SessionManagementInvocation = Object.freeze({ assert,
        constrain(original, operation, candidate) {
          assert(operation, candidate)
          return { ...original,
            createSession: deny, updateSession: deny, deleteSessions: deny, deleteUserSessions: deny, refreshUserSessions: deny,
            createUser: deny, updateUser: deny, deleteUser: deny, updateUserByEmail: deny, updatePassword: deny, createOAuthUser: deny,
            createAccount: deny, updateAccount: deny, deleteAccount: deny, deleteAccounts: deny, linkAccount: deny,
            findVerificationValue: deny, updateVerificationByIdentifier: deny, reserveVerificationValue: deny,
            async deleteVerificationByIdentifier(identifier) {
              assert('execute', candidate)
              if (allowance !== 'cleanup' || identifier !== cleanupIdentifier) throw new SessionManagementRejected()
              allowance = undefined
              await original.deleteVerificationByIdentifier(identifier); assert('execute', candidate)
            },
            async findSession(token) {
              assert('session', candidate)
              if (readToken !== undefined) throw new SessionManagementRejected()
              readToken = token
              const value = await original.findSession(token); assert('session', candidate); return value
            },
            async createVerificationValue(data) {
              assert('execute', candidate)
              if (allowance !== 'create' || !prepared || JSON.stringify(data) !== JSON.stringify(prepared.data)) throw new SessionManagementRejected()
              allowance = undefined
              const value = await original.createVerificationValue(data); assert('execute', candidate); return value
            },
            async consumeVerificationValue(identifier) {
              assert('execute', candidate)
              if (allowance !== 'consume' || identifier !== state?.verification?.identifier) throw new SessionManagementRejected()
              allowance = undefined
              const value = await original.consumeVerificationValue(identifier); assert('execute', candidate); return value
            },
            async deleteSession(token) {
              assert(operation, candidate)
              if (operation === 'session') {
                // Native expired-session cleanup is allowed only for its own read;
                // refusal then aborts this physical owner and discards its headers.
                if (!readToken || token !== readToken) throw new SessionManagementRejected()
              } else {
                if (allowance !== 'delete' || token !== state?.target?.token) throw new SessionManagementRejected()
                allowance = undefined
              }
              await original.deleteSession(token); assert(operation, candidate)
            },
          }
        },
        async execute(adapter, candidate) {
          assert('execute', candidate)
          if (used || !state) throw new SessionManagementRejected()
          used = true
          if (prepared) {
            await cleanupSessionManagementChallenges(lease, state, async identifier => {
              allowance = 'cleanup'; cleanupIdentifier = identifier
              await adapter.deleteVerificationByIdentifier(identifier); assert('execute', candidate)
              if (allowance !== undefined) throw new SessionManagementRejected()
              cleanupIdentifier = undefined
            })
            allowance = 'create'
            const created = await adapter.createVerificationValue(prepared.data); assert('execute', candidate)
            if (!created || created.identifier !== prepared.data.identifier || created.value !== prepared.data.value
              || created.expiresAt.getTime() !== prepared.data.expiresAt.getTime()) throw new SessionManagementRejected()
            const rows = await lease.db.select().from(verification).where(eq(verification.identifier, prepared.data.identifier)).limit(2)
            if (rows.length !== 1 || rows[0].id !== created.id || rows[0].value !== created.value || rows[0].expiresAt.getTime() !== created.expiresAt.getTime()) throw new SessionManagementRejected()
          } else {
            const row = state.verification
            if (!row) throw new SessionManagementRejected()
            allowance = 'consume'
            const consumed = await adapter.consumeVerificationValue(row.identifier); assert('execute', candidate)
            if (!consumed || consumed.id !== row.id || consumed.identifier !== row.identifier || consumed.value !== row.value
              || consumed.expiresAt.getTime() !== row.expiresAt.getTime()) throw new SessionManagementRejected()
            if (state.action === 'REVOKE') {
              if (!state.target) throw new SessionManagementRejected()
              allowance = 'delete'
              await adapter.deleteSession(state.target.token); assert('execute', candidate)
            }
          }
          if (allowance !== undefined) throw new SessionManagementRejected()
          return { completed: true }
        },
      })
      try {
        Object.defineProperty(request, key, { value: cell, enumerable: false, writable: false, configurable: true })
        const ambient = await native.session(request); assert('session')
        if (ambient instanceof Response) throw new Error('Authentication unavailable')
        state = await lockSessionManagementState(lease, ambient, action, selected)
        if ('response' in selected) await advanceSessionManagementKey(lease, state, selected.response, origin)
        else prepared = await prepareSessionManagement(lease, state, origin)
        phase = 'execute'
        const result = await native.execute(request); assert('execute')
        validateSessionManagementNativeResult(result)
        if (!used) throw new Error('Authentication unavailable')
        phase = 'session'; readToken = undefined
        const current = await native.session(request); assert('session')
        if (current instanceof Response) throw new Error('Authentication unavailable')
        if (!current || current.user.id !== state.user.id || current.session.id !== state.session.id) throw new SessionManagementRejected(true)
        await recheckSessionManagementState(lease, state); assert('session')
        if (prepared) return { kind: 'begin' as const, value: { challengeId: prepared.challengeId, expiresAt: prepared.expiresAt, options: prepared.options } }
        if (action === 'LIST') {
          const value = await completeSessionList(lease, state); assert('session')
          return { kind: 'list' as const, value }
        }
        const value = await completeSessionRevocation(lease, state, invocation.correlationId); assert('session')
        return { kind: 'finish' as const, value }
      } finally { active = false; if (!Reflect.deleteProperty(request, key)) throw new SessionManagementRejected() }
    }))
  }
  return { bound,
    async beginSessionList(request: Request, input: unknown) {
      const result = await command(request, 'beginSessionList', input)
      if (result.kind !== 'begin') throw new SessionManagementRejected()
      return result.value
    },
    async finishSessionList(request: Request, input: unknown) {
      const result = await command(request, 'finishSessionList', input)
      if (result.kind !== 'list') throw new SessionManagementRejected()
      return result.value
    },
    async beginSessionRevocation(request: Request, input: unknown) {
      const result = await command(request, 'beginSessionRevocation', input)
      if (result.kind !== 'begin') throw new SessionManagementRejected()
      return result.value
    },
    async finishSessionRevocation(request: Request, input: unknown) {
      const result = await command(request, 'finishSessionRevocation', input)
      if (result.kind !== 'finish') throw new SessionManagementRejected()
      return result.value
    },
    sessionManagementErrorResponse(error: unknown) {
      if (error instanceof SessionManagementRejected && error.restart) return new Response('Restart session list', { status: 409, headers: privateHeaders })
      if (error instanceof SessionManagementRejected) return new Response('Authentication rejected', { status: error.principalRefused ? 401 : 400, headers: privateHeaders })
      if (error instanceof APIError && (error.statusCode === 400 || error.statusCode === 401)) return new Response('Authentication rejected', { status: error.statusCode, headers: privateHeaders })
      return undefined
    },
  }
}
