import { afterAll, beforeAll, expect, test } from 'vitest'
import { nativeImage } from '../helpers/native-image'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { readMigrationFiles } from 'drizzle-orm/migrator'
let image: string
let stores: Awaited<ReturnType<typeof startDisposableStores>>
beforeAll(async () => { image = await nativeImage('migrator'); stores=await startDisposableStores() }, 600000)
afterAll(async()=>{if(stores){await stores.cleanup();expect(stores.evidence.unrelatedUnchanged).toBe(true);expect(stores.evidence.inventoryDelta).toEqual([])}})
test('missing_native_role_rolls_back',async()=>{
  expect((await stores.administrator.query("SELECT current_setting('server_version_num') AS version")).rows[0].version).toBe('160015')
  expect((await stores.administrator.query("SELECT to_regclass('public.\"user\"') AS relation")).rows[0].relation).toBeNull()
  await stores.administrator.query('DROP ROLE sparra_voice_definer')
  try{
    const result=await stores.runMigrationImage(image)
    expect(result).toMatchObject({exitCode:1,stdout:'',stderr:'Database migration failed\n'})
    expect((await stores.administrator.query("SELECT to_regclass('public.\"user\"') AS users,to_regclass('drizzle.__drizzle_migrations') AS journal")).rows[0]).toEqual({users:null,journal:null})
    expect((await stores.administrator.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname='auth' AND state='idle in transaction'")).rows[0].n).toBe(0)
  }finally{await stores.administrator.query('CREATE ROLE sparra_voice_definer NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION')}
})
test('unknown_commit_never_retries_and_journal_is_really_committed',async()=>{
  const result=await stores.runMigrationImage(image,'valid','drop-commit-ack')
  expect(result).toMatchObject({exitCode:1,stdout:'',stderr:'Database migration failed; commit was not acknowledged\n'})
  expect(stores.evidence.commitProxy).toEqual({type:'terminal',connections:1,commits:1,upstreamCompletions:1,accepting:false,activeSockets:0})
  expect((await stores.administrator.query('SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows.map(row=>row.hash)).toEqual(readMigrationFiles({migrationsFolder:'drizzle'}).map(migration=>migration.hash))
})
test('native_cli_closure_without_checkout_and_native_journal_idempotence',async()=>{
  const result=await stores.runMigrationImage(image)
  expect(result).toMatchObject({exitCode:0,stdout:'Database migrations applied\n',stderr:''})
  const journal=await stores.administrator.query('SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at')
  expect(journal.rows.map(row=>row.hash)).toEqual(readMigrationFiles({migrationsFolder:'drizzle'}).map(migration=>migration.hash))
  const second=await stores.runMigrationImage(image)
  expect(second).toMatchObject({exitCode:0,stdout:'Database migrations applied\n',stderr:''})
  expect((await stores.administrator.query('SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows).toEqual(journal.rows)
  const metadata=await stores.imageMetadata(result.id)
  expect(metadata.user).toBe('10001:10001');expect(metadata.readonly).toBe(true)
  expect(metadata.mounts.map((mount:{Destination:string})=>mount.Destination)).toEqual(['/run/secrets'])
})
test.each(['empty-env','missing','malformed','oversized','symlink','mode','empty','newline','nul','whitespace','utf8','uid','gid','directory','parent-mode'] as const)('file_failure_does_not_import_assign_or_leak: %s',async mutation=>{
  const result=await stores.runMigrationImage(image,mutation)
  expect(result).toMatchObject({exitCode:1,stdout:'',stderr:'Migration credential loading failed\n'})
})
