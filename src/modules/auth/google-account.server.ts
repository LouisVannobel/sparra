import { Schema } from 'effect'
import { generateAuthenticationOptions } from '@simplewebauthn/server'
import { verifyPasskeyAssertion } from './passkey-assertion.server'
import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm'
import type { AuthTransactions } from '../../platform/db/transactions.server'
import type { AdmittedPrincipal } from './session.server'
import { validateAdditionalPasskeyAuthorizeInput } from './additional-passkey.server'
import { account, googleAccountIntent, passkey, session, user, verification } from './schema.server'

export class GoogleAccountRejected extends Error {
  constructor(readonly reason: 'unavailable' | 'expired' | 'cancelled' = 'unavailable', readonly principalRefused = false) { super('Authentication rejected') }
}
export const googleAccountPurpose = 'google-account-link'
export const googleAccountCallbackPath = '/api/auth/account/google/callback'
export type GoogleAccountConnection = { state: 'unlinked'; canLink: boolean } | { state: 'linked'; accountId: string; canUnlink: boolean } | { state: 'unavailable' }
export function googleAccountConnection(accounts: { id: string }[], eligible: boolean, configured: boolean): GoogleAccountConnection {
  return accounts.length > 1 ? { state: 'unavailable' } : accounts.length === 1 ? { state: 'linked', accountId: accounts[0].id, canUnlink: eligible }
    : { state: 'unlinked', canLink: eligible && configured }
}
const intentId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i))
const target = Schema.Struct({ intentId })
const unlink = Schema.Struct({ accountId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)) })
export function validateGoogleAccountTarget(input: unknown) {
  try { return Schema.decodeUnknownSync(target)(input, { onExcessProperty: 'error' }) } catch { throw new GoogleAccountRejected() }
}
export function validateGoogleAccountUnlink(input: unknown) {
  try { return Schema.decodeUnknownSync(unlink)(input, { onExcessProperty: 'error' }) } catch { throw new GoogleAccountRejected() }
}
export function validateGoogleAccountAssertion(input: unknown) {
  try { return validateAdditionalPasskeyAuthorizeInput(input) } catch { throw new GoogleAccountRejected() }
}

type Intent = typeof googleAccountIntent.$inferSelect
type Authority = { user: typeof user.$inferSelect; session: typeof session.$inferSelect; workspaceId: string; intent?: Intent }
export type GoogleAccountLease = Parameters<Parameters<AuthTransactions['withAuthPromise']>[1]>[0]
export type GoogleAccountState = Authority & { principal: AdmittedPrincipal; key?: typeof passkey.$inferSelect; accounts: (typeof account.$inferSelect)[] }
export const googleAccountTerminalMaterial = { authenticationChallenge: null, authorizingKeyId: null, authorizingCredentialId: null, authorizingPublicKey: null, oauthState: null }
export function checkGoogleAccountState(state: Authority, now: Date, receipt: boolean) {
  const u = state.user, s = state.session, i = state.intent, n = now.getTime()
  if (u.recovering || s.authState !== 'ACTIVE' || s.userId !== u.id || s.recoveryGeneration !== u.recoveryGeneration
    || u.holdUntil !== null && u.holdUntil.getTime() > n || s.expiresAt.getTime() <= n
    || s.authenticatedAt.getTime() + 604800000 <= n || s.lastActivityAt.getTime() + 43200000 <= n) throw new GoogleAccountRejected('unavailable', true)
  if (i && (i.userId !== u.id || i.sessionId !== s.id || i.recoveryGeneration !== u.recoveryGeneration
      || i.workspaceId !== state.workspaceId || i.createdAt.getTime() + 86400000 <= n)) throw new GoogleAccountRejected()
  if (!receipt && i && (i.expiresAt.getTime() <= n || i.phase === 'CONSUMED' || i.phase === 'INVALIDATED')) throw new GoogleAccountRejected('expired')
}
export type GoogleAccountStatus = { intentId: string; action: 'LINK' | 'UNLINK'; state: 'pending' | 'authorized' | 'exchanging' | 'linked' | 'unlinked' | 'expired' | 'invalidated'; expiresAt: string; reason: GoogleAccountRejected['reason'] | null }
export function googleAccountStatus(i: Intent, now: Date): GoogleAccountStatus {
  if (i.phase === 'CONSUMED' && (!i.nativeAccountId || !i.providerSubject || i.outcome !== (i.action === 'LINK' ? 'linked' : 'unlinked'))) throw new GoogleAccountRejected()
  return { intentId: i.id, action: i.action, expiresAt: i.expiresAt.toISOString(), reason: i.reason,
    state: i.phase === 'CONSUMED' ? i.action === 'LINK' ? 'linked' : 'unlinked' : i.phase === 'INVALIDATED' ? 'invalidated'
      : i.expiresAt.getTime() <= now.getTime() ? 'expired' : i.phase === 'AUTHORIZED' ? 'authorized' : i.phase === 'EXCHANGING' ? 'exchanging' : 'pending' }
}
export async function verifyGoogleAccountAssertion(key: { credentialID: string; publicKey: string; counter: number }, challenge: string,
  response: ReturnType<typeof validateGoogleAccountAssertion>['response'], origin: string) {
  try { return await verifyPasskeyAssertion(key, challenge, response, origin) } catch { throw new GoogleAccountRejected() }
}

export async function googleAccountDatabaseTime(lease: GoogleAccountLease) {
  const [clock] = await lease.db.select({ now: sql<Date>`clock_timestamp()`.mapWith(user.createdAt) }).from(sql`(select 1) as google_account_clock`)
  if (!clock) throw new GoogleAccountRejected()
  return clock.now
}
export async function lockGoogleAccountState(lease: GoogleAccountLease, ambient: { user: { id: string }; session: { id: string } } | null,
  target?: { intentId: string; credentialId?: string }, receipt = false): Promise<GoogleAccountState> {
  if (!ambient) throw new GoogleAccountRejected('unavailable', true)
  const [u] = await lease.db.select().from(user).where(eq(user.id, ambient.user.id)).for('update')
  const [s] = await lease.db.select().from(session).where(eq(session.id, ambient.session.id)).for('update')
  if (!u || !s || s.userId !== u.id) throw new GoogleAccountRejected()
  const principal = Object.freeze({ userId: u.id, sessionId: s.id, name: u.name, email: u.email })
  const workspaceId = await lease.resolveAdditionalPasskeyWorkspace(principal)
  if (!workspaceId) throw new GoogleAccountRejected()
  const keys = receipt ? [] : await lease.db.select().from(passkey).where(eq(passkey.userId, u.id)).orderBy(asc(passkey.id)).for('update')
  const [intent] = target ? await lease.db.select().from(googleAccountIntent).where(eq(googleAccountIntent.id, target.intentId)).for('update') : []
  if (target && !intent) throw new GoogleAccountRejected()
  const accounts = receipt ? [] : await lease.db.select().from(account).where(and(eq(account.userId, u.id), eq(account.providerId, 'google'))).orderBy(asc(account.id)).for('update')
  const key = target ? keys.find(item => target.credentialId ? item.credentialID === target.credentialId : item.id === intent?.authorizingKeyId) : undefined
  const state = { principal, user: u, session: s, workspaceId, intent, key, accounts }
  checkGoogleAccountState(state, await googleAccountDatabaseTime(lease), receipt)
  if (!receipt) {
    if (!keys.length || target && !key || accounts.length > 1) throw new GoogleAccountRejected()
    if (intent?.action === 'LINK' && accounts.length !== 0 || intent?.action === 'UNLINK' && (accounts.length !== 1
      || accounts[0].id !== intent.targetAccountId || accounts[0].accountId !== intent.targetSubject)) throw new GoogleAccountRejected()
    if (intent && intent.phase !== 'CHALLENGE' && (!key || key.id !== intent.authorizingKeyId || key.credentialID !== intent.authorizingCredentialId
      || key.publicKey !== intent.authorizingPublicKey)) throw new GoogleAccountRejected()
  }
  return state
}
export async function recheckGoogleAccountState(lease: GoogleAccountLease, state: GoogleAccountState, receipt = false) {
  const [u] = await lease.db.select().from(user).where(eq(user.id, state.user.id))
  const [s] = await lease.db.select().from(session).where(eq(session.id, state.session.id))
  // Security commands authorize no profile/session write, including activity refresh.
  if (!u || !s || JSON.stringify(u) !== JSON.stringify(state.user) || JSON.stringify(s) !== JSON.stringify(state.session)
    || await lease.resolveAdditionalPasskeyWorkspace(state.principal) !== state.workspaceId) throw new GoogleAccountRejected()
  checkGoogleAccountState({ ...state, user: u, session: s }, await googleAccountDatabaseTime(lease), receipt)
  if (state.key) {
    const [key] = await lease.db.select().from(passkey).where(eq(passkey.id, state.key.id))
    if (!key || key.userId !== u.id || key.credentialID !== state.key.credentialID || key.publicKey !== state.key.publicKey) throw new GoogleAccountRejected()
  }
}
export async function beginGoogleAccountIntent(lease: GoogleAccountLease, state: GoogleAccountState, action: 'LINK' | 'UNLINK', locale: 'fr' | 'en', origin: string, accountId?: string) {
  if (action === 'LINK' ? state.accounts.length !== 0 : state.accounts.length !== 1 || state.accounts[0].id !== accountId) throw new GoogleAccountRejected()
  const now = await googleAccountDatabaseTime(lease)
  const expired = await lease.db.select({ id: googleAccountIntent.id }).from(googleAccountIntent)
    .where(and(eq(googleAccountIntent.userId, state.user.id), lte(googleAccountIntent.createdAt, new Date(now.getTime() - 86400000))))
    .orderBy(asc(googleAccountIntent.createdAt), asc(googleAccountIntent.id)).limit(100)
  if (expired.length) await lease.db.delete(googleAccountIntent).where(and(eq(googleAccountIntent.userId, state.user.id), inArray(googleAccountIntent.id, expired.map(item => item.id))))
  const keys = await lease.db.select({ id: passkey.credentialID }).from(passkey).where(eq(passkey.userId, state.user.id))
  if (!keys.length) throw new GoogleAccountRejected()
  const expiresAt = new Date(Math.min(now.getTime() + 300000, state.session.expiresAt.getTime(), state.session.authenticatedAt.getTime() + 604800000,
    state.session.lastActivityAt.getTime() + 43200000))
  const options = await generateAuthenticationOptions({ rpID: new URL(origin).hostname, userVerification: 'required', allowCredentials: keys, timeout: 300000 })
  const [intent] = await lease.db.insert(googleAccountIntent).values({ id: randomUUID(), userId: state.user.id, sessionId: state.session.id,
    workspaceId: state.workspaceId, recoveryGeneration: state.user.recoveryGeneration, action, locale, createdAt: now, expiresAt, phase: 'CHALLENGE',
    authenticationChallenge: options.challenge, targetAccountId: action === 'UNLINK' ? state.accounts[0].id : null,
    targetSubject: action === 'UNLINK' ? state.accounts[0].accountId : null }).returning()
  if (!intent) throw new GoogleAccountRejected()
  state.intent = intent
  await recheckGoogleAccountState(lease, state)
  return { intentId: intent.id, expiresAt: expiresAt.toISOString(), options }
}
export async function advanceGoogleAccountKey(lease: GoogleAccountLease, state: GoogleAccountState, input: ReturnType<typeof validateGoogleAccountAssertion>, origin: string) {
  if (!state.key || state.intent?.phase !== 'CHALLENGE' || !state.intent.authenticationChallenge) throw new GoogleAccountRejected()
  const counter = await verifyGoogleAccountAssertion(state.key, state.intent.authenticationChallenge, input.response, origin)
  await recheckGoogleAccountState(lease, state)
  const rows = await lease.db.update(passkey).set({ counter }).where(and(eq(passkey.id, state.key.id), eq(passkey.counter, state.key.counter))).returning({ id: passkey.id })
  if (rows.length !== 1) throw new GoogleAccountRejected()
}
export async function invalidateGoogleAccountIntent(lease: GoogleAccountLease, state: GoogleAccountState, reason: GoogleAccountRejected['reason']) {
  if (!state.intent || state.intent.phase === 'CONSUMED' || state.intent.phase === 'INVALIDATED') return
  if (state.intent.oauthState) await lease.db.delete(verification).where(eq(verification.identifier, state.intent.oauthState))
  const [changed] = await lease.db.update(googleAccountIntent).set({ phase: 'INVALIDATED', reason, ...googleAccountTerminalMaterial })
    .where(and(eq(googleAccountIntent.id, state.intent.id), eq(googleAccountIntent.phase, state.intent.phase))).returning()
  if (!changed) throw new GoogleAccountRejected()
  state.intent = changed
}
