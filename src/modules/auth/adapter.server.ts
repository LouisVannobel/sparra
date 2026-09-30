import type { BetterAuthOptions, DBAdapter, DBTransactionAdapter } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import type { AuthQueryDb } from '../../platform/db/auth-pg-lease.server'
import type { AuthTransactions } from '../../platform/db/transactions.server'
import { authSchema } from './schema.server'
import { currentSignupEmailPolicy, persistRequiredSignupEmail } from './signup-obligation.server'
import { normalizeAuthEmail } from './auth-email-normalization.server'

type AuthDb = AuthQueryDb & { transaction<A>(call: (db: AuthDb) => Promise<A>): Promise<A> }

export function createAuthAdapter(owner: AuthTransactions, options: BetterAuthOptions): DBAdapter {
  const db: AuthDb = Object.freeze({
    get select() { return owner.currentDb().select },
    get insert() { return owner.currentDb().insert },
    get update() { return owner.currentDb().update },
    get delete() { return owner.currentDb().delete },
    transaction: <A>(call: (db: AuthDb) => Promise<A>) => owner.withAuthPromise(owner.invocationOptions(), () => call(db)),
  })
  const base = drizzleAdapter(db, { provider: 'pg', schema: authSchema, transaction: true })(options)
  function decorateTransaction(child: DBTransactionAdapter): DBTransactionAdapter {
    const enter = <A>(call: () => Promise<A>) => Promise.resolve().then(() => owner.withAuthPromise(owner.invocationOptions(), call))
    const create: DBAdapter['create'] = <T extends Record<string, unknown>, R = T>(args: Parameters<typeof child.create<T, R>>[0]) => Promise.resolve().then(() => owner.withAuthPromise(owner.invocationOptions(), async lease => {
      const data = args.model === 'user' ? { ...args.data, email: normalizeAuthEmail(args.data.email) } : args.data
      const created = await child.create<T, R>({ ...args, data })
      const policy = currentSignupEmailPolicy()
      if (args.model === 'user' && policy) await persistRequiredSignupEmail(lease, policy, created)
      return created
    }))
    const findOne: DBAdapter['findOne'] = args => enter(() => child.findOne(args))
    const findMany: DBAdapter['findMany'] = args => enter(() => child.findMany(args))
    const count: DBAdapter['count'] = args => enter(() => child.count(args))
    const update: DBAdapter['update'] = args => enter(() => child.update(args.model === 'user' && Object.hasOwn(args.update, 'email')
      ? { ...args, update: { ...args.update, email: normalizeAuthEmail(args.update.email) } } : args))
    const updateMany: DBAdapter['updateMany'] = args => enter(() => child.updateMany(args.model === 'user' && Object.hasOwn(args.update, 'email')
      ? { ...args, update: { ...args.update, email: normalizeAuthEmail(args.update.email) } } : args))
    const deleteOne: DBAdapter['delete'] = args => enter(() => child.delete(args))
    const deleteMany: DBAdapter['deleteMany'] = args => enter(() => child.deleteMany(args))
    const consumeOne: DBAdapter['consumeOne'] = args => enter(() => child.consumeOne(args))
    const incrementOne: DBAdapter['incrementOne'] = args => enter(() => child.incrementOne(args))
    return Object.freeze({ ...child, create, findOne, findMany, count, update, updateMany, delete: deleteOne, deleteMany, consumeOne, incrementOne })
  }
  const transaction: DBAdapter['transaction'] = callback => Promise.resolve().then(() =>
    owner.withAuthPromise(owner.invocationOptions(), () => base.transaction(child => callback(decorateTransaction(child)))))
  return Object.freeze({ ...decorateTransaction(base), transaction })
}
