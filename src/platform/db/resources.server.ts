import { Effect, Redacted } from 'effect'
import { Pool, type PoolClient } from 'pg'
import { sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { readDatabaseConfig } from './config.server'
import { createTransactions } from './transactions.server'

export const acquireDatabase = Effect.fn('acquireDatabase')(function* (database: ReturnType<typeof readDatabaseConfig>, expectedLogin?: 'auth_mail_relay' | 'auth_mail_worker') {
  let stopping = false, databaseFault = false
  const clients = new Set<PoolClient>()
    const pool = yield* Effect.acquireRelease(Effect.sync(() => {
      const pool = new Pool({
        connectionString: Redacted.value(database.url), max: database.max,
        // pg emits pool connect only after handshake. Its native connect timer
        // must also fit cleanup, including sockets not yet visible to the pool
        // connect listener. No client subclass or second transport owner.
        connectionTimeoutMillis: Math.min(database.connectTimeoutMs, database.cleanupTimeoutMs),
        idleTimeoutMillis: 10000,
      })
      pool.on('connect', client => {
        clients.add(client)
        client.once('end', () => clients.delete(client))
      })
      pool.on('error', () => { databaseFault = true })
      return pool
    }), pool => Effect.promise(async () => {
      stopping = true
      const ended = pool.end()
      // Only the physical lease releases checkouts. On a stuck socket, destroy
      // its transport; the existing lease invalidates and evicts it itself.
      const timer = setTimeout(() => {
        for (const client of clients) client.connection.stream.destroy()
      }, database.cleanupTimeoutMs)
      try { await ended } finally { clearTimeout(timer) }
    }))
    const transactions = createTransactions({
      async connect() {
        if (stopping || databaseFault) throw new Error('Database unavailable')
        return pool.connect()
      },
    }, { maxStatementTimeoutMs: database.statementTimeoutMs, maxCleanupTimeoutMs: database.cleanupTimeoutMs })
    yield* Effect.tryPromise({
      try: () => transactions.withAuthPromise({
        deadlineAtMs: Date.now() + database.connectTimeoutMs + database.statementTimeoutMs,
        statementTimeoutMs: database.statementTimeoutMs, cleanupTimeoutMs: database.cleanupTimeoutMs,
        correlationId: randomUUID(),
      }, async ({ db }) => {
        const [observed] = await db.select({
          version: sql<string>`current_setting('server_version_num')`,
          ...(expectedLogin ? {
            login: sql<string>`session_user`,
            currentUser: sql<string>`current_user`,
            canImpersonate: sql<boolean>`exists(select 1 from pg_roles where rolname in ('auth_mail_owner','auth_mail_definer') and pg_has_role(session_user,oid,'MEMBER'))`,
          } : {}),
          superuser: sql<string>`rolsuper::text`,
          bypassrls: sql<string>`rolbypassrls::text`,
          databaseOwner: sql<string>`(select datdba = (select oid from pg_roles where rolname = current_user) from pg_database where datname = current_database())::text`,
          tableOwner: sql<string>`exists(select 1 from pg_class c join pg_namespace n on c.relnamespace = n.oid where n.nspname = 'public' and c.relowner = (select oid from pg_roles where rolname = current_user))::text`,
          fsync: sql<string>`current_setting('fsync')`,
          fullPageWrites: sql<string>`current_setting('full_page_writes')`,
          synchronousCommit: sql<string>`current_setting('synchronous_commit')`,
          schemaReady: sql<string>`(to_regclass('public.user') is not null and to_regclass('public.account') is not null and to_regclass('public.session') is not null and to_regclass('public.verification') is not null)::text`,
          ...(!expectedLogin ? { workspaceReady: sql<string>`coalesce((
            session_user = 'runtime' and current_user = 'runtime' and not rolcreaterole and not rolcreatedb and not rolreplication and not rolinherit
            and (select count(*) = 2 from pg_roles where rolname in ('workspace_owner','workspace_bootstrap') and not rolcanlogin and not rolsuper and not rolbypassrls and not rolcreaterole and not rolcreatedb and not rolreplication and not rolinherit)
            and not exists(select 1 from pg_auth_members m join pg_roles r on r.oid=m.member or r.oid=m.roleid where r.rolname in ('workspace_owner','workspace_bootstrap','runtime'))
            and (select count(*) = 2 from pg_class c join pg_roles r on r.oid=c.relowner where c.oid in (to_regclass('public.workspace'),to_regclass('public.workspace_audit')) and c.relrowsecurity and c.relforcerowsecurity and r.rolname='workspace_owner')
            and exists(select 1 from pg_proc p join pg_roles r on r.oid=p.proowner where p.oid=to_regprocedure('app_private.resolve_personal_workspace(text,text,boolean)') and r.rolname='workspace_bootstrap' and p.prosecdef and p.provolatile='v' and p.proconfig @> array['search_path=pg_catalog, pg_temp'])
            and has_function_privilege(current_user,to_regprocedure('app_private.resolve_personal_workspace(text,text,boolean)'),'EXECUTE')
            and not exists(select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=to_regprocedure('app_private.resolve_personal_workspace(text,text,boolean)') and a.grantee=0)
            and not has_schema_privilege(current_user,'app_private','CREATE')
            and not has_table_privilege(current_user,'public.workspace','INSERT,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            and not has_table_privilege(current_user,'public.workspace_audit','SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          ),false)::text` } : {}),
        }).from(sql`pg_roles`).where(sql`rolname = current_user`)
        if (!observed || expectedLogin && (observed.login !== expectedLogin || observed.currentUser !== expectedLogin || observed.canImpersonate) || observed.version !== '160015' || observed.superuser !== 'false' || observed.bypassrls !== 'false'
          || observed.databaseOwner !== 'false' || observed.tableOwner !== 'false' || observed.fsync !== 'on'
          || observed.fullPageWrites !== 'on' || observed.synchronousCommit !== 'on' || observed.schemaReady !== 'true' || !expectedLogin && observed.workspaceReady !== 'true') throw new Error('Database contract mismatch')
      }),
      catch: () => new Error('Application stores unavailable'),
    })

  return { transactions, isReady: () => !stopping && !databaseFault, stop: () => { stopping = true } }
})
