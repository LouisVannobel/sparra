import { expect, test } from 'vitest'
import { randomUUID } from 'node:crypto'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { startDisposableStores } from '../fixtures/db/disposable-stores'

test('forward billing migration preserves populated consumer0022 auth, Inbox and audio rows and migration receipts', async () => {
  const stores = await startDisposableStores()
  let prefix: string | undefined
  try {
    const journal = JSON.parse(await readFile('drizzle/meta/_journal.json', 'utf8'))
    expect(journal.entries[22].tag).toBe('0022_sparra_optional_recording_contact')
    expect(journal.entries[23].tag).toBe('0023_sparra_billing_core')
    const expectedJournal = readMigrationFiles({ migrationsFolder: resolve('drizzle') })
      .map(migration => ({ hash: migration.hash, created_at: String(migration.folderMillis) }))
    prefix = await mkdtemp(join(tmpdir(), 'sparra-billing-prefix-'))
    await cp(resolve('drizzle'), prefix, { recursive: true })
    await writeFile(join(prefix, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 23) }))
    await migrate(drizzle(stores.administrator), { migrationsFolder: prefix })
    const userId = randomUUID(), workspaceId = randomUUID(), callId = randomUUID(), recordingId = randomUUID()
    await stores.administrator.query('INSERT INTO "user"(id,name,email,email_verified) VALUES($1,\'Fixture\',$2,true)', [userId, userId + '@example.test'])
    await stores.administrator.query("INSERT INTO session(id,token,user_id,expires_at,auth_state,auth_method,authenticated_at,recovery_generation,last_activity_at) VALUES($1,$2,$3,now()+interval '1 day','ACTIVE','passkey',now(),0,now())", [randomUUID(), randomUUID(), userId])
    await stores.administrator.query("INSERT INTO workspace(id,kind,lifecycle,owner_user_id) VALUES($1,'personal','active',$2)", [workspaceId, userId])
    await stores.administrator.query("INSERT INTO sparra_knowledge_revision(workspace_id,revision,business_name,sector,opening_hours,services,prices,faq,instructions,recording_policy,recording_contact_phone) VALUES($1,1,'Fixture','garage','','','','','','local_30d','+33123456789')", [workspaceId])
    await stores.administrator.query("INSERT INTO sparra_call(id,workspace_id,configuration_revision,deployment_id,provider_call_control_id,admitted_at,retention_until,recording_id,audio_state) VALUES($1,$2,1,'billing-migration','synthetic-call',now(),now()+interval '30 days',$3,'pending')", [callId, workspaceId, recordingId])
    await stores.administrator.query("INSERT INTO sparra_audio_chunk(workspace_id,call_id,recording_id,deployment_id,sequence,configuration_revision,retention_until,sample_count,sample_rate,channels,sample_format,crypto_version,key_version,nonce,ciphertext,charged_bytes) VALUES($1,$2,$3,'billing-migration',0,1,now()+interval '30 days',1,8000,2,'s16le',1,1,decode(repeat('00',12),'hex'),decode(repeat('00',20),'hex'),32)", [workspaceId, callId, recordingId])
    const tables = (await stores.administrator.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(row => row.tablename)
    const publicationColumns = ['collection_manifest','collection_closed','publication_snapshot','publication_version','declared_publication','declaration_active','publication_token']
    const snapshot = async () => {
      const rows: Record<string, { value: unknown }[]> = {}
      for (const table of tables) {
        if (!/^[a-z_]+$/.test(table)) throw new Error('Unexpected consumer relation')
        rows[table] = (await stores.administrator.query(`SELECT to_jsonb(t)-$1::text[] AS value FROM public."${table}" t ORDER BY (to_jsonb(t)-$1::text[])::text`, [table === 'sparra_call' ? publicationColumns : []])).rows
      }
      return rows
    }
    const publication = async () => (await stores.administrator.query('SELECT collection_manifest,collection_closed,publication_snapshot,publication_version,declared_publication,declaration_active,publication_token FROM sparra_call WHERE id=$1', [callId])).rows
    const before = await snapshot()
    const admittedAt = (await stores.administrator.query<{admitted_at:string}>("SELECT to_jsonb(c)->>'admitted_at' AS admitted_at FROM sparra_call c WHERE id=$1", [callId])).rows[0]!.admitted_at
    const receipts = (await stores.administrator.query('SELECT id,hash,created_at::text FROM drizzle.__drizzle_migrations ORDER BY id')).rows
    await stores.migrate()
    expect(await snapshot()).toEqual(before)
    const published = await publication()
    expect(published).toEqual([{
      collection_manifest:null,collection_closed:false,declaration_active:false,declared_publication:0,publication_version:1,
      publication_token:expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      publication_snapshot:{schema_version:1,collection:null,collection_closed:false,status:'pending',configuration_revision:1,
        from_e164:null,admitted_at:admittedAt,ended_at:null,end_reason:null,disclosure_state:'pending',
        transcript_loss_count:0,encrypted_turns:{},encrypted_message_result:null,bookings:[],
        audio:{state:'pending',recording_id:recordingId,total_samples:null,last_sequence:null,finish_reason:null,coverage:'unknown'}},
    }])
    const installedJournal = (await stores.administrator.query('SELECT id,hash,created_at::text FROM drizzle.__drizzle_migrations ORDER BY id')).rows
    expect(installedJournal).toHaveLength(expectedJournal.length)
    expect(installedJournal.map(row => ({ hash: row.hash, created_at: row.created_at }))).toEqual(expectedJournal)
    expect(installedJournal.slice(0, 23)).toEqual(receipts)
    expect((await stores.administrator.query("SELECT count(*)::int AS n FROM public.billing_operation")).rows[0].n).toBe(0)
    await stores.migrate()
    expect(await snapshot()).toEqual(before)
    expect(await publication()).toEqual(published)
    expect((await stores.administrator.query('SELECT id,hash,created_at::text FROM drizzle.__drizzle_migrations ORDER BY id')).rows).toEqual(installedJournal)
    expect((await stores.administrator.query("SELECT count(*)::int AS n FROM public.billing_operation")).rows[0].n).toBe(0)
  } finally {
    try { await stores.cleanup() } finally {
      if (prefix) {
        if (dirname(resolve(prefix)) !== resolve(tmpdir()) || !basename(prefix).startsWith('sparra-billing-prefix-')) throw new Error('Non-owned migration prefix')
        await rm(prefix, { recursive: true })
      }
    }
  }
}, 180000)
