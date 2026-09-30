import { Effect, Exit } from 'effect'
import { describe, expect, it } from 'vitest'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { PgTransactionError } from '../../src/platform/db/auth-pg-lease.server'
import { fixture, initialization, type Step } from '../platform/db/pg-client-fixture'
import { workspace } from '../../src/modules/workspaces/schema.server'

const principal = { userId: 'actor', sessionId: 'exact-ba-session', name: 'Actor', email: 'actor@example.test' }
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const correlationId = '3efaf2ac-d41e-43e9-aebe-f446bc233bb0'
const options = () => ({ deadlineAtMs: Date.now()+3000, statementTimeoutMs: 500, cleanupTimeoutMs: 100, correlationId })
const commit: Step = { text: 'COMMIT', command: 'COMMIT', status: 'I' }
const rollback: Step = { text: 'ROLLBACK', command: 'ROLLBACK', status: 'I' }
const bootstrap = (resolved: string | null = id): Step[] => [
  ...initialization(),
  { text: "SELECT set_config('app.correlation_id', $1, true)", values: [correlationId] },
  { text: 'SELECT app_private.resolve_personal_workspace($1, $2, $3) AS workspace_id', values: ['actor', 'exact-ba-session', true], rows: [{ workspace_id: resolved }] },
  ...(resolved ? [
    { text: "SELECT set_config('app.tenant_id', $1, true) AS tenant_id", values: [resolved], rows: [{ tenant_id: resolved }] },
    { text: "SELECT current_setting('app.tenant_id', true) AS tenant_id", rows: [{ tenant_id: resolved }] },
    { text: 'select "id", "owner_user_id", "kind", "lifecycle", "auth_organization_id" from "workspace" where "workspace"."id" = $1 for update', values: [resolved], rows: [[resolved, 'actor', 'personal', 'active', null]] },
  ] : []),
]
function owner(steps: Step[]) {
  const f = fixture(steps)
  let checkouts = 0
  const tx = createTransactions({ async connect() { checkouts++; return f.client } }, { maxStatementTimeoutMs: 500, maxCleanupTimeoutMs: 100 })
  return { f, tx, checkouts: () => checkouts }
}
describe('closed personal Workspace scope on the existing owner', () => {
  it('resolves, verifies and re-locks before exposing a tenant capability; nesting uses one lease', async () => {
    const { f, tx, checkouts } = owner([...bootstrap(), commit]), opts = options()
    const result = await tx.withPersonalWorkspacePromise(opts, principal, true, async lease => {
      expect(lease?.workspaceId).toBe(id)
      expect(() => tx.currentDb()).toThrow(PgTransactionError)
      return tx.withPersonalWorkspacePromise(opts, principal, true, async nested => nested === lease)
    })
    expect(result).toBe(true)
    expect(checkouts()).toBe(1)
    expect(f.remaining()).toBe(0)
    expect(f.releases).toEqual([undefined])
  })
  it('absent authority exposes no store and never selects a tenant', async () => {
    const { f, tx } = owner([...bootstrap(null), commit])
    expect(await tx.withPersonalWorkspacePromise(options(), principal, true, async lease => lease)).toBeNull()
    expect(f.remaining()).toBe(0)
  })
  it.each(['auth-in-tenant', 'tenant-in-auth', 'different-session'] as const)('rejects %s and rolls back', async mode => {
    const { f, tx } = owner([...(mode === 'tenant-in-auth' ? initialization() : bootstrap()), rollback]), opts = options()
    const personal = () => tx.withPersonalWorkspacePromise(opts, principal, true, async () => {
      if (mode === 'auth-in-tenant') return tx.withAuthPromise(opts, async () => 1)
      return tx.withPersonalWorkspacePromise(opts, { ...principal, sessionId: 'forged' }, true, async () => 1)
    })
    await expect(mode === 'tenant-in-auth' ? tx.withAuthPromise(opts, personal) : personal()).rejects.toBeInstanceOf(PgTransactionError)
    expect(f.remaining()).toBe(0)
  })
  it('Effect uses the same tenant scope and rejects auth nesting', async () => {
    const { f, tx, checkouts } = owner([...bootstrap(), rollback]), opts = options()
    const result = await Effect.runPromiseExit(tx.withPersonalWorkspaceTransaction(opts, principal, true,
      tx.withAuthTransaction(opts, Effect.succeed('forbidden'))))
    expect(Exit.isFailure(result)).toBe(true)
    expect(checkouts()).toBe(1)
    expect(f.remaining()).toBe(0)
  })
  it('Effect entered from a personal Promise participant joins its existing physical owner', async () => {
    const { f, tx, checkouts } = owner([...bootstrap(), commit]), opts = options()
    const result = await tx.withPersonalWorkspacePromise(opts, principal, true, () => Effect.runPromise(
      tx.withPersonalWorkspaceTransaction(opts, principal, true, tx.invokePersonalWorkspacePromise(opts, () =>
        tx.withPersonalWorkspacePromise(opts, principal, true, async lease => lease?.workspaceId)))))
    expect(result).toBe(id); expect(checkouts()).toBe(1); expect(f.remaining()).toBe(0)
  })
  it.each(['setter','verification','locked-owner','locked-lifecycle'] as const)('does not expose a store after forged %s', async mode => {
    const steps = bootstrap()
    if (mode === 'setter') steps[6] = { ...steps[6], rows: [{ tenant_id: 'forged' }] }
    if (mode === 'verification') steps[7] = { ...steps[7], rows: [{ tenant_id: 'forged' }] }
    if (mode === 'locked-owner') steps[8] = { ...steps[8], rows: [[id,'other','personal','active',null]] }
    if (mode === 'locked-lifecycle') steps[8] = { ...steps[8], rows: [[id,'actor','personal','deleting',null]] }
    if (mode === 'setter' || mode === 'verification') steps.pop()
    const { f, tx } = owner([...steps, rollback]); let exposed = false
    await expect(tx.withPersonalWorkspacePromise(options(), principal, true, async () => { exposed = true })).rejects.toBeInstanceOf(PgTransactionError)
    expect(exposed).toBe(false); expect(f.remaining()).toBe(0)
  })
  it('client cancellation finalizes tenant scope and makes an inherited builder unusable', async () => {
    const { f, tx } = owner([...bootstrap(), rollback]), controller = new AbortController()
    let stale: PromiseLike<unknown> | undefined
    const result = tx.withPersonalWorkspacePromise({ ...options(), signal: controller.signal }, principal, true, async lease => {
      stale = lease!.db.select({ id: workspace.id }).from(workspace)
      controller.abort()
      return new Promise<never>(() => {})
    })
    await expect(result).rejects.toBeInstanceOf(PgTransactionError)
    await expect(Promise.resolve(stale)).rejects.toBeDefined()
    expect(f.remaining()).toBe(0); expect(f.releases).toEqual([undefined])
  })
})
