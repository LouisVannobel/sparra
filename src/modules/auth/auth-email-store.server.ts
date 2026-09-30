import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { and, eq, inArray, isNotNull, lte, or, sql } from 'drizzle-orm'
import { integer, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { Schema } from 'effect'
import type { AuthQueryDb } from '../../platform/db/auth-pg-lease.server'
import type { AuthEmailEnvelope } from './auth-email-envelope.server'
import { authEmailCommand, authEmailOutbox, authEmailRequest, emailDelivery, user } from './schema.server'
import { createMailSnapshot, type MailProfile } from './mail-snapshot.server'
import { normalizeAuthEmail } from './auth-email-normalization.server'
export { normalizeAuthEmail } from './auth-email-normalization.server'

// Native INSERT projections match the web role's column grants. Drizzle's
// full-table insert spells even absent provider/admission columns as DEFAULT,
// which still requires INSERT privilege on those worker-owned columns.
const deliveryInsert = pgTable('email_delivery', {
  id: uuid('id').notNull(), commandId: uuid('command_id').notNull(), state: text('state').notNull(),
  verifierHash: text('verifier_hash'), keyId: text('key_id').notNull(), ciphertext: text('ciphertext'), nonce: text('nonce'), tag: text('tag'),
  snapshotFormat: text('snapshot_format'), snapshotHash: text('snapshot_hash'), replayWindowSeconds: integer('replay_window_seconds'),
})
const outboxInsert = pgTable('auth_email_outbox', { id: uuid('id').notNull(), deliveryId: uuid('delivery_id').notNull() })

export type AuthEmailLease = Readonly<{ db: AuthQueryDb }>
export type AuthEmailCommand = typeof authEmailCommand.$inferSelect
export type AuthEmailRequest = typeof authEmailRequest.$inferSelect
export const authEmailPurpose = Schema.Literal('magic-link')
export const authEmailLocale = Schema.Literals(['fr', 'en'])
const generation = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 2147483646 }))
const authorization = Schema.Struct({
  email: Schema.String, purpose: authEmailPurpose, locale: authEmailLocale, expectedGeneration: generation,
  lifetimeSeconds: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 600 })),
  userId: Schema.optional(Schema.NonEmptyString), recoveryGeneration: Schema.optional(generation),
})
const rejected = () => new Error('Auth email request rejected')
export function validateEmailAuthorization(input: unknown) {
  try {
    const value = Schema.decodeUnknownSync(authorization)(input)
    if ((value.userId === undefined) !== (value.recoveryGeneration === undefined)) throw rejected()
    return { ...value, email: normalizeAuthEmail(value.email) }
  } catch { throw rejected() }
}
async function databaseNow({ db }: AuthEmailLease) {
  const [row] = await db.select({ now: sql`clock_timestamp()`.mapWith(authEmailCommand.createdAt) }).from(sql`(select 1) as auth_email_clock`)
  if (!row) throw rejected()
  return row.now
}
async function boundUser(lease: AuthEmailLease, userId: string | null, recoveryGeneration: number | null, recipient: string) {
  if (userId === null) return recoveryGeneration === null
  const [record] = await lease.db.select().from(user).where(eq(user.id, userId)).for('update')
  return !!record && !record.recovering && record.recoveryGeneration === recoveryGeneration && normalizeAuthEmail(record.email) === recipient
}
const cleared = { ciphertext: null, nonce: null, tag: null, verifierHash: null }
async function purgeCommand(lease: AuthEmailLease, commandId: string, state: 'consumed' | 'terminal' | 'superseded' | 'expired') {
  await lease.db.update(emailDelivery).set({ ...cleared, state }).where(and(eq(emailDelivery.commandId, commandId), eq(emailDelivery.state, 'active')))
  // Restored payload on an already retired tombstone must be removed as well.
  await lease.db.update(emailDelivery).set(cleared).where(eq(emailDelivery.commandId, commandId))
}

// The caller is a named, authorized server operation, never an arbitrary mail endpoint.
export async function authorizeEmailRequest(lease: AuthEmailLease, input: unknown): Promise<AuthEmailCommand> {
  const value = validateEmailAuthorization(input)
  if (!await boundUser(lease, value.userId ?? null, value.recoveryGeneration ?? null, value.email)) throw rejected()
  const inserted = await lease.db.insert(authEmailRequest).values({ id: randomUUID(), email: value.email, purpose: value.purpose, generation: 1, state: 'active', userId: value.userId })
    .onConflictDoNothing({ target: [authEmailRequest.email, authEmailRequest.purpose] }).returning()
  const [request] = await lease.db.select().from(authEmailRequest).where(and(eq(authEmailRequest.email, value.email), eq(authEmailRequest.purpose, value.purpose))).for('update')
  if (!request || (inserted.length ? value.expectedGeneration !== 0 : request.generation !== value.expectedGeneration)
    || request.userId !== null && request.userId !== value.userId) throw rejected()
  const nextGeneration = inserted.length ? 1 : request.generation + 1
  if (!inserted.length) {
    const prior = await lease.db.select({ id: authEmailCommand.id }).from(authEmailCommand).where(and(eq(authEmailCommand.requestId, request.id), eq(authEmailCommand.generation, request.generation)))
    for (const command of prior) await purgeCommand(lease, command.id, 'superseded')
    await lease.db.update(authEmailRequest).set({ generation: nextGeneration, state: 'active', userId: value.userId ?? request.userId }).where(eq(authEmailRequest.id, request.id))
  }
  const now = await databaseNow(lease)
  const [command] = await lease.db.insert(authEmailCommand).values({
    id: randomUUID(), requestId: request.id, generation: nextGeneration, purpose: value.purpose, recipient: value.email,
    locale: value.locale, createdAt: now, expiresAt: new Date(now.getTime() + value.lifetimeSeconds * 1000),
    userId: value.userId, recoveryGeneration: value.recoveryGeneration,
  }).returning()
  if (!command) throw rejected()
  return command
}

async function admitCommand(lease: AuthEmailLease, commandId: string) {
  const [command] = await lease.db.select().from(authEmailCommand).where(eq(authEmailCommand.id, commandId))
  if (!command) return null
  // Common lock order is User (where relevant), Request, Delivery.
  const userValid = await boundUser(lease, command.userId, command.recoveryGeneration, command.recipient)
  const [request] = await lease.db.select().from(authEmailRequest).where(eq(authEmailRequest.id, command.requestId)).for('update')
  const [delivery] = await lease.db.select().from(emailDelivery).where(eq(emailDelivery.commandId, command.id)).for('update')
  // Read the authoritative clock after the last potentially blocking row lock;
  // this same sample is consumed immediately by the envelope primitive.
  const now = await databaseNow(lease)
  const expired = command.expiresAt.getTime() <= now.getTime()
  if (!request || request.generation !== command.generation || request.state !== 'active' || !userValid
    || request.userId !== command.userId || request.email !== command.recipient || request.purpose !== command.purpose || expired) {
    if (request?.generation === command.generation && request.state === 'active') {
      await lease.db.update(authEmailRequest).set({ state: 'terminal' }).where(eq(authEmailRequest.id, request.id))
    }
    await purgeCommand(lease, command.id, expired ? 'expired' : request?.state === 'consumed' ? 'consumed' : 'superseded')
    return null
  }
  return { command, delivery, now }
}

export async function materializeDelivery(lease: AuthEmailLease, commandId: string, envelope: AuthEmailEnvelope, profile: MailProfile) {
  const admission = await admitCommand(lease, commandId)
  if (!admission) return null
  const { command, delivery: existing, now } = admission
  if (existing) {
    if (existing.state !== 'active') return null
    // The delivery association is immutable. Request/Delivery are already
    // locked; reading its outbox identity does not require worker UPDATE rights.
    const [outbox] = await lease.db.select().from(authEmailOutbox).where(eq(authEmailOutbox.deliveryId, existing.id))
    if (!outbox) throw rejected()
    return { id: existing.id, outboxId: outbox.id }
  }
  const id = randomUUID(), outboxId = randomUUID(), token = randomBytes(32)
  try {
    const snapshot = createMailSnapshot(profile, command, outboxId, token)
    let sealed
    try { sealed = envelope.seal(snapshot.bytes, { deliveryId: id, purpose: command.purpose, generation: command.generation, expiresAt: command.expiresAt }, now) }
    finally { snapshot.bytes.fill(0) }
    await lease.db.insert(deliveryInsert).values({ id, commandId: command.id, state: 'active', verifierHash: createHash('sha256').update(token).digest('hex'), ...sealed,
      snapshotFormat: snapshot.format, snapshotHash: snapshot.hash, replayWindowSeconds: profile.replayWindowSeconds })
    await lease.db.insert(outboxInsert).values({ id: outboxId, deliveryId: id })
    return { id, outboxId }
  } finally { token.fill(0) }
}

// Restart/post-commit repair reads the immutable obligation by id.
export const reconcileAuthorizedObligation = materializeDelivery

// Bounded storage operation for the later worker lifecycle; no timer/worker shell.
export async function purgeExpiredEmailDeliveries(lease: AuthEmailLease): Promise<number> {
  const expired = await lease.db.select({ id: authEmailCommand.id }).from(authEmailCommand)
    .innerJoin(emailDelivery, eq(emailDelivery.commandId, authEmailCommand.id))
    .where(and(lte(authEmailCommand.expiresAt, sql`clock_timestamp()`), or(isNotNull(emailDelivery.ciphertext), isNotNull(emailDelivery.verifierHash))))
    .orderBy(authEmailCommand.expiresAt).limit(100)
  for (const command of expired) await admitCommand(lease, command.id)
  return expired.length
}

// Worker-side storage primitive only. Task7 must add claim/fence and provider
// admission through dedicated SQL functions; no web route calls this function.
export async function readAuthorizedEmailPayload(lease: AuthEmailLease, outboxId: string, envelope: AuthEmailEnvelope): Promise<Buffer | null> {
  const [identity] = await lease.db.select({ commandId: emailDelivery.commandId }).from(authEmailOutbox)
    .innerJoin(emailDelivery, eq(emailDelivery.id, authEmailOutbox.deliveryId)).where(eq(authEmailOutbox.id, outboxId))
  if (!identity) return null
  const admission = await admitCommand(lease, identity.commandId)
  if (!admission) return null
  const { command, delivery, now } = admission
  if (!delivery || delivery.state !== 'active' || !delivery.ciphertext || !delivery.tag || !delivery.nonce) return null
  return envelope.open({ keyId: delivery.keyId, ciphertext: delivery.ciphertext, nonce: delivery.nonce, tag: delivery.tag },
    { deliveryId: delivery.id, purpose: command.purpose, generation: command.generation, expiresAt: command.expiresAt }, now)
}

export async function retireEmailRequest(lease: AuthEmailLease, requestId: string, expectedGeneration: number, state: 'consumed' | 'terminal'): Promise<boolean> {
  const changed = await lease.db.update(authEmailRequest).set({ state }).where(and(eq(authEmailRequest.id, requestId), eq(authEmailRequest.generation, expectedGeneration), eq(authEmailRequest.state, 'active'))).returning()
  if (!changed.length) return false
  const commands = await lease.db.select({ id: authEmailCommand.id }).from(authEmailCommand).where(and(eq(authEmailCommand.requestId, requestId), eq(authEmailCommand.generation, expectedGeneration)))
  if (commands.length) await lease.db.update(emailDelivery).set({ ...cleared, state }).where(and(inArray(emailDelivery.commandId, commands.map(command => command.id)), eq(emailDelivery.state, 'active')))
  return true
}
