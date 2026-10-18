import { Effect, Redacted } from 'effect'
import { Pool, type PoolClient } from 'pg'
import { sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { readDatabaseConfig } from './config.server'
import { createTransactions } from './transactions.server'

type DatabaseLogin = 'auth_mail_relay' | 'auth_mail_worker' | 'billing_relay' | 'billing_worker'
type DatabaseReadiness = {
  version: string; login?: string; currentUser?: string; canImpersonate?: boolean
  superuser: string; bypassrls: string; databaseOwner: string; tableOwner: string
  fsync: string; fullPageWrites: string; synchronousCommit: string; schemaReady: string
  billingReady?: string; workspaceReady?: string
}

function validateDatabaseIdentity(observed: DatabaseReadiness, expectedLogin: DatabaseLogin | undefined) {
  if (expectedLogin && (observed.login !== expectedLogin || observed.currentUser !== expectedLogin || observed.canImpersonate)
    || observed.version !== '160015' || observed.superuser !== 'false' || observed.bypassrls !== 'false'
    || observed.databaseOwner !== 'false' || observed.tableOwner !== 'false') throw new Error('Database contract mismatch')
}

function validateDatabaseReadiness(observed: DatabaseReadiness | undefined, expectedLogin: DatabaseLogin | undefined, billingLogin: boolean) {
  if (!observed) throw new Error('Database contract mismatch')
  validateDatabaseIdentity(observed, expectedLogin)
  if (observed.fsync !== 'on' || observed.fullPageWrites !== 'on' || observed.synchronousCommit !== 'on'
    || observed.schemaReady !== 'true' || billingLogin && observed.billingReady !== 'true'
    || !expectedLogin && observed.workspaceReady !== 'true') throw new Error('Database contract mismatch')
}

export const acquireDatabase = Effect.fn('acquireDatabase')(function* (database: ReturnType<typeof readDatabaseConfig>, expectedLogin?: DatabaseLogin) {
  let stopping = false, databaseFault = false
  const billingLogin = expectedLogin === 'billing_relay' || expectedLogin === 'billing_worker'
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
            canImpersonate: sql<boolean>`exists(select 1 from pg_roles where rolname in ('auth_mail_owner','auth_mail_definer','billing_owner','billing_definer','billing_relay','billing_worker') and rolname<>session_user and pg_has_role(session_user,oid,'MEMBER'))`,
          } : {}),
          superuser: sql<string>`rolsuper::text`,
          bypassrls: sql<string>`rolbypassrls::text`,
          databaseOwner: sql<string>`(select datdba = (select oid from pg_roles where rolname = current_user) from pg_database where datname = current_database())::text`,
          tableOwner: sql<string>`exists(select 1 from pg_class c join pg_namespace n on c.relnamespace = n.oid where n.nspname = 'public' and c.relowner = (select oid from pg_roles where rolname = current_user))::text`,
          fsync: sql<string>`current_setting('fsync')`,
          fullPageWrites: sql<string>`current_setting('full_page_writes')`,
          synchronousCommit: sql<string>`current_setting('synchronous_commit')`,
          schemaReady: billingLogin ? sql<string>`coalesce((
            (select count(*)=11 from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_roles r on r.oid=c.relowner
             where n.nspname='public' and c.relname in ('billing_agreed_terms','billing_customer','billing_operation','billing_agreement','billing_charge_binding',
               'billing_command','billing_current_agreement','billing_event_receipt','billing_outbox','billing_receipt_assignment','billing_risk_observation')
             and c.relrowsecurity and c.relforcerowsecurity
             and r.rolname=case when c.relname in ('billing_agreed_terms','billing_customer','billing_operation') then 'workspace_owner' else 'billing_owner' end)
            and (select count(*)=4 from pg_attribute where attrelid=to_regclass('public.billing_command')
              and attname in ('manifest_revision','target_progress','identities','completed_at') and not attisdropped)
            and exists(select 1 from pg_attribute where attrelid=to_regclass('public.billing_outbox') and attname='terminal_disposition' and not attisdropped)
            and exists(select 1 from pg_attribute where attrelid=to_regclass('public.billing_operation') and attname='checkout_reference_version' and not attisdropped)
            and exists(select 1 from pg_attribute where attrelid=to_regclass('public.billing_operation') and attname='agreed_terms_id' and not attisdropped)
          ),false)::text` : sql<string>`(to_regclass('public.user') is not null and to_regclass('public.account') is not null and to_regclass('public.session') is not null and to_regclass('public.verification') is not null)::text`,
          ...(billingLogin ? { billingReady: sql<string>`coalesce((
            not rolcreaterole and not rolcreatedb and not rolreplication and not rolinherit
            and (select count(*)=4 from pg_roles where rolname in ('billing_owner','billing_definer','billing_relay','billing_worker')
              and rolcanlogin=(rolname in ('billing_relay','billing_worker')) and not rolsuper and not rolbypassrls
              and not rolcreaterole and not rolcreatedb and not rolreplication and not rolinherit)
            and not exists(select 1 from pg_auth_members m join pg_roles r on r.oid=m.member or r.oid=m.roleid
              where r.rolname in ('billing_owner','billing_definer','billing_relay','billing_worker'))
            and has_schema_privilege(current_user,'app_private','USAGE')
            and not has_schema_privilege(current_user,'app_private','CREATE')
            and not has_schema_privilege(current_user,'public','CREATE')
            and not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
              where n.nspname='public' and c.relkind in ('r','p','v','m','f')
              and has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
            and (select bool_and(coalesce(p.oid is not null and p.prosecdef and p.provolatile='v' and r.rolname='billing_definer'
                and p.proconfig @> array['search_path=pg_catalog, pg_temp']
                and has_function_privilege(current_user,p.oid,'EXECUTE')=(current_user=required.login)
                and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0),false))
              from (values
                ('app_private.billing_receive_event(jsonb)','runtime'),
                ('app_private.billing_claim_admission()','billing_relay'),
                ('app_private.billing_finalize_admission(uuid,uuid,bigint,jsonb)','billing_relay'),
                ('app_private.billing_claim_command(uuid,uuid)','billing_worker'),
                ('app_private.billing_observe_command(uuid,uuid,bigint,jsonb,jsonb)','billing_worker'),
                ('app_private.billing_apply_command(uuid,uuid,bigint,jsonb,jsonb)','billing_worker'),
                ('app_private.billing_record_risk(uuid,uuid,bigint,jsonb)','billing_worker')
              ) required(signature,login)
              left join pg_proc p on p.oid=to_regprocedure(required.signature) left join pg_roles r on r.oid=p.proowner)
            and not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='app_private' and p.proname like 'billing_%' and has_function_privilege(current_user,p.oid,'EXECUTE')
              and p.oid<>all(case when current_user='billing_relay' then array[
                to_regprocedure('app_private.billing_claim_admission()'),to_regprocedure('app_private.billing_finalize_admission(uuid,uuid,bigint,jsonb)')]
              else array[to_regprocedure('app_private.billing_claim_command(uuid,uuid)'),to_regprocedure('app_private.billing_observe_command(uuid,uuid,bigint,jsonb,jsonb)'),
                to_regprocedure('app_private.billing_apply_command(uuid,uuid,bigint,jsonb,jsonb)'),to_regprocedure('app_private.billing_record_risk(uuid,uuid,bigint,jsonb)')] end))
          ),false)::text` } : {}),
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
        validateDatabaseReadiness(observed, expectedLogin, billingLogin)
      }),
      catch: () => new Error('Application stores unavailable'),
    })

  return { transactions, isReady: () => !stopping && !databaseFault, stop: () => { stopping = true } }
})
