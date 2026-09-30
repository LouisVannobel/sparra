import type { startAuthentication } from '@simplewebauthn/browser'
import type { passkey as passkeyPlugin } from '@better-auth/passkey'
import { and, eq, sql } from 'drizzle-orm'
import { Schema } from 'effect'
import type { AuthTransactions } from '../../platform/db/transactions.server'
import { passkey, session, user } from './schema.server'

export type PasskeyAuthenticationOptions = Parameters<typeof startAuthentication>[0]['optionsJSON']
export type PasskeyAuthenticationResponse = Awaited<ReturnType<typeof startAuthentication>>
type NativeAuthentication = NonNullable<NonNullable<Parameters<typeof passkeyPlugin>[0]>['authentication']>
export type VerifiedPasskeyAuthentication = Parameters<NonNullable<NativeAuthentication['afterVerification']>>[0]
type AuthLease = Parameters<Parameters<AuthTransactions['withAuthPromise']>[1]>[0]

export class PasskeyLoginRejected extends Error { constructor() { super('Authentication rejected') } }
export class PasskeyLoginSessionConflict extends Error { constructor() { super('Sign out before using a passkey') } }

const base64url = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16384), Schema.isPattern(/^[A-Za-z0-9_-]+$/))
const assertionSchema = Schema.Struct({
  id: base64url,
  rawId: base64url,
  type: Schema.Literal('public-key'),
  response: Schema.Struct({
    clientDataJSON: base64url,
    authenticatorData: base64url,
    signature: base64url,
    userHandle: Schema.optional(base64url),
  }),
  clientExtensionResults: Schema.Record(Schema.String.check(Schema.isMaxLength(128)), Schema.Unknown),
  authenticatorAttachment: Schema.optional(Schema.Literals(['platform', 'cross-platform'])),
})
const finishSchema = Schema.Struct({ response: assertionSchema })

function canonicalBase64url(value: string) {
  const bytes = Buffer.from(value, 'base64url')
  return bytes.length > 0 && bytes.toString('base64url') === value
}

export function validatePasskeyFinishInput(input: unknown): { response: PasskeyAuthenticationResponse } {
  try {
    const value = Schema.decodeUnknownSync(finishSchema)(input, { onExcessProperty: 'error' })
    if (Object.keys(value.response.clientExtensionResults).length !== 0
      || value.response.id !== value.response.rawId || !canonicalBase64url(value.response.id)
      || !canonicalBase64url(value.response.response.clientDataJSON)
      || !canonicalBase64url(value.response.response.authenticatorData)
      || !canonicalBase64url(value.response.response.signature)
      || value.response.response.userHandle !== undefined && !canonicalBase64url(value.response.response.userHandle)) throw new Error()
    return { response: { ...value.response, clientExtensionResults: {} } }
  } catch { throw new PasskeyLoginRejected() }
}

const authenticationOptionsSchema = Schema.Struct({
  challenge: base64url,
  rpId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(253), Schema.isPattern(/^[A-Za-z0-9.-]+$/)),
  timeout: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 300000 })),
  allowCredentials: Schema.optional(Schema.Undefined),
  userVerification: Schema.Literals(['discouraged', 'preferred', 'required']),
  extensions: Schema.optional(Schema.Undefined),
})

export function validatePasskeyAuthenticationOptions(input: unknown): PasskeyAuthenticationOptions {
  try {
    const value = Schema.decodeUnknownSync(authenticationOptionsSchema)(input, { onExcessProperty: 'error' })
    return { challenge: value.challenge, rpId: value.rpId, timeout: value.timeout, userVerification: 'required' }
  } catch { throw new PasskeyLoginRejected() }
}

export type LockedPasskeyLogin = Readonly<{
  user: Readonly<{ id: string; recoveryGeneration: number }>
  key: Readonly<{ id: string; credentialID: string; publicKey: string; userId: string; counter: number }>
}>

export async function lockPasskeyLoginCandidate(lease: AuthLease, credentialID: string): Promise<LockedPasskeyLogin> {
  const [candidate] = await lease.db.select({ keyId: passkey.id, credentialID: passkey.credentialID, publicKey: passkey.publicKey,
    userId: passkey.userId, recoveryGeneration: user.recoveryGeneration }).from(passkey)
    .innerJoin(user, eq(passkey.userId, user.id)).where(eq(passkey.credentialID, credentialID))
  if (!candidate) throw new PasskeyLoginRejected()
  const [lockedUser] = await lease.db.select({ id: user.id, recovering: user.recovering, recoveryGeneration: user.recoveryGeneration })
    .from(user).where(eq(user.id, candidate.userId)).for('update')
  if (!lockedUser || lockedUser.recovering || lockedUser.recoveryGeneration !== candidate.recoveryGeneration) throw new PasskeyLoginRejected()
  const [lockedKey] = await lease.db.select({ id: passkey.id, credentialID: passkey.credentialID, publicKey: passkey.publicKey,
    userId: passkey.userId, counter: passkey.counter }).from(passkey).where(eq(passkey.id, candidate.keyId)).for('update')
  if (!lockedKey || lockedKey.credentialID !== credentialID || lockedKey.credentialID !== candidate.credentialID
    || lockedKey.publicKey !== candidate.publicKey || lockedKey.userId !== candidate.userId) throw new PasskeyLoginRejected()
  return Object.freeze({ user: Object.freeze({ id: lockedUser.id, recoveryGeneration: lockedUser.recoveryGeneration }), key: Object.freeze(lockedKey) })
}

export async function passkeyDatabaseTime(lease: AuthLease) {
  const [clock] = await lease.db.select({ now: sql<Date>`clock_timestamp()`.mapWith(user.createdAt) }).from(sql`(select 1) as passkey_clock`)
  if (!clock) throw new PasskeyLoginRejected()
  return clock.now
}

export async function recheckLockedPasskeyLogin(lease: AuthLease, proof: LockedPasskeyLogin, expectedCounter: number) {
  const [currentUser] = await lease.db.select({ id: user.id, recovering: user.recovering, recoveryGeneration: user.recoveryGeneration })
    .from(user).where(eq(user.id, proof.user.id)).for('update')
  const [currentKey] = await lease.db.select({ id: passkey.id, credentialID: passkey.credentialID, publicKey: passkey.publicKey,
    userId: passkey.userId, counter: passkey.counter }).from(passkey).where(eq(passkey.id, proof.key.id)).for('update')
  if (!currentUser || currentUser.recovering || currentUser.recoveryGeneration !== proof.user.recoveryGeneration
    || !currentKey || currentKey.credentialID !== proof.key.credentialID || currentKey.publicKey !== proof.key.publicKey
    || currentKey.userId !== proof.key.userId || currentKey.counter !== expectedCounter) throw new PasskeyLoginRejected()
}

export async function validatePersistedPasskeySession(lease: AuthLease, proof: LockedPasskeyLogin, sessionId: string,
  challengeExpiry: Date, expectedCounter: number) {
  await recheckLockedPasskeyLogin(lease, proof, expectedCounter)
  const [persisted] = await lease.db.select({ id: session.id, userId: session.userId, authState: session.authState,
    authMethod: session.authMethod, authenticatedAt: session.authenticatedAt, lastActivityAt: session.lastActivityAt,
    recoveryGeneration: session.recoveryGeneration, expiresAt: session.expiresAt }).from(session)
    .where(and(eq(session.id, sessionId), eq(session.userId, proof.user.id))).for('update')
  const now = await passkeyDatabaseTime(lease)
  if (!persisted || persisted.authState !== 'ACTIVE' || persisted.authMethod !== 'passkey'
    || persisted.recoveryGeneration !== proof.user.recoveryGeneration
    || persisted.authenticatedAt.getTime() !== persisted.lastActivityAt.getTime()
    || persisted.expiresAt.getTime() <= now.getTime() || challengeExpiry.getTime() <= now.getTime()) throw new PasskeyLoginRejected()
  return persisted
}

export type PasskeyLoginInvocation = Readonly<{
  assert(operation: 'options' | 'complete', request?: Request): void
  preparedChallenge(expiresAt: Date): void
  consumedChallenge(expiresAt: Date): void
  verified(args: VerifiedPasskeyAuthentication): Promise<void>
  take(userId: string): Promise<{ now: Date; newCounter: number; recoveryGeneration: number }>
  created(value: { id: string; userId: string; authState?: string; authMethod?: string; recoveryGeneration?: number;
    authenticatedAt?: Date; lastActivityAt?: Date }): void
  returned(sessionId: string, userId: string): void
}>
