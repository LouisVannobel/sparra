import { afterAll, beforeAll, expect, test } from 'vitest'
import { randomUUID, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Client } from 'pg'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { startRecordingArchiveFixture, type ArchivedFixture, type NativeRecordingRouting, type NativeRecordingSnapshot } from '../helpers/sparra-recording-archive-driver'

// The break this suite catches: native receipt rejection, mutable receipt state,
// or acceptance without making the existing provider-copy purge due atomically.
// All valid receipt bytes below come from the actual Voice archive/writer. The
// ON pin and disclosure facts are controlled historical fixture data; production
// capability admission stays closed and France/provider qualification is separate.
let stores:Awaited<ReturnType<typeof startDisposableStores>>,archive:Awaited<ReturnType<typeof startRecordingArchiveFixture>>,a:Client,b:Client
let main:ArchivedFixture,strict:ArchivedFixture,atomic:ArchivedFixture,lost:ArchivedFixture,erased:ArchivedFixture,expired:ArchivedFixture,cleanupCase:ArchivedFixture
let off:{id:string;route:NativeRecordingRouting;snapshot:NativeRecordingSnapshot}
const workspaceA='11111111-1111-4111-8111-111111111111',workspaceB='22222222-2222-4222-8222-222222222222'
const admin=(sql:string,values?:unknown[])=>stores.administrator.query(sql,values)
const ingest=async(operation:unknown,client=a)=>(await client.query('SELECT voice.ingest_operation_v1($1::jsonb) AS v',[typeof operation==='string'?operation:JSON.stringify(operation)])).rows[0].v
const receiptRow=async(fixture:ArchivedFixture)=>(await admin(`SELECT recording_id,call_id,provider_recording_id,original_retention_until,
  archive_ciphertext_sha256,archive_encrypted_bytes,archive_key_version::text,retry_at,outcome,lease_token,ack_token
  FROM voice_private.recording_purge WHERE recording_id=$1`,[fixture.recordingId])).rows[0]
const recordingLease=async(fixture:ArchivedFixture)=>(await a.query("SELECT * FROM voice.lease_recording_purge_v1('receipt-fixture',30,100)")).rows.map(row=>row.lease_recording_purge_v1).find(row=>row.recording_id===fixture.recordingId)
async function begin(){
  const id=randomUUID(),route:NativeRecordingRouting={schema_version:1,direction:'incoming',connection_id:'connection-a',to_e164:'+33123456789',from_e164:null,
    telnyx_call_control_id:'fixture-call-'+id,telnyx_call_leg_id:'fixture-leg-'+id,telnyx_call_session_id:'fixture-session-'+id,admitted_at:new Date().toISOString()}
  const snapshot:NativeRecordingSnapshot=(await a.query('SELECT voice.begin_call_v1($1,$2,$3) AS v',['fixture-a',id,route])).rows[0].v
  return {id,route,snapshot}
}
async function prepare(){
  const call=await begin()
  expect(call.snapshot.recording_enabled).toBe(true)
  return archive.prepare({url:stores.voiceUrlA,deployment:'fixture-a',routing:call.route,snapshot:call.snapshot})
}
async function prime(fixture:ArchivedFixture){
  for(const bytes of fixture.operations)if(bytes!==fixture.receiptBytes)expect((await ingest(bytes)).status).toMatch(/^(applied|duplicate)$/)
}
async function postpone(fixture:ArchivedFixture){
  await admin("UPDATE voice_private.recording_purge SET retry_at=clock_timestamp()+interval '1 day' WHERE recording_id=$1",[fixture.recordingId])
}
async function eraseNative(fixture:ArchivedFixture){
  await admin('BEGIN')
  try{
    await admin("SELECT set_config('app.tenant_id',$1,true)",[workspaceA])
    await admin('UPDATE sparra_call SET erasure_requested_at=clock_timestamp() WHERE id=$1',[fixture.callId])
    await admin('COMMIT')
  }catch(error){await admin('ROLLBACK');throw error}
}

beforeAll(async()=>{
  const journal=JSON.parse(await readFile('drizzle/meta/_journal.json','utf8'))
  const legacy:{tag:string}[]=journal.entries.slice(0,18)
  expect(legacy.at(-1)?.tag).toBe('0017_company_recording_policy')
  const hashes=await Promise.all(legacy.map(async entry=>createHash('sha256').update(await readFile('drizzle/'+entry.tag+'.sql')).digest('hex')))
  stores=await startDisposableStores()
  await stores.migrate()
  expect(await Promise.all(legacy.map(async entry=>createHash('sha256').update(await readFile('drizzle/'+entry.tag+'.sql')).digest('hex')))).toEqual(hashes)
  await admin(`INSERT INTO "user"(id,name,email) VALUES('receipt-a','Receipt A','receipt-a@example.test'),('receipt-b','Receipt B','receipt-b@example.test')`)
  await admin("INSERT INTO workspace(id,owner_user_id) VALUES($1,'receipt-a'),($2,'receipt-b')",[workspaceA,workspaceB])
  await admin(`INSERT INTO sparra_knowledge_revision(workspace_id,revision,business_name,sector,opening_hours,services,prices,faq,instructions,recording_enabled)
    VALUES($1,1,'Garage','garage','','','','','',false),($1,2,'Garage','garage','','','','','',true),($2,1,'Foreign','garage','','','','','',false)`,[workspaceA,workspaceB])
  for(const [role,deployment,workspace,connection,did,audio] of [
    ['sparra_voice_a','fixture-a',workspaceA,'connection-a','+33123456789',true],
    ['sparra_voice_b','fixture-b',workspaceB,'connection-b','+33123456780',false],
  ] as const){
    await admin(`GRANT USAGE ON SCHEMA voice TO ${role}`)
    for(const signature of ['voice.begin_call_v1(text,uuid,jsonb)','voice.ingest_operation_v1(jsonb)','voice.lease_recording_purge_v1(text,integer,integer)',
      'voice.ack_recording_purge_v1(uuid,uuid,text,timestamptz)','voice.lease_call_erasure_v1(text,integer,integer)','voice.ack_call_erasure_v1(uuid,uuid,timestamptz)'])await admin(`GRANT EXECUTE ON FUNCTION ${signature} TO ${role}`)
    await admin(`INSERT INTO voice_private.deployment_binding(service_login,service_role_oid,deployment_id,workspace_id,connection_id,to_e164,admission_enabled,audio_enabled)
      SELECT $1,oid,$2,$3,$4,$5,true,$6 FROM pg_roles WHERE rolname=$1`,[role,deployment,workspace,connection,did,audio])
  }
  a=new Client({connectionString:stores.voiceUrlA});b=new Client({connectionString:stores.voiceUrlB});await a.connect();await b.connect()
  archive=await startRecordingArchiveFixture()
  main=await prepare();strict=await prepare();atomic=await prepare();lost=await prepare();erased=await prepare();cleanupCase=await prepare()
  const historical=await begin()
  // Only owned fixture clock travel; both native admission/deadline stay30days apart.
  await admin("UPDATE sparra_call SET admitted_at=admitted_at-interval '31 days',retention_until=retention_until-interval '31 days' WHERE id=$1",[historical.id])
  const old=(await admin('SELECT admitted_at,retention_until FROM sparra_call WHERE id=$1',[historical.id])).rows[0]
  expired=await archive.prepare({url:stores.voiceUrlA,deployment:'fixture-a',routing:{...historical.route,admitted_at:old.admitted_at.toISOString()},snapshot:{...historical.snapshot,retention_until:old.retention_until.toISOString()}})
  await admin(`INSERT INTO sparra_knowledge_revision(workspace_id,revision,business_name,sector,opening_hours,services,prices,faq,instructions,recording_enabled)
    VALUES($1,3,'Current OFF','garage','','','','','',false)`,[workspaceA])
  off=await begin();expect(off.snapshot.recording_enabled).toBe(false)
},120000)

afterAll(async()=>{
  const failures:unknown[]=[]
  for(const close of [()=>archive?.cleanup(),()=>a?.end(),()=>b?.end(),()=>stores?.cleanup()])try{await close()}catch(error){failures.push(error)}
  if(failures.length)throw new AggregateError(failures,'Recording receipt fixture cleanup failed')
},30000)

test('actual Voice archived receipt commits with provider purge due',async()=>{
  expect(main).toMatchObject({ciphertextBytes:188,ledgerState:'archived'})
  expect(main.operation.payload.archive_receipt.retention_until).toBe(new Date(Date.parse(main.operation.payload.retention_until)).toISOString())
  await prime(main);await postpone(main)
  expect(await recordingLease(main)).toBeUndefined()
  // Current0017 rejects the actual new receipt. This resolves assertion is the
  // first genuine RED; preparation errors are not counted as that RED.
  let delivered:Awaited<ReturnType<typeof archive.relay>>|undefined
  try{delivered=await archive.relay(main.callId)}catch(relayError){
    // Diagnostic after actual relay dispatch: distinguish the native contract
    // SQLSTATE from its intentionally conservative COMMIT-ambiguity mapping.
    for(const bytes of main.operations)if(bytes!==main.receiptBytes)await expect(archive.ingest(main.callId,bytes)).resolves.toEqual({ack:true})
    const before=(await admin('SELECT count(*)::int n FROM voice_private.operation_receipt WHERE operation_id=$1',[main.operation.operation_id])).rows[0].n
    let sqlstate:string|null=null
    try{await ingest(main.receiptBytes)}catch(error){if(error instanceof Error&&'code' in error&&typeof error.code==='string')sqlstate=error.code;else throw error}
    const after=(await admin('SELECT count(*)::int n FROM voice_private.operation_receipt WHERE operation_id=$1',[main.operation.operation_id])).rows[0].n
    const witness=await archive.witness(main.callId)
    console.log('RECORDING_RECEIPT_NATIVE_DIAGNOSTIC '+JSON.stringify({kind:main.operation.kind,archive_receipt_present:true,sqlstate,nativeReceiptRowsBefore:before,nativeReceiptRowsAfter:after,...witness}))
    if(sqlstate==='PV202'){
      expect(after).toBe(before);expect(witness.ledger_state).toBe('archived');expect(witness.recording_outbox_rows).toBe(1)
      expect(witness.outbox_head_kind).toBe('recording.upsert');expect(witness.outbox_head_operation_id).toBe(main.operation.operation_id)
    }
    await expect(Promise.reject(relayError)).resolves.toMatchObject({status:'delivered',ledgerState:'acknowledged'})
  }
  expect(delivered).toMatchObject({status:'delivered',ledgerState:'acknowledged'})
  expect(await receiptRow(main)).toMatchObject({archive_ciphertext_sha256:main.ciphertextSha256,archive_encrypted_bytes:188,archive_key_version:'1',outcome:null})
  const lease=await recordingLease(main)
  expect(lease).toMatchObject({recording_id:main.recordingId,telnyx_recording_id:main.operation.payload.telnyx_recording_id,purge_attempt:1})
  expect(Object.keys(lease).sort()).toEqual(['schema_version','recording_id','lease_token','telnyx_recording_id','purge_attempt','lease_expires_at'].sort())
})

test('native receipt shape and exact integer/canonical deadline validation reject metadata coercion',async()=>{
  await prime(strict) // Native policy/disclosure admission cannot mask shape failures.
  const operation=strict.operation,receipt=operation.payload.archive_receipt
  const malformed:unknown[]=[null,{...receipt,url:'https://example.invalid/audio'},Object.fromEntries(Object.entries(receipt).filter(([key])=>key!=='key_version')),
    ...[true,'188',null,16,33554449,188.5].map(encrypted_bytes=>({...receipt,encrypted_bytes})),
    ...[true,'1',0,9007199254740992].map(key_version=>({...receipt,key_version})),
    {...receipt,ciphertext_sha256:receipt.ciphertext_sha256.toUpperCase()},{...receipt,ciphertext_sha256:'a'.repeat(63)},
    {...receipt,recording_id:randomUUID()},
    ...[receipt.retention_until.replace('Z','+00:00'),receipt.retention_until.replace('Z','0Z')].map(retention_until=>({...receipt,retention_until})),
  ]
  // Omit all milliseconds regardless of this run's dynamic admission fraction.
  malformed.push({...receipt,retention_until:receipt.retention_until.replace(/\.\d{3}Z$/,'Z')})
  for(const archive_receipt of malformed)await expect(ingest({...operation,payload:{...operation.payload,archive_receipt}})).rejects.toMatchObject({code:'PV202'})
  const extended=new Date(Date.parse(receipt.retention_until)+1).toISOString()
  await expect(ingest({...operation,payload:{...operation.payload,retention_until:extended,archive_receipt:{...receipt,retention_until:extended}}})).rejects.toMatchObject({code:'PV202'})
  expect((await admin('SELECT count(*)::int n FROM voice_private.operation_receipt WHERE operation_id=$1',[operation.operation_id])).rows[0].n).toBe(0)
})

test('native pin and bound Workspace/deployment/provider identity cannot be supplied by a callback',async()=>{
  // Current latest OFF does not change the authentic earlier ON pin.
  expect((await admin('SELECT configuration_revision FROM sparra_call WHERE id=$1',[strict.callId])).rows[0].configuration_revision).toBe(2)
  await expect(ingest(strict.receiptBytes,b)).rejects.toMatchObject({code:'PV202'})
  await expect(ingest({...strict.operation,deployment_id:'fixture-b'},b)).rejects.toMatchObject({code:'PV202'})
  const active=JSON.parse(strict.operations.find(bytes=>{const value=JSON.parse(bytes);return value.kind==='call.upsert'&&value.payload.status==='active'})!)
  const started=off.route.admitted_at,completed=new Date(Date.parse(started)+1000).toISOString(),gate=new Date(Date.parse(started)+2000).toISOString()
  await ingest({...active,operation_id:randomUUID(),call_id:off.id,occurred_at:gate,payload:{...active.payload,
    telnyx_call_control_id:off.route.telnyx_call_control_id,telnyx_call_leg_id:off.route.telnyx_call_leg_id,telnyx_call_session_id:off.route.telnyx_call_session_id,
    started_at:started,retention_until:off.snapshot.retention_until,disclosure_evidence:{schema_version:1,started_at:started,completed_at:completed,failed_at:null,input_gate_opened_at:gate}}})
  const foreignReceiptId=randomUUID()
  const changedCall={...strict.operation,call_id:off.id,occurred_at:gate,payload:{...strict.operation.payload,recording_id:foreignReceiptId,telnyx_recording_id:'fixture-off-'+off.id,
    started_at:started,ended_at:completed,retention_until:off.snapshot.retention_until,
    archive_receipt:{...strict.operation.payload.archive_receipt,recording_id:foreignReceiptId,retention_until:off.snapshot.retention_until}}}
  await expect(ingest(changedCall)).rejects.toMatchObject({code:'PV202'})
  await prime(strict)
  expect((await ingest(strict.receiptBytes)).status).toBe('applied')
  const collision=randomUUID()
  expect((await ingest({...strict.operation,operation_id:randomUUID(),payload:{...strict.operation.payload,recording_id:collision,
    archive_receipt:{...strict.operation.payload.archive_receipt,recording_id:collision}}})).status).toBe('conflict')
})

test('old receiptless bytes and changed receipts cannot clear accepted metadata or terminal purge ACK',async()=>{
  await prime(strict);expect((await ingest(strict.receiptBytes)).status).toMatch(/^(applied|duplicate)$/)
  const lease=await recordingLease(strict),at=new Date().toISOString()
  expect((await a.query("SELECT voice.ack_recording_purge_v1($1,$2,'deleted',$3) IS NULL AS v",[strict.recordingId,lease.lease_token,at])).rows[0].v).toBe(true)
  const accepted=await receiptRow(strict)
  for(const bytes of strict.operations)if(bytes!==strict.receiptBytes){const parsed=JSON.parse(bytes);if(parsed.kind==='recording.upsert'){expect(Object.hasOwn(parsed.payload,'archive_receipt')).toBe(false);expect((await ingest(bytes)).status).toBe('duplicate')}}
  const saved=JSON.parse(strict.operations.find(bytes=>JSON.parse(bytes).kind==='recording.upsert'&&bytes!==strict.receiptBytes)!)
  // A controlled legacy purged event still passes the actual producer model
  // and native sink; only the genuine leased ACK above proves native deletion.
  await expect(archive.ingest(strict.callId,JSON.stringify({...saved,operation_id:randomUUID(),payload:{...saved.payload,status:'purged'}}))).resolves.toEqual({ack:true})
  expect((await ingest(JSON.stringify(saved))).status).toBe('duplicate')
  expect((await ingest(strict.receiptBytes)).status).toBe('duplicate')
  const changed={...strict.operation,payload:{...strict.operation.payload,archive_receipt:{...strict.operation.payload.archive_receipt,ciphertext_sha256:'0'.repeat(64)}}}
  expect((await ingest(changed)).status).toBe('conflict')
  expect((await ingest({...changed,operation_id:randomUUID()})).status).toBe('conflict')
  expect(await receiptRow(strict)).toEqual(accepted)
  expect(await recordingLease(strict)).toBeUndefined()
  await expect(admin('UPDATE voice_private.recording_purge SET archive_ciphertext_sha256=$1 WHERE recording_id=$2',['0'.repeat(64),strict.recordingId])).rejects.toMatchObject({code:'23514'})
})

test('native deferred commit failure rolls back receipt metadata and immediate purge due together',async()=>{
  await prime(atomic);await postpone(atomic)
  const before=await receiptRow(atomic)
  await admin(`CREATE FUNCTION public.fixture_recording_receipt_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'owned receipt commit failure';END$$;
    CREATE CONSTRAINT TRIGGER fixture_recording_receipt_commit_failure AFTER INSERT ON voice_private.operation_receipt DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW WHEN (NEW.operation_id='${atomic.operation.operation_id}'::uuid) EXECUTE FUNCTION public.fixture_recording_receipt_commit_failure()`)
  try{await expect(archive.ingest(atomic.callId,atomic.receiptBytes)).rejects.toThrow('OperationSinkCommitAmbiguousError')}
  finally{await admin('DROP TRIGGER fixture_recording_receipt_commit_failure ON voice_private.operation_receipt;DROP FUNCTION public.fixture_recording_receipt_commit_failure()')}
  expect(await receiptRow(atomic)).toEqual(before)
  expect((await admin('SELECT count(*)::int n FROM voice_private.operation_receipt WHERE operation_id=$1',[atomic.operation.operation_id])).rows[0].n).toBe(0)
  expect(await recordingLease(atomic)).toBeUndefined()
  await expect(archive.relay(atomic.callId)).resolves.toMatchObject({status:'delivered',ledgerState:'acknowledged'})
  expect(await recordingLease(atomic)).toBeDefined()
})

test('lost native receipt COMMIT reply replays the unchanged operation before actual local ACK',async()=>{
  await prime(lost);await postpone(lost)
  await expect(archive.ingest(lost.callId,lost.receiptBytes,true)).rejects.toThrow('OperationSinkCommitAmbiguousError')
  expect(await receiptRow(lost)).toMatchObject({archive_ciphertext_sha256:lost.ciphertextSha256,archive_encrypted_bytes:188})
  expect((await ingest(lost.receiptBytes)).status).toBe('duplicate')
  await expect(archive.relay(lost.callId)).resolves.toMatchObject({status:'delivered',ledgerState:'acknowledged'})
  expect((await admin('SELECT count(*)::int n FROM voice_private.operation_receipt WHERE operation_id=$1',[lost.operation.operation_id])).rows[0].n).toBe(1)
})

test('erased and expired late receipts retain provider-copy obligations without archive availability',async()=>{
  await prime(erased);await postpone(erased);await eraseNative(erased)
  expect((await admin('SELECT count(*)::int n FROM sparra_call WHERE id=$1',[erased.callId])).rows[0].n).toBe(0)
  // Native expiry uses its actual original deadline; the fictional ciphertext
  // was produced as historical fixture data, never archived by a late runtime.
  for(const bytes of expired.operations){const operation=JSON.parse(bytes);if(operation.kind==='recording.upsert'&&!Object.hasOwn(operation.payload,'archive_receipt'))await ingest(bytes)}
  await postpone(expired)
  for(const fixture of [erased,expired]){
    expect((await ingest(fixture.receiptBytes)).status).toBe('applied')
    expect(await receiptRow(fixture)).toMatchObject({archive_ciphertext_sha256:null,archive_encrypted_bytes:null,archive_key_version:null,outcome:null})
    expect(await recordingLease(fixture)).toBeDefined()
    expect((await admin('SELECT count(*)::int n FROM sparra_call WHERE id=$1',[fixture.callId])).rows[0].n).toBe(0)
    expect((await admin('SELECT state,local_cleanup_completed_at FROM sparra_erasure WHERE call_id=$1',[fixture.callId])).rows[0]).toEqual({state:'queued',local_cleanup_completed_at:null})
  }
})

test('provider NULL ACK remains distinct from actual archive unlink and local cleanup NULL ACK',async()=>{
  await prime(cleanupCase);expect((await ingest(cleanupCase.receiptBytes)).status).toBe('applied')
  const lease=await recordingLease(cleanupCase),at=new Date().toISOString()
  // Controlled native worker outcome; this is not Telnyx deletion qualification.
  for(let replay=0;replay<2;replay++)expect((await a.query("SELECT voice.ack_recording_purge_v1($1,$2,'deleted',$3) IS NULL AS v",[cleanupCase.recordingId,lease.lease_token,at])).rows[0].v).toBe(true)
  await expect(a.query("SELECT voice.ack_recording_purge_v1($1,$2,'deleted',$3)",[cleanupCase.recordingId,randomUUID(),at])).rejects.toMatchObject({code:'PV201'})
  await eraseNative(cleanupCase)
  expect((await admin('SELECT state,local_cleanup_completed_at FROM sparra_erasure WHERE call_id=$1',[cleanupCase.callId])).rows[0]).toEqual({state:'queued',local_cleanup_completed_at:null})
  const local=(await a.query("SELECT * FROM voice.lease_call_erasure_v1('receipt-fixture',30,100)")).rows.map(row=>row.lease_call_erasure_v1).find(row=>row.call_id===cleanupCase.callId)
  expect(Object.keys(local).sort()).toEqual(['schema_version','call_id','lease_token','deployment_id','original_retention_until','lease_expires_at'].sort())
  await expect(archive.erase(cleanupCase.callId,local.lease_token)).resolves.toEqual({files_removed:true,ack:true})
  expect((await admin('SELECT state,local_cleanup_completed_at IS NOT NULL AS cleaned FROM sparra_erasure WHERE call_id=$1',[cleanupCase.callId])).rows[0]).toEqual({state:'completed',cleaned:true})
})

test('receipt columns retain FORCE RLS and execute-only native authority',async()=>{
  expect((await admin(`SELECT c.relrowsecurity,c.relforcerowsecurity,r.rolname FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner
    WHERE c.oid='voice_private.recording_purge'::regclass`)).rows[0]).toEqual({relrowsecurity:true,relforcerowsecurity:true,rolname:'workspace_owner'})
  for(const role of ['sparra_voice_a','sparra_voice_b'])expect((await admin("SELECT has_table_privilege($1,'voice_private.recording_purge','SELECT,INSERT,UPDATE,DELETE') allowed",[role])).rows[0].allowed).toBe(false)
  expect((await admin("SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='voice'")).rows[0].n).toBe(6)
})
