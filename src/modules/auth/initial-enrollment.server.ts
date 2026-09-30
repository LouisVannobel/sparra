import { createHash, timingSafeEqual } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { Schema } from 'effect'
import type { AuthContext } from 'better-auth'
import type { passkey } from '@better-auth/passkey'
import type { AuthEmailLease } from './auth-email-store.server'
import { authEmailCommand, authEmailRequest, emailDelivery, user } from './schema.server'
import { magicDatabaseTime, MagicProofRejected, validateMagicConsume, type MagicConsumeInput, type MagicProof } from './magic.server'

const inputSchema = Schema.Struct({ token: Schema.String, intendedEmail: Schema.String, response: Schema.Unknown })
export function validateMagicEnrollment(input: unknown) {
  try {
    const value = Schema.decodeUnknownSync(inputSchema)(input, { onExcessProperty: 'error' })
    return { ...validateMagicConsume({ token: value.token, intendedEmail: value.intendedEmail }), response: value.response }
  } catch { throw new MagicProofRejected() }
}
export type MagicEnrollmentInput = ReturnType<typeof validateMagicEnrollment>
type NativeRegistration = NonNullable<NonNullable<Parameters<typeof passkey>[0]>['registration']>
export type VerifiedInitialRegistration = Parameters<NonNullable<NativeRegistration['afterVerification']>>[0]

// Candidate lookup confers no authority. In particular, a null User binding is
// never replaced by an email lookup of a subsequently created account.
export async function findMagicCommand(lease: AuthEmailLease, input: MagicConsumeInput) {
  const bytes = Buffer.from(input.token, 'base64url')
  const hash = createHash('sha256').update(bytes).digest('hex'); bytes.fill(0)
  const [candidate] = await lease.db.select({ command: authEmailCommand }).from(emailDelivery)
    .innerJoin(authEmailCommand, eq(authEmailCommand.id, emailDelivery.commandId)).where(eq(emailDelivery.verifierHash, hash))
  if (!candidate) throw new MagicProofRejected()
  return candidate.command
}
export function initialContext(command: typeof authEmailCommand.$inferSelect) {
  return JSON.stringify({ commandId: command.id, generation: command.generation })
}
export async function proveInitialMagic(lease: AuthEmailLease, input: MagicConsumeInput, createdUserId?: string) {
  const command = await findMagicCommand(lease, input)
  if (command.userId !== null || command.recoveryGeneration !== null || command.recipient !== input.intendedEmail || command.purpose !== 'magic-link') throw new MagicProofRejected()
  const [claimed] = await lease.db.select().from(user).where(eq(user.email, command.recipient))
  if (createdUserId === undefined ? !!claimed : !claimed || claimed.id !== createdUserId || claimed.recovering || claimed.recoveryGeneration !== 0) throw new MagicProofRejected()
  // Final User INSERT resolves competing creators before Request/Delivery locks.
  const requestQuery = lease.db.select().from(authEmailRequest).where(eq(authEmailRequest.id, command.requestId))
  const [current] = createdUserId === undefined ? await requestQuery : await requestQuery.for('update')
  const deliveryQuery = lease.db.select().from(emailDelivery).where(eq(emailDelivery.commandId, command.id))
  const [delivery] = createdUserId === undefined ? await deliveryQuery : await deliveryQuery.for('update')
  const now = await magicDatabaseTime(lease)
  const bytes = Buffer.from(input.token, 'base64url'), digest = createHash('sha256').update(bytes).digest(); bytes.fill(0)
  try {
    if (!current || current.state !== 'active' || current.userId !== null || current.generation !== command.generation
      || current.email !== command.recipient || current.purpose !== command.purpose || !delivery || delivery.state !== 'active'
      || !delivery.verifierHash || !/^[0-9a-f]{64}$/.test(delivery.verifierHash)
      || !timingSafeEqual(digest, Buffer.from(delivery.verifierHash, 'hex')) || command.expiresAt.getTime() <= now.getTime()) throw new MagicProofRejected()
    return { command, now }
  } finally { digest.fill(0) }
}

export type InitialEnrollmentInvocation = Readonly<{
  assert(operation: 'options' | 'complete', request?: Request): void
  resolve(context: string | null | undefined): { id: string; name: string; displayName: string }
  verified(args: VerifiedInitialRegistration): Promise<{ userId: string }>
  prepareChallenge(data: Parameters<AuthContext['internalAdapter']['createVerificationValue']>[0]): Parameters<AuthContext['internalAdapter']['createVerificationValue']>[0]
  consumedChallenge(expiresAt: Date): void
  take(userId: string): Promise<MagicProof>
}>
