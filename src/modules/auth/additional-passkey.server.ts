import { randomUUID } from 'node:crypto'
import type { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import { generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server'
import type { AuthContext } from 'better-auth'
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm'
import { Schema } from 'effect'
import type { AuthTransactions } from '../../platform/db/transactions.server'
import type { AdmittedPrincipal } from './session.server'
import type { VerifiedInitialRegistration } from './initial-enrollment.server'
import { validatePasskeyFinishInput } from './passkey-login.server'
import { additionalPasskeyIntent, passkey, session, user, verification } from './schema.server'

type AdditionalPasskeyLease = Parameters<Parameters<AuthTransactions['withAuthPromise']>[1]>[0]
type AuthenticationOptions = Parameters<typeof startAuthentication>[0]['optionsJSON']
type RegistrationOptions = Parameters<typeof startRegistration>[0]['optionsJSON']
type Assertion = Awaited<ReturnType<typeof startAuthentication>>
type Registration = Awaited<ReturnType<typeof startRegistration>>
export type AdditionalPasskeyBegin = { intentId: string; expiresAt: string; options: AuthenticationOptions }
export type AdditionalPasskeyAuthorized = { intentId: string; expiresAt: string; options: RegistrationOptions }
export type AdditionalPasskeyAuthorizeInput = { intentId: string; response: Assertion }
export type AdditionalPasskeyFinishInput = { intentId: string; response: Registration }
type VerificationCreate = Parameters<AuthContext['internalAdapter']['createVerificationValue']>[0]
export type AdditionalPasskeyInvocation = Readonly<{
  command: 'beginAdditionalPasskey' | 'authorizeAdditionalPasskey' | 'finishAdditionalPasskey'
  assert(operation: 'session' | 'options' | 'complete', request?: Request): void
  checkAmbient(value: { user: { id: string }; session: { id: string } } | null): Promise<void>
  prepareChallenge(data: VerificationCreate): Promise<VerificationCreate>
  beforeConsume(identifier: string): Promise<void>
  consumedChallenge(value: NonNullable<Awaited<ReturnType<AuthContext['internalAdapter']['consumeVerificationValue']>>>): Promise<void>
  verified(args: VerifiedInitialRegistration): Promise<void>
}>
export class AdditionalPasskeyRejected extends Error { constructor() { super('Authentication rejected') } }
const handle = Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i))
const envelope = Schema.Struct({ intentId: handle, response: Schema.Unknown })
const encoded = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16384), Schema.isPattern(/^[A-Za-z0-9_-]+$/))
const registrationInput = Schema.Struct({ intentId: handle, response: Schema.Struct({
  id: encoded, rawId: encoded, type: Schema.Literal('public-key'),
  response: Schema.Struct({ clientDataJSON: encoded, attestationObject: encoded,
    transports: Schema.optional(Schema.Array(Schema.Literals(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'])).check(Schema.isMaxLength(8))) }),
  clientExtensionResults: Schema.Struct({ credProps: Schema.optional(Schema.Struct({ rk: Schema.optional(Schema.Boolean) })) }),
  authenticatorAttachment: Schema.optional(Schema.Literals(['platform', 'cross-platform'])),
}) })
export function validateAdditionalPasskeyAuthorizeInput(input: unknown): AdditionalPasskeyAuthorizeInput {
  try {
    const value = Schema.decodeUnknownSync(envelope)(input, { onExcessProperty: 'error' })
    return { intentId: value.intentId, ...validatePasskeyFinishInput({ response: value.response }) }
  } catch { throw new AdditionalPasskeyRejected() }
}
export function validateAdditionalPasskeyFinishInput(input: unknown): AdditionalPasskeyFinishInput {
  try {
    const value = Schema.decodeUnknownSync(registrationInput)(input, { onExcessProperty: 'error' })
    if (value.response.id !== value.response.rawId || [value.response.id, value.response.response.clientDataJSON, value.response.response.attestationObject]
      .some(item => Buffer.from(item, 'base64url').toString('base64url') !== item)) throw new AdditionalPasskeyRejected()
    return { intentId: value.intentId, response: { ...value.response, response: { ...value.response.response,
      transports: value.response.response.transports ? [...value.response.response.transports] : undefined } } }
  } catch { throw new AdditionalPasskeyRejected() }
}
type Ambient = { user: { id: string }; session: { id: string } }
type Intent = typeof additionalPasskeyIntent.$inferSelect
type Key = typeof passkey.$inferSelect
export type AdditionalPasskeyState = {
  principal: AdmittedPrincipal
  user: typeof user.$inferSelect
  session: typeof session.$inferSelect
  workspaceId: string
  key?: Key
  intent?: Intent
}
export async function additionalDatabaseTime(lease: AdditionalPasskeyLease): Promise<Date> {
  const [clock] = await lease.db.select({ now: sql<Date>`clock_timestamp()`.mapWith(user.createdAt) }).from(sql`(select 1) as additional_clock`)
  if (!clock) throw new AdditionalPasskeyRejected()
  return clock.now
}
function validState(state: AdditionalPasskeyState, now: Date) {
  const s = state.session, u = state.user, n = now.getTime()
  if (u.recovering || s.authState !== 'ACTIVE' || s.userId !== u.id || s.recoveryGeneration !== u.recoveryGeneration
    || u.holdUntil !== null && u.holdUntil.getTime() > n || s.expiresAt.getTime() <= n
    || s.authenticatedAt.getTime() + 604800000 <= n || s.lastActivityAt.getTime() + 43200000 <= n
    || state.intent && (state.intent.expiresAt.getTime() <= n || state.intent.recoveryGeneration !== u.recoveryGeneration
      || state.intent.userId !== u.id || state.intent.sessionId !== s.id || state.intent.workspaceId !== state.workspaceId)) throw new AdditionalPasskeyRejected()
}
export async function lockAdditionalState(lease: AdditionalPasskeyLease, ambient: Ambient | null,
  target?: { intentId: string; phase: 'CHALLENGE' | 'AUTHORIZED'; credentialId?: string }): Promise<AdditionalPasskeyState> {
  if (!ambient) throw new AdditionalPasskeyRejected()
  const [locatedIntent] = target ? await lease.db.select().from(additionalPasskeyIntent).where(eq(additionalPasskeyIntent.id, target.intentId)) : []
  const [locatedKey] = target ? await lease.db.select().from(passkey).where(target.credentialId
    ? eq(passkey.credentialID, target.credentialId) : eq(passkey.id, locatedIntent?.authorizingKeyId ?? '')) : []
  const [u] = await lease.db.select().from(user).where(eq(user.id, ambient.user.id)).for('update')
  const [s] = await lease.db.select().from(session).where(eq(session.id, ambient.session.id)).for('update')
  if (!u || !s || u.id !== ambient.user.id || s.id !== ambient.session.id || s.userId !== u.id) throw new AdditionalPasskeyRejected()
  const principal = Object.freeze({ userId: u.id, sessionId: s.id, name: u.name, email: u.email })
  const workspaceId = await lease.resolveAdditionalPasskeyWorkspace(principal)
  if (!workspaceId) throw new AdditionalPasskeyRejected()
  const state: AdditionalPasskeyState = { principal, user: u, session: s, workspaceId }
  validState(state, await additionalDatabaseTime(lease))
  if (target) {
    if (!locatedIntent || !locatedKey || locatedKey.userId !== u.id) throw new AdditionalPasskeyRejected()
    const [key] = await lease.db.select().from(passkey).where(eq(passkey.id, locatedKey.id)).for('update')
    if (!key || key.userId !== u.id || key.credentialID !== locatedKey.credentialID || key.publicKey !== locatedKey.publicKey) throw new AdditionalPasskeyRejected()
    const [intent] = await lease.db.select().from(additionalPasskeyIntent).where(eq(additionalPasskeyIntent.id, target.intentId)).for('update')
    if (!intent || intent.phase !== target.phase || intent.userId !== locatedIntent.userId || intent.sessionId !== locatedIntent.sessionId
      || intent.workspaceId !== locatedIntent.workspaceId || intent.recoveryGeneration !== locatedIntent.recoveryGeneration
      || intent.expiresAt.getTime() !== locatedIntent.expiresAt.getTime()) throw new AdditionalPasskeyRejected()
    if (target.phase === 'AUTHORIZED' && (intent.authorizingKeyId !== key.id || intent.authorizingCredentialId !== key.credentialID
      || intent.authorizingPublicKey !== key.publicKey)) throw new AdditionalPasskeyRejected()
    state.key = key; state.intent = intent
  }
  validState(state, await additionalDatabaseTime(lease))
  return state
}
export async function recheckAdditionalState(lease: AdditionalPasskeyLease, state: AdditionalPasskeyState) {
  // All these locks were acquired in order at entry and remain owned throughout.
  const [u] = await lease.db.select().from(user).where(eq(user.id, state.user.id))
  const [s] = await lease.db.select().from(session).where(eq(session.id, state.session.id))
  if (!u || !s || s.userId !== u.id || u.recoveryGeneration !== state.user.recoveryGeneration) throw new AdditionalPasskeyRejected()
  if (await lease.resolveAdditionalPasskeyWorkspace(state.principal) !== state.workspaceId) throw new AdditionalPasskeyRejected()
  if (state.key) {
    const [key] = await lease.db.select().from(passkey).where(eq(passkey.id, state.key.id))
    if (!key || key.userId !== u.id || key.credentialID !== state.key.credentialID || key.publicKey !== state.key.publicKey) throw new AdditionalPasskeyRejected()
  }
  validState({ ...state, user: u, session: s }, await additionalDatabaseTime(lease))
}
export async function beginAdditionalIntent(lease: AdditionalPasskeyLease, state: AdditionalPasskeyState, rpID: string): Promise<AdditionalPasskeyBegin> {
  const expired = await lease.db.select({ id: additionalPasskeyIntent.id }).from(additionalPasskeyIntent)
    .where(and(eq(additionalPasskeyIntent.userId, state.user.id), lte(additionalPasskeyIntent.expiresAt, sql`clock_timestamp()`)))
    .orderBy(asc(additionalPasskeyIntent.expiresAt), asc(additionalPasskeyIntent.id)).limit(100)
  if (expired.length) await lease.db.delete(additionalPasskeyIntent).where(and(eq(additionalPasskeyIntent.userId, state.user.id),
    inArray(additionalPasskeyIntent.id, expired.map(item => item.id)), lte(additionalPasskeyIntent.expiresAt, sql`clock_timestamp()`)))
  const storedKeys = await lease.db.select({ id: passkey.credentialID }).from(passkey).where(eq(passkey.userId, state.user.id))
  if (!storedKeys.length) throw new AdditionalPasskeyRejected()
  const now = await additionalDatabaseTime(lease)
  const expiresAt = new Date(Math.min(now.getTime() + 300000, state.session.expiresAt.getTime(),
    state.session.authenticatedAt.getTime() + 604800000, state.session.lastActivityAt.getTime() + 43200000))
  const options = await generateAuthenticationOptions({ rpID, userVerification: 'required', allowCredentials: storedKeys, timeout: 300000 })
  const intentId = randomUUID()
  const [intent] = await lease.db.insert(additionalPasskeyIntent).values({ id: intentId, userId: state.user.id, sessionId: state.session.id,
    workspaceId: state.workspaceId, recoveryGeneration: state.user.recoveryGeneration, phase: 'CHALLENGE', expiresAt,
    authenticationChallenge: options.challenge }).returning()
  if (!intent) throw new AdditionalPasskeyRejected()
  state.intent = intent
  await recheckAdditionalState(lease, state)
  return { intentId, expiresAt: expiresAt.toISOString(), options }
}
export async function verifyAdditionalAssertion(lease: AdditionalPasskeyLease, state: AdditionalPasskeyState, input: AdditionalPasskeyAuthorizeInput, origin: string) {
  if (!state.key || !state.intent?.authenticationChallenge || input.response.id !== state.key.credentialID) throw new AdditionalPasskeyRejected()
  const verification = await verifyAuthenticationResponse({ response: input.response, expectedChallenge: state.intent.authenticationChallenge,
    expectedOrigin: origin, expectedRPID: new URL(origin).hostname, credential: { id: state.key.credentialID,
      publicKey: new Uint8Array(Buffer.from(state.key.publicKey, 'base64')), counter: state.key.counter }, requireUserVerification: true })
    .catch(() => { throw new Error('Authentication verification failed') })
  const counter = verification.authenticationInfo.newCounter
  if (verification.verified !== true || verification.authenticationInfo.userVerified !== true || !Number.isSafeInteger(counter) || counter < 0
    || (counter > 0 || state.key.counter > 0) && counter <= state.key.counter) throw new AdditionalPasskeyRejected()
  await recheckAdditionalState(lease, state)
  const updated = await lease.db.update(passkey).set({ counter }).where(and(eq(passkey.id, state.key.id), eq(passkey.userId, state.user.id))).returning({ id: passkey.id })
  if (updated.length !== 1) throw new AdditionalPasskeyRejected()
}
const nativeChallenge = Schema.Struct({ type: Schema.Literal('registration'), expectedChallenge: Schema.NonEmptyString,
  userData: Schema.Struct({ id: Schema.NonEmptyString }), context: Schema.NonEmptyString })
export function checkAdditionalChallenge(data: { value: string }, state: AdditionalPasskeyState) {
  try {
    const parsed = Schema.decodeUnknownSync(nativeChallenge)(JSON.parse(data.value))
    if (!state.intent || parsed.userData.id !== state.user.id || parsed.context !== 'additional-passkey:' + state.intent.id) throw new AdditionalPasskeyRejected()
  } catch { throw new AdditionalPasskeyRejected() }
}
export async function lockAdditionalVerification(lease: AdditionalPasskeyLease, state: AdditionalPasskeyState, identifier: string) {
  if (!state.intent || identifier !== state.intent.registrationVerificationIdentifier) throw new AdditionalPasskeyRejected()
  const rows = await lease.db.select().from(verification).where(eq(verification.identifier, identifier)).for('update')
  if (rows.length !== 1) throw new AdditionalPasskeyRejected()
  checkAdditionalChallenge(rows[0], state)
  await recheckAdditionalState(lease, state)
  if (rows[0].expiresAt.getTime() <= (await additionalDatabaseTime(lease)).getTime()) throw new AdditionalPasskeyRejected()
  return rows[0]
}
