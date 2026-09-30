import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { Schema } from 'effect'
import type { AuthTransactions } from '../../platform/db/transactions.server'
import type { PlunkResult } from './plunk.server'

const uuid = Schema.String.check(Schema.isUUID())
export const mailJob = Schema.Struct({ outboxId: uuid })
const claimSchema = Schema.Struct({ outboxId: uuid, deliveryId: uuid, fence: Schema.Int, format: Schema.Literal('auth-plunk-v1'), hash: Schema.String,
  keyId: Schema.String, ciphertext: Schema.String, nonce: Schema.String, tag: Schema.String, purpose: Schema.Literal('magic-link'), generation: Schema.Int,
  expiresAt: Schema.String, databaseTime: Schema.String, leaseUntil: Schema.String,
  replayNotAfter: Schema.NullOr(Schema.String), replayWindowSeconds: Schema.NullOr(Schema.Int) })
export type MailClaim = typeof claimSchema.Type
export function createMailStore(owner: AuthTransactions) {
  const options = (signal?: AbortSignal) => ({ deadlineAtMs: Date.now() + 5000, statementTimeoutMs: 1000, cleanupTimeoutMs: 1000, correlationId: randomUUID(), signal })
  async function claimAdmission(signal?: AbortSignal) {
    const value = await owner.withAuthPromise(options(signal), async ({ db }) => (await db.select({ value: sql`public.auth_mail_claim_admission()` }).from(sql`(select 1) AS mail_call`))[0]?.value)
    if (value === null) return null
    try { return Schema.decodeUnknownSync(Schema.Struct({ outboxId: uuid, fence: Schema.Int }))(value) }
    catch { throw new Error('Auth mail admission unavailable') }
  }
  async function finalizeAdmission(outboxId: string, fence: number, runId: string | null) {
    return owner.withAuthPromise(options(), async ({ db }) => (await db.select({ value: sql<boolean>`public.auth_mail_finalize_admission(${outboxId}::uuid,${fence},${runId}::uuid)` }).from(sql`(select 1) AS mail_call`))[0]?.value === true)
  }
  async function claimDelivery(outboxId: string, signal?: AbortSignal) {
    const value = await owner.withAuthPromise(options(signal), async ({ db }) => (await db.select({ value: sql`public.auth_mail_claim_delivery(${outboxId}::uuid)` }).from(sql`(select 1) AS mail_call`))[0]?.value)
    if (value === null) return null
    try { return Schema.decodeUnknownSync(claimSchema)(value) }
    catch { throw new Error('Auth mail attempt unavailable') }
  }
  async function finalizeDelivery(outboxId: string, fence: number, result: PlunkResult) {
    const evidence = result.state === 'plunk_queued' ? result.evidence : null
    const emailId = result.state === 'plunk_queued' ? result.emailId : null
    return owner.withAuthPromise(options(), async ({ db }) => (await db.select({ value: sql<boolean>`public.auth_mail_finalize_delivery(${outboxId}::uuid,${fence},${result.state},${evidence},${emailId}::uuid)` }).from(sql`(select 1) AS mail_call`))[0]?.value === true)
  }
  async function purge() {
    return owner.withAuthPromise(options(), async ({ db }) => (await db.select({ value: sql<number>`public.auth_mail_purge()` }).from(sql`(select 1) AS mail_call`))[0]?.value ?? 0)
  }
  return { claimAdmission, finalizeAdmission, claimDelivery, finalizeDelivery, purge }
}
export type MailStore = ReturnType<typeof createMailStore>
