import { AsyncLocalStorage } from 'node:async_hooks'
import { Schema } from 'effect'
import { and, eq } from 'drizzle-orm'
import { authEmailLocale, authEmailPurpose, authorizeEmailRequest, normalizeAuthEmail, type AuthEmailLease } from './auth-email-store.server'
import { authEmailRequest, user } from './schema.server'

const policySchema = Schema.Struct({ purpose: authEmailPurpose, locale: authEmailLocale })
type SignupEmailPolicy = Readonly<typeof policySchema.Type>
const policies = new AsyncLocalStorage<{ readonly policy: SignupEmailPolicy; active: boolean }>()
const rejected = () => new Error('Signup email policy rejected')

// A selected server signup operation must enter here with its explicit policy.
// Ordinary creates do not infer mail authority from User/emailVerified.
export async function withRequiredSignupEmail<A>(input: unknown, call: () => Promise<A>): Promise<A> {
  let policy: SignupEmailPolicy
  try { policy = Object.freeze(Schema.decodeUnknownSync(policySchema)(input)) }
  catch { throw rejected() }
  if (policies.getStore()) throw rejected()
  const operation = { policy, active: true }
  try { return await policies.run(operation, call) }
  finally { operation.active = false }
}
export function currentSignupEmailPolicy(): SignupEmailPolicy | undefined {
  const operation = policies.getStore()
  if (operation && !operation.active) throw rejected()
  return operation?.policy
}

const createdUser = Schema.Struct({ id: Schema.NonEmptyString, email: Schema.NonEmptyString })
export async function persistRequiredSignupEmail(lease: AuthEmailLease, policy: SignupEmailPolicy, created: unknown): Promise<void> {
  let identity: typeof createdUser.Type
  try { identity = Schema.decodeUnknownSync(createdUser)(created) }
  catch { throw rejected() }
  const recipient = normalizeAuthEmail(identity.email)
  const [record] = await lease.db.select().from(user).where(eq(user.id, identity.id)).for('update')
  if (!record || normalizeAuthEmail(record.email) !== recipient) throw rejected()
  const [request] = await lease.db.select().from(authEmailRequest).where(and(eq(authEmailRequest.email, recipient), eq(authEmailRequest.purpose, policy.purpose))).for('update')
  await authorizeEmailRequest(lease, {
    email: recipient, purpose: policy.purpose, locale: policy.locale, expectedGeneration: request?.generation ?? 0,
    lifetimeSeconds: 600, userId: record.id, recoveryGeneration: record.recoveryGeneration,
  })
}
