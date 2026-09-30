import { randomUUID } from 'node:crypto'
import { Schema } from 'effect'
import { and, asc, desc, eq, like, lt, lte, or, sql } from 'drizzle-orm'
import { generateAuthenticationOptions, type AuthenticationResponseJSON } from '@simplewebauthn/server'
import type { AuthTransactions } from '../../platform/db/transactions.server'
import { validatePasskeyFinishInput } from './passkey-login.server'
import { verifyPasskeyAssertion } from './passkey-assertion.server'
import { authSessionRevocation, passkey, session, user, verification } from './schema.server'

export class SessionManagementRejected extends Error {
  constructor(readonly principalRefused = false, readonly restart = false) { super('Authentication rejected') }
}
export type SessionManagementLease = Parameters<Parameters<AuthTransactions['withAuthPromise']>[1]>[0]
const opaqueId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024))
const uuid = Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i))
const revokeInput = Schema.Struct({ sessionId: opaqueId })
const listInput = Schema.Struct({ cursor: Schema.optional(opaqueId), reconcileSessionId: Schema.optional(opaqueId) })
const finishInput = Schema.Struct({ challengeId: uuid, response: Schema.Unknown })
const proofFields = { version: Schema.Literal(1), userId: opaqueId, sessionId: opaqueId, workspaceId: uuid,
  recoveryGeneration: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), challenge: Schema.NonEmptyString, expiresAt: Schema.String }
const challengeValue = Schema.Union([
  Schema.Struct({ ...proofFields, action: Schema.Literal('REVOKE'), targetSessionId: opaqueId }),
  Schema.Struct({ ...proofFields, action: Schema.Literal('LIST'), cursor: Schema.NullOr(opaqueId), reconcileSessionId: Schema.NullOr(opaqueId) }),
])
export type SessionManagementProof = typeof challengeValue.Type
export function validateSessionList(input: unknown) {
  try { return Schema.decodeUnknownSync(listInput)(input, { onExcessProperty: 'error' }) } catch { throw new SessionManagementRejected() }
}
export function validateSessionRevocation(input: unknown) {
  try { return Schema.decodeUnknownSync(revokeInput)(input, { onExcessProperty: 'error' }) } catch { throw new SessionManagementRejected() }
}
export function validateSessionManagementFinish(input: unknown): { challengeId: string; response: AuthenticationResponseJSON } {
  try {
    const value = Schema.decodeUnknownSync(finishInput)(input, { onExcessProperty: 'error' })
    return { challengeId: value.challengeId, ...validatePasskeyFinishInput({ response: value.response }) }
  } catch { throw new SessionManagementRejected() }
}
const completedResult = Schema.Struct({ response: Schema.Struct({ completed: Schema.Literal(true) }), headers: Schema.instanceOf(Headers) })
export function validateSessionManagementNativeResult(value: unknown) {
  try { return Schema.decodeUnknownSync(completedResult)(value, { onExcessProperty: 'error' }).response }
  catch { throw new Error('Authentication unavailable') }
}
type Authority = {
  user: Pick<typeof user.$inferSelect, 'id' | 'recovering' | 'recoveryGeneration'>
  session: Pick<typeof session.$inferSelect, 'id' | 'userId' | 'authState' | 'recoveryGeneration' | 'expiresAt' | 'authenticatedAt' | 'lastActivityAt'>
  workspaceId: string
}
export type SessionManagementState = Authority & {
  action: 'LIST' | 'REVOKE'
  user: typeof user.$inferSelect
  session: typeof session.$inferSelect
  keys: (typeof passkey.$inferSelect)[]
  key?: typeof passkey.$inferSelect
  proof?: SessionManagementProof
  verification?: typeof verification.$inferSelect
  target?: typeof session.$inferSelect
  cursor?: { id: string; createdAt: Date }
  reconcileSessionId?: string
}
export function checkSessionManagementState(state: Authority, now: Date, proof?: SessionManagementProof) {
  const u = state.user, s = state.session, n = now.getTime()
  if (u.recovering || s.authState !== 'ACTIVE' || s.userId !== u.id || s.recoveryGeneration !== u.recoveryGeneration
    || s.expiresAt.getTime() <= n || s.authenticatedAt.getTime() + 604800000 <= n || s.lastActivityAt.getTime() + 43200000 <= n) throw new SessionManagementRejected(true)
  // LIST and exact other-session revocation are outside the closed hold registry.
  if (proof && (proof.userId !== u.id || proof.sessionId !== s.id || proof.workspaceId !== state.workspaceId
    || proof.recoveryGeneration !== u.recoveryGeneration || !Number.isFinite(Date.parse(proof.expiresAt)) || Date.parse(proof.expiresAt) <= n)) throw new SessionManagementRejected()
}
export async function sessionManagementDatabaseTime(lease: SessionManagementLease) {
  const [clock] = await lease.db.select({ now: sql<Date>`clock_timestamp()`.mapWith(user.createdAt) }).from(sql`(select 1) as session_management_clock`)
  if (!clock) throw new SessionManagementRejected()
  return clock.now
}
export function sessionManagementNamespace(userId: string) {
  // Canonical UTF-8 hex encoding is unambiguous and contains no LIKE wildcards.
  return 'application-session-v1:' + Buffer.from(userId, 'utf8').toString('hex') + ':'
}
export async function lockSessionManagementState(lease: SessionManagementLease, ambient: { user: { id: string }; session: { id: string } } | null,
  action: 'LIST' | 'REVOKE', input: { sessionId?: string; cursor?: string; reconcileSessionId?: string; challengeId?: string; response?: AuthenticationResponseJSON }): Promise<SessionManagementState> {
  if (!ambient) throw new SessionManagementRejected(true)
  const [u] = await lease.db.select().from(user).where(eq(user.id, ambient.user.id)).for('update')
  const [s] = await lease.db.select().from(session).where(eq(session.id, ambient.session.id)).for('update')
  if (!u || !s || s.userId !== u.id) throw new SessionManagementRejected(true)
  const workspaceId = await lease.resolveAdditionalPasskeyWorkspace({ userId: u.id, sessionId: s.id, name: u.name, email: u.email })
  if (!workspaceId) throw new SessionManagementRejected()
  const keys = await lease.db.select().from(passkey).where(eq(passkey.userId, u.id)).orderBy(asc(passkey.id)).for('update')
  if (!keys.length) throw new SessionManagementRejected()
  const state: SessionManagementState = { action, user: u, session: s, workspaceId, keys }
  checkSessionManagementState(state, await sessionManagementDatabaseTime(lease))
  let targetId = input.sessionId, cursorId = input.cursor, reconcileSessionId = input.reconcileSessionId
  if (input.challengeId) {
    const identifier = sessionManagementNamespace(u.id) + input.challengeId
    const rows = await lease.db.select().from(verification).where(eq(verification.identifier, identifier)).limit(2).for('update')
    if (rows.length !== 1) throw new SessionManagementRejected()
    const row = rows[0]
    let proof: SessionManagementProof
    try { proof = Schema.decodeUnknownSync(challengeValue)(JSON.parse(row.value), { onExcessProperty: 'error' }) }
    catch { throw new SessionManagementRejected() }
    if (proof.action !== action || proof.expiresAt !== row.expiresAt.toISOString()) throw new SessionManagementRejected()
    checkSessionManagementState(state, await sessionManagementDatabaseTime(lease), proof)
    state.key = keys.find(key => key.credentialID === input.response?.id)
    if (!state.key) throw new SessionManagementRejected()
    state.proof = proof; state.verification = row
    if (proof.action === 'REVOKE') targetId = proof.targetSessionId
    else { cursorId = proof.cursor ?? undefined; reconcileSessionId = proof.reconcileSessionId ?? undefined }
  }
  if (action === 'REVOKE') {
    if (!targetId || targetId === s.id) throw new SessionManagementRejected()
    const [target] = await lease.db.select().from(session).where(and(eq(session.id, targetId), eq(session.userId, u.id))).for('update')
    if (!target) throw new SessionManagementRejected()
    state.target = target
  } else {
    state.reconcileSessionId = reconcileSessionId
    if (cursorId) {
      const [cursor] = await lease.db.select({ id: session.id, createdAt: session.createdAt }).from(session)
        .where(and(eq(session.id, cursorId), sessionListEligibility(state, await sessionManagementDatabaseTime(lease)))).limit(1).for('update')
      if (!cursor) throw new SessionManagementRejected(false, true)
      state.cursor = cursor
    }
  }
  return state
}
export async function recheckSessionManagementState(lease: SessionManagementLease, state: SessionManagementState) {
  const [u] = await lease.db.select().from(user).where(eq(user.id, state.user.id))
  const [s] = await lease.db.select().from(session).where(eq(session.id, state.session.id))
  if (!u || !s || JSON.stringify(u) !== JSON.stringify(state.user) || JSON.stringify(s) !== JSON.stringify(state.session)
    || await lease.resolveAdditionalPasskeyWorkspace({ userId: u.id, sessionId: s.id, name: u.name, email: u.email }) !== state.workspaceId) throw new SessionManagementRejected(true)
  checkSessionManagementState(state, await sessionManagementDatabaseTime(lease), state.proof)
  if (state.key) {
    const [key] = await lease.db.select().from(passkey).where(eq(passkey.id, state.key.id))
    if (!key || JSON.stringify(key) !== JSON.stringify(state.key)) throw new SessionManagementRejected()
  }
}
export async function prepareSessionManagement(lease: SessionManagementLease, state: SessionManagementState, origin: string) {
  if (state.action === 'REVOKE' && !state.target) throw new SessionManagementRejected()
  const now = await sessionManagementDatabaseTime(lease), challengeId = randomUUID()
  const expiresAt = new Date(Math.min(now.getTime() + 300000, state.session.expiresAt.getTime(), state.session.authenticatedAt.getTime() + 604800000,
    state.session.lastActivityAt.getTime() + 43200000))
  const options = await generateAuthenticationOptions({ rpID: new URL(origin).hostname, userVerification: 'required',
    allowCredentials: state.keys.map(key => ({ id: key.credentialID })), timeout: 300000 })
  const fields = { version: 1 as const, userId: state.user.id, sessionId: state.session.id, workspaceId: state.workspaceId,
    recoveryGeneration: state.user.recoveryGeneration, challenge: options.challenge, expiresAt: expiresAt.toISOString() }
  const proof: SessionManagementProof = state.action === 'REVOKE' ? { ...fields, action: 'REVOKE', targetSessionId: state.target!.id }
    : { ...fields, action: 'LIST', cursor: state.cursor?.id ?? null, reconcileSessionId: state.reconcileSessionId ?? null }
  state.proof = proof
  return { challengeId, expiresAt: expiresAt.toISOString(), options,
    data: { identifier: sessionManagementNamespace(state.user.id) + challengeId, value: JSON.stringify(proof), expiresAt } }
}
export async function advanceSessionManagementKey(lease: SessionManagementLease, state: SessionManagementState, response: AuthenticationResponseJSON, origin: string) {
  if (!state.key || !state.proof) throw new SessionManagementRejected()
  let counter: number
  try { counter = await verifyPasskeyAssertion(state.key, state.proof.challenge, response, origin) } catch { throw new SessionManagementRejected() }
  await recheckSessionManagementState(lease, state)
  const [key] = await lease.db.update(passkey).set({ counter }).where(and(eq(passkey.id, state.key.id), eq(passkey.counter, state.key.counter))).returning()
  if (!key) throw new SessionManagementRejected()
  state.key = { ...state.key, counter }
  if (JSON.stringify(key) !== JSON.stringify(state.key)) throw new SessionManagementRejected()
}
export async function completeSessionRevocation(lease: SessionManagementLease, state: SessionManagementState, correlationId: string) {
  if (!state.target || !state.verification) throw new SessionManagementRejected()
  const targets = await lease.db.select({ id: session.id }).from(session).where(eq(session.id, state.target.id)).limit(1)
  const proofs = await lease.db.select({ id: verification.id }).from(verification).where(eq(verification.identifier, state.verification.identifier)).limit(1)
  if (targets.length || proofs.length) throw new SessionManagementRejected()
  await recheckSessionManagementState(lease, state)
  const inserted = await lease.db.insert(authSessionRevocation).values({ id: randomUUID(), actorUserId: state.user.id, authorizingSessionId: state.session.id,
    targetSessionId: state.target.id, workspaceId: state.workspaceId, correlationId, occurredAt: await sessionManagementDatabaseTime(lease) })
  if (inserted.rowCount !== 1) throw new Error('Authentication unavailable')
  await recheckSessionManagementState(lease, state)
  return { revoked: true as const, sessionId: state.target.id }
}

type VerificationCandidate = Pick<typeof verification.$inferSelect, 'id' | 'identifier' | 'value' | 'expiresAt'>
export function sessionManagementCleanupCandidate(rows: VerificationCandidate[], userId: string, now: Date) {
  if (rows.length !== 1) return undefined
  const row = rows[0], prefix = sessionManagementNamespace(userId)
  try {
    if (!row.identifier.startsWith(prefix) || row.expiresAt.getTime() > now.getTime()) return undefined
    Schema.decodeUnknownSync(uuid)(row.identifier.slice(prefix.length))
    const proof = Schema.decodeUnknownSync(challengeValue)(JSON.parse(row.value), { onExcessProperty: 'error' })
    if (proof.userId !== userId || proof.expiresAt !== row.expiresAt.toISOString()
      || proof.action === 'REVOKE' && proof.sessionId === proof.targetSessionId) return undefined
    return row
  } catch { return undefined }
}
export async function cleanupSessionManagementChallenges(lease: SessionManagementLease, state: SessionManagementState, remove: (identifier: string) => Promise<void>) {
  const now = await sessionManagementDatabaseTime(lease)
  const candidates = await lease.db.select({ identifier: verification.identifier }).from(verification)
    .where(and(like(verification.identifier, sessionManagementNamespace(state.user.id) + '%'), lte(verification.expiresAt, now)))
    .orderBy(asc(verification.expiresAt), asc(verification.id)).limit(100).for('update')
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (seen.has(candidate.identifier)) continue
    seen.add(candidate.identifier)
    // The exact lookup intentionally does not filter away live/foreign JSON
    // duplicates. User-first serialization and confined namespace writers hold.
    const matches = await lease.db.select().from(verification).where(eq(verification.identifier, candidate.identifier)).limit(2).for('update')
    if (!sessionManagementCleanupCandidate(matches, state.user.id, now)) continue
    await remove(candidate.identifier)
    const remaining = await lease.db.select({ id: verification.id }).from(verification).where(eq(verification.identifier, candidate.identifier)).limit(1)
    if (remaining.length) throw new SessionManagementRejected()
  }
}
function sessionListEligibility(state: Authority, now: Date) {
  return and(eq(session.userId, state.user.id), eq(session.authState, 'ACTIVE'), eq(session.recoveryGeneration, state.user.recoveryGeneration),
    sql`${session.expiresAt} > ${now}`, sql`${session.authenticatedAt} + interval '7 days' > ${now}`, sql`${session.lastActivityAt} + interval '12 hours' > ${now}`)
}
type SessionListRow = { id: string; current: boolean; createdAt: Date; lastActivityAt: Date; expiresAt: Date }
type TargetState = 'absent' | 'active' | 'ineligible' | null
export function projectSessionPage(rows: SessionListRow[], targetState: TargetState) {
  if (rows.length > 26) throw new Error('Authentication unavailable')
  return { sessions: rows.slice(0, 25).map(row => ({ id: row.id, current: row.current, createdAt: row.createdAt.toISOString(),
    lastActivityAt: row.lastActivityAt.toISOString(), expiresAt: row.expiresAt.toISOString() })), nextCursor: rows.length > 25 ? rows[24].id : null, targetState }
}
export async function completeSessionList(lease: SessionManagementLease, state: SessionManagementState) {
  if (state.proof?.action !== 'LIST' || !state.verification) throw new SessionManagementRejected()
  const proofs = await lease.db.select({ id: verification.id }).from(verification).where(eq(verification.identifier, state.verification.identifier)).limit(1)
  if (proofs.length) throw new SessionManagementRejected()
  const now = await sessionManagementDatabaseTime(lease), cursor = state.cursor
  const rows = await lease.db.select({ id: session.id, current: sql<boolean>`${session.id} = ${state.session.id}`,
    createdAt: session.createdAt, lastActivityAt: session.lastActivityAt,
    expiresAt: sql<Date>`least(${session.expiresAt}, ${session.authenticatedAt} + interval '7 days', ${session.lastActivityAt} + interval '12 hours')`.mapWith(session.expiresAt),
  }).from(session).where(and(sessionListEligibility(state, now), cursor ? or(lt(session.createdAt, cursor.createdAt),
    and(eq(session.createdAt, cursor.createdAt), lt(session.id, cursor.id))) : undefined)).orderBy(desc(session.createdAt), desc(session.id)).limit(26)
  let targetState: TargetState = null
  if (state.reconcileSessionId) {
    const [target] = await lease.db.select({ eligible: sql<boolean>`${sessionListEligibility(state, now)}` }).from(session)
      .where(and(eq(session.id, state.reconcileSessionId), eq(session.userId, state.user.id))).limit(1)
    targetState = !target ? 'absent' : target.eligible ? 'active' : 'ineligible'
  }
  await recheckSessionManagementState(lease, state)
  if (cursor) {
    const [currentCursor] = await lease.db.select({ id: session.id }).from(session).where(and(eq(session.id, cursor.id),
      eq(session.createdAt, cursor.createdAt), sessionListEligibility(state, await sessionManagementDatabaseTime(lease)))).limit(1)
    if (!currentCursor) throw new SessionManagementRejected(false, true)
  }
  return projectSessionPage(rows, targetState)
}
