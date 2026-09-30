import { and, eq, sql } from 'drizzle-orm'
import type { AuthTransactions } from '../../platform/db/transactions.server'
import { session, user } from './schema.server'

export type AdmittedPrincipal = Readonly<{ userId: string; sessionId: string; name: string; email: string }>

// The caller supplies only ids from Better Auth's validated getSession result.
// Never decode the browser's opaque cookie here or restore filtered BA fields.
export async function readPrivatePrincipal(owner: AuthTransactions, validated: { session: { id: string }; user: { id: string } }) {
  return owner.withAuthPromise(owner.invocationOptions(), async ({ db }) => {
    const [current] = await db.select({ id: user.id, name: user.name, email: user.email, recovering: user.recovering, generation: user.recoveryGeneration })
      .from(user).where(eq(user.id, validated.user.id)).for('update')
    if (!current || current.recovering) return null
    const [active] = await db.select({ id: session.id }).from(session).where(and(
      eq(session.id, validated.session.id), eq(session.userId, validated.user.id),
      eq(session.authState, 'ACTIVE'), eq(session.recoveryGeneration, current.generation),
    )).for('update')
    if (!active) return null
    const [touched] = await db.update(session).set({ lastActivityAt: sql`clock_timestamp()` }).where(and(
      eq(session.id, active.id), eq(session.userId, current.id),
      sql`${session.expiresAt} > clock_timestamp()`,
      sql`${session.lastActivityAt} > clock_timestamp() - interval '43200 seconds'`,
      sql`${session.authenticatedAt} + interval '604800 seconds' > clock_timestamp()`,
    )).returning({ id: session.id })
    return touched ? Object.freeze({ userId: current.id, sessionId: active.id, name: current.name, email: current.email }) : null
  })
}
