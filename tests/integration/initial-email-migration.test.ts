import { afterAll, beforeAll, expect, test } from 'vitest'
import { cp, mkdir, readFile, writeFile, symlink, unlink, lstat } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Client } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { startDisposableStores } from '../fixtures/db/disposable-stores'

let stores: Awaited<ReturnType<typeof startDisposableStores>>
let prefix: string, fixtureRoot: string, fixtureUrl: URL
const clients: Client[] = []
const links: string[] = []
const exec = promisify(execFile)
beforeAll(async () => {
  stores = await startDisposableStores()
  clients.push(stores.administrator)
  if (typeof stores.evidence.directory !== 'string') throw new Error('Owned fixture directory missing')
  fixtureRoot = stores.evidence.directory
  prefix = join(fixtureRoot, 'initial-email-prefix')
  await mkdir(join(prefix, 'meta'), { recursive: true })
  const journal = JSON.parse(await readFile(resolve('drizzle/meta/_journal.json'), 'utf8'))
  journal.entries = journal.entries.slice(0, 7)
  const tags = ['0000_auth_storage', '0001_cheerful_sharon_carter', '0002_worthless_newton_destine',
    '0003_auth_mail_polling_candidates', '0004_wealthy_impossible_man', '0005_account_provider_key', '0006_magic_verifier']
  if (JSON.stringify(journal.entries.map((entry: { tag: string }) => entry.tag)) !== JSON.stringify(tags)) throw new Error('Unexpected immutable migration prefix')
  for (const tag of tags) await cp(resolve('drizzle', tag + '.sql'), join(prefix, tag + '.sql'))
  await writeFile(join(prefix, 'meta/_journal.json'), JSON.stringify(journal))
  await migrate(drizzle(stores.administrator, { logger: false }), { migrationsFolder: prefix })
})
afterAll(async () => {
  if (!stores) return
  const failures: string[] = []
  for (const client of clients) {
    const timer = setTimeout(() => { failures.push('client-deadline'); client.connection.stream.destroy() }, 1000)
    try { await client.end() } catch { failures.push('client'); client.connection.stream.destroy() }
    finally { clearTimeout(timer) }
  }
  // Remove the test-only dependency junction itself before recursive fixture
  // cleanup; its external target is never part of the deletion boundary.
  const retainedLinks: string[] = []
  for (const link of links) {
    try { await unlink(link) } catch {}
    let absent = false
    try { await lstat(link) } catch (error) { absent = error instanceof Error && 'code' in error && error.code === 'ENOENT' }
    if (!absent) retainedLinks.push(link)
  }
  try {
    if (retainedLinks.length) {
      stores.evidence.cleanupDeferred = { reason: 'dependency-junction-removal-not-confirmed', links: retainedLinks,
        directory: fixtureRoot, containers: stores.evidence.containers, network: stores.evidence.network }
      throw new Error('Owned migration cleanup deferred: dependency junction still present; ROOT recovery required')
    }
    await stores.cleanup(); if (failures.length) throw new Error('Owned migration cleanup failed')
  }
  finally { const directory = resolve('.superpowers/sdd/2026-09-10-functional-auth/task-8b-evidence'); await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, `migration-${stores.evidence.runId}.json`), JSON.stringify(stores.evidence, null, 2) + '\n') }
})
async function isolatedDatabase() {
  if (!fixtureUrl) {
    const role = 'migration_fixture_' + randomUUID().replaceAll('-', ''), password = randomBytes(32).toString('hex')
    await stores.administrator.query(`CREATE ROLE ${role} LOGIN SUPERUSER PASSWORD '${password}'`)
    fixtureUrl = new URL(stores.directRuntimeUrl); fixtureUrl.username = role; fixtureUrl.password = password
  }
  const name = 'migration_' + randomUUID().replaceAll('-', '')
  await stores.administrator.query(`CREATE DATABASE ${name}`)
  const url = new URL(fixtureUrl); url.pathname = '/' + name
  const client = new Client({ connectionString: url.href, statement_timeout: 3000, connectionTimeoutMillis: 1000 })
  client.on('error', () => {}); clients.push(client); await client.connect()
  return { client, url, name }
}
async function cli(url: URL, script = resolve('scripts/migrate.ts')) {
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
    MIGRATION_DATABASE_URL: url.href }
  try { const result = await exec(process.execPath, [script], { env, windowsHide: true, timeout: 15000 }); return { code: 0, ...result } }
  catch (error) {
    if (error instanceof Error && 'stdout' in error && typeof error.stdout === 'string' && 'stderr' in error && typeof error.stderr === 'string') {
      return { code: 1, stdout: error.stdout, stderr: error.stderr }
    }
    throw new Error('Owned migration process failure')
  }
}
async function copiedHistory(extraSql: string) {
  const root = join(fixtureRoot, 'cli-' + randomUUID())
  for (const file of ['scripts/migrate.ts', 'src/platform/db/config.server.ts', 'src/platform/config.server.ts', 'src/modules/auth/auth-email-normalization.server.ts']) {
    const target = join(root, file); await mkdir(resolve(target, '..'), { recursive: true }); await cp(resolve(file), target)
  }
  await cp(resolve('drizzle'), join(root, 'drizzle'), { recursive: true })
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  const link = join(root, 'node_modules'); await symlink(resolve('node_modules'), link, 'junction'); links.push(link)
  const journal = JSON.parse(await readFile(join(root, 'drizzle/meta/_journal.json'), 'utf8'))
  journal.entries.push({ idx: journal.entries.length, version: '7', when: journal.entries.at(-1).when + 1, tag: '9999_owned_fixture', breakpoints: true })
  await writeFile(join(root, 'drizzle/meta/_journal.json'), JSON.stringify(journal))
  await writeFile(join(root, 'drizzle/9999_owned_fixture.sql'), extraSql)
  return join(root, 'scripts/migrate.ts')
}
async function cleanFailure(result: Awaited<ReturnType<typeof cli>>, database: string) {
  expect(result.code !== 0 && result.stdout === '' && /^Database migration failed(?:; commit was not acknowledged)?\n$/.test(result.stderr)).toBe(true)
  expect((await stores.administrator.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND xact_start IS NOT NULL', [database])).rows[0].n).toBe(0)
}
async function structure(client: Client) {
  const result = {
    columns: (await client.query(`SELECT table_schema,table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns
      WHERE table_schema IN('public','app_private','drizzle') ORDER BY table_schema,table_name,ordinal_position`)).rows,
    constraints: (await client.query(`SELECT n.nspname,c.relname,k.conname,pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k
      JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('public','app_private','drizzle') ORDER BY 1,2,3`)).rows,
    indexes: (await client.query(`SELECT schemaname,tablename,indexname,indexdef FROM pg_indexes WHERE schemaname IN('public','app_private','drizzle') ORDER BY 1,2,3`)).rows,
    policies: (await client.query(`SELECT * FROM pg_policies WHERE schemaname IN('public','app_private','drizzle') ORDER BY schemaname,tablename,policyname`)).rows,
    triggers: (await client.query(`SELECT n.nspname,c.relname,t.tgname,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname IN('public','app_private','drizzle') ORDER BY 1,2,3`)).rows,
    journal: (await client.query('SELECT id,hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id')).rows,
  }
  return JSON.stringify(result)
}
async function snapshot() {
  return JSON.stringify({ users: (await stores.administrator.query('SELECT to_jsonb(u) AS row FROM "user" u ORDER BY id')).rows,
    journal: (await stores.administrator.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')).rows,
    sequence: (await stores.administrator.query('SELECT last_value,is_called FROM drizzle.__drizzle_migrations_id_seq')).rows,
    passkey: (await stores.administrator.query("SELECT to_regclass('public.passkey') IS NOT NULL AS present")).rows })
}
test.each(['Alice@example.test', '\uFEFFalice@example.test', 'invalid-lowercase', 'a'.repeat(250) + '@example.test', 'a b@example.test'])('exact preflight refuses incompatible historical mailbox (%#) without repair or journal mutation', async email => {
  const id = randomUUID()
  await stores.administrator.query('INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$2,$3,true)', [id, 'Historical fixture', email])
  try {
    const before = await snapshot()
    expect(await stores.migrate().then(() => false, error => error instanceof Error && error.message === 'Disposable migration command failed')).toBe(true)
    expect(await snapshot() === before).toBe(true)
  } finally { await stores.administrator.query('DELETE FROM "user" WHERE id=$1', [id]) }
})
test('late committed invalid syntax is checked after the User write lock, not by lower-trim equality', async () => {
  const id = randomUUID()
  let pending: Promise<boolean> | undefined, locked = true
  await stores.administrator.query('BEGIN')
  try {
    await stores.administrator.query('INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$2,$3,true)', [id, 'Late fixture', 'invalid-lowercase'])
    pending = stores.migrate().then(() => false, () => true)
    let waiting = false
    for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
      waiting = (await stores.administrator.query(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE relation='"user"'::regclass AND NOT granted) AS waiting`)).rows[0].waiting === true
      if (!waiting) await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(waiting).toBe(true)
    await stores.administrator.query('COMMIT'); locked = false
    const before = await snapshot()
    expect(await pending).toBe(true); expect(await snapshot() === before).toBe(true)
    stores.evidence.canonicalPreflightWaitedForWriter = true
  } finally {
    if (locked) await stores.administrator.query('ROLLBACK')
    await pending
    await stores.administrator.query('DELETE FROM "user" WHERE id=$1', [id])
  }
})
test('a later forward-DDL failure preserves User data and native journal', async () => {
  await stores.administrator.query('CREATE VIEW passkey AS SELECT 1 AS fixture')
  try {
    const before = await snapshot()
    expect(await stores.migrate().then(() => false, () => true)).toBe(true)
    expect(await snapshot() === before).toBe(true)
  } finally { await stores.administrator.query('DROP VIEW passkey') }
})
test('canonical N-1 data migrates with exact native journal hashes and remains idempotent', async () => {
  await stores.administrator.query(`INSERT INTO "user"(id,name,email,email_verified) VALUES('canonical-fixture','Canonical fixture','canonical@example.test',true)`)
  const before = JSON.stringify((await stores.administrator.query('SELECT to_jsonb(u) AS row FROM "user" u ORDER BY id')).rows)
  await stores.migrate()
  expect(JSON.stringify((await stores.administrator.query('SELECT to_jsonb(u) AS row FROM "user" u ORDER BY id')).rows) === before).toBe(true)
  const expected = readMigrationFiles({ migrationsFolder: resolve('drizzle') }).map(migration => migration.hash)
  expect((await stores.administrator.query('SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id')).rows.map(row => row.hash)).toEqual(expected)
  const after = await snapshot(); await stores.migrate(); expect(await snapshot() === after).toBe(true)
})

test.each(['fresh', 'upgrade'] as const)('CLI matches unmodified native Drizzle schema and ordered journal on %s history', async mode => {
  const native = await isolatedDatabase(), application = await isolatedDatabase()
  if (mode === 'upgrade') {
    for (const database of [native, application]) {
      await migrate(drizzle(database.client, { logger: false }), { migrationsFolder: prefix })
      await database.client.query(`INSERT INTO "user"(id,name,email,email_verified) VALUES('parity','Parity','parity@example.test',true)`)
    }
  }
  await migrate(drizzle(native.client, { logger: false }), { migrationsFolder: resolve('drizzle') })
  const result = await cli(application.url)
  expect(result.code === 0 && result.stdout === 'Database migrations applied\n' && result.stderr === '').toBe(true)
  expect(await structure(application.client) === await structure(native.client)).toBe(true)
  const before = await structure(application.client)
  expect((await cli(application.url)).code).toBe(0)
  expect(await structure(application.client) === before).toBe(true)
  stores.evidence['journalParity-' + mode] = true
})
test('fresh invalid fixture history rolls back schema and provisional journal rather than skipping validation', async () => {
  const database = await isolatedDatabase()
  const script = await copiedHistory(`INSERT INTO public."user"(id,name,email,email_verified) VALUES('owned-invalid','Owned fixture','invalid-lowercase',true);`)
  const result = await cli(database.url, script)
  await cleanFailure(result, database.name)
  expect((await database.client.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema IN('public','app_private','drizzle')`)).rows[0].n).toBe(0)
})
test('missing User relation with an already-applied journal fails closed without history repair', async () => {
  const database = await isolatedDatabase()
  await migrate(drizzle(database.client, { logger: false }), { migrationsFolder: resolve('drizzle') })
  await database.client.query('DROP TABLE public."user" CASCADE')
  const before = await structure(database.client)
  await cleanFailure(await cli(database.url), database.name)
  expect(await structure(database.client) === before).toBe(true)
})
test('late SQL failure rolls back earlier pending schema and journal rows without reseeding sequence gaps', async () => {
  const database = await isolatedDatabase()
  await migrate(drizzle(database.client, { logger: false }), { migrationsFolder: prefix })
  const before = await structure(database.client)
  const sequence = (await database.client.query('SELECT last_value FROM drizzle.__drizzle_migrations_id_seq')).rows[0].last_value
  const script = await copiedHistory('CREATE TABLE owned_late_sentinel(id integer);\n--> statement-breakpoint\nSELECT 1/0;')
  await cleanFailure(await cli(database.url, script), database.name)
  expect(await structure(database.client) === before).toBe(true)
  expect(Number((await database.client.query('SELECT last_value FROM drizzle.__drizzle_migrations_id_seq')).rows[0].last_value) > Number(sequence)).toBe(true)
})
test('native deferred journal COMMIT rejection leaves no new schema or journal rows and no success output', async () => {
  const database = await isolatedDatabase()
  await migrate(drizzle(database.client, { logger: false }), { migrationsFolder: prefix })
  await database.client.query(`CREATE FUNCTION owned_journal_commit_reject() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Owned deferred journal rejection' USING ERRCODE='23514'; END $$;
    CREATE CONSTRAINT TRIGGER owned_journal_commit_reject AFTER INSERT ON drizzle.__drizzle_migrations DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION owned_journal_commit_reject()`)
  const before = await structure(database.client)
  await cleanFailure(await cli(database.url), database.name)
  expect(await structure(database.client) === before).toBe(true)
  expect(Number((await database.client.query('SELECT last_value FROM drizzle.__drizzle_migrations_id_seq')).rows[0].last_value)).toBe(8)
})
test('row-security filtered visibility refuses certification rather than silently scanning a subset', async () => {
  const database = await isolatedDatabase()
  await migrate(drizzle(database.client, { logger: false }), { migrationsFolder: resolve('drizzle') })
  const role = 'limited_migration_' + randomUUID().replaceAll('-', ''), password = randomBytes(32).toString('hex')
  await database.client.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}';
    GRANT CREATE ON DATABASE ${database.name} TO ${role};
    GRANT USAGE,CREATE ON SCHEMA public,drizzle TO ${role};
    GRANT SELECT,INSERT,UPDATE,DELETE ON drizzle.__drizzle_migrations TO ${role};
    GRANT USAGE,SELECT ON SEQUENCE drizzle.__drizzle_migrations_id_seq TO ${role};
    GRANT SELECT,UPDATE,DELETE ON public."user" TO ${role}`)
  const url = new URL(database.url); url.username = role; url.password = password
  expect((await cli(url)).code).toBe(0)
  await database.client.query(`INSERT INTO public."user"(id,name,email,email_verified) VALUES('hidden-invalid','Hidden fixture','invalid-lowercase',true);
    ALTER TABLE public."user" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY owned_hidden_user ON public."user" FOR SELECT TO ${role} USING(false)`)
  const before = await structure(database.client)
  await cleanFailure(await cli(url), database.name)
  expect(await structure(database.client) === before).toBe(true)
})
test('bounded User lock wait failure closes the CLI transaction without migration progress', async () => {
  const database = await isolatedDatabase()
  await migrate(drizzle(database.client, { logger: false }), { migrationsFolder: prefix })
  const before = await structure(database.client)
  await database.client.query('BEGIN; LOCK TABLE public."user" IN ROW EXCLUSIVE MODE')
  let result: Awaited<ReturnType<typeof cli>>
  const start = performance.now()
  try { result = await cli(database.url) }
  finally { await database.client.query('ROLLBACK') }
  expect(performance.now() - start < 8000).toBe(true)
  await cleanFailure(result, database.name)
  expect(await structure(database.client) === before).toBe(true)
})
test('migrator-first table lock excludes a late writer until commit without claiming permanent SQL validation', async () => {
  const database = await isolatedDatabase()
  await migrate(drizzle(database.client, { logger: false }), { migrationsFolder: prefix })
  const key = 88007
  const script = await copiedHistory(`SELECT pg_advisory_xact_lock(${key});\n--> statement-breakpoint\nCREATE TABLE owned_migration_gate(id integer);`)
  await database.client.query('SELECT pg_advisory_lock($1)', [key])
  const userOid = (await database.client.query(`SELECT 'public."user"'::regclass::oid AS oid`)).rows[0].oid
  const pending = cli(database.url, script)
  const writer = new Client({ connectionString: database.url.href, statement_timeout: 400, connectionTimeoutMillis: 1000 })
  writer.on('error', () => {}); clients.push(writer); await writer.connect()
  let writing: Promise<boolean> | undefined
  try {
    let held = false
    for (let attempt = 0; attempt < 100 && !held; attempt++) {
      held = (await stores.administrator.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid
        WHERE a.datname=$1 AND a.wait_event='advisory' AND l.relation=$2 AND l.mode='ShareRowExclusiveLock' AND l.granted) AS held`, [database.name, userOid])).rows[0].held === true
      if (!held) await new Promise(resolve => setTimeout(resolve, 15))
    }
    expect(held).toBe(true)
    const pid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    await writer.query('BEGIN')
    writing = writer.query(`INSERT INTO public."user"(id,name,email,email_verified) VALUES('late-writer','Late writer','invalid-lowercase',true)`)
      .then(() => false, error => error.code === '57014')
    let blocked = false
    for (let attempt = 0; attempt < 30 && !blocked; attempt++) {
      blocked = (await stores.administrator.query(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND relation=$2 AND NOT granted) AS blocked`, [pid, userOid])).rows[0].blocked === true
      if (!blocked) await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(blocked).toBe(true); expect(await writing).toBe(true)
    await writer.query('ROLLBACK')
    expect((await database.client.query('SELECT count(*)::int AS n FROM public."user"')).rows[0].n).toBe(0)
    await database.client.query('SELECT pg_advisory_unlock($1)', [key])
    const result = await pending
    expect(result.code === 0 && result.stdout === 'Database migrations applied\n' && result.stderr === '').toBe(true)
    stores.evidence.canonicalMigratorFirstWriteBlocked = true
  } finally {
    await writing
    await writer.query('ROLLBACK')
    await database.client.query('SELECT pg_advisory_unlock($1)', [key])
    await pending
  }
})
