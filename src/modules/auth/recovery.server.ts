import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Schema } from 'effect'
import { and, asc, eq, like, lte, sql } from 'drizzle-orm'
import { generateAuthenticationOptions, type AuthenticationResponseJSON } from '@simplewebauthn/server'
import type { AuthTransactions } from '../../platform/db/transactions.server'
import { normalizeAuthEmail } from './auth-email-normalization.server'
import { validatePasskeyFinishInput } from './passkey-login.server'
import { verifyPasskeyAssertion } from './passkey-assertion.server'
import { account, passkey, recoveryAttempt, recoveryCode, recoveryCodeBatch, recoveryCodeRotationFact, session, user, verification } from './schema.server'

export class RecoveryRejected extends Error { constructor() { super('Authentication rejected') } }
export type RecoveryLease = Parameters<Parameters<AuthTransactions['withAuthPromise']>[1]>[0]
const opaque = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024))
const uuid = Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i))
const rotationInput = Schema.Struct({ challengeId: uuid, response: Schema.Unknown })
const googleInput = Schema.Struct({ email: Schema.String, code: Schema.String })
const rotationValue = Schema.Struct({ version: Schema.Literal(1), action: Schema.Literal('ROTATE'), userId: opaque,
  originalSessionId: opaque, recoveryGeneration: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  currentBatchId: Schema.NullOr(uuid), challenge: Schema.NonEmptyString, expiresAt: Schema.String })
export type RecoveryRotationValue = typeof rotationValue.Type
export const recoveryGooglePurpose = 'recovery-google-proof'
export const recoveryGoogleCallbackPath = '/api/auth/recovery/google/callback'
export const recoveryIssuer = 'https://accounts.google.com'
const nonempty = Schema.String.check(Schema.isMinLength(1))

export function decodeRecoveryCode(input: unknown): Uint8Array {
  if (typeof input !== 'string' || !/^rc1_[A-Za-z0-9_-]{27}$/.test(input)) throw new RecoveryRejected()
  const material = input.slice(4)
  const bytes = Buffer.from(material, 'base64url')
  if (bytes.length !== 20 || bytes.toString('base64url') !== material) throw new RecoveryRejected()
  return bytes
}
export function digestRecoveryCode(input: unknown): string {
  decodeRecoveryCode(input)
  return createHash('sha256').update('recovery-code-v1\0' + input, 'utf8').digest('hex')
}
export function issueRecoveryCodes(): readonly string[] {
  return Array.from({ length: 8 }, () => 'rc1_' + randomBytes(20).toString('base64url'))
}
export function validateRecoveryGoogleBegin(input: unknown): { email: string; code: string } {
  try {
    const decoded = Schema.decodeUnknownSync(googleInput)(input, { onExcessProperty: 'error' })
    const email = normalizeAuthEmail(decoded.email)
    decodeRecoveryCode(decoded.code)
    return { email, code: decoded.code }
  } catch { throw new RecoveryRejected() }
}
export function validateRecoveryRotationFinish(input: unknown): { challengeId: string; response: AuthenticationResponseJSON } {
  try {
    const decoded = Schema.decodeUnknownSync(rotationInput)(input, { onExcessProperty: 'error' })
    return { challengeId: decoded.challengeId, ...validatePasskeyFinishInput({ response: decoded.response }) }
  } catch { throw new RecoveryRejected() }
}
export function recoveryRotationIdentifier(userId: string, challengeId: string) {
  return 'application-recovery-rotation-v1:' + Buffer.from(userId, 'utf8').toString('hex') + ':' + challengeId
}
export function recoveryProofIdentifier(attemptId: string) { return 'application-recovery-google-v1:' + attemptId }
export async function recoveryDatabaseTime(lease: RecoveryLease): Promise<Date> {
  const [clock] = await lease.db.select({ now: sql<Date>`clock_timestamp()`.mapWith(user.createdAt) }).from(sql`(select 1) as recovery_clock`)
  if (!clock) throw new RecoveryRejected()
  return clock.now
}

type Ambient = { user: { id: string }; session: { id: string } } | null
export type RotationState = {
  user: typeof user.$inferSelect; session: typeof session.$inferSelect; key?: typeof passkey.$inferSelect
  keys: (typeof passkey.$inferSelect)[]; batch: typeof recoveryCodeBatch.$inferSelect | undefined
  challenge?: RecoveryRotationValue; verification?: typeof verification.$inferSelect
}
function checkRotation(state: RotationState, now: Date) {
  const u = state.user, s = state.session, n = now.getTime()
  if (u.recovering || u.holdUntil && u.holdUntil.getTime() > n || s.userId !== u.id || s.authState !== 'ACTIVE'
    || s.recoveryGeneration !== u.recoveryGeneration || s.expiresAt.getTime() <= n
    || s.authenticatedAt.getTime() + 604800000 <= n || s.lastActivityAt.getTime() + 43200000 <= n
    || state.keys.length === 0 || state.batch && (state.batch.formatVersion !== 1 || state.batch.recoveryGeneration !== u.recoveryGeneration))
    throw new RecoveryRejected()
  if (state.challenge && (state.challenge.userId !== u.id || state.challenge.originalSessionId !== s.id
    || state.challenge.recoveryGeneration !== u.recoveryGeneration || state.challenge.currentBatchId !== (state.batch?.batchId ?? null)
    || state.challenge.expiresAt !== state.verification?.expiresAt.toISOString() || Date.parse(state.challenge.expiresAt) <= n))
    throw new RecoveryRejected()
}
export async function lockRotationState(lease: RecoveryLease, ambient: Ambient, selected?: { challengeId: string; response: AuthenticationResponseJSON }): Promise<RotationState> {
  if (!ambient) throw new RecoveryRejected()
  const [u] = await lease.db.select().from(user).where(eq(user.id, ambient.user.id)).for('update')
  if (!u) throw new RecoveryRejected()
  const [s] = await lease.db.select().from(session).where(eq(session.id, ambient.session.id)).for('update')
  if (!s || s.userId !== u.id) throw new RecoveryRejected()
  const keys = await lease.db.select().from(passkey).where(eq(passkey.userId, u.id)).for('update')
  const [batch] = await lease.db.select().from(recoveryCodeBatch).where(eq(recoveryCodeBatch.userId, u.id)).for('update')
  const state: RotationState = { user: u, session: s, keys, batch }
  if (selected) {
    state.key = keys.find(key => key.credentialID === selected.response.id)
    if (!state.key) throw new RecoveryRejected()
    const identifier = recoveryRotationIdentifier(u.id, selected.challengeId)
    const rows = await lease.db.select().from(verification).where(eq(verification.identifier, identifier)).limit(2).for('update')
    if (rows.length !== 1) throw new RecoveryRejected()
    const row = rows[0]
    let proof: RecoveryRotationValue
    try { proof = Schema.decodeUnknownSync(rotationValue)(JSON.parse(row.value), { onExcessProperty: 'error' }) }
    catch { throw new RecoveryRejected() }
    state.challenge = proof; state.verification = row
  }
  checkRotation(state, await recoveryDatabaseTime(lease))
  return state
}
export async function recheckRotationState(lease: RecoveryLease, state: RotationState) {
  const [u] = await lease.db.select().from(user).where(eq(user.id, state.user.id))
  const [s] = await lease.db.select().from(session).where(eq(session.id, state.session.id))
  const [batch] = await lease.db.select().from(recoveryCodeBatch).where(eq(recoveryCodeBatch.userId, state.user.id))
  if (!u || !s || JSON.stringify(u) !== JSON.stringify(state.user) || JSON.stringify(s) !== JSON.stringify(state.session)
    || (batch?.batchId ?? null) !== (state.batch?.batchId ?? null) || batch && (batch.formatVersion !== 1 || batch.recoveryGeneration !== u.recoveryGeneration))
    throw new RecoveryRejected()
  if (state.key) {
    const [key] = await lease.db.select().from(passkey).where(eq(passkey.id, state.key.id))
    if (!key || JSON.stringify(key) !== JSON.stringify(state.key)) throw new RecoveryRejected()
  }
  checkRotation(state, await recoveryDatabaseTime(lease))
}
export async function prepareRecoveryRotation(lease: RecoveryLease, state: RotationState, origin: string) {
  const now = await recoveryDatabaseTime(lease), challengeId = randomUUID()
  const expiresAt = new Date(Math.min(now.getTime() + 300000, state.session.expiresAt.getTime(), state.session.authenticatedAt.getTime() + 604800000,
    state.session.lastActivityAt.getTime() + 43200000))
  if (expiresAt.getTime() <= now.getTime()) throw new RecoveryRejected()
  const options = await generateAuthenticationOptions({ rpID: new URL(origin).hostname, userVerification: 'required',
    allowCredentials: state.keys.map(key => ({ id: key.credentialID })), timeout: 300000 })
  const challenge: RecoveryRotationValue = { version: 1, action: 'ROTATE', userId: state.user.id, originalSessionId: state.session.id,
    recoveryGeneration: state.user.recoveryGeneration, currentBatchId: state.batch?.batchId ?? null, challenge: options.challenge, expiresAt: expiresAt.toISOString() }
  return { challengeId, expiresAt: expiresAt.toISOString(), options,
    data: { identifier: recoveryRotationIdentifier(state.user.id, challengeId), value: JSON.stringify(challenge), expiresAt } }
}
export async function advanceRecoveryRotationKey(lease: RecoveryLease, state: RotationState, response: AuthenticationResponseJSON, origin: string) {
  if (!state.key || !state.challenge) throw new RecoveryRejected()
  let counter: number
  try { counter = await verifyPasskeyAssertion(state.key, state.challenge.challenge, response, origin) }
  catch { throw new RecoveryRejected() }
  await recheckRotationState(lease, state)
  const [changed] = await lease.db.update(passkey).set({ counter }).where(and(eq(passkey.id, state.key.id), eq(passkey.counter, state.key.counter))).returning()
  if (!changed) throw new RecoveryRejected()
  state.key = { ...state.key, counter }
  if (JSON.stringify(changed) !== JSON.stringify(state.key)) throw new RecoveryRejected()
}
export async function finishRecoveryRotation(lease: RecoveryLease, state: RotationState, challengeId: string, correlationId: string) {
  if (!state.challenge || !state.verification || !state.key) throw new RecoveryRejected()
  const challengeDeadline = Date.parse(state.challenge.expiresAt)
  const remaining = await lease.db.select({ id: verification.id }).from(verification).where(eq(verification.identifier, state.verification.identifier)).limit(1)
  if (remaining.length) throw new RecoveryRejected()
  await recheckRotationState(lease, state)
  const previous = await lease.db.select().from(recoveryCode).where(eq(recoveryCode.userId, state.user.id)).limit(9).for('update')
  if (previous.length > 8 || (!state.batch && previous.length !== 0)
    || previous.some(row => row.batchId !== state.batch?.batchId)) throw new RecoveryRejected()
  if (previous.length) {
    const removed = await lease.db.delete(recoveryCode).where(eq(recoveryCode.userId, state.user.id))
    if (removed.rowCount !== previous.length) throw new RecoveryRejected()
  }
  if (state.batch) {
    const removed = await lease.db.delete(recoveryCodeBatch).where(and(eq(recoveryCodeBatch.userId, state.user.id), eq(recoveryCodeBatch.batchId, state.batch.batchId)))
    if (removed.rowCount !== 1) throw new RecoveryRejected()
  }
  const now = await recoveryDatabaseTime(lease), batchId = randomUUID(), codes = issueRecoveryCodes()
  const inserted = await lease.db.insert(recoveryCodeBatch).values({ userId: state.user.id, batchId, formatVersion: 1,
    recoveryGeneration: state.user.recoveryGeneration, issuedAt: now })
  if (inserted.rowCount !== 1) throw new RecoveryRejected()
  const rows = await lease.db.insert(recoveryCode).values(codes.map(code => ({ id: randomUUID(), userId: state.user.id, batchId,
    digest: digestRecoveryCode(code), spentAt: null })))
  if (rows.rowCount !== 8) throw new RecoveryRejected()
  const fact = await lease.db.insert(recoveryCodeRotationFact).values({ id: randomUUID(), actorUserId: state.user.id,
    generation: state.user.recoveryGeneration, authorizingSessionId: state.session.id, authorizingPasskeyId: state.key.id,
    challengeId, priorBatchId: state.batch?.batchId ?? null, newBatchId: batchId, codeCount: 8, occurredAt: await recoveryDatabaseTime(lease), correlationId })
  if (fact.rowCount !== 1) throw new RecoveryRejected()
  state.batch = { userId: state.user.id, batchId, formatVersion: 1, recoveryGeneration: state.user.recoveryGeneration, issuedAt: now }
  state.challenge = undefined; state.verification = undefined
  await recheckRotationState(lease, state)
  if (challengeDeadline <= (await recoveryDatabaseTime(lease)).getTime()) throw new RecoveryRejected()
  return codes
}
export async function cleanupRecoveryRotationChallenges(lease: RecoveryLease, userId: string, remove: (identifier: string) => Promise<void>) {
  const now = await recoveryDatabaseTime(lease), prefix = recoveryRotationIdentifier(userId, '')
  const candidates = await lease.db.select({ identifier: verification.identifier }).from(verification)
    .where(and(like(verification.identifier, prefix + '%'), lte(verification.expiresAt, now)))
    .orderBy(asc(verification.expiresAt), asc(verification.id)).limit(25).for('update')
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (seen.has(candidate.identifier)) continue
    seen.add(candidate.identifier)
    const rows = await lease.db.select().from(verification).where(eq(verification.identifier, candidate.identifier)).limit(2).for('update')
    if (rows.length !== 1 || !rows[0].identifier.startsWith(prefix) || rows[0].expiresAt.getTime() > now.getTime()) continue
    try {
      Schema.decodeUnknownSync(uuid)(rows[0].identifier.slice(prefix.length))
      const proof = Schema.decodeUnknownSync(rotationValue)(JSON.parse(rows[0].value), { onExcessProperty: 'error' })
      if (proof.userId !== userId || proof.expiresAt !== rows[0].expiresAt.toISOString()) continue
    } catch { continue }
    await remove(candidate.identifier)
    const remaining = await lease.db.select({ id: verification.id }).from(verification).where(eq(verification.identifier, candidate.identifier)).limit(1)
    if (remaining.length) throw new RecoveryRejected()
  }
}

export type GoogleState = {
  user: typeof user.$inferSelect; batch: typeof recoveryCodeBatch.$inferSelect; code: typeof recoveryCode.$inferSelect
  account: typeof account.$inferSelect; attempt?: typeof recoveryAttempt.$inferSelect
}
export function checkRecoveryGoogleUser(value: Pick<typeof user.$inferSelect, 'recovering' | 'emailVerified'>) {
  if (value.recovering) throw new RecoveryRejected()
}
export async function lockRecoveryGoogleByCode(lease: RecoveryLease, email: string, code: string): Promise<GoogleState> {
  const [u] = await lease.db.select().from(user).where(eq(user.email, email)).for('update')
  if (!u) throw new RecoveryRejected()
  checkRecoveryGoogleUser(u)
  const [batch] = await lease.db.select().from(recoveryCodeBatch).where(eq(recoveryCodeBatch.userId, u.id)).for('update')
  if (!batch || batch.formatVersion !== 1 || batch.recoveryGeneration !== u.recoveryGeneration) throw new RecoveryRejected()
  const codes = await lease.db.select().from(recoveryCode).where(and(eq(recoveryCode.userId, u.id), eq(recoveryCode.batchId, batch.batchId),
    eq(recoveryCode.digest, digestRecoveryCode(code)), sql`${recoveryCode.spentAt} is null`)).limit(2).for('update')
  if (codes.length !== 1) throw new RecoveryRejected()
  const accounts = await lease.db.select().from(account).where(and(eq(account.userId, u.id), eq(account.providerId, 'google'))).limit(2).for('update')
  if (accounts.length !== 1 || !accounts[0].accountId) throw new RecoveryRejected()
  return { user: u, batch, code: codes[0], account: accounts[0] }
}
export async function lockRecoveryGoogleAttempt(lease: RecoveryLease, oauthState: string): Promise<GoogleState> {
  const locator = await lease.db.select({ userId: recoveryAttempt.userId }).from(recoveryAttempt).where(eq(recoveryAttempt.oauthState, oauthState)).limit(1)
  if (locator.length !== 1) throw new RecoveryRejected()
  const [u] = await lease.db.select().from(user).where(eq(user.id, locator[0].userId)).for('update')
  if (!u) throw new RecoveryRejected()
  checkRecoveryGoogleUser(u)
  const [attempt] = await lease.db.select().from(recoveryAttempt).where(eq(recoveryAttempt.oauthState, oauthState)).for('update')
  if (!attempt || attempt.userId !== u.id) throw new RecoveryRejected()
  const [batch] = await lease.db.select().from(recoveryCodeBatch).where(eq(recoveryCodeBatch.userId, u.id)).for('update')
  const [code] = await lease.db.select().from(recoveryCode).where(eq(recoveryCode.id, attempt.codeId)).for('update')
  const [linked] = await lease.db.select().from(account).where(eq(account.id, attempt.googleAccountId)).for('update')
  const linkedRows = await lease.db.select({ id: account.id }).from(account)
    .where(and(eq(account.userId, u.id), eq(account.providerId, 'google'))).limit(2).for('update')
  if (!batch || !code || !linked || batch.formatVersion !== 1 || batch.recoveryGeneration !== u.recoveryGeneration
    || attempt.recoveryGeneration !== u.recoveryGeneration || attempt.batchId !== batch.batchId || code.userId !== u.id
    || code.batchId !== batch.batchId || code.spentAt !== null || linked.userId !== u.id || linked.providerId !== 'google'
    || linked.accountId !== attempt.subject || linkedRows.length !== 1 || linkedRows[0].id !== linked.id || attempt.issuer !== recoveryIssuer
    || attempt.expiresAt.getTime() <= (await recoveryDatabaseTime(lease)).getTime()) throw new RecoveryRejected()
  return { user: u, batch, code, account: linked, attempt }
}
type AttemptBinding = Pick<typeof recoveryAttempt.$inferSelect, 'id' | 'userId' | 'recoveryGeneration' | 'batchId' | 'codeId' | 'googleAccountId'
  | 'issuer' | 'subject' | 'oauthState' | 'createdAt' | 'expiresAt'> & { phase: string }
export function assertRecoveryAttemptBinding(original: AttemptBinding, current: AttemptBinding, phase: string) {
  if (current.phase !== phase || original.id !== current.id || original.userId !== current.userId
    || original.recoveryGeneration !== current.recoveryGeneration || original.batchId !== current.batchId
    || original.codeId !== current.codeId || original.googleAccountId !== current.googleAccountId
    || original.issuer !== current.issuer || original.subject !== current.subject || original.oauthState !== current.oauthState
    || original.createdAt.getTime() !== current.createdAt.getTime() || original.expiresAt.getTime() !== current.expiresAt.getTime())
    throw new RecoveryRejected()
}
export async function recheckRecoveryGoogle(lease: RecoveryLease, state: GoogleState, original: AttemptBinding, phase: string) {
  if (!state.attempt) throw new RecoveryRejected()
  assertRecoveryAttemptBinding(original, state.attempt, phase)
  const fresh = await lockRecoveryGoogleAttempt(lease, state.attempt.oauthState)
  if (!fresh.attempt) throw new RecoveryRejected()
  assertRecoveryAttemptBinding(original, fresh.attempt, phase)
  if (fresh.user.id !== state.user.id || fresh.batch.batchId !== state.batch.batchId || fresh.code.id !== state.code.id
    || fresh.account.id !== state.account.id || fresh.account.accountId !== state.account.accountId) throw new RecoveryRejected()
}

type CleanupRow = Pick<typeof verification.$inferSelect, 'identifier' | 'value' | 'expiresAt'>
const cleanupProof = Schema.Struct({ version: Schema.Literal(1), purpose: Schema.Literal('recovery-google-proof'), userId: nonempty,
  attemptId: uuid, recoveryGeneration: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), batchId: uuid, codeId: uuid,
  googleAccountId: nonempty, issuer: Schema.Literal('https://accounts.google.com'), subject: nonempty, expiresAt: Schema.String })
const cleanupState = Schema.Struct({ oauthState: nonempty, callbackURL: nonempty, errorURL: nonempty,
  codeVerifier: nonempty, idTokenNonce: nonempty, expiresAt: Schema.Number.check(Schema.isFinite()),
  serverContext: Schema.Struct({ purpose: Schema.Literal('recovery-google-proof'), attemptId: uuid }) })
export function recoveryGoogleCleanupCandidate(attempt: AttemptBinding, proofs: readonly CleanupRow[], states: readonly CleanupRow[], origin: string) {
  if (proofs.length > 1 || states.length > 1) return false
  try {
    if (proofs.length) {
      const row = proofs[0]
      if (row.identifier !== recoveryProofIdentifier(attempt.id) || row.expiresAt.getTime() !== attempt.expiresAt.getTime()) return false
      const value = Schema.decodeUnknownSync(cleanupProof)(JSON.parse(row.value), { onExcessProperty: 'error' })
      if (value.userId !== attempt.userId || value.attemptId !== attempt.id || value.recoveryGeneration !== attempt.recoveryGeneration
        || value.batchId !== attempt.batchId || value.codeId !== attempt.codeId || value.googleAccountId !== attempt.googleAccountId
        || value.issuer !== attempt.issuer || value.subject !== attempt.subject || value.expiresAt !== attempt.expiresAt.toISOString()) return false
    }
    if (states.length) {
      const row = states[0]
      if (row.identifier !== attempt.oauthState) return false
      const value = Schema.decodeUnknownSync(cleanupState)(JSON.parse(row.value), { onExcessProperty: 'error' })
      if (value.oauthState !== attempt.oauthState || value.serverContext.attemptId !== attempt.id
        || value.callbackURL !== origin + '/login' || value.errorURL !== origin + '/login') return false
    }
    return true
  } catch { return false }
}
export async function cleanupRecoveryGoogleAttempts(lease: RecoveryLease, userId: string, origin: string, remove: (identifier: string) => Promise<void>) {
  const now = await recoveryDatabaseTime(lease)
  const candidates = await lease.db.select().from(recoveryAttempt)
    .where(and(eq(recoveryAttempt.userId, userId), lte(recoveryAttempt.expiresAt, now)))
    .orderBy(asc(recoveryAttempt.expiresAt), asc(recoveryAttempt.id)).limit(25).for('update')
  for (const attempt of candidates) {
    const proofId = recoveryProofIdentifier(attempt.id)
    const proofs = await lease.db.select().from(verification).where(eq(verification.identifier, proofId)).limit(2).for('update')
    const states = await lease.db.select().from(verification).where(eq(verification.identifier, attempt.oauthState)).limit(2).for('update')
    if (!recoveryGoogleCleanupCandidate(attempt, proofs, states, origin)) continue
    if (proofs.length) await remove(proofId)
    if (states.length) await remove(attempt.oauthState)
    for (const identifier of [proofId, attempt.oauthState]) {
      const remaining = await lease.db.select({ id: verification.id }).from(verification).where(eq(verification.identifier, identifier)).limit(1)
      if (remaining.length) throw new RecoveryRejected()
    }
    const removed = await lease.db.delete(recoveryAttempt).where(and(eq(recoveryAttempt.id, attempt.id), eq(recoveryAttempt.userId, userId)))
    if (removed.rowCount !== 1) throw new RecoveryRejected()
  }
}
