import { createHash, timingSafeEqual } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { Schema } from 'effect'
import type { AuthEmailEnvelope } from './auth-email-envelope.server'
import { authorizeEmailRequest, materializeDelivery, normalizeAuthEmail, retireEmailRequest, type AuthEmailLease } from './auth-email-store.server'
import type { MailProfile } from './mail-snapshot.server'
import { authEmailCommand, authEmailRequest, emailDelivery, user } from './schema.server'

const requestSchema = Schema.Struct({ email: Schema.String, locale: Schema.Literals(['fr', 'en']) })
const consumeSchema = Schema.Struct({ token: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)), intendedEmail: Schema.String })
export type MagicRequestInput = typeof requestSchema.Type
export type MagicConsumeInput = typeof consumeSchema.Type
export class MagicProofRejected extends Error { constructor() { super('Authentication rejected') } }
export class MagicSessionConflict extends Error { constructor() { super('Sign out before using this link') } }
export function validateMagicRequest(input: unknown) {
  try { const value = Schema.decodeUnknownSync(requestSchema)(input, { onExcessProperty: 'error' }); return { ...value, email: normalizeAuthEmail(value.email) } }
  catch { throw new MagicProofRejected() }
}
export function validateMagicConsume(input: unknown) {
  try {
    const value = Schema.decodeUnknownSync(consumeSchema)(input, { onExcessProperty: 'error' })
    const bytes = Buffer.from(value.token, 'base64url')
    try { if (bytes.length !== 32 || bytes.toString('base64url') !== value.token) throw new MagicProofRejected() }
    finally { bytes.fill(0) }
    return { ...value, intendedEmail: normalizeAuthEmail(value.intendedEmail) }
  } catch { throw new MagicProofRejected() }
}
export async function magicDatabaseTime({ db }: AuthEmailLease) {
  const [clock] = await db.select({ now: sql`clock_timestamp()`.mapWith(authEmailCommand.createdAt) }).from(sql`(select 1) as magic_clock`)
  if (!clock) throw new MagicProofRejected()
  return clock.now
}
export async function requestMagicProof(lease: AuthEmailLease, input: MagicRequestInput, producer: { envelope: AuthEmailEnvelope; profile: MailProfile }) {
  const value = validateMagicRequest(input)
  const [bound] = await lease.db.select().from(user).where(eq(user.email, value.email)).for('update')
  if (bound?.recovering) return
  const [current] = await lease.db.select().from(authEmailRequest).where(and(eq(authEmailRequest.email, value.email), eq(authEmailRequest.purpose, 'magic-link'))).for('update')
  const command = await authorizeEmailRequest(lease, { ...value, purpose: 'magic-link', lifetimeSeconds: 600,
    expectedGeneration: current?.generation ?? 0, userId: bound?.id, recoveryGeneration: bound?.recoveryGeneration })
  if (!await materializeDelivery(lease, command.id, producer.envelope, producer.profile)) throw new Error('Authentication unavailable')
}
export async function establishMagicProof(lease: AuthEmailLease, input: MagicConsumeInput, ambientUserId: string | undefined) {
  const value = validateMagicConsume(input), bytes = Buffer.from(value.token, 'base64url')
  const digest = createHash('sha256').update(bytes).digest(); bytes.fill(0)
  try {
    // The index locates a candidate; authority is re-established under locks.
    const [candidate] = await lease.db.select({ commandId: emailDelivery.commandId }).from(emailDelivery).where(eq(emailDelivery.verifierHash, digest.toString('hex')))
    if (!candidate) throw new MagicProofRejected()
    const [command] = await lease.db.select().from(authEmailCommand).where(eq(authEmailCommand.id, candidate.commandId))
    // First signup requires native initial enrollment (8B); never retarget it.
    if (!command?.userId || command.recoveryGeneration === null) throw new MagicProofRejected()
    const [bound] = await lease.db.select().from(user).where(eq(user.id, command.userId)).for('update')
    const [current] = await lease.db.select().from(authEmailRequest).where(eq(authEmailRequest.id, command.requestId)).for('update')
    const [delivery] = await lease.db.select().from(emailDelivery).where(eq(emailDelivery.commandId, command.id)).for('update')
    const now = await magicDatabaseTime(lease)
    if (!bound || bound.recovering || bound.recoveryGeneration !== command.recoveryGeneration || normalizeAuthEmail(bound.email) !== command.recipient
      || command.purpose !== 'magic-link' || command.recipient !== value.intendedEmail || !current || current.state !== 'active'
      || current.generation !== command.generation || current.userId !== bound.id || current.email !== command.recipient || current.purpose !== command.purpose
      || !delivery || delivery.state !== 'active' || !delivery.verifierHash || !/^[0-9a-f]{64}$/.test(delivery.verifierHash)
      || !timingSafeEqual(digest, Buffer.from(delivery.verifierHash, 'hex')) || command.expiresAt.getTime() <= now.getTime()) throw new MagicProofRejected()
    if (ambientUserId !== undefined && ambientUserId !== bound.id) throw new MagicSessionConflict()
    return Object.freeze({ user: bound, command, now })
  } finally { digest.fill(0) }
}
export type MagicProof = Awaited<ReturnType<typeof establishMagicProof>>
export async function finishMagicProof(lease: AuthEmailLease, proof: MagicProof) {
  if (proof.command.expiresAt.getTime() <= (await magicDatabaseTime(lease)).getTime()
    || !await retireEmailRequest(lease, proof.command.requestId, proof.command.generation, 'consumed')) throw new MagicProofRejected()
}

// Only the private auth factory supplies this original-Request/same-lease cell.
export type MagicInvocation = Readonly<{
  assert(request?: Request): void
  establish(): Promise<MagicProof>
  take(userId: string): Promise<MagicProof>
}>
