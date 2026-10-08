import { expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { startDisposableStores } from '../fixtures/db/disposable-stores'

type Stores = Awaited<ReturnType<typeof startDisposableStores>>
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', callId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const recordingId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', prefixName = 'sparra-audio-store-prefix-'
const audioColumns = ['recording_id','audio_state','audio_reserved_bytes','audio_charged_bytes','audio_denied_at','audio_total_samples','audio_last_sequence','audio_finish_reason']
const signatures = ['voice.begin_call_v1(text,uuid,jsonb)','voice.ingest_operation_v1(jsonb)','voice.lease_recording_purge_v1(text,integer,integer)','voice.ack_recording_purge_v1(uuid,uuid,text,timestamptz)','voice.lease_call_erasure_v1(text,integer,integer)','voice.ack_call_erasure_v1(uuid,uuid,timestamptz)']
const sourceHashes = (entries: readonly { tag: string }[]) => Promise.all(entries.map(async entry => createHash('sha256').update(await readFile('drizzle/' + entry.tag + '.sql')).digest('hex')))

async function retirePrefix(directory: string | undefined) {
  if (!directory) return
  const owned = resolve(directory)
  if (dirname(owned) !== resolve(tmpdir()) || !basename(owned).startsWith(prefixName)) throw new Error('Non-owned audio store prefix')
  await rm(owned, { recursive: true })
}
async function migratePrefix(stores: Stores) {
  const directory = await mkdtemp(join(tmpdir(), prefixName))
  try {
    await mkdir(join(directory, 'meta'))
    const journal = JSON.parse(await readFile('drizzle/meta/_journal.json', 'utf8'))
    const entries: { tag: string }[] = journal.entries.slice(0, 20)
    expect(entries).toHaveLength(20); expect(entries.at(-1)?.tag).toBe('0019_sparra_optional_audio_policy')
    expect(journal.entries[20].tag).toBe('0020_sparra_local_audio_store')
    const hashes = await sourceHashes(entries)
    for (const entry of entries) await cp('drizzle/' + entry.tag + '.sql', join(directory, entry.tag + '.sql'))
    await writeFile(join(directory, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }))
    await migrate(drizzle(stores.administrator), { migrationsFolder: directory })
    return { directory, entries, hashes }
  } catch (error) { await retirePrefix(directory); throw error }
}
async function historicalState(stores: Stores) {
  return (await stores.administrator.query(`SELECT
    (SELECT to_jsonb(u) FROM "user" u WHERE id='audio-store-history-owner') owner,
    (SELECT to_jsonb(w) FROM workspace w WHERE id=$1::uuid) workspace,
    (SELECT jsonb_agg(to_jsonb(k) ORDER BY revision) FROM sparra_knowledge_revision k WHERE workspace_id=$1::uuid) revisions,
    (SELECT to_jsonb(b) FROM voice_private.deployment_binding b WHERE service_login='sparra_voice_a') binding,
    (SELECT to_jsonb(c)-$3::text[] FROM sparra_call c WHERE id=$2::uuid) call,
    (SELECT to_jsonb(p) FROM voice_private.recording_purge p WHERE call_id=$2::uuid) purge,
    (SELECT to_jsonb(r) FROM voice_private.operation_receipt r WHERE call_id=$2::uuid) receipt`, [workspaceId, callId, audioColumns])).rows[0]
}
async function oldAuthority(stores: Stores) {
  return {
    roles: (await stores.administrator.query("SELECT oid,rolname,rolcanlogin,rolinherit,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN ('runtime','workspace_owner','workspace_bootstrap','sparra_voice_definer','sparra_voice_a') ORDER BY rolname")).rows,
    grants: (await stores.administrator.query("SELECT signature,has_function_privilege('sparra_voice_a',signature,'EXECUTE') allowed FROM unnest($1::text[]) signature ORDER BY signature", [signatures])).rows,
  }
}

test('0020 atomically retries after late DDL failure without changing historical calls or provider purge receipts', async () => {
  const stores = await startDisposableStores()
  let directory: string | undefined
  try {
    const prefix = await migratePrefix(stores); directory = prefix.directory
    const admin = (sql: string, values?: unknown[]) => stores.administrator.query(sql, values)
    // Administrative historical data only; no provider call or audio success is produced here.
    await admin(`INSERT INTO "user"(id,name,email) VALUES('audio-store-history-owner','Historical owner','audio-store-history@example.test');
      INSERT INTO workspace(id,owner_user_id) VALUES('${workspaceId}','audio-store-history-owner');
      INSERT INTO sparra_knowledge_revision(workspace_id,revision,business_name,sector,opening_hours,services,prices,faq,instructions,recording_enabled)
        VALUES('${workspaceId}',1,'Old OFF','garage','','','','','',false),('${workspaceId}',2,'Old provider ON','garage','','','','','',true);
      INSERT INTO voice_private.deployment_binding(service_login,service_role_oid,deployment_id,workspace_id,connection_id,to_e164,admission_enabled,audio_enabled)
        SELECT 'sparra_voice_a',oid,'store-history','${workspaceId}','history-connection','+33123456789',true,true FROM pg_roles WHERE rolname='sparra_voice_a';
      INSERT INTO sparra_call(id,workspace_id,configuration_revision,deployment_id,provider_call_control_id,admitted_at,retention_until)
        VALUES('${callId}','${workspaceId}',2,'store-history','history-control','2026-10-01T10:00:00.123Z','2026-10-31T10:00:00.123Z');
      INSERT INTO voice_private.recording_purge(recording_id,workspace_id,deployment_id,call_id,provider_recording_id,original_retention_until,archive_ciphertext_sha256,archive_encrypted_bytes,archive_key_version)
        VALUES('${recordingId}','${workspaceId}','store-history','${callId}','historical-provider-recording','2026-10-31T10:00:00.123Z','${'b'.repeat(64)}',188,1);
      INSERT INTO voice_private.operation_receipt(deployment_id,operation_id,workspace_id,call_id,payload_sha256,occurred_at,original_retention_until)
        VALUES('store-history','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','${workspaceId}','${callId}','${'c'.repeat(64)}','2026-10-01T10:00:01.123Z','2026-10-31T10:00:00.123Z');
      GRANT USAGE ON SCHEMA voice TO sparra_voice_a`)
    for (const signature of signatures) await admin(`GRANT EXECUTE ON FUNCTION ${signature} TO sparra_voice_a`)
    const before = await historicalState(stores), authorityBefore = await oldAuthority(stores)
    const journalBefore = (await admin('SELECT id,hash,created_at::text FROM drizzle.__drizzle_migrations ORDER BY id')).rows
    expect(journalBefore).toHaveLength(20)
    await admin(`CREATE SEQUENCE public.fixture_audio_store_late;
      CREATE FUNCTION public.fixture_audio_store_fault() RETURNS event_trigger LANGUAGE plpgsql AS $$
      DECLARE command record;
      BEGIN
        FOR command IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
          IF command.command_tag='CREATE FUNCTION' AND command.object_identity LIKE 'voice.begin_call_v1(%' THEN
            PERFORM nextval('public.fixture_audio_store_late'); RAISE EXCEPTION 'Owned late audio store migration failure';
          END IF;
        END LOOP;
      END $$;
      CREATE EVENT TRIGGER fixture_audio_store_fault ON ddl_command_end WHEN TAG IN ('CREATE FUNCTION') EXECUTE FUNCTION public.fixture_audio_store_fault()`)
    const schemaDump = async () => (await stores.command(stores.pg, ['pg_dump','--schema-only','--no-comments','--username=migrator','auth'])).split('\n').filter(line => !line.startsWith('\\restrict ') && !line.startsWith('\\unrestrict ')).join('\n')
    const schemaBefore = await schemaDump()
    await expect(stores.migrate()).rejects.toThrow('Disposable migration command failed')
    expect((await admin('SELECT is_called FROM fixture_audio_store_late')).rows[0].is_called).toBe(true)
    expect(await schemaDump()).toBe(schemaBefore)
    expect(await historicalState(stores)).toEqual(before); expect(await oldAuthority(stores)).toEqual(authorityBefore)
    expect((await admin('SELECT id,hash,created_at::text FROM drizzle.__drizzle_migrations ORDER BY id')).rows).toEqual(journalBefore)
    expect((await admin("SELECT to_regclass('public.sparra_audio_chunk') IS NULL AND to_regclass('public.sparra_audio_quota') IS NULL absent")).rows[0].absent).toBe(true)
    expect((await admin("SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='public' AND table_name='sparra_call' AND column_name=ANY($1::text[])", [audioColumns])).rows[0].n).toBe(0)
    await admin('DROP EVENT TRIGGER fixture_audio_store_fault; DROP FUNCTION public.fixture_audio_store_fault(); DROP SEQUENCE public.fixture_audio_store_late')
    await stores.migrate()
    expect(await historicalState(stores)).toEqual(before); expect(await oldAuthority(stores)).toEqual(authorityBefore)
    expect((await admin('SELECT recording_id,audio_state,audio_reserved_bytes,audio_charged_bytes,audio_total_samples,audio_last_sequence,audio_finish_reason,audio_denied_at FROM sparra_call WHERE id=$1', [callId])).rows[0]).toEqual({ recording_id: null, audio_state: 'off', audio_reserved_bytes: 0, audio_charged_bytes: 0, audio_total_samples: null, audio_last_sequence: null, audio_finish_reason: null, audio_denied_at: null })
    expect((await admin('SELECT (SELECT count(*)::int FROM sparra_audio_chunk) chunks,(SELECT count(*)::int FROM sparra_audio_quota) quotas')).rows[0]).toEqual({ chunks: 0, quotas: 0 })
    const finalJournal = (await admin('SELECT id,hash,created_at::text FROM drizzle.__drizzle_migrations ORDER BY id')).rows
    expect(finalJournal).toHaveLength(21); expect(finalJournal.slice(0,20)).toEqual(journalBefore)
    expect(finalJournal[20].hash).toBe(createHash('sha256').update(await readFile('drizzle/0020_sparra_local_audio_store.sql')).digest('hex'))
    expect(await sourceHashes(prefix.entries)).toEqual(prefix.hashes)
    expect((await admin("SELECT has_function_privilege('sparra_voice_a','voice.begin_call_v2(text,uuid,jsonb)','EXECUTE') OR has_function_privilege('sparra_voice_a','voice.ingest_operation_v2(jsonb)','EXECUTE') allowed")).rows[0].allowed).toBe(false)
  } finally {
    const settled = await Promise.allSettled([retirePrefix(directory), stores.cleanup()])
    const failures = settled.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'Audio store migration fixture cleanup failed')
  }
}, 30000)
