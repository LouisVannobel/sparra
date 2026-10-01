import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { fetch as loopbackFetch } from 'undici'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { createPersonalWorkspaces } from '../../src/modules/workspaces/personal.server'
import { createActivityOperations } from '../../src/modules/sparra/activity.server'
import { createRequestOperations } from '../../src/modules/sparra/requests.server'
import { startGoogleProtocolPeer } from '../helpers/google-protocol-peer.mjs'
import { googleCeremony } from '../helpers/google-ceremony'
import { createAuthRateLimiter, readRateLimitConfig } from '../../src/modules/auth/rate-limit.server'
import type { createApplicationAuth } from '../../src/modules/auth/auth.server'
import { startWeb, bounded, unusedLoopbackPort } from '../helpers/web-process'
import { authRpcPath, rpcBody } from '../helpers/auth-rpc'
import { cryptoFixture, nativeVoiceTurn } from '../helpers/sparra-crypto-fixture'

let stores: Awaited<ReturnType<typeof startDisposableStores>>,pool:Pool
let requests:ReturnType<typeof createRequestOperations>,personal:ReturnType<typeof createPersonalWorkspaces>,activity:ReturnType<typeof createActivityOperations>
let auth:ReturnType<typeof createApplicationAuth>,limiter:ReturnType<typeof createAuthRateLimiter>,peer:Awaited<ReturnType<typeof startGoogleProtocolPeer>>,ceremony:ReturnType<typeof googleCeremony>
let app:ReturnType<typeof startWeb>,origin:string,crypto:Awaited<ReturnType<typeof cryptoFixture>>
const configuration={expectedRevision:0,businessName:'Garage',sector:'garage',knowledge:{openingHours:'',services:'Vidange',prices:'',faq:'',instructions:''}}
const inventory=async(id:string)=>(await stores.administrator.query('SELECT (SELECT count(*)::int FROM sparra_call WHERE id=$1) AS calls,(SELECT count(*)::int FROM sparra_erasure WHERE call_id=$1) AS fences',[id])).rows[0]
async function call(workspaceId:string,options:{id?:string;status?:string;revision?:number;admittedAt?:Date;retentionUntil?:Date;turns?:unknown;result?:unknown;endedAt?:Date}={}){
  const id=options.id??randomUUID(),admitted=options.admittedAt??new Date()
  await stores.administrator.query(`INSERT INTO sparra_call(id,workspace_id,deployment_id,provider_call_control_id,admitted_at,retention_until,status,configuration_revision,encrypted_turns,encrypted_message_result,ended_at) VALUES($1::uuid,$2,'fixture',$1::text,$3,$4,$5,$6,$7,$8,$9)`,[id,workspaceId,admitted,options.retentionUntil??new Date(admitted.getTime()+2592000000),options.status??'pending',options.revision??null,options.turns??{},options.result??null,options.endedAt??null])
  return id
}
beforeAll(async()=>{
  stores=await startDisposableStores()
  const dir=await mkdtemp(join(tmpdir(),'sparra-inbox-prefix-'))
  try{
    await mkdir(join(dir,'meta'))
    const journal=JSON.parse(await readFile('drizzle/meta/_journal.json','utf8')),entries:{tag:string}[]=journal.entries.slice(0,15)
    expect(entries.at(-1)?.tag).toBe('0014_chemical_lifeguard')
    for(const entry of entries)await cp('drizzle/'+entry.tag+'.sql',join(dir,entry.tag+'.sql'))
    await writeFile(join(dir,'meta/_journal.json'),JSON.stringify({...journal,entries}))
    await migrate(drizzle(stores.administrator),{migrationsFolder:dir})
    await stores.administrator.query(`INSERT INTO "user"(id,name,email) VALUES('inbox-prefix','Before','inbox-prefix@example.test'); INSERT INTO workspace(id,owner_user_id) VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','inbox-prefix'); INSERT INTO sparra_knowledge_revision(workspace_id,revision,business_name,sector,opening_hours,services,prices,faq,instructions) VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,'Before','garage','','','','','')`)
    const snapshot=async()=>(await stores.administrator.query(`SELECT (SELECT jsonb_agg(u) FROM "user" u) AS users,(SELECT jsonb_agg(w) FROM workspace w) AS workspaces,(SELECT jsonb_agg(k) FROM sparra_knowledge_revision k) AS revisions,(SELECT jsonb_agg(m) FROM drizzle.__drizzle_migrations m) AS journal`)).rows
    const unchangedCatalog=async()=>(await stores.administrator.query(`SELECT (SELECT jsonb_agg(p ORDER BY tablename,policyname) FROM pg_policies p WHERE tablename IN ('workspace','workspace_audit','user','session') AND policyname NOT IN ('workspace_voice_read','workspace_voice_lock')) AS policies,(SELECT jsonb_agg(m ORDER BY roleid,member) FROM pg_auth_members m) AS memberships`)).rows
    const catalogBefore=await unchangedCatalog(),before=await snapshot(),hashes=await Promise.all(entries.map(async e=>createHash('sha256').update(await readFile('drizzle/'+e.tag+'.sql')).digest('hex')))
    await stores.administrator.query(`CREATE FUNCTION app_private.sparra_erase_call() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$; CREATE SEQUENCE public.fixture_inbox_ddl_marker; CREATE FUNCTION app_private.fixture_inbox_ddl_seen() RETURNS event_trigger LANGUAGE plpgsql AS $$ DECLARE command record; BEGIN FOR command IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP IF command.command_tag='CREATE POLICY' AND command.object_identity LIKE '%sparra_call%' THEN PERFORM nextval('public.fixture_inbox_ddl_marker'); END IF; END LOOP; END $$; CREATE EVENT TRIGGER fixture_inbox_ddl_seen ON ddl_command_end WHEN TAG IN ('CREATE POLICY') EXECUTE FUNCTION app_private.fixture_inbox_ddl_seen()`)
    const dump=async()=>(await stores.command(stores.pg,['pg_dump','--schema-only','--no-comments','--username=migrator','auth'])).split('\n').filter(line=>!line.startsWith('\\restrict ')&&!line.startsWith('\\unrestrict ')).join('\n')
    const ddl=await dump()
    await expect(stores.migrate()).rejects.toThrow('Disposable migration command failed')
    expect((await stores.administrator.query('SELECT is_called FROM fixture_inbox_ddl_marker')).rows[0].is_called).toBe(true)
    expect(await dump()).toBe(ddl);expect(await snapshot()).toEqual(before)
    await stores.administrator.query('DROP EVENT TRIGGER fixture_inbox_ddl_seen; DROP FUNCTION app_private.fixture_inbox_ddl_seen(); DROP SEQUENCE fixture_inbox_ddl_marker; DROP FUNCTION app_private.sparra_erase_call()')
    await stores.migrate()
    const after=await snapshot();expect(after[0].revisions).toEqual(before[0].revisions);expect(after[0].workspaces).toEqual(before[0].workspaces);expect(after[0].users).toEqual(before[0].users)
    expect(await unchangedCatalog()).toEqual(catalogBefore)
    expect(await Promise.all(entries.map(async e=>createHash('sha256').update(await readFile('drizzle/'+e.tag+'.sql')).digest('hex')))).toEqual(hashes)
  }finally{await rm(dir,{recursive:true,force:true})}
  await stores.administrator.query('GRANT USAGE ON SCHEMA public TO runtime; GRANT SELECT,INSERT,UPDATE,DELETE ON "user",account,session,verification TO runtime')
  const webPort=await unusedLoopbackPort();origin='http://localhost:'+webPort
  peer=await startGoogleProtocolPeer({ports:[webPort,...[stores.runtimeUrl,stores.directRuntimeUrl,stores.redisUrl].map(url=>Number(new URL(url).port))]})
  const {createApplicationAuth,readAuthConfig}=await import('../../src/modules/auth/auth.server')
  pool=new Pool({connectionString:stores.directRuntimeUrl,max:4})
  const owner=createTransactions(pool,{maxStatementTimeoutMs:1000,maxCleanupTimeoutMs:1000}),secret=randomBytes(48).toString('hex')
  limiter=createAuthRateLimiter(readRateLimitConfig({REDIS_URL:stores.redisUrl,RATE_LIMIT_HMAC_SECRET:stores.hmac,RATE_LIMIT_KEY_ID:'inbox',TRUSTED_PROXY_IPS:'127.0.0.1',NODE_ENV:'test'}));await limiter.connect()
  auth=createApplicationAuth(owner,readAuthConfig({APP_ORIGIN:'http://localhost:3000',NODE_ENV:'test',AUTH_SECRET:secret,GOOGLE_CLIENT_ID:'fixture.apps.googleusercontent.com',GOOGLE_CLIENT_SECRET:'fixture-only'})!,limiter)
  ceremony=googleCeremony(auth,owner,peer);personal=createPersonalWorkspaces(owner);activity=createActivityOperations(owner);requests=createRequestOperations(owner)
  crypto=await cryptoFixture();crypto.turn=await nativeVoiceTurn(crypto);vi.stubEnv('SPARRA_AEAD_KEYRING_PATH',crypto.path)
  app=startWeb({PORT:String(webPort),NODE_ENV:'test',APP_ORIGIN:origin,DATABASE_URL:stores.runtimeUrl,REDIS_URL:stores.redisUrl,RATE_LIMIT_HMAC_SECRET:stores.hmac,RATE_LIMIT_KEY_ID:'inbox-web',TRUSTED_PROXY_IPS:'127.0.0.1',AUTH_SECRET:secret,REQUEST_TIMEOUT_MS:'10000',SPARRA_AEAD_KEYRING_PATH:crypto.path})
  const address=await bounded(app.ready);origin='http://localhost:'+address.port
})
afterAll(async()=>{
  vi.unstubAllEnvs();const failures:unknown[]=[]
  for(const close of [()=>app?.cleanup(),()=>crypto?.cleanup(),()=>auth?.close(),()=>limiter?.close(),()=>pool?.end(),()=>peer?.close(),()=>stores?.cleanup()])try{await close()}catch(error){failures.push(error)}
  if(failures.length)throw new AggregateError(failures,'Inbox fixture cleanup failed')
})
test('native owner reads absent state, actual Voice ciphertext and pinned configuration without inventing pending results',async()=>{
  const a=await ceremony(),b=await ceremony()
  expect(await requests.list(a.principal,{})).toEqual({requests:[],nextCursor:null})
  for(const op of [requests.detail,requests.treat,requests.erase,requests.erasure])await expect(op(a.principal,randomUUID())).rejects.toMatchObject({name:'RequestNotFound'})
  expect((await stores.administrator.query('SELECT count(*)::int AS n FROM workspace WHERE owner_user_id=$1',[a.principal.userId])).rows[0].n).toBe(0)
  const wa=await personal.ensurePersonalWorkspace(a.principal),wb=await personal.ensurePersonalWorkspace(b.principal)
  const config=await activity.save(a.principal,configuration)
  const id=await call(wa!.id,{id:crypto.callId,revision:1,turns:{[crypto.turnId]:crypto.turn},result:crypto.result()})
  expect(await requests.detail(a.principal,id)).toMatchObject({configuration:config,summary:'Demande de rappel',resultAvailability:'available',resultQuality:'partial',transcriptAvailability:'available',transcript:[{text:'Rappelez-moi'}],endedAt:null})
  expect(await requests.detail(a.principal,id.toUpperCase())).toMatchObject({id,resultAvailability:'available'})
  await expect(call(wb!.id,{revision:1})).rejects.toMatchObject({code:'23503'})
  const shell=await call(wa!.id),detail=await requests.detail(a.principal,shell)
  expect(detail).toMatchObject({configuration:null,configurationRevision:null,endedAt:null,resultAvailability:'unavailable',resultQuality:null,summary:null,transcriptAvailability:'unavailable'})
  expect((await requests.list(b.principal,{})).requests).toEqual([])
  for(const op of [requests.detail,requests.treat,requests.erase,requests.erasure])await expect(op(b.principal,id)).rejects.toMatchObject({name:'RequestNotFound'})
  expect(JSON.stringify(await requests.detail(a.principal,id))).not.toMatch(/ciphertext|key_version|provider_call|nonce_b64/)
  vi.stubEnv('SPARRA_AEAD_KEYRING_PATH','')
  try{
    expect(await requests.detail(a.principal,id)).toMatchObject({resultAvailability:'unavailable',transcriptAvailability:'unavailable',summary:null,configuration:config})
    expect(await requests.detail(a.principal,shell)).toMatchObject({resultAvailability:'unavailable',configuration:null})
  }finally{vi.stubEnv('SPARRA_AEAD_KEYRING_PATH',crypto.path)}
  await stores.administrator.query('UPDATE sparra_call SET encrypted_turns=$2 WHERE id=$1',[id,{[crypto.turnId]:crypto.turn,[randomUUID()]:{}}])
  expect(await requests.detail(a.principal,id)).toMatchObject({resultAvailability:'available',summary:'Demande de rappel',transcriptAvailability:'partial',unavailableTurnCount:1})
})
test('equal-millisecond pagination returns all 103 calls exactly once in tuple order',async()=>{
  const {principal}=await ceremony(),workspace=await personal.ensurePersonalWorkspace(principal),ids:string[]=[],time=new Date()
  for(let i=0;i<103;i++)ids.push(await call(workspace!.id,{admittedAt:time}))
  const first=await requests.list(principal,{}),second=await requests.list(principal,{cursor:first.nextCursor}),third=await requests.list(principal,{cursor:second.nextCursor})
  expect([first.requests.length,second.requests.length,third.requests.length]).toEqual([50,50,3]);expect(third.nextCursor).toBeNull()
  expect([...first.requests,...second.requests,...third.requests].map(r=>r.id)).toEqual(ids.sort().reverse())
})
test.each(['active','closed'])('treat %s preserves inventory and stamp, erase deletes native content and survives retention',async status=>{
  const {principal}=await ceremony(),workspace=await personal.ensurePersonalWorkspace(principal)
  const id=await call(workspace!.id,{status,endedAt:status==='closed'?new Date():undefined})
  const treated=await requests.treat(principal,id);expect(await requests.treat(principal,id)).toEqual(treated)
  expect(await inventory(id)).toEqual({calls:1,fences:0})
  expect((await requests.detail(principal,id)).status).toBe(status)
  expect(await requests.erase(principal,id)).toEqual({requestId:id,state:'queued'})
  expect(await inventory(id)).toEqual({calls:0,fences:1})
  expect(await requests.erase(principal,id)).toEqual({requestId:id,state:'queued'})
  expect(await requests.erasure(principal,id)).toEqual({requestId:id,state:'queued'})
  await expect(requests.detail(principal,id)).rejects.toMatchObject({name:'RequestNotFound'})
  const fence=(await stores.administrator.query('SELECT workspace_id,call_id,deployment_id,provider_call_control_id,original_retention_until,fence_until,state FROM sparra_erasure WHERE call_id=$1',[id])).rows[0]
  expect(fence).toMatchObject({workspace_id:workspace!.id,call_id:id,deployment_id:'fixture',provider_call_control_id:id,state:'queued'})
  expect(fence.fence_until.getTime()-fence.original_retention_until.getTime()).toBe(900000)
  await stores.administrator.query("UPDATE sparra_erasure SET state='completed',completed_at=clock_timestamp() WHERE call_id=$1",[id])
  expect(await inventory(id)).toEqual({calls:0,fences:1});expect(await requests.erasure(principal,id)).toEqual({requestId:id,state:'completed'})
  await expect(stores.administrator.query('DELETE FROM sparra_erasure WHERE call_id=$1',[id])).rejects.toMatchObject({code:'23514'})
  await expect(stores.administrator.query('UPDATE sparra_erasure SET call_id=$2 WHERE call_id=$1',[id,randomUUID()])).rejects.toMatchObject({code:'23514'})
  await expect(stores.administrator.query("UPDATE sparra_erasure SET state='queued',completed_at=NULL WHERE call_id=$1",[id])).rejects.toMatchObject({code:'23514'})
})
test('expired content stays unreadable including a Workspace lock held across retention; queued receipt outlives fence deadline',async()=>{
  const {principal}=await ceremony(),workspace=await personal.ensurePersonalWorkspace(principal),end=new Date(Date.now()+600),admitted=new Date(end.getTime()-2592000000)
  const id=await call(workspace!.id,{admittedAt:admitted,retentionUntil:end})
  const blocker=new Client({connectionString:stores.directRuntimeUrl});await blocker.connect()
  try{await blocker.query('BEGIN');await blocker.query("SELECT set_config('app.tenant_id',$1,true)",[workspace!.id]);await blocker.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[workspace!.id])
    const detail=requests.detail(principal,id);void detail.catch(()=>{})
    await stores.administrator.query('SELECT pg_sleep(0.7)');await blocker.query('COMMIT')
    await expect(detail).rejects.toMatchObject({name:'RequestNotFound'})
  }finally{await blocker.query('ROLLBACK');await blocker.end()}
  expect((await requests.list(principal,{})).requests).toEqual([])
  await expect(requests.treat(principal,id)).rejects.toMatchObject({name:'RequestNotFound'})
  // Erasure is permitted after expiry: it returns only the scoped durable obligation.
  const oldEnd=new Date(Date.now()-1800000),old=await call(workspace!.id,{admittedAt:new Date(oldEnd.getTime()-2592000000),retentionUntil:oldEnd})
  expect(await requests.erase(principal,old)).toEqual({requestId:old,state:'queued'})
  expect(await requests.erase(principal,old)).toEqual({requestId:old,state:'queued'})
  expect(await requests.erasure(principal,old)).toEqual({requestId:old,state:'queued'})
  await expect(stores.administrator.query('DELETE FROM sparra_erasure WHERE call_id=$1',[old])).rejects.toMatchObject({code:'23514'})
  await stores.administrator.query("UPDATE sparra_erasure SET state='completed',completed_at=clock_timestamp() WHERE call_id=$1",[old])
  expect(await requests.erasure(principal,old)).toEqual({requestId:old,state:'completed'})
})
test('native runtime UPDATE RETURNING cooperates with narrow definer, FORCE RLS and column grants',async()=>{
  const {principal}=await ceremony(),workspace=await personal.ensurePersonalWorkspace(principal),id=await call(workspace!.id)
  const other=await call(workspace!.id),foreign=await personal.ensurePersonalWorkspace((await ceremony()).principal)
  const client=new Client({connectionString:stores.directRuntimeUrl});await client.connect()
  try{
    await client.query('BEGIN');await client.query("SELECT set_config('app.tenant_id',$1,true)",[workspace!.id]);await client.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[workspace!.id])
    expect((await client.query('UPDATE sparra_call SET erasure_requested_at=clock_timestamp() WHERE id=$1 RETURNING id',[id])).rows).toEqual([{id}]);await client.query('COMMIT')
    expect(await inventory(id)).toEqual({calls:0,fences:1})
    for(const tenant of ['', 'invalid','00000000-0000-0000-0000-000000000000',randomUUID(),foreign!.id]){
      await client.query('BEGIN');await client.query("SELECT set_config('app.tenant_id',$1,true)",[tenant]);expect((await client.query('SELECT call_id FROM sparra_erasure WHERE call_id=$1',[id])).rows).toEqual([])
      expect((await client.query('SELECT id FROM sparra_call WHERE id=$1',[other])).rows).toEqual([])
      expect((await client.query('UPDATE sparra_call SET treated_at=clock_timestamp(),erasure_requested_at=clock_timestamp() WHERE id=$1 RETURNING id',[other])).rows).toEqual([])
      await client.query('ROLLBACK')
    }
    expect(await inventory(other)).toEqual({calls:1,fences:0})
    const forbidden=['DELETE FROM sparra_call','INSERT INTO sparra_call(id) VALUES (gen_random_uuid())',"UPDATE sparra_call SET status='closed'",'UPDATE sparra_call SET encrypted_message_result=NULL','DELETE FROM sparra_erasure',"UPDATE sparra_erasure SET state='completed'"]
    for(const query of forbidden)await expect(client.query(query)).rejects.toMatchObject({code:'42501'})
  }finally{await client.end()}
  expect((await stores.administrator.query("SELECT c.relname,r.rolname AS owner,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.relname IN ('sparra_call','sparra_erasure') ORDER BY c.relname")).rows).toEqual(['sparra_call','sparra_erasure'].map(relname=>({relname,owner:'workspace_owner',relrowsecurity:true,relforcerowsecurity:true})))
  expect((await stores.administrator.query("SELECT r.rolname,r.rolcanlogin,r.rolbypassrls,p.prosecdef,p.proconfig,has_function_privilege('runtime',p.oid,'EXECUTE') AS execute FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid='app_private.sparra_erase_call()'::regprocedure")).rows).toEqual([{rolname:'workspace_owner',rolcanlogin:false,rolbypassrls:false,prosecdef:true,proconfig:['search_path=pg_catalog, pg_temp'],execute:false}])
  expect((await stores.administrator.query("SELECT column_name FROM information_schema.column_privileges WHERE grantee='runtime' AND table_name='sparra_call' AND privilege_type='UPDATE' ORDER BY column_name")).rows).toEqual([{column_name:'erasure_requested_at'},{column_name:'treated_at'}])
  expect((await stores.administrator.query("SELECT count(*)::int AS n FROM pg_class c,LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.relname IN ('sparra_call','sparra_erasure') AND a.grantee=0")).rows[0].n).toBe(0)
  expect((await stores.administrator.query("SELECT has_table_privilege('workspace_bootstrap','sparra_call','SELECT,INSERT,UPDATE,DELETE') AS calls,has_table_privilege('workspace_bootstrap','sparra_erasure','SELECT,INSERT,UPDATE,DELETE') AS fences")).rows).toEqual([{calls:false,fences:false}])
  await stores.administrator.query("UPDATE workspace SET lifecycle='deleting' WHERE id=$1",[workspace!.id])
  const inactive=new Client({connectionString:stores.directRuntimeUrl});await inactive.connect()
  try{await inactive.query('BEGIN');await inactive.query("SELECT set_config('app.tenant_id',$1,true)",[workspace!.id]);expect((await inactive.query('SELECT call_id FROM sparra_erasure')).rows).toEqual([]);expect((await inactive.query('SELECT id FROM sparra_call')).rows).toEqual([]);expect((await inactive.query('UPDATE sparra_call SET erasure_requested_at=clock_timestamp() WHERE id=$1 RETURNING id',[other])).rows).toEqual([])}finally{await inactive.query('ROLLBACK');await inactive.end()}
})
test('fence insertion failure and cancellation roll back; recorded COMMIT cancellation rejects completion and reload resolves',async()=>{
  const {principal}=await ceremony(),workspace=await personal.ensurePersonalWorkspace(principal),id=await call(workspace!.id)
  await stores.administrator.query("CREATE FUNCTION fixture_inbox_abort() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private-inbox-marker'; END $$; CREATE TRIGGER fixture_inbox_abort BEFORE INSERT ON sparra_erasure FOR EACH ROW EXECUTE FUNCTION fixture_inbox_abort()")
  try{await expect(requests.erase(principal,id)).rejects.toMatchObject({name:'PgTransactionError'});expect(await inventory(id)).toEqual({calls:1,fences:0});expect((await stores.administrator.query('SELECT erasure_requested_at FROM sparra_call WHERE id=$1',[id])).rows[0].erasure_requested_at).toBeNull()}
  finally{await stores.administrator.query('DROP TRIGGER fixture_inbox_abort ON sparra_erasure; DROP FUNCTION fixture_inbox_abort()')}
  const aborted=new AbortController();aborted.abort();await expect(requests.erase(principal,id,aborted.signal)).rejects.toMatchObject({name:'PgTransactionError'});expect(await inventory(id)).toEqual({calls:1,fences:0})
  const blocker=new Client({connectionString:stores.directRuntimeUrl});await blocker.connect()
  try{
    await blocker.query('BEGIN');await blocker.query("SELECT set_config('app.tenant_id',$1,true)",[workspace!.id]);await blocker.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[workspace!.id])
    const waiting=new AbortController(),pending=requests.erase(principal,id,waiting.signal);void pending.catch(()=>{})
    await stores.administrator.query('SELECT pg_sleep(0.05)');waiting.abort();await expect(pending).rejects.toMatchObject({name:'PgTransactionError'})
    expect(await inventory(id)).toEqual({calls:1,fences:0})
  }finally{await blocker.query('ROLLBACK');await blocker.end()}
  const controller=new AbortController(),observed:string[]=[],observedPool=new Pool({connectionString:stores.directRuntimeUrl,max:1})
  observedPool.on('connect',client=>client.connection.on('commandComplete',(message:unknown)=>{if(typeof message==='object'&&message!==null&&'text'in message&&message.text==='COMMIT'){observed.push('COMMIT');controller.abort()}}))
  try{const owner=createTransactions(observedPool,{maxStatementTimeoutMs:1000,maxCleanupTimeoutMs:1000});await expect(createRequestOperations(owner).erase(principal,id,controller.signal)).rejects.toMatchObject({name:'PgTransactionError',phase:'finalize',outcome:'committed'});expect(observed).toEqual(['COMMIT']);expect(await requests.erasure(principal,id)).toEqual({requestId:id,state:'queued'});expect(await inventory(id)).toEqual({calls:0,fences:1})}finally{await observedPool.end()}
})
test('built native RPC enforces strict input, auth, missing and foreign Origin, bounded failures and no-store',async()=>{
  const {principal,cookie}=await ceremony(),workspace=await personal.ensurePersonalWorkspace(principal),id=randomUUID()
  await call(workspace!.id,{id,turns:{[crypto.turnId]:crypto.turn},result:{schema_version:1,...crypto.encrypt(JSON.stringify(crypto.inner),'result:'+id)}})
  const names=['listRequests','getRequestDetail','markRequestTreated','eraseRequest','getRequestErasure'] as const
  for(const name of names){
    const path=await authRpcPath(name),method=name==='markRequestTreated'||name==='eraseRequest'?'POST':'GET',data=name==='listRequests'?{}:{requestId:id}
    const invoke=async(value:unknown,headers:Record<string,string>)=>{const body=await rpcBody(value);return loopbackFetch(origin+path+(method==='GET'?'?payload='+encodeURIComponent(body):''),{method,headers:{'content-type':'application/json','x-tsr-serverFn':'true',...headers},body:method==='POST'?body:undefined})}
    for(const headers of [{cookie},{cookie,origin:'https://foreign.example'}] as Record<string,string>[]){const denied=await invoke(data,headers);expect(denied.status).toBe(403);expect(denied.headers.get('cache-control')).toBe('no-store')}
    expect((await invoke(data,{origin})).status).toBe(401)
    expect((await invoke({...data,workspaceId:workspace!.id},{cookie,origin})).status).toBe(400)
    if(name==='getRequestErasure')continue
    const response=await invoke(data,{cookie,origin});expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');expect(response.headers.get('x-robots-tag')).toBe('noindex');expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
    if(name==='getRequestDetail'){const body=await response.text();expect(body).toContain('Rappelez-moi');expect(body).toContain('Demande de rappel');expect(body).not.toMatch(/ciphertext|key_version|nonce_b64/)}
  }
  const failureId=await call(workspace!.id)
  await stores.administrator.query("CREATE FUNCTION fixture_inbox_rpc_abort() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private-inbox-rpc-marker'; END $$; CREATE TRIGGER fixture_inbox_rpc_abort BEFORE INSERT ON sparra_erasure FOR EACH ROW EXECUTE FUNCTION fixture_inbox_rpc_abort()")
  try{const response=await loopbackFetch(origin+await authRpcPath('eraseRequest'),{method:'POST',headers:{cookie,origin,'content-type':'application/json','x-tsr-serverFn':'true'},body:await rpcBody({requestId:failureId})});expect(response.status).toBe(500);expect(await response.text()).toBe('Request unavailable');expect(app.output()).not.toContain('private-inbox-rpc-marker');expect(await inventory(failureId)).toEqual({calls:1,fences:0})}
  finally{await stores.administrator.query('DROP TRIGGER fixture_inbox_rpc_abort ON sparra_erasure; DROP FUNCTION fixture_inbox_rpc_abort()')}
})
