import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { nativeVoice, nativeValue } from '../helpers/sparra-voice-driver'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { createPersonalWorkspaces } from '../../src/modules/workspaces/personal.server'
import { createActivityOperations } from '../../src/modules/sparra/activity.server'
import { createRequestOperations } from '../../src/modules/sparra/requests.server'
import { createAuthRateLimiter, readRateLimitConfig } from '../../src/modules/auth/rate-limit.server'
import { startGoogleProtocolPeer } from '../helpers/google-protocol-peer.mjs'
import { googleCeremony } from '../helpers/google-ceremony'
import { cryptoFixture } from '../helpers/sparra-crypto-fixture'

let stores:Awaited<ReturnType<typeof startDisposableStores>>,pool:Pool,a:Client,b:Client
let auth:Awaited<ReturnType<typeof import('../../src/modules/auth/auth.server')['createApplicationAuth']>>,limiter:ReturnType<typeof createAuthRateLimiter>,peer:Awaited<ReturnType<typeof startGoogleProtocolPeer>>
let activity:ReturnType<typeof createActivityOperations>,requests:ReturnType<typeof createRequestOperations>,owner:ReturnType<typeof createTransactions>
let principalA:Awaited<ReturnType<ReturnType<typeof googleCeremony>>>['principal'],principalB:typeof principalA,workspaceA:string,workspaceB:string
let crypto:Awaited<ReturnType<typeof cryptoFixture>>
const configuration={expectedRevision:0,businessName:'Garage',sector:'garage',knowledge:{openingHours:'',services:'Vidange',prices:'',faq:'',instructions:''}}
const rpcSignatures=['voice.begin_call_v1(text,uuid,jsonb)','voice.ingest_operation_v1(jsonb)','voice.lease_recording_purge_v1(text,integer,integer)','voice.ack_recording_purge_v1(uuid,uuid,text,timestamptz)','voice.lease_call_erasure_v1(text,integer,integer)','voice.ack_call_erasure_v1(uuid,uuid,timestamptz)']
const admin=(sql:string,values?:unknown[])=>stores.administrator.query(sql,values)
const routing=(id:string,at=new Date().toISOString())=>({schema_version:1,direction:'incoming',connection_id:'connection-a',to_e164:'+33123456789',from_e164:null,telnyx_call_control_id:id,telnyx_call_leg_id:null,telnyx_call_session_id:null,admitted_at:at})
const begin=async(id=randomUUID(),route=routing(id))=>({id,route,snapshot:(await a.query('SELECT voice.begin_call_v1($1,$2,$3) AS v',['fixture-a',id,route])).rows[0].v})
const callOp=(id:string,route:ReturnType<typeof routing>,extension:Partial<{status:string;disclosure_state:string;started_at:string|null;ended_at:string|null;end_reason:string|null;retention_until:string;transcript_loss_count:number;message_result:ReturnType<typeof crypto.result>;disclosure_evidence:{schema_version:number;started_at:string|null;completed_at:string|null;failed_at:string|null;input_gate_opened_at:string|null}}>={})=>({schema_version:1,operation_id:randomUUID(),deployment_id:'fixture-a',call_id:id,occurred_at:route.admitted_at,kind:'call.upsert',payload:{telnyx_call_control_id:route.telnyx_call_control_id,telnyx_call_leg_id:null,telnyx_call_session_id:null,status:'pending',disclosure_state:'pending',started_at:null,ended_at:null,end_reason:null,retention_until:new Date(Date.parse(route.admitted_at)+2592000000).toISOString(),...extension}})
const ingest=async(op:unknown,client=a)=>(await client.query('SELECT voice.ingest_operation_v1($1) AS v',[op])).rows[0].v
const turnOp=(id:string,turn:unknown)=>({schema_version:1,operation_id:randomUUID(),deployment_id:'fixture-a',call_id:id,occurred_at:new Date().toISOString(),kind:'turn.upsert',payload:turn})
const recordingOp=(id:string,rid=randomUUID())=>({schema_version:1,operation_id:randomUUID(),deployment_id:'fixture-a',call_id:id,occurred_at:new Date().toISOString(),kind:'recording.upsert',payload:{recording_id:rid,status:'failed',telnyx_recording_id:'fixture-'+rid,channels:'dual',format:'wav',started_at:null,ended_at:null,retention_until:null}})
const row=async(id:string)=>(await admin('SELECT * FROM sparra_call WHERE id=$1',[id])).rows[0]

beforeAll(async()=>{
 stores=await startDisposableStores()
 const prefix=await mkdtemp(join(tmpdir(),'sparra-voice-prefix-'))
 try{
  await mkdir(join(prefix,'meta'));const journal=JSON.parse(await readFile('drizzle/meta/_journal.json','utf8')),entries:{tag:string}[]=journal.entries.slice(0,16)
  expect(entries.at(-1)?.tag).toBe('0015_good_jack_power')
  for(const entry of entries)await cp('drizzle/'+entry.tag+'.sql',join(prefix,entry.tag+'.sql'))
  await writeFile(join(prefix,'meta/_journal.json'),JSON.stringify({...journal,entries}));await migrate(drizzle(stores.administrator),{migrationsFolder:prefix})
  await admin(`INSERT INTO "user"(id,name,email) VALUES('voice-prefix','Before','voice-prefix@example.test'); INSERT INTO workspace(id,owner_user_id) VALUES('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','voice-prefix'); INSERT INTO sparra_knowledge_revision(workspace_id,revision,business_name,sector,opening_hours,services,prices,faq,instructions) VALUES('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',1,'Before','garage','','','','',''); INSERT INTO sparra_call(id,workspace_id,deployment_id,provider_call_control_id,admitted_at,retention_until,configuration_revision) VALUES('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','prefix','prefix',date_trunc('milliseconds',clock_timestamp()),date_trunc('milliseconds',clock_timestamp())+interval '2592000 seconds',1)`)
  const snapshot=async()=>(await admin(`SELECT (SELECT jsonb_agg(u) FROM "user" u) users,(SELECT jsonb_agg(w) FROM workspace w) workspaces,(SELECT jsonb_agg(k) FROM sparra_knowledge_revision k) revisions,(SELECT jsonb_agg(c) FROM sparra_call c) calls,(SELECT jsonb_agg(m) FROM drizzle.__drizzle_migrations m) journal`)).rows[0]
  const before=await snapshot(),hashes=await Promise.all(entries.map(async e=>createHash('sha256').update(await readFile('drizzle/'+e.tag+'.sql')).digest('hex')))
  await admin(`CREATE SEQUENCE public.fixture_voice_late; CREATE FUNCTION public.fixture_voice_fail() RETURNS event_trigger LANGUAGE plpgsql AS $$ DECLARE cmd record; BEGIN FOR cmd IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP IF cmd.command_tag='ALTER FUNCTION' AND cmd.object_identity LIKE '%ack_call_erasure_v1%' THEN PERFORM nextval('public.fixture_voice_late');RAISE EXCEPTION 'owned late migration failure';END IF;END LOOP;END $$;CREATE EVENT TRIGGER fixture_voice_fail ON ddl_command_end EXECUTE FUNCTION public.fixture_voice_fail()`)
  await expect(stores.migrate()).rejects.toThrow('Disposable migration command failed')
  if(!(await admin('SELECT is_called FROM fixture_voice_late')).rows[0].is_called){
   await admin('BEGIN');let index=0;try{for(const statement of readMigrationFiles({migrationsFolder:'drizzle'}).at(-1)!.sql){index++;await admin(statement)}}catch(error){if(!(error instanceof Error))throw new Error('Owned migration failed');throw new Error('Owned migration statement '+index+': '+error.message)}finally{await admin('ROLLBACK')}
  }
  expect((await admin('SELECT is_called FROM fixture_voice_late')).rows[0].is_called).toBe(true)
  expect(await snapshot()).toEqual(before);expect((await admin("SELECT to_regnamespace('voice') AS v")).rows[0].v).toBeNull()
  await admin('DROP EVENT TRIGGER fixture_voice_fail;DROP FUNCTION public.fixture_voice_fail();DROP SEQUENCE public.fixture_voice_late')
  await stores.migrate();const after=await snapshot()
  expect(after.users).toEqual(before.users);expect(after.workspaces).toEqual(before.workspaces);expect(after.revisions).toEqual(before.revisions)
  expect(after.calls[0]).toMatchObject(before.calls[0]);expect(after.calls[0].transcript_loss_count).toBe(0)
  expect(after.journal.slice(0,16)).toEqual(before.journal)
  expect(await Promise.all(entries.map(async e=>createHash('sha256').update(await readFile('drizzle/'+e.tag+'.sql')).digest('hex')))).toEqual(hashes)
 }finally{await rm(prefix,{recursive:true,force:true})}
 await admin(`GRANT USAGE ON SCHEMA public TO runtime;GRANT SELECT,INSERT,UPDATE,DELETE ON "user",account,session,verification TO runtime`)
 for(const role of ['sparra_voice_a','sparra_voice_b']){
  expect((await admin(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE (n.nspname='voice_private' OR p.proname='resolve_personal_workspace') AND has_function_privilege($1,p.oid,'EXECUTE')`,[role])).rows).toEqual([])
  await admin(`GRANT USAGE ON SCHEMA voice TO ${role}`)
  for(const signature of rpcSignatures)await admin(`GRANT EXECUTE ON FUNCTION ${signature} TO ${role}`)
 }
 peer=await startGoogleProtocolPeer({ports:[3000,...[stores.runtimeUrl,stores.directRuntimeUrl,stores.redisUrl].map(url=>Number(new URL(url).port))]})
 const {createApplicationAuth,readAuthConfig}=await import('../../src/modules/auth/auth.server')
 pool=new Pool({connectionString:stores.runtimeUrl,max:3});owner=createTransactions(pool,{maxStatementTimeoutMs:2000,maxCleanupTimeoutMs:1000})
 limiter=createAuthRateLimiter(readRateLimitConfig({REDIS_URL:stores.redisUrl,RATE_LIMIT_HMAC_SECRET:stores.hmac,RATE_LIMIT_KEY_ID:'voice',TRUSTED_PROXY_IPS:'127.0.0.1',NODE_ENV:'test'}));await limiter.connect()
 auth=createApplicationAuth(owner,readAuthConfig({APP_ORIGIN:'http://localhost:3000',NODE_ENV:'test',AUTH_SECRET:randomBytes(48).toString('hex'),GOOGLE_CLIENT_ID:'fixture.apps.googleusercontent.com',GOOGLE_CLIENT_SECRET:'fixture-only'})!,limiter)
 const ceremony=googleCeremony(auth,owner,peer);principalA=(await ceremony()).principal;principalB=(await ceremony()).principal
 const personal=createPersonalWorkspaces(owner);workspaceA=(await personal.ensurePersonalWorkspace(principalA))!.id;workspaceB=(await personal.ensurePersonalWorkspace(principalB))!.id
 activity=createActivityOperations(owner);requests=createRequestOperations(owner);await activity.save(principalA,configuration);await activity.save(principalB,configuration)
 await admin(`INSERT INTO voice_private.deployment_binding(service_login,service_role_oid,deployment_id,workspace_id,connection_id,to_e164,admission_enabled) SELECT 'sparra_voice_a',oid,'fixture-a',$1,'connection-a','+33123456789',true FROM pg_roles WHERE rolname='sparra_voice_a'`,[workspaceA])
 await admin(`INSERT INTO voice_private.deployment_binding(service_login,service_role_oid,deployment_id,workspace_id,connection_id,to_e164,admission_enabled) SELECT 'sparra_voice_b',oid,'fixture-b',$1,'connection-b','+33123456780',true FROM pg_roles WHERE rolname='sparra_voice_b'`,[workspaceB])
 a=new Client({connectionString:stores.voiceUrlA});b=new Client({connectionString:stores.voiceUrlB});await a.connect();await b.connect()
 crypto=await cryptoFixture();const nativeTurn=nativeValue(await nativeVoice({action:'turn',keyring_path:crypto.path,turn_id:crypto.turnId,at:new Date().toISOString()}));expect(nativeTurn.turn_id).toBe(crypto.turnId);crypto.turn={...nativeTurn,turn_id:crypto.turnId};vi.stubEnv('SPARRA_AEAD_KEYRING_PATH',crypto.path)
},180000)
afterAll(async()=>{
 vi.unstubAllEnvs();const failures:unknown[]=[]
 for(const close of [()=>a?.end(),()=>b?.end(),()=>crypto?.cleanup(),()=>auth?.close(),()=>limiter?.close(),()=>pool?.end(),()=>peer?.close(),()=>stores?.cleanup()])try{await close()}catch(e){failures.push(e)}
 if(failures.length)throw new AggregateError(failures,'Voice cleanup failed')
})

test('native session_user and execute-only catalog including restricted Workspace column locks',async()=>{
 for(const [url,role] of [[stores.voiceUrlA,'sparra_voice_a'],[stores.voiceUrlB,'sparra_voice_b']])expect(await nativeVoice({action:'identity',url})).toEqual({ok:{login:role,role}})
 expect((await admin("SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='voice'")).rows[0].n).toBe(6)
 const functions=(await admin("SELECT p.prosecdef,p.proconfig,r.rolname,p.oid::regprocedure::text signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname='voice'")).rows
 expect(functions).toHaveLength(6);for(const f of functions)expect(f).toMatchObject({prosecdef:true,rolname:'sparra_voice_definer',proconfig:['search_path=pg_catalog, pg_temp']})
 expect((await admin("SELECT rolcanlogin,rolinherit,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication FROM pg_roles WHERE rolname='sparra_voice_definer'")).rows[0]).toEqual({rolcanlogin:false,rolinherit:false,rolsuper:false,rolbypassrls:false,rolcreatedb:false,rolcreaterole:false,rolreplication:false})
 expect((await admin("SELECT count(*)::int n FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid OR r.oid=m.member WHERE r.rolname IN ('sparra_voice_definer','sparra_voice_a','sparra_voice_b')")).rows[0].n).toBe(0)
 for(const role of ['sparra_voice_a','sparra_voice_b']){
  expect((await admin(`SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','voice_private') AND c.relkind='r' AND has_table_privilege($1,c.oid,'SELECT,INSERT,UPDATE,DELETE')`,[role])).rows).toEqual([])
  expect((await admin(`SELECT has_column_privilege($1,'public.workspace','owner_user_id','SELECT') AS owner,has_schema_privilege($1,'voice_private','USAGE') AS private`,[role])).rows[0]).toEqual({owner:false,private:false})
 }
 expect((await admin(`SELECT has_column_privilege('sparra_voice_definer','public.workspace','id','UPDATE') AS lock,has_column_privilege('sparra_voice_definer','public.workspace','owner_user_id','SELECT') AS owner,has_column_privilege('sparra_voice_definer','public.sparra_call','treated_at','UPDATE') AS treat,has_table_privilege('sparra_voice_definer','public.user','SELECT') AS auth`)).rows[0]).toEqual({lock:true,owner:false,treat:false,auth:false})
 for(const signature of rpcSignatures)expect((await admin(`SELECT has_function_privilege('runtime',$1,'EXECUTE') AS allowed`,[signature])).rows[0].allowed).toBe(false)
 expect((await admin("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE (n.nspname='voice_private' OR c.relname IN ('sparra_call','sparra_erasure','sparra_knowledge_revision')) AND c.relkind='r' AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity OR c.relowner<>(SELECT oid FROM pg_roles WHERE rolname='workspace_owner'))")).rows).toEqual([])
})

test('real native begin pin is committed, stable on retry, and read through the authenticated Node owner',async()=>{
 const id=crypto.callId,route=routing(id)
 const result=nativeValue(await nativeVoice({action:'begin',url:stores.voiceUrlA,deployment:'fixture-a',call_id:id,routing:route}))
 expect(result).toMatchObject({schema_version:1,call_id:id,configuration_revision:1,knowledge:{business_name:'Garage',services:'Vidange'},transfer_destination:null,retention_until:new Date(Date.parse(route.admitted_at)+2592000000).toISOString()})
 expect(Object.keys(result).sort()).toEqual(['schema_version','call_id','configuration_revision','knowledge','transfer_destination','retention_until'].sort())
 await activity.save(principalA,{...configuration,expectedRevision:1,businessName:'Updated'})
 expect(nativeValue(await nativeVoice({action:'begin',url:stores.voiceUrlA,deployment:'fixture-a',call_id:id,routing:route}))).toEqual(result)
 expect(await requests.detail(principalA,id)).toMatchObject({configurationRevision:1,configuration:{businessName:'Garage'},transcriptLossCount:0})
 await expect(requests.detail(principalB,id)).rejects.toMatchObject({name:'RequestNotFound'})
 const nativeTurn={...crypto.turn,started_at:route.admitted_at,ended_at:route.admitted_at}
 expect(await nativeVoice({action:'ingest',url:stores.voiceUrlA,operation:turnOp(id,nativeTurn)})).toEqual({ok:{ack:true}})
 const terminal=callOp(id,route,{status:'closed',started_at:route.admitted_at,ended_at:route.admitted_at,end_reason:'hangup',message_result:crypto.result(),transcript_loss_count:3})
 expect(await nativeVoice({action:'ingest',url:stores.voiceUrlA,operation:terminal})).toEqual({ok:{ack:true}})
 expect(await requests.detail(principalA,id)).toMatchObject({resultAvailability:'available',resultQuality:'partial',summary:'Demande de rappel',transcriptAvailability:'partial',transcriptLossCount:3,unavailableTurnCount:0,transcript:[{text:'Rappelez-moi'}]})
 await expect(a.query('SELECT voice.begin_call_v1($1,$2,$3)',['fixture-a',id,route])).rejects.toMatchObject({code:'PV202'})
})

test('pending-before-begin and begin-before-pending preserve one identity, retention and pin',async()=>{
 const id=randomUUID(),route=routing(id),op=callOp(id,route)
 expect((await ingest(op)).status).toBe('applied');expect((await row(id)).configuration_revision).toBeNull()
 const one=await begin(id,route);expect(one.snapshot.configuration_revision).toBe(2)
 expect((await ingest({...op,operation_id:randomUUID()})).status).toBe('applied');expect((await row(id)).configuration_revision).toBe(2)
 const two=await begin();expect((await ingest(callOp(two.id,two.route))).status).toBe('applied')
 for(const changed of [{...route,from_e164:'+33612345678'},{...route,admitted_at:new Date(Date.parse(route.admitted_at)+1).toISOString()},{...route,telnyx_call_leg_id:'different'},{...route,connection_id:'foreign'}])await expect(a.query('SELECT voice.begin_call_v1($1,$2,$3)',['fixture-a',id,changed])).rejects.toMatchObject({code:'PV202'})
 await expect(a.query('SELECT voice.begin_call_v1($1,$2,$3)',['fixture-a',randomUUID(),route])).rejects.toMatchObject({code:'PV202'})
 for(const delta of [-300001,31000]){const fresh=randomUUID();await expect(begin(fresh,routing(fresh,new Date(Date.now()+delta).toISOString()))).rejects.toMatchObject({code:'PV202'})}
 await a.query('BEGIN');try{await a.query("SELECT set_config('app.tenant_id',$1,true)",[workspaceB]);await expect(a.query('SELECT voice.begin_call_v1($1,$2,$3)',['fixture-b',randomUUID(),route])).rejects.toMatchObject({code:'PV202'})}finally{await a.query('ROLLBACK')}
 await expect(b.query('SELECT voice.begin_call_v1($1,$2,$3)',['fixture-a',id,route])).rejects.toMatchObject({code:'PV202'})
})

test('strict operations, deterministic digest, conflict, monotone facts, loss and first immutable result',async()=>{
 const {id,route}=await begin(),op=callOp(id,route,{transcript_loss_count:4}),receipt=await ingest(op)
 const expected=(await admin("SELECT encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') AS d",[op])).rows[0].d
 expect(receipt).toEqual({schema_version:1,status:'applied',operation_id:op.operation_id,payload_sha256:expected})
 expect((await ingest(JSON.parse(JSON.stringify(op)))).status).toBe('duplicate')
 expect((await ingest({...op,payload:{...op.payload,transcript_loss_count:8}})).status).toBe('conflict');expect((await row(id)).transcript_loss_count).toBe(4)
 for(const invalid of [null,true,-1,2147483648,'2'])await expect(ingest({...op,operation_id:randomUUID(),payload:{...op.payload,transcript_loss_count:invalid}})).rejects.toMatchObject({code:'PV202'})
 for(const changed of [{...op,extra:1},{...op,payload:{...op.payload,message_result:null}},{...op,payload:{...op.payload,disclosure_evidence:null}},{...op,payload:{...op.payload,retention_until:new Date(Date.parse(route.admitted_at)+2592001000).toISOString()}}])await expect(ingest({...changed,operation_id:randomUUID()})).rejects.toMatchObject({code:'PV202'})
 const firstResult={schema_version:1,...crypto.encrypt(JSON.stringify({...crypto.inner,evidence:[]}),'result:'+id)}
 const terminal=callOp(id,route,{status:'closed',started_at:route.admitted_at,ended_at:route.admitted_at,end_reason:'closed',message_result:firstResult,transcript_loss_count:9,disclosure_state:'completed',disclosure_evidence:{schema_version:1,started_at:route.admitted_at,completed_at:route.admitted_at,failed_at:null,input_gate_opened_at:route.admitted_at}})
 await ingest(terminal);await requests.treat(principalA,id);const treated=(await row(id)).treated_at
 await ingest(callOp(id,route,{status:'failed',ended_at:route.admitted_at,end_reason:'failed',disclosure_state:'failed',transcript_loss_count:2}))
 await ingest(callOp(id,route));expect(await row(id)).toMatchObject({status:'closed',end_reason:'closed',transcript_loss_count:9,treated_at:treated,disclosure_state:'completed',disclosure_completed_at:new Date(route.admitted_at)})
 expect((await row(id)).encrypted_message_result).toEqual(firstResult)
 expect((await ingest({...terminal,operation_id:randomUUID(),payload:{...terminal.payload,message_result:{schema_version:1,...crypto.encrypt(JSON.stringify({...crypto.inner,evidence:[]}),'result:'+id)},transcript_loss_count:22}})).status).toBe('conflict')
 expect((await row(id)).transcript_loss_count).toBe(9)
})

test('whole JSONB map is bounded atomically; duplicate turns and ordinal/body conflicts do not lose retained content',async()=>{
 const {id,route}=await begin(),turnId=randomUUID(),payload={...crypto.turn,turn_id:turnId,started_at:route.admitted_at,ended_at:route.admitted_at,...crypto.encrypt('x'.repeat(16384),'turn:'+turnId)}
 const make=(i:number)=>({...payload,turn_id:i===1?turnId:randomUUID(),turn_no:i})
 let map={},lastBytes=0,rejected:ReturnType<typeof turnOp>|undefined
 for(let i=1;i<40;i++){
  const turn=make(i),op=turnOp(id,turn),next={...map,[turn.turn_id]:turn}
  const bytes=(await admin('SELECT octet_length($1::jsonb::text)::int n',[next])).rows[0].n
  if(bytes>524288){await expect(ingest(op)).rejects.toMatchObject({code:'PV202'});rejected=op;break}
  expect((await ingest(op)).status).toBe('applied');map=next;lastBytes=bytes
 }
 expect(Object.keys(map).length).toBeLessThan(200);expect(rejected).toBeDefined();expect(lastBytes).toBeLessThanOrEqual(524288)
 expect((await row(id)).encrypted_turns).toEqual(map)
 expect(await nativeVoice({action:'aggregate_size',turns:map})).toEqual({ok:{bytes:lastBytes}})
 // Size the next individually valid envelope so compact JSON fits but actual
 // PostgreSQL JSONB whitespace/metadata overhead crosses the stored bound.
 const boundaryId=randomUUID(),boundaryTurn={...payload,turn_id:boundaryId,turn_no:Object.keys(map).length+1,...crypto.encrypt('','turn:'+boundaryId)}
 const baseline=Buffer.byteLength(JSON.stringify({...map,[boundaryId]:boundaryTurn}))
 const plainSize=Math.floor((524280-baseline)*3/4)
 expect(plainSize).toBeGreaterThan(0);expect(plainSize).toBeLessThan(16384)
 const boundary={...boundaryTurn,...crypto.encrypt('x'.repeat(plainSize),'turn:'+boundaryId)},overheadMap={...map,[boundaryId]:boundary}
 expect(Buffer.byteLength(JSON.stringify(overheadMap))).toBeLessThanOrEqual(524288)
 const actualBytes=(await admin('SELECT octet_length($1::jsonb::text)::int n',[overheadMap])).rows[0].n
 expect(actualBytes).toBeGreaterThan(524288)
 expect(await nativeVoice({action:'aggregate_size',turns:overheadMap})).toEqual({ok:{bytes:actualBytes}})
 await expect(ingest(turnOp(id,boundary))).rejects.toMatchObject({code:'PV202'})
 // The largest fitting base64 quantum is retained; one extra quantum fails.
 const fitSize=plainSize-Math.ceil((actualBytes-524288)/4)*3
 const fit={...boundaryTurn,...crypto.encrypt('x'.repeat(fitSize),'turn:'+boundaryId)}
 const fittingBytes=(await admin('SELECT octet_length($1::jsonb::text)::int n',[{...map,[boundaryId]:fit}])).rows[0].n
 expect(fittingBytes).toBeLessThanOrEqual(524288);expect(524288-fittingBytes).toBeLessThan(4)
 expect((await ingest(turnOp(id,fit))).status).toBe('applied')
 const extra={...fit,turn_id:randomUUID(),turn_no:fit.turn_no+1,...crypto.encrypt('x','turn:'+randomUUID())}
 await expect(ingest(turnOp(id,extra))).rejects.toMatchObject({code:'PV202'})
 expect((await admin('SELECT count(*)::int n FROM voice_private.operation_receipt WHERE operation_id=$1',[rejected!.operation_id])).rows[0].n).toBe(0)
 expect((await ingest(turnOp(id,payload))).status).toBe('applied')
 expect((await ingest(turnOp(id,{...payload,interrupted:true}))).status).toBe('conflict')
 expect((await ingest(turnOp(id,{...payload,turn_id:randomUUID()}))).status).toBe('conflict')
})

test('native erasure and recording acknowledgements are actual SQL NULL and join local with remote cleanup',async()=>{
 const {id}=await begin(),op=recordingOp(id),rid=op.payload.recording_id
 const off={...recordingOp(id),payload:{recording_id:randomUUID(),status:'off',telnyx_recording_id:null,channels:null,format:null,started_at:null,ended_at:null,retention_until:null}}
 expect(await nativeVoice({action:'ingest',url:stores.voiceUrlA,operation:off})).toEqual({ok:{ack:true}})
 expect(await nativeVoice({action:'lease_recording',url:stores.voiceUrlA})).toEqual({ok:[]})
 expect(await nativeVoice({action:'ingest',url:stores.voiceUrlA,operation:op})).toEqual({ok:{ack:true}})
 expect(await requests.erase(principalA,id)).toEqual({requestId:id,state:'queued'})
 const local=nativeValue(await nativeVoice({action:'lease_call',url:stores.voiceUrlA})).find((e:{call_id:string})=>e.call_id===id)
 const remote=nativeValue(await nativeVoice({action:'lease_recording',url:stores.voiceUrlA})).find((e:{recording_id:string})=>e.recording_id===rid)
 if(!local||!remote)throw new Error('Owned leases missing')
 expect(Object.keys(local).sort()).toEqual(['schema_version','call_id','lease_token','deployment_id','original_retention_until','lease_expires_at'].sort())
 expect(Object.keys(remote).sort()).toEqual(['schema_version','recording_id','lease_token','telnyx_recording_id','purge_attempt','lease_expires_at'].sort())
 const at=new Date().toISOString().replace('Z','123Z')
 expect(await nativeVoice({action:'ack_call',url:stores.voiceUrlA,id,token:local.lease_token,at})).toEqual({ok:{ack:true}})
 expect((await a.query('SELECT voice.ack_call_erasure_v1($1,$2,$3) IS NULL AS v',[id,local.lease_token,at])).rows[0].v).toBe(true)
 expect(await requests.erasure(principalA,id)).toEqual({requestId:id,state:'queued'})
 expect(await nativeVoice({action:'ack_recording',url:stores.voiceUrlA,id:rid,token:remote.lease_token,outcome:'deleted',at})).toEqual({ok:{ack:true}})
 expect((await a.query("SELECT voice.ack_recording_purge_v1($1,$2,'deleted',$3) IS NULL AS v",[rid,remote.lease_token,at])).rows[0].v).toBe(true)
 expect(await requests.erasure(principalA,id)).toEqual({requestId:id,state:'completed'})
 await expect(a.query('SELECT voice.ack_call_erasure_v1($1,$2,$3)',[id,randomUUID(),at])).rejects.toMatchObject({code:'PV201'})
 expect(await nativeVoice({action:'ack_call',url:stores.voiceUrlA,id,token:randomUUID(),at})).toEqual({error:'OperationSinkStaleLeaseError'})
 await expect(b.query('SELECT voice.ack_call_erasure_v1($1,$2,$3)',[id,local.lease_token,at])).rejects.toMatchObject({code:'PV201'})
 await expect(a.query('SELECT voice.ack_call_erasure_v1(NULL,NULL,NULL)')).rejects.toMatchObject({code:'PV202'})
 await expect(ingest(turnOp(id,crypto.turn))).rejects.toMatchObject({code:'PV301'})
 const late=recordingOp(id);await ingest(late);expect(await requests.erasure(principalA,id)).toEqual({requestId:id,state:'queued'})
 const lateLease=nativeValue(await nativeVoice({action:'lease_recording',url:stores.voiceUrlA})).find((e:{recording_id:string})=>e.recording_id===late.payload.recording_id)
 if(!lateLease)throw new Error('Owned late lease missing')
 await a.query("SELECT voice.ack_recording_purge_v1($1,$2,'failed',$3)",[late.payload.recording_id,lateLease.lease_token,at]);expect(await requests.erasure(principalA,id)).toEqual({requestId:id,state:'queued'})
 expect(await row(id)).toBeUndefined()
})

test('maintenance expires content with audio off and preserves original expiry fences while admission is disabled',async()=>{
 const {id,route}=await begin()
 // Clock travel only in owned administrator fixture, preserving exact retention.
 await admin("UPDATE sparra_call SET admitted_at=admitted_at-interval '31 days',retention_until=retention_until-interval '31 days' WHERE id=$1",[id])
 await expect(requests.detail(principalA,id)).rejects.toMatchObject({name:'RequestNotFound'})
 await expect(ingest(callOp(id,route))).rejects.toMatchObject({code:'PV301'})
 await admin("UPDATE voice_private.deployment_binding SET admission_enabled=false WHERE deployment_id='fixture-a'")
 try{
  await a.query('BEGIN');await a.query("SELECT set_config('app.tenant_id',$1,true)",[workspaceB])
  await a.query("SELECT * FROM voice.lease_call_erasure_v1('fixture',30,100)")
  expect((await a.query("SELECT current_setting('app.tenant_id') v")).rows[0].v).toBe(workspaceB);await a.query('COMMIT')
  expect(await row(id)).toBeUndefined();expect((await admin('SELECT state,original_retention_until,fence_until FROM sparra_erasure WHERE call_id=$1',[id])).rows[0]).toMatchObject({state:'queued',original_retention_until:new Date(Date.parse(route.admitted_at)-86400000)})
  const op=recordingOp(id);expect((await ingest(op)).status).toBe('applied')
  expect((await a.query("SELECT * FROM voice.lease_recording_purge_v1('fixture',30,100)")).rows.some(r=>r.lease_recording_purge_v1.recording_id===op.payload.recording_id)).toBe(true)
 }finally{await a.query('ROLLBACK');await admin("UPDATE voice_private.deployment_binding SET admission_enabled=true WHERE deployment_id='fixture-a'")}
})

test('same native call survives a lost successful COMMIT reply; failed COMMIT retains neither fact nor receipt',async()=>{
 const id=randomUUID(),route=routing(id),request={url:stores.voiceUrlA,deployment:'fixture-a',call_id:id,routing:route}
 expect(await nativeVoice({...request,action:'begin_unknown_commit'})).toEqual({error:'OperationSinkCommitAmbiguousError'})
 const committed=await row(id);expect(committed.id).toBe(id)
 const retry=nativeValue(await nativeVoice({...request,action:'begin'}));expect(retry.configuration_revision).toBe(committed.configuration_revision)
 const op=callOp(id,route,{transcript_loss_count:11})
 await admin(`CREATE FUNCTION public.fixture_voice_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'owned commit failure';END$$;CREATE CONSTRAINT TRIGGER fixture_voice_commit_failure AFTER INSERT ON voice_private.operation_receipt DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fixture_voice_commit_failure()`)
 try{expect(await nativeVoice({action:'ingest',url:stores.voiceUrlA,operation:op})).toEqual({error:'OperationSinkCommitAmbiguousError'})}finally{await admin('DROP TRIGGER fixture_voice_commit_failure ON voice_private.operation_receipt;DROP FUNCTION public.fixture_voice_commit_failure()')}
 expect((await row(id)).transcript_loss_count).toBe(0)
 expect((await admin('SELECT count(*)::int n FROM voice_private.operation_receipt WHERE operation_id=$1',[op.operation_id])).rows[0].n).toBe(0)
 expect(await nativeVoice({action:'ingest',url:stores.voiceUrlA,operation:op})).toEqual({ok:{ack:true}})
})

test('native save/begin and erase/ingest serialize on the actual Workspace lock',async()=>{
 const id=randomUUID(),route=routing(id)
 await a.query('BEGIN');await a.query('SELECT voice.begin_call_v1($1,$2,$3)',['fixture-a',id,route])
 let saved=false;const saving=activity.save(principalA,{...configuration,expectedRevision:2,businessName:'After lock'}).then(v=>{saved=true;return v})
 try{
  let blocked=false
  for(let n=0;n<30;n++){blocked=(await admin("SELECT count(*)::int n FROM pg_stat_activity WHERE usename='runtime' AND wait_event_type='Lock'")).rows[0].n>0;if(blocked)break;await new Promise(r=>setTimeout(r,10))}
  expect(blocked).toBe(true);expect(saved).toBe(false);await a.query('COMMIT')
 }finally{await a.query('ROLLBACK')}
 expect((await saving)!.revision).toBe(3);expect((await row(id)).configuration_revision).toBe(2)
 await a.query('BEGIN');await ingest(callOp(id,route,{transcript_loss_count:7}))
 let erased=false;const erasing=requests.erase(principalA,id).then(v=>{erased=true;return v})
 try{
  let blocked=false
  for(let n=0;n<30;n++){blocked=(await admin("SELECT count(*)::int n FROM pg_stat_activity WHERE usename='runtime' AND wait_event_type='Lock'")).rows[0].n>0;if(blocked)break;await new Promise(r=>setTimeout(r,10))}
  expect(blocked).toBe(true);expect(erased).toBe(false);await a.query('COMMIT')
 }finally{await a.query('ROLLBACK')}
 expect(await erasing).toEqual({requestId:id,state:'queued'});expect(await row(id)).toBeUndefined()
 await expect(ingest(callOp(id,route))).rejects.toMatchObject({code:'PV301'})
})

test('recording failed/retry stays queued; replaced tokens fail, deleting Workspace still cleans, and completed fence GC never revives original expiry',async()=>{
 const {id,route}=await begin(),op=recordingOp(id),rid=op.payload.recording_id
 await ingest(op);await requests.erase(principalA,id)
 let local=(await a.query("SELECT * FROM voice.lease_call_erasure_v1('fixture',30,100)")).rows.map(r=>r.lease_call_erasure_v1).find(r=>r.call_id===id)
 const remote=(await a.query("SELECT * FROM voice.lease_recording_purge_v1('fixture',1,100)")).rows.map(r=>r.lease_recording_purge_v1).find(r=>r.recording_id===rid)
 await admin("UPDATE voice_private.recording_purge SET lease_until=clock_timestamp()-interval '1 second' WHERE recording_id=$1",[rid])
 await expect(a.query("SELECT voice.ack_recording_purge_v1($1,$2,'deleted',$3)",[rid,remote.lease_token,new Date().toISOString()])).rejects.toMatchObject({code:'PV201'})
 await admin("UPDATE sparra_erasure SET lease_until=clock_timestamp()-interval '1 second' WHERE call_id=$1",[id])
 await expect(a.query('SELECT voice.ack_call_erasure_v1($1,$2,$3)',[id,local.lease_token,new Date().toISOString()])).rejects.toMatchObject({code:'PV201'})
 local=(await a.query("SELECT * FROM voice.lease_call_erasure_v1('fixture',30,100)")).rows.map(r=>r.lease_call_erasure_v1).find(r=>r.call_id===id)
 const replacement=(await a.query("SELECT * FROM voice.lease_recording_purge_v1('fixture',30,100)")).rows.map(r=>r.lease_recording_purge_v1).find(r=>r.recording_id===rid)
 const at=new Date().toISOString()
 await expect(a.query("SELECT voice.ack_recording_purge_v1($1,$2,'deleted',$3)",[rid,remote.lease_token,at])).rejects.toMatchObject({code:'PV201'})
 await a.query("SELECT voice.ack_recording_purge_v1($1,$2,'retry',$3)",[rid,replacement.lease_token,at]);expect(await requests.erasure(principalA,id)).toEqual({requestId:id,state:'queued'})
 await admin("UPDATE workspace SET lifecycle='deleting' WHERE id=$1",[workspaceA])
 try{
  await a.query('SELECT voice.ack_call_erasure_v1($1,$2,$3)',[id,local.lease_token,at])
  await admin("UPDATE voice_private.recording_purge SET retry_at=clock_timestamp()-interval '1 second' WHERE recording_id=$1",[rid])
  const next=(await a.query("SELECT * FROM voice.lease_recording_purge_v1('fixture',30,100)")).rows.map(r=>r.lease_recording_purge_v1).find(r=>r.recording_id===rid)
  expect((await a.query("SELECT voice.ack_recording_purge_v1($1,$2,'not_found',$3) IS NULL v",[rid,next.lease_token,at])).rows[0].v).toBe(true)
  expect((await admin('SELECT state FROM sparra_erasure WHERE call_id=$1',[id])).rows[0].state).toBe('completed')
 }finally{await admin("UPDATE workspace SET lifecycle='active' WHERE id=$1",[workspaceA])}
 // One owned fixture clock-travel transaction must temporarily suspend only the
 // immutable fence trigger to move original expiry; production never does this.
 await admin('BEGIN')
 try{
  await admin('ALTER TABLE sparra_erasure DISABLE TRIGGER sparra_erasure_guard')
  await admin("UPDATE sparra_erasure SET original_retention_until=original_retention_until-interval '31 days',fence_until=fence_until-interval '31 days' WHERE call_id=$1",[id])
  await admin("UPDATE voice_private.operation_receipt SET original_retention_until=original_retention_until-interval '31 days' WHERE call_id=$1",[id])
  await admin("UPDATE voice_private.recording_purge SET original_retention_until=original_retention_until-interval '31 days' WHERE call_id=$1",[id])
  await admin('ALTER TABLE sparra_erasure ENABLE TRIGGER sparra_erasure_guard');await admin('COMMIT')
 }catch(error){await admin('ROLLBACK');throw error}
 await a.query("SELECT * FROM voice.lease_call_erasure_v1('fixture',30,100)")
 expect((await admin('SELECT count(*)::int n FROM sparra_erasure WHERE call_id=$1',[id])).rows[0].n).toBe(0)
 expect((await admin('SELECT count(*)::int n FROM voice_private.operation_receipt WHERE call_id=$1',[id])).rows[0].n).toBe(0)
 const original=routing(id,new Date(Date.parse(route.admitted_at)-31*86400000).toISOString())
 await expect(ingest(callOp(id,original))).rejects.toMatchObject({code:'PV301'})
 await expect(ingest(recordingOp(id))).rejects.toMatchObject({code:'PV202'})
 await expect(begin(id,original)).rejects.toMatchObject({code:'PV202'})
 await activity.save(principalA,{...configuration,expectedRevision:3,businessName:'Current retained'})
 await a.query("SELECT * FROM voice.lease_call_erasure_v1('fixture',30,100)")
 expect((await admin('SELECT revision FROM sparra_knowledge_revision WHERE workspace_id=$1 ORDER BY revision',[workspaceA])).rows.map(r=>r.revision)).toEqual([1,2,4])
 await expect(admin('UPDATE sparra_knowledge_revision SET business_name=business_name WHERE workspace_id=$1 AND revision=4',[workspaceA])).rejects.toMatchObject({code:'23514'})
})

test('binding tuple cannot change and a renamed or recreated login does not inherit the old role OID',async()=>{
 await expect(admin("UPDATE voice_private.deployment_binding SET workspace_id=$1 WHERE deployment_id='fixture-a'",[workspaceB])).rejects.toMatchObject({code:'23514'})
 const before=(await admin("SELECT oid FROM pg_roles WHERE rolname='sparra_voice_b'")).rows[0].oid
 await admin('ALTER ROLE sparra_voice_b RENAME TO sparra_voice_b_old')
 try{
  await expect(b.query("SELECT * FROM voice.lease_call_erasure_v1('fixture',30,1)")).rejects.toMatchObject({code:'PV202'})
  // Recreate the old catalog name with a distinct OID and the owned userlist's
  // generated password. Reconnect only this fixture's PgBouncer backends so the
  // native Python client actually authenticates the new catalog login.
  const password=decodeURIComponent(new URL(stores.voiceUrlB).password)
  if(!/^[0-9a-f]{64}$/.test(password))throw new Error('Owned voice password shape')
  await admin(`CREATE ROLE sparra_voice_b LOGIN PASSWORD '${password}' NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`)
  expect((await admin("SELECT oid FROM pg_roles WHERE rolname='sparra_voice_b'")).rows[0].oid).not.toBe(before)
  await admin('GRANT USAGE ON SCHEMA voice TO sparra_voice_b')
  for(const signature of rpcSignatures)await admin(`GRANT EXECUTE ON FUNCTION ${signature} TO sparra_voice_b`)
  await b.end()
  const poolAdmin=await stores.poolAdmin();try{await poolAdmin.query('RECONNECT auth')}finally{await poolAdmin.end()}
  expect(await nativeVoice({action:'identity',url:stores.voiceUrlB})).toEqual({ok:{login:'sparra_voice_b',role:'sparra_voice_b'}})
  expect(await nativeVoice({action:'lease_call',url:stores.voiceUrlB})).toEqual({error:'OperationSinkPermanentError'})
 }finally{
  await admin('DROP OWNED BY sparra_voice_b');await admin('DROP ROLE sparra_voice_b');await admin('ALTER ROLE sparra_voice_b_old RENAME TO sparra_voice_b')
 }
})
