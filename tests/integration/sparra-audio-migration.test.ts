import { expect, test } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Client } from 'pg'
import { startDisposableStores } from '../fixtures/db/disposable-stores'

type Stores = Awaited<ReturnType<typeof startDisposableStores>>
const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const prefixName = 'sparra-audio-migration-prefix-'
const hashes = (entries: readonly { tag: string }[]) => Promise.all(entries.map(async entry =>
  createHash('sha256').update(await readFile('drizzle/' + entry.tag + '.sql')).digest('hex'),
))

async function retirePrefix(directory: string | undefined) {
  if (!directory) return
  const owned = resolve(directory)
  if (dirname(owned) !== resolve(tmpdir()) || !basename(owned).startsWith(prefixName)) throw new Error('Non-owned audio migration prefix')
  await rm(owned, { recursive: true })
}

async function migratePrefix(stores: Stores, count = 19) {
  const directory = await mkdtemp(join(tmpdir(), prefixName))
  try {
    await mkdir(join(directory, 'meta'))
    const journal = JSON.parse(await readFile('drizzle/meta/_journal.json', 'utf8'))
    const entries: { tag: string; idx: number }[] = journal.entries.slice(0, count)
    expect(entries).toHaveLength(count)
    expect(entries.at(-1)?.tag).toBe(count === 19 ? '0018_recording_archive_receipt' : '0021_sparra_private_audio_reader')
    const originalHashes = await hashes(entries)
    for (const entry of entries) await cp('drizzle/' + entry.tag + '.sql', join(directory, entry.tag + '.sql'))
    await writeFile(join(directory, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }))
    await migrate(drizzle(stores.administrator), { migrationsFolder: directory })
    return { directory, entries, originalHashes }
  } catch (error) { await retirePrefix(directory); throw error }
}

async function historicalState(stores: Stores) {
  return (await stores.administrator.query(`SELECT
    (SELECT to_jsonb(u) FROM "user" u WHERE id='audio-history-owner') owner,
    (SELECT to_jsonb(w) FROM workspace w WHERE id=$1::uuid) workspace,
    (SELECT jsonb_agg(to_jsonb(k)-'recording_policy'-'recording_contact_phone' ORDER BY revision)
      FROM sparra_knowledge_revision k WHERE workspace_id=$1::uuid) revisions,
    (SELECT to_jsonb(b)-'contract_version'-'local_audio_enabled' FROM voice_private.deployment_binding b WHERE service_login='sparra_voice_a') binding`, [workspaceId])).rows[0]
}

test('0019 rolls back a real late DDL failure then preserves preexisting provider policies and binding authority', async () => {
  const stores = await startDisposableStores()
  let directory: string | undefined
  try {
    const prefix = await migratePrefix(stores); directory = prefix.directory
    const admin = (sql: string, values?: unknown[]) => stores.administrator.query(sql, values)
    // Freeze this witness at0019 even when the repository has later migrations.
    const journal = JSON.parse(await readFile('drizzle/meta/_journal.json', 'utf8'))
    await cp('drizzle/0019_sparra_optional_audio_policy.sql', join(directory, '0019_sparra_optional_audio_policy.sql'))
    await writeFile(join(directory, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 20) }))
    const apply0019 = async () => {
      try { await migrate(drizzle(stores.administrator), { migrationsFolder: directory! }) }
      catch { throw new Error('Owned policy migration failed') }
    }
    await admin(`INSERT INTO "user"(id,name,email) VALUES('audio-history-owner','Historical owner','audio-history@example.test');
      INSERT INTO workspace(id,owner_user_id) VALUES('${workspaceId}','audio-history-owner');
      INSERT INTO sparra_knowledge_revision(workspace_id,revision,business_name,sector,opening_hours,services,prices,faq,instructions,recording_enabled)
        VALUES('${workspaceId}',1,'Historical OFF','garage','','','','','',false),('${workspaceId}',2,'Historical ON','garage','','','','','',true);
      INSERT INTO voice_private.deployment_binding(service_login,service_role_oid,deployment_id,workspace_id,connection_id,to_e164,admission_enabled,audio_enabled)
        SELECT 'sparra_voice_a',oid,'historical-audio-binding','${workspaceId}','historical-connection','+33123456789',true,true FROM pg_roles WHERE rolname='sparra_voice_a'`)
    const before = await historicalState(stores)
    const journalBefore = (await admin('SELECT id,hash,created_at::text FROM drizzle.__drizzle_migrations ORDER BY id')).rows
    expect(journalBefore).toHaveLength(19)
    await admin(`CREATE SEQUENCE public.fixture_audio_policy_late;
      CREATE FUNCTION public.fixture_audio_policy_fault() RETURNS event_trigger LANGUAGE plpgsql AS $$
      DECLARE command record;
      BEGIN
        FOR command IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
          IF command.command_tag='CREATE FUNCTION' AND command.object_identity='voice_private.binding_guard()' THEN
            PERFORM nextval('public.fixture_audio_policy_late');
            RAISE EXCEPTION 'Owned late audio policy migration failure';
          END IF;
        END LOOP;
      END $$;
      CREATE EVENT TRIGGER fixture_audio_policy_fault ON ddl_command_end WHEN TAG IN ('CREATE FUNCTION') EXECUTE FUNCTION public.fixture_audio_policy_fault()`)
    const schemaDump = async () => (await stores.command(stores.pg, ['pg_dump', '--schema-only', '--no-comments', '--username=migrator', 'auth']))
      .split('\n').filter(line => !line.startsWith('\\restrict ') && !line.startsWith('\\unrestrict ')).join('\n')
    const schemaBefore = await schemaDump()
    await expect(apply0019()).rejects.toThrow('Owned policy migration failed')
    expect((await admin('SELECT is_called FROM fixture_audio_policy_late')).rows[0].is_called).toBe(true)
    expect(await schemaDump()).toBe(schemaBefore)
    expect(await historicalState(stores)).toEqual(before)
    expect((await admin('SELECT id,hash,created_at::text FROM drizzle.__drizzle_migrations ORDER BY id')).rows).toEqual(journalBefore)
    expect((await admin(`SELECT count(*)::int n FROM information_schema.columns WHERE
      (table_schema='public' AND table_name='sparra_knowledge_revision' AND column_name IN ('recording_policy','recording_contact_phone'))
      OR (table_schema='voice_private' AND table_name='deployment_binding' AND column_name IN ('contract_version','local_audio_enabled'))`)).rows[0].n).toBe(0)
    expect((await admin("SELECT to_regprocedure('public.sparra_local_audio_available_v1()') IS NULL absent")).rows[0].absent).toBe(true)
    await admin('DROP EVENT TRIGGER fixture_audio_policy_fault; DROP FUNCTION public.fixture_audio_policy_fault(); DROP SEQUENCE public.fixture_audio_policy_late')
    await apply0019()
    expect(await historicalState(stores)).toEqual(before)
    expect((await admin('SELECT revision,recording_enabled,recording_policy,recording_contact_phone FROM sparra_knowledge_revision WHERE workspace_id=$1 ORDER BY revision', [workspaceId])).rows).toEqual([
      { revision: 1, recording_enabled: false, recording_policy: 'off', recording_contact_phone: null },
      { revision: 2, recording_enabled: true, recording_policy: 'off', recording_contact_phone: null },
    ])
    expect((await admin("SELECT contract_version,local_audio_enabled FROM voice_private.deployment_binding WHERE service_login='sparra_voice_a'")).rows[0]).toEqual({ contract_version: 1, local_audio_enabled: false })
    const finalJournal = (await admin('SELECT id,hash,created_at::text FROM drizzle.__drizzle_migrations ORDER BY id')).rows
    expect(finalJournal).toHaveLength(20)
    expect(finalJournal.slice(0, 19)).toEqual(journalBefore)
    expect(finalJournal[19].hash).toBe(createHash('sha256').update(await readFile('drizzle/0019_sparra_optional_audio_policy.sql')).digest('hex'))
    expect(await hashes(prefix.entries)).toEqual(prefix.originalHashes)
  } finally {
    const settled = await Promise.allSettled([retirePrefix(directory), stores.cleanup()])
    const failures = settled.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'Audio migration fixture cleanup failed')
  }
}, 30000)

test('0022 forwards only optional contact admission while preserving old rows, pins, expiry, quota and authority', async () => {
  const stores = await startDisposableStores()
  let directory: string | undefined, machine: Client | undefined
  try {
    const prefix = await migratePrefix(stores, 22); directory = prefix.directory
    const admin = (sql: string, values?: unknown[]) => stores.administrator.query(sql, values)
    await admin(`INSERT INTO "user"(id,name,email) VALUES('audio-history-owner','Historical owner','audio-history@example.test');
      INSERT INTO workspace(id,owner_user_id) VALUES('${workspaceId}','audio-history-owner');
      INSERT INTO sparra_knowledge_revision(workspace_id,revision,business_name,sector,opening_hours,services,prices,faq,instructions,recording_policy,recording_contact_phone)
        VALUES('${workspaceId}',1,'Existing local ON','garage','','','','','','local_30d','+33123456789');
      INSERT INTO voice_private.deployment_binding(service_login,service_role_oid,deployment_id,workspace_id,connection_id,to_e164,admission_enabled,audio_enabled,contract_version,local_audio_enabled)
        SELECT 'sparra_voice_a',oid,'optional-contact-history','${workspaceId}','history-connection','+33102030405',true,false,2,true FROM pg_roles WHERE rolname='sparra_voice_a';
      GRANT USAGE ON SCHEMA voice TO sparra_voice_a;
      GRANT EXECUTE ON FUNCTION voice.begin_call_v2(text,uuid,jsonb) TO sparra_voice_a`)
    machine = new Client({ connectionString: stores.voiceUrlA }); await machine.connect()
    const route = (id: string) => ({ schema_version: 1, direction: 'incoming', connection_id: 'history-connection', to_e164: '+33102030405', from_e164: null,
      telnyx_call_control_id: 'history-' + id, telnyx_call_leg_id: null, telnyx_call_session_id: null, admitted_at: new Date().toISOString() })
    const oldId = randomUUID(), oldRoute = route(oldId)
    const begin = async (id: string, routing: ReturnType<typeof route>) => (await machine!.query('SELECT voice.begin_call_v2($1::text,$2::uuid,$3::jsonb) v', ['optional-contact-history', id, JSON.stringify(routing)])).rows[0].v
    const oldPin = await begin(oldId, oldRoute)
    expect(oldPin).toMatchObject({ configuration_revision: 1, recording_policy: 'local_30d', recording_contact_phone: '+33123456789', audio_available: true })
    await admin(`INSERT INTO sparra_knowledge_revision(workspace_id,revision,business_name,sector,opening_hours,services,prices,faq,instructions,recording_enabled)
      VALUES('${workspaceId}',2,'Existing OFF','garage','','','','','',false),('${workspaceId}',3,'Existing legacy ON','garage','','','','','',true)`)
    const insert = (revision: number, phone: string | null, legacy = false) => admin(`INSERT INTO sparra_knowledge_revision(workspace_id,revision,business_name,sector,opening_hours,services,prices,faq,instructions,recording_enabled,recording_policy,recording_contact_phone)
      VALUES($1,$2,'Forward contact fixture','garage','','','','','',$3,'local_30d',$4)`, [workspaceId, revision, legacy, phone])
    await expect(insert(4, null)).rejects.toMatchObject({ code: '23514' })
    const state = async () => (await admin(`SELECT
      (SELECT to_jsonb(u) FROM "user" u WHERE id='audio-history-owner') owner,
      (SELECT to_jsonb(w) FROM workspace w WHERE id=$1) workspace,
      (SELECT jsonb_agg(to_jsonb(k) ORDER BY revision) FROM sparra_knowledge_revision k WHERE workspace_id=$1) revisions,
      (SELECT to_jsonb(c) FROM sparra_call c WHERE id=$2) call,
      (SELECT to_jsonb(q) FROM sparra_audio_quota q WHERE workspace_id=$1) quota,
      (SELECT to_jsonb(b) FROM voice_private.deployment_binding b WHERE service_login='sparra_voice_a') binding,
      (SELECT jsonb_build_object('owner',p.proowner,'acl',p.proacl,'security_definer',p.prosecdef,'config',p.proconfig) FROM pg_proc p WHERE p.oid='voice.begin_call_v2(text,uuid,jsonb)'::regprocedure) authority`, [workspaceId, oldId])).rows[0]
    const before = await state(), oldJournal = (await admin('SELECT id,hash,created_at::text FROM drizzle.__drizzle_migrations ORDER BY id')).rows
    expect(oldJournal).toHaveLength(22)
    await admin(`CREATE SEQUENCE public.fixture_optional_contact_late;
      CREATE FUNCTION public.fixture_optional_contact_fault() RETURNS event_trigger LANGUAGE plpgsql AS $$
      DECLARE command record;
      BEGIN
        FOR command IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
          IF command.command_tag='CREATE FUNCTION' AND command.objid='voice.begin_call_v2(text,uuid,jsonb)'::regprocedure THEN
            PERFORM nextval('public.fixture_optional_contact_late');
            RAISE EXCEPTION 'Owned optional contact migration failure';
          END IF;
        END LOOP;
      END $$;
      CREATE EVENT TRIGGER fixture_optional_contact_fault ON ddl_command_end WHEN TAG IN ('CREATE FUNCTION') EXECUTE FUNCTION public.fixture_optional_contact_fault()`)
    await expect(stores.migrate()).rejects.toThrow('Disposable migration command failed')
    expect((await admin('SELECT is_called FROM fixture_optional_contact_late')).rows[0].is_called).toBe(true)
    expect(await state()).toEqual(before)
    expect((await admin('SELECT id,hash,created_at::text FROM drizzle.__drizzle_migrations ORDER BY id')).rows).toEqual(oldJournal)
    await expect(insert(4, null)).rejects.toMatchObject({ code: '23514' })
    await admin('DROP EVENT TRIGGER fixture_optional_contact_fault; DROP FUNCTION public.fixture_optional_contact_fault(); DROP SEQUENCE public.fixture_optional_contact_late')
    await stores.migrate()
    expect(await state()).toEqual(before)
    const finalJournal = (await admin('SELECT id,hash,created_at::text FROM drizzle.__drizzle_migrations ORDER BY id')).rows
    expect(finalJournal).toHaveLength(23)
    expect(finalJournal.slice(0, 22)).toEqual(oldJournal)
    expect(finalJournal[22].hash).toBe(createHash('sha256').update(await readFile('drizzle/0022_sparra_optional_recording_contact.sql')).digest('hex'))
    expect(await hashes(prefix.entries)).toEqual(prefix.originalHashes)
    await insert(4, null)
    const newId = randomUUID(), newPin = await begin(newId, route(newId))
    expect(newPin).toMatchObject({ schema_version: 2, configuration_revision: 4, recording_policy: 'local_30d', recording_contact_phone: null, audio_available: true })
    expect(newPin.recording_id).not.toBeNull()
    expect(await begin(oldId, oldRoute)).toEqual(oldPin)
    expect((await admin('SELECT to_jsonb(c) row FROM sparra_call c WHERE id=$1', [oldId])).rows[0].row).toEqual(before.call)
    for (const [phone, legacy] of [[null, true], ['+33123456789', true], ['', false], ['0612345678', false], ['+33123456789\n', false]] as const) {
      await expect(insert(5, phone, legacy)).rejects.toMatchObject({ code: '23514' })
    }
    expect((await admin('SELECT count(*)::int n FROM sparra_knowledge_revision WHERE workspace_id=$1', [workspaceId])).rows[0].n).toBe(4)
    const runtime = new Client({ connectionString: stores.runtimeUrl }); await runtime.connect()
    try {
      await runtime.query('BEGIN'); await runtime.query("SELECT set_config('app.tenant_id',$1,true)", [workspaceId])
      expect((await runtime.query('SELECT public.sparra_local_audio_available_v1() available')).rows[0].available).toBe(true)
      await runtime.query('ROLLBACK')
    } finally { await runtime.end() }
  } finally {
    const settled = await Promise.allSettled([machine?.end(), retirePrefix(directory), stores.cleanup()])
    const failures = settled.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'Optional contact migration fixture cleanup failed')
  }
}, 30000)
