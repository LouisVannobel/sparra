import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { Schema, SchemaGetter } from 'effect'
import type { AuthTransactions } from '../../platform/db/transactions.server'
import type { AdmittedPrincipal } from '../auth/session.server'
import { workspace, workspaceAudit } from './schema.server'

const nameSchema = Schema.String.check(Schema.isPattern(/^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]*$/)).pipe(
  Schema.decode({ decode: SchemaGetter.transform(value => value.trim()), encode: SchemaGetter.transform(value => value) }),
).check(Schema.isMinLength(1), Schema.isMaxLength(80))
export class InvalidDisplayName extends Error {
  constructor() { super('Invalid display name'); this.name = 'InvalidDisplayName' }
}
export function parseDisplayName(input: unknown) {
  try { return Schema.decodeUnknownSync(nameSchema)(input) }
  catch { throw new InvalidDisplayName() }
}
export function parseWorkspaceId(input: unknown) {
  try { return Schema.decodeUnknownSync(Schema.String.check(Schema.isUUID()))(input) }
  catch { throw new Error('Workspace unavailable') }
}
export type WorkspaceDto = Readonly<{ id: string; displayName: string }>
const projection = { id: workspace.id, displayName: workspace.displayName }

export function createPersonalWorkspaces(owner: AuthTransactions) {
  function options(signal?: AbortSignal) {
    return { deadlineAtMs: Date.now()+10000, statementTimeoutMs: 1000, cleanupTimeoutMs: 1000, correlationId: randomUUID(), signal }
  }
  async function ensurePersonalWorkspace(principal: AdmittedPrincipal, signal?: AbortSignal): Promise<WorkspaceDto | null> {
    return owner.withPersonalWorkspacePromise(options(signal), principal, true, async lease => {
      if (!lease) return null
      const [row] = await lease.db.select(projection).from(workspace).where(eq(workspace.id, lease.workspaceId))
      return row ?? null
    })
  }
  // Omitting the selector is the protected screen's read-only initial lookup.
  async function readWorkspace(principal: AdmittedPrincipal, workspaceId?: string, signal?: AbortSignal): Promise<WorkspaceDto | null> {
    const selected = workspaceId === undefined ? undefined : parseWorkspaceId(workspaceId)
    return owner.withPersonalWorkspacePromise(options(signal), principal, false, async lease => {
      if (!lease || selected !== undefined && selected !== lease.workspaceId) return null
      const [row] = await lease.db.select(projection).from(workspace).where(eq(workspace.id, lease.workspaceId))
      return row ?? null
    })
  }
  async function renameWorkspace(principal: AdmittedPrincipal, workspaceId: string, displayName: unknown, signal?: AbortSignal): Promise<WorkspaceDto | null> {
    const selected = parseWorkspaceId(workspaceId), name = parseDisplayName(displayName), opts = options(signal)
    return owner.withPersonalWorkspacePromise(opts, principal, false, async lease => {
      if (!lease || lease.workspaceId !== selected) return null
      const [row] = await lease.db.select(projection).from(workspace).where(eq(workspace.id, selected))
      if (!row || row.displayName === name) return row ?? null
      const [changed] = await lease.db.update(workspace).set({ displayName: name, updatedAt: sql`clock_timestamp()` }).where(eq(workspace.id, selected)).returning(projection)
      if (!changed) throw new Error('Workspace unavailable')
      await lease.db.insert(workspaceAudit).values({ action: 'display-name-changed', actorUserId: principal.userId, workspaceId: selected, correlationId: opts.correlationId })
      return changed
    })
  }
  return { ensurePersonalWorkspace, readWorkspace, renameWorkspace }
}
