import { Schema } from 'effect'
import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm'
import type { AuthTransactions } from '../../platform/db/transactions.server'
import type { AdmittedPrincipal } from './session.server'
import { account, firstGooglePasskeyIntent, passkey, session, user, verification } from './schema.server'
import { validateAdditionalPasskeyFinishInput } from './additional-passkey.server'

export class FirstGooglePasskeyRejected extends Error {
  constructor(readonly reason: 'unavailable' | 'proof_unavailable' | 'proof_stale' | 'cancelled' | 'superseded' = 'unavailable') { super('Authentication rejected') }
}

export const firstGooglePurpose = 'first-google-passkey'
export const firstGoogleCallbackPath = '/api/auth/first-passkey/google/callback'
const targetSchema = Schema.Struct({ intentId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) })
export function validateFirstGoogleTarget(input: unknown) {
  try { return Schema.decodeUnknownSync(targetSchema)(input, { onExcessProperty: 'error' }) } catch { throw new FirstGooglePasskeyRejected() }
}
export function validateFirstGoogleFinish(input: unknown) {
  try { return validateAdditionalPasskeyFinishInput(input) } catch { throw new FirstGooglePasskeyRejected() }
}
export type FirstGoogleLease = Parameters<Parameters<AuthTransactions['withAuthPromise']>[1]>[0]
export type FirstGoogleState = {
  principal: AdmittedPrincipal; user: typeof user.$inferSelect; session: typeof session.$inferSelect;
  workspaceId: string; account: typeof account.$inferSelect; intent?: typeof firstGooglePasskeyIntent.$inferSelect
}
export async function firstGoogleDatabaseTime(lease: FirstGoogleLease) {
  const [clock] = await lease.db.select({ now: sql<Date>`clock_timestamp()`.mapWith(user.createdAt) }).from(sql`(select 1) as first_google_clock`)
  if (!clock) throw new FirstGooglePasskeyRejected()
  return clock.now
}
function checkSession(state: FirstGoogleState, now: Date) {
  const u = state.user, s = state.session, n = now.getTime(), i = state.intent
  if (u.recovering || s.authState !== 'ACTIVE' || s.userId !== u.id || s.recoveryGeneration !== u.recoveryGeneration
    || u.holdUntil !== null && u.holdUntil.getTime() > n || s.expiresAt.getTime() <= n
    || s.authenticatedAt.getTime() + 604800000 <= n || s.lastActivityAt.getTime() + 43200000 <= n
    || i && (i.userId !== u.id || i.sessionId !== s.id || i.recoveryGeneration !== u.recoveryGeneration
      || i.workspaceId !== state.workspaceId || i.accountId !== state.account.id || i.subject !== state.account.accountId
      || i.createdAt.getTime() + 86400000 <= n)) throw new FirstGooglePasskeyRejected()
}
export async function lockFirstGoogleState(lease: FirstGoogleLease, ambient: { user: { id: string }; session: { id: string } } | null,
  intentId?: string, expected: 'zero' | 'receipt' = 'zero'): Promise<FirstGoogleState> {
  if (!ambient) throw new FirstGooglePasskeyRejected()
  const [u] = await lease.db.select().from(user).where(eq(user.id, ambient.user.id)).for('update')
  const [s] = await lease.db.select().from(session).where(eq(session.id, ambient.session.id)).for('update')
  if (!u || !s || s.userId !== u.id) throw new FirstGooglePasskeyRejected()
  const principal = Object.freeze({ userId: u.id, sessionId: s.id, name: u.name, email: u.email })
  const workspaceId = await lease.resolveAdditionalPasskeyWorkspace(principal)
  if (!workspaceId) throw new FirstGooglePasskeyRejected()
  const [intent] = intentId ? await lease.db.select().from(firstGooglePasskeyIntent).where(eq(firstGooglePasskeyIntent.id, intentId)).for('update') : []
  if (intentId && !intent) throw new FirstGooglePasskeyRejected()
  const bindings = await lease.db.select().from(account).where(and(eq(account.userId, u.id), eq(account.providerId, 'google'),
    ...(intent ? [eq(account.id, intent.accountId)] : []))).orderBy(asc(account.id)).for('update')
  if (bindings.length !== 1 || !bindings[0].accountId) throw new FirstGooglePasskeyRejected()
  const state = { principal, user: u, session: s, workspaceId, account: bindings[0], intent }
  checkSession(state, await firstGoogleDatabaseTime(lease))
  await recheckFirstGoogleState(lease, state, expected)
  return state
}
export async function recheckFirstGoogleState(lease: FirstGoogleLease, state: FirstGoogleState, expected: 'zero' | 'one' | 'receipt' = 'zero') {
  const [u] = await lease.db.select().from(user).where(eq(user.id, state.user.id))
  const [s] = await lease.db.select().from(session).where(eq(session.id, state.session.id))
  const [a] = await lease.db.select().from(account).where(eq(account.id, state.account.id))
  if (!u || !s || !a || u.recoveryGeneration !== state.user.recoveryGeneration || a.userId !== u.id
    || a.providerId !== 'google' || a.accountId !== state.account.accountId
    || await lease.resolveAdditionalPasskeyWorkspace(state.principal) !== state.workspaceId) throw new FirstGooglePasskeyRejected()
  const now = await firstGoogleDatabaseTime(lease)
  checkSession({ ...state, user: u, session: s, account: a }, now)
  const keys = await lease.db.select({ id: passkey.id }).from(passkey).where(eq(passkey.userId, u.id))
  if (expected === 'zero' && keys.length !== 0 || expected === 'one' && (keys.length !== 1 || keys[0].id !== state.intent?.passkeyId)) throw new FirstGooglePasskeyRejected()
  if (expected !== 'receipt' && state.intent && (state.intent.expiresAt.getTime() <= now.getTime()
    || state.intent.phase === 'INVALIDATED')) throw new FirstGooglePasskeyRejected('proof_stale')
}
export async function beginFirstGoogleIntent(lease: FirstGoogleLease, state: FirstGoogleState) {
  const now = await firstGoogleDatabaseTime(lease)
  const expired = await lease.db.select({ id: firstGooglePasskeyIntent.id }).from(firstGooglePasskeyIntent)
    .where(and(eq(firstGooglePasskeyIntent.userId, state.user.id), lte(firstGooglePasskeyIntent.createdAt, new Date(now.getTime() - 86400000))))
    .orderBy(asc(firstGooglePasskeyIntent.createdAt), asc(firstGooglePasskeyIntent.id)).limit(100)
  if (expired.length) await lease.db.delete(firstGooglePasskeyIntent).where(and(eq(firstGooglePasskeyIntent.userId, state.user.id), inArray(firstGooglePasskeyIntent.id, expired.map(row => row.id))))
  const [intent] = await lease.db.insert(firstGooglePasskeyIntent).values({ id: randomUUID(), userId: state.user.id, sessionId: state.session.id,
    workspaceId: state.workspaceId, recoveryGeneration: state.user.recoveryGeneration, accountId: state.account.id,
    subject: state.account.accountId, createdAt: now, expiresAt: new Date(now.getTime() + 300000), phase: 'PENDING_GOOGLE' }).returning()
  if (!intent) throw new FirstGooglePasskeyRejected()
  state.intent = intent
  await recheckFirstGoogleState(lease, state)
  return intent
}
export type FirstGoogleStatus = { intentId: string; state: 'pending' | 'exchanging' | 'authorized' | 'added' | 'expired' | 'invalidated'; expiresAt: string; reason: FirstGooglePasskeyRejected['reason'] | null }
export async function firstGoogleStatus(lease: FirstGoogleLease, state: FirstGoogleState): Promise<FirstGoogleStatus> {
  const i = state.intent
  if (!i) throw new FirstGooglePasskeyRejected()
  await recheckFirstGoogleState(lease, state, 'receipt')
  let status: FirstGoogleStatus['state']
  if (i.phase === 'CONSUMED') {
    const [key] = i.passkeyId ? await lease.db.select().from(passkey).where(and(eq(passkey.id, i.passkeyId), eq(passkey.userId, state.user.id))) : []
    if (!key) throw new FirstGooglePasskeyRejected()
    status = 'added'
  } else if (i.phase === 'INVALIDATED') status = 'invalidated'
  else if (i.expiresAt.getTime() <= (await firstGoogleDatabaseTime(lease)).getTime()) status = 'expired'
  else status = i.phase === 'AUTHORIZED' ? 'authorized' : i.phase === 'EXCHANGING' ? 'exchanging' : 'pending'
  return { intentId: i.id, state: status, expiresAt: i.expiresAt.toISOString(), reason: i.reason }
}
const nativeChallenge = Schema.Struct({ type: Schema.Literal('registration'), expectedChallenge: Schema.NonEmptyString,
  userData: Schema.Struct({ id: Schema.NonEmptyString }), context: Schema.NonEmptyString })
export function checkFirstGoogleChallenge(data: { value: string }, state: FirstGoogleState) {
  try {
    const value = Schema.decodeUnknownSync(nativeChallenge)(JSON.parse(data.value))
    if (!state.intent || value.userData.id !== state.user.id || value.context !== firstGooglePurpose + ':' + state.intent.id) throw new FirstGooglePasskeyRejected()
  } catch { throw new FirstGooglePasskeyRejected() }
}
export async function lockFirstGoogleVerification(lease: FirstGoogleLease, state: FirstGoogleState, identifier: string) {
  if (!state.intent || state.intent.registrationVerificationIdentifier !== identifier) throw new FirstGooglePasskeyRejected()
  const rows = await lease.db.select().from(verification).where(eq(verification.identifier, identifier)).for('update')
  if (rows.length !== 1 || rows[0].expiresAt.getTime() <= (await firstGoogleDatabaseTime(lease)).getTime()) throw new FirstGooglePasskeyRejected()
  checkFirstGoogleChallenge(rows[0], state)
  await recheckFirstGoogleState(lease, state)
  return rows[0]
}
const seconds = Schema.Number.check(Schema.isFinite(), Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))
const proofClaims = Schema.Struct({ auth_time: seconds, iat: seconds, exp: seconds })

// A projection of this invocation's trusted provider result; never a proof authority.
export function firstGoogleProofWindow(profile: unknown, now: Date, createdAt: Date): { authenticatedAt: Date; expiresAt: Date } {
  let claims: typeof proofClaims.Type
  try { claims = Schema.decodeUnknownSync(proofClaims)(profile) } catch { throw new FirstGooglePasskeyRejected('proof_unavailable') }
  const n = now.getTime(), created = createdAt.getTime(), authenticated = claims.auth_time * 1000
  const expires = Math.min(created + 300000, authenticated + 300000, claims.exp * 1000)
  if (!Number.isFinite(n) || !Number.isFinite(created) || created > n || claims.auth_time > claims.iat
    || claims.iat * 1000 > n || claims.iat >= claims.exp || !Number.isFinite(new Date(authenticated).getTime())) {
    throw new FirstGooglePasskeyRejected('proof_unavailable')
  }
  if (expires <= n) throw new FirstGooglePasskeyRejected('proof_stale')
  return { authenticatedAt: new Date(authenticated), expiresAt: new Date(expires) }
}
