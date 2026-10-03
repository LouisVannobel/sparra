import { afterAll, beforeAll, expect, test } from 'vitest'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, Pool } from 'pg'
import { fetch as loopbackFetch } from 'undici'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { createPersonalWorkspaces } from '../../src/modules/workspaces/personal.server'
import { createActivityOperations } from '../../src/modules/sparra/activity.server'
import { startGoogleProtocolPeer } from '../helpers/google-protocol-peer.mjs'
import { googleCeremony } from '../helpers/google-ceremony'
import { createAuthRateLimiter, readRateLimitConfig } from '../../src/modules/auth/rate-limit.server'
import type { createApplicationAuth } from '../../src/modules/auth/auth.server'
import { startWeb, bounded, unusedLoopbackPort } from '../helpers/web-process'
import { authRpcPath, rpcBody } from '../helpers/auth-rpc'

let stores: Awaited<ReturnType<typeof startDisposableStores>>, pool: Pool
let activity: ReturnType<typeof createActivityOperations>, personal: ReturnType<typeof createPersonalWorkspaces>
let auth: ReturnType<typeof createApplicationAuth>, limiter: ReturnType<typeof createAuthRateLimiter>, peer: Awaited<ReturnType<typeof startGoogleProtocolPeer>>, ceremony: ReturnType<typeof googleCeremony>
let app: ReturnType<typeof startWeb>, origin: string
const input = (expectedRevision = 0) => ({ expectedRevision, businessName: ' Garage Dupont ', sector: 'garage', knowledge: { openingHours: 'Lundi\r\nVendredi', services: 'Vidange', prices: '', faq: '', instructions: '' }, transferDestination: null })
const revisions = async (id: string) => (await stores.administrator.query('SELECT revision,business_name FROM sparra_knowledge_revision WHERE workspace_id=$1 ORDER BY revision', [id])).rows
beforeAll(async () => {
  stores = await startDisposableStores()
  const directory = await mkdtemp(join(tmpdir(), 'sparra-migration-prefix-'))
  try {
    await mkdir(join(directory, 'meta'))
    const journal = JSON.parse(await readFile('drizzle/meta/_journal.json', 'utf8'))
    const entries: { tag: string; idx: number }[] = journal.entries.slice(0,13)
    expect(entries.at(-1)?.tag).toBe('0012_recovery_admission')
    for (const entry of entries) await cp('drizzle/'+entry.tag+'.sql', join(directory,entry.tag+'.sql'))
    await writeFile(join(directory,'meta/_journal.json'), JSON.stringify({ ...journal, entries }))
    await migrate(drizzle(stores.administrator), { migrationsFolder: directory })
    await stores.administrator.query(`INSERT INTO "user" (id,name,email) VALUES ('preexisting-user','Before','preexisting@example.test');
      INSERT INTO session (id,token,user_id,expires_at,auth_state,auth_method,authenticated_at,recovery_generation,last_activity_at) VALUES ('preexisting-session','fixture-only','preexisting-user',now()+interval '1 day','ACTIVE','google',now(),0,now());
      INSERT INTO workspace(id,owner_user_id) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','preexisting-user');
      INSERT INTO workspace_audit(action,actor_user_id,workspace_id,correlation_id) VALUES ('personal-created','preexisting-user','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')`)
    const before = (await stores.administrator.query(`SELECT (SELECT to_jsonb(u) FROM "user" u WHERE id='preexisting-user') AS u,(SELECT to_jsonb(s) FROM session s WHERE id='preexisting-session') AS s,(SELECT to_jsonb(w) FROM workspace w WHERE owner_user_id='preexisting-user') AS w,(SELECT to_jsonb(a) FROM workspace_audit a WHERE actor_user_id='preexisting-user') AS a`)).rows
    const hashes = await Promise.all(entries.map(async e => createHash('sha256').update(await readFile('drizzle/'+e.tag+'.sql')).digest('hex')))
    // The function collision is late in 0013, after its table/policies/grants.
    // A sequence is intentionally nontransactional: it proves DDL was reached
    // even though every transactional DDL/data/journal change must roll back.
    await stores.administrator.query(`
      CREATE FUNCTION app_private.sparra_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
      CREATE SEQUENCE public.fixture_forward_ddl_marker;
      CREATE FUNCTION app_private.fixture_forward_ddl_seen() RETURNS event_trigger LANGUAGE plpgsql AS $$
      DECLARE command record;
      BEGIN
        FOR command IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
          IF command.command_tag='CREATE POLICY' AND command.object_identity LIKE '%sparra_knowledge_revision%' THEN
            PERFORM nextval('public.fixture_forward_ddl_marker');
          END IF;
        END LOOP;
      END $$;
      CREATE EVENT TRIGGER fixture_forward_ddl_seen ON ddl_command_end WHEN TAG IN ('CREATE POLICY') EXECUTE FUNCTION app_private.fixture_forward_ddl_seen();
    `)
    const schemaDump = async () => (await stores.command(stores.pg,['pg_dump','--schema-only','--no-comments','--username=migrator','auth']))
      .split('\n').filter(line => !line.startsWith('\\restrict ') && !line.startsWith('\\unrestrict ')).join('\n')
    const ddlBefore = await schemaDump()
    const journalBefore = (await stores.administrator.query('SELECT id,hash,created_at::text FROM drizzle.__drizzle_migrations ORDER BY id')).rows
    await expect(stores.migrate()).rejects.toThrow('Disposable migration command failed')
    expect((await stores.administrator.query('SELECT last_value::int,is_called FROM fixture_forward_ddl_marker')).rows).toEqual([{last_value:2,is_called:true}])
    expect((await stores.administrator.query("SELECT to_regclass('public.sparra_knowledge_revision') IS NULL AS absent")).rows).toEqual([{absent:true}])
    expect((await stores.administrator.query("SELECT count(*)::int AS n FROM pg_policies WHERE tablename='sparra_knowledge_revision'")).rows[0].n).toBe(0)
    expect(await schemaDump()).toBe(ddlBefore)
    expect((await stores.administrator.query('SELECT id,hash,created_at::text FROM drizzle.__drizzle_migrations ORDER BY id')).rows).toEqual(journalBefore)
    expect((await stores.administrator.query(`SELECT (SELECT to_jsonb(u) FROM "user" u WHERE id='preexisting-user') AS u,(SELECT to_jsonb(s) FROM session s WHERE id='preexisting-session') AS s,(SELECT to_jsonb(w) FROM workspace w WHERE owner_user_id='preexisting-user') AS w,(SELECT to_jsonb(a) FROM workspace_audit a WHERE actor_user_id='preexisting-user') AS a`)).rows).toEqual(before)
    await stores.administrator.query('DROP EVENT TRIGGER fixture_forward_ddl_seen; DROP FUNCTION app_private.fixture_forward_ddl_seen(); DROP SEQUENCE fixture_forward_ddl_marker; DROP FUNCTION app_private.sparra_revision_immutable()')
    await stores.migrate()
    expect((await stores.administrator.query(`SELECT (SELECT to_jsonb(u) FROM "user" u WHERE id='preexisting-user') AS u,(SELECT to_jsonb(s) FROM session s WHERE id='preexisting-session') AS s,(SELECT to_jsonb(w) FROM workspace w WHERE owner_user_id='preexisting-user') AS w,(SELECT to_jsonb(a) FROM workspace_audit a WHERE actor_user_id='preexisting-user') AS a`)).rows).toEqual(before)
    expect(await Promise.all(entries.map(async e => createHash('sha256').update(await readFile('drizzle/'+e.tag+'.sql')).digest('hex')))).toEqual(hashes)
  } finally { await rm(directory,{recursive:true,force:true}) }
  await stores.administrator.query('GRANT USAGE ON SCHEMA public TO runtime; GRANT SELECT,INSERT,UPDATE,DELETE ON "user",account,session,verification TO runtime')
  const webPort = await unusedLoopbackPort(); origin = 'http://localhost:'+webPort
  peer = await startGoogleProtocolPeer({ ports: [webPort,...[stores.runtimeUrl,stores.directRuntimeUrl,stores.redisUrl].map(url => Number(new URL(url).port))] })
  const { createApplicationAuth, readAuthConfig } = await import('../../src/modules/auth/auth.server')
  pool = new Pool({ connectionString: stores.directRuntimeUrl, max: 4 })
  const owner = createTransactions(pool,{ maxStatementTimeoutMs:1000,maxCleanupTimeoutMs:1000 })
  const secret = randomBytes(48).toString('hex')
  limiter = createAuthRateLimiter(readRateLimitConfig({REDIS_URL:stores.redisUrl,RATE_LIMIT_HMAC_SECRET:stores.hmac,RATE_LIMIT_KEY_ID:'activity',TRUSTED_PROXY_IPS:'127.0.0.1',NODE_ENV:'test'}))
  await limiter.connect()
  auth = createApplicationAuth(owner,readAuthConfig({APP_ORIGIN:'http://localhost:3000',NODE_ENV:'test',AUTH_SECRET:secret,GOOGLE_CLIENT_ID:'fixture.apps.googleusercontent.com',GOOGLE_CLIENT_SECRET:'fixture-only'})!,limiter)
  ceremony = googleCeremony(auth,owner,peer); personal=createPersonalWorkspaces(owner); activity=createActivityOperations(owner)
  app = startWeb({PORT:String(webPort),NODE_ENV:'test',APP_ORIGIN:origin,DATABASE_URL:stores.runtimeUrl,REDIS_URL:stores.redisUrl,RATE_LIMIT_HMAC_SECRET:stores.hmac,RATE_LIMIT_KEY_ID:'activity-web',TRUSTED_PROXY_IPS:'127.0.0.1',AUTH_SECRET:secret,REQUEST_TIMEOUT_MS:'10000'})
  const address = await bounded(app.ready)
  origin = 'http://localhost:'+address.port
})
afterAll(async () => {
  const failures: unknown[]=[]
  for (const close of [()=>app?.cleanup(),()=>auth?.close(),()=>limiter?.close(),()=>pool?.end(),()=>peer?.close(),()=>stores?.cleanup()]) { try { await close() } catch (error) { failures.push(error) } }
  if(failures.length) throw new AggregateError(failures,'Activity integration cleanup failed')
})
test('absent reads and saves never create a workspace; native ensure enables revision one and persistent reload', async () => {
  const {principal}=await ceremony()
  expect(await activity.read(principal)).toEqual({workspace:null,configuration:null})
  expect(await activity.save(principal,input())).toBeNull()
  expect((await stores.administrator.query('SELECT count(*)::int AS n FROM workspace WHERE owner_user_id=$1',[principal.userId])).rows[0].n).toBe(0)
  const workspace=await personal.ensurePersonalWorkspace(principal)
  expect(await activity.read(principal)).toEqual({workspace,configuration:null})
  const saved=await activity.save(principal,input())
  expect(saved).toEqual({sector:input().sector,transferDestination:null,workspaceId:workspace!.id,revision:1,savedAt:expect.any(String),businessName:'Garage Dupont',knowledge:{...input().knowledge,openingHours:'Lundi\nVendredi'}})
  expect(await activity.read(principal)).toEqual({workspace,configuration:saved})
})
test('same expected revision has exactly one winner; old snapshot remains immutable', async () => {
  const {principal}=await ceremony(), workspace=await personal.ensurePersonalWorkspace(principal)
  const first=await activity.save(principal,input())
  const outcomes=await Promise.allSettled([activity.save(principal,{...input(1),businessName:'A'}),activity.save(principal,{...input(1),businessName:'B'})])
  expect(outcomes.filter(o=>o.status==='fulfilled')).toHaveLength(1)
  expect(outcomes.filter(o=>o.status==='rejected')).toEqual([{status:'rejected',reason:expect.objectContaining({name:'ActivityRevisionConflict'})}])
  expect(await revisions(workspace!.id)).toEqual([{revision:1,business_name:first!.businessName},{revision:2,business_name:expect.stringMatching(/^[AB]$/)}])
  await expect(stores.administrator.query('UPDATE sparra_knowledge_revision SET business_name=$1 WHERE workspace_id=$2',['Modified',workspace!.id])).rejects.toMatchObject({code:'23514'})
  await expect(stores.administrator.query('DELETE FROM sparra_knowledge_revision WHERE workspace_id=$1',[workspace!.id])).rejects.toMatchObject({code:'23514'})
})
test.each(['revoked','deleting'])('native %s state denies reads and saves',async state=>{
  const {principal}=await ceremony(),workspace=await personal.ensurePersonalWorkspace(principal)
  await activity.save(principal,input())
  if(state==='revoked') await stores.administrator.query('DELETE FROM session WHERE id=$1',[principal.sessionId])
  else await stores.administrator.query("UPDATE workspace SET lifecycle='deleting' WHERE id=$1",[workspace!.id])
  expect(await activity.read(principal)).toEqual({workspace:null,configuration:null})
  expect(await activity.save(principal,input(1))).toBeNull()
  expect(await revisions(workspace!.id)).toHaveLength(1)
})

test.each(['deleting','provisioning'])('direct runtime SQL denies the matching tenant after Workspace becomes %s',async lifecycle=>{
  const {principal}=await ceremony(),workspace=await personal.ensurePersonalWorkspace(principal)
  await activity.save(principal,input())
  await stores.administrator.query('UPDATE workspace SET lifecycle=$1 WHERE id=$2',[lifecycle,workspace!.id])
  const client=new Client({connectionString:stores.directRuntimeUrl});await client.connect()
  try{
    await client.query('BEGIN')
    await client.query("SELECT set_config('app.tenant_id',$1,true)",[workspace!.id])
    expect((await client.query('SELECT id FROM workspace WHERE id=$1',[workspace!.id])).rows).toEqual([])
    expect((await client.query('SELECT revision FROM sparra_knowledge_revision WHERE workspace_id=$1',[workspace!.id])).rows).toEqual([])
    await expect(client.query(`INSERT INTO sparra_knowledge_revision(workspace_id,revision,business_name,sector,opening_hours,services,prices,faq,instructions) VALUES ($1,2,'Forbidden','garage','','','','','')`,[workspace!.id])).rejects.toMatchObject({code:'42501'})
  }finally{await client.query('ROLLBACK');await client.end()}
  expect(await revisions(workspace!.id)).toHaveLength(1)
})
test('RLS denies absent/zero/invalid/foreign tenants and guessed IDs, runtime has SELECT/INSERT only',async()=>{
  const a=await ceremony(),b=await ceremony(),workspace=await personal.ensurePersonalWorkspace(a.principal)
  await activity.save(a.principal,input())
  expect(await activity.read(b.principal)).toEqual({workspace:null,configuration:null})
  const foreignWorkspace=await personal.ensurePersonalWorkspace(b.principal)
  expect(await activity.save({...a.principal,userId:b.principal.userId},input())).toBeNull()
  const client=new Client({connectionString:stores.directRuntimeUrl});await client.connect()
  try{
    for(const tenant of [undefined,'','invalid','00000000-0000-0000-0000-000000000000',randomUUID(),foreignWorkspace!.id]){
      await client.query('BEGIN')
      if(tenant!==undefined) await client.query("SELECT set_config('app.tenant_id',$1,true)",[tenant])
      expect((await client.query('SELECT revision FROM sparra_knowledge_revision WHERE workspace_id=$1',[workspace!.id])).rows).toEqual([])
      await expect(client.query(`INSERT INTO sparra_knowledge_revision(workspace_id,revision,business_name,sector,opening_hours,services,prices,faq,instructions) VALUES ($1,2,'Forbidden','garage','','','','','')`,[workspace!.id])).rejects.toMatchObject({code:'42501'})
      await client.query('ROLLBACK')
    }
  }finally{await client.end()}
  expect((await stores.administrator.query("SELECT r.rolname AS owner,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid='sparra_knowledge_revision'::regclass")).rows).toEqual([{owner:'workspace_owner',relrowsecurity:true,relforcerowsecurity:true}])
  expect((await stores.administrator.query("SELECT has_table_privilege('runtime','sparra_knowledge_revision','SELECT') AS read,has_table_privilege('runtime','sparra_knowledge_revision','INSERT') AS insert,has_table_privilege('runtime','sparra_knowledge_revision','UPDATE,DELETE') AS mutate,has_table_privilege('workspace_bootstrap','sparra_knowledge_revision','SELECT,INSERT') AS bootstrap")).rows).toEqual([{read:true,insert:true,mutate:false,bootstrap:false}])
  expect((await stores.administrator.query("SELECT count(*)::int AS n FROM pg_class c, LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid='sparra_knowledge_revision'::regclass AND a.grantee=0")).rows[0].n).toBe(0)
  const policies=(await stores.administrator.query("SELECT policyname,cmd,roles::text[] AS roles,permissive,qual,with_check FROM pg_policies WHERE schemaname='public' AND tablename='sparra_knowledge_revision' ORDER BY policyname")).rows
  expect(policies.map(({policyname,cmd,roles,permissive,qual,with_check})=>({policyname,cmd,roles,permissive,using:qual!==null,check:with_check!==null}))).toEqual([
    {policyname:'sparra_revision_insert',cmd:'INSERT',roles:['runtime'],permissive:'PERMISSIVE',using:false,check:true},
    {policyname:'sparra_revision_read',cmd:'SELECT',roles:['runtime'],permissive:'PERMISSIVE',using:true,check:false},
    {policyname:'sparra_revision_voice_delete',cmd:'DELETE',roles:['sparra_voice_definer'],permissive:'PERMISSIVE',using:true,check:false},
    {policyname:'sparra_revision_voice_read',cmd:'SELECT',roles:['sparra_voice_definer'],permissive:'PERMISSIVE',using:true,check:false},
  ])
  for(const policy of policies){
    if(policy.roles[0]==='runtime'){
      const predicate:string=policy.qual ?? policy.with_check
      expect(predicate).toContain('EXISTS')
      expect(predicate).toContain("lifecycle = 'active'")
      expect(predicate).toContain('workspace.id = sparra_knowledge_revision.workspace_id')
      expect(predicate).toMatch(/\(?workspace_id\)?::text = current_setting\('app\.tenant_id'::text, true\)/)
      expect(predicate).toContain("<> '00000000-0000-0000-0000-000000000000'::text")
    }else expect(policy.qual).toBe('(workspace_id = voice_private.bound_workspace())')
  }
  const boundWorkspace=(await stores.administrator.query("SELECT prosrc FROM pg_proc WHERE oid='voice_private.bound_workspace()'::regprocedure")).rows[0].prosrc
  expect(boundWorkspace.replace(/\s+/g,' ').trim()).toBe('SELECT workspace_id FROM voice_private.deployment_binding WHERE service_login=session_user AND service_role_oid=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=session_user)')
})

test('SQL independently bounds revision, sector, UTF16 text, typed destination and finite timestamp',async()=>{
  const {principal}=await ceremony(),workspace=await personal.ensurePersonalWorkspace(principal)
  type SqlInput = { revision:number;business_name:string;sector:string;opening_hours:string;services:string;prices:string;faq:string;instructions:string;transfer_destination:string|null;saved_at:Date|string }
  const insert=(changes:Partial<SqlInput>={})=>{
    const row={revision:1,business_name:'Garage',sector:'garage',opening_hours:'',services:'',prices:'',faq:'',instructions:'',transfer_destination:null,saved_at:new Date(),...changes}
    return stores.administrator.query('INSERT INTO sparra_knowledge_revision(workspace_id,revision,business_name,sector,opening_hours,services,prices,faq,instructions,transfer_destination,saved_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[workspace!.id,...Object.values(row)])
  }
  for(const changes of [{revision:0},{business_name:'  Garage'},{business_name:'😀'.repeat(41)},{sector:'restaurant'},{opening_hours:'x'.repeat(1001)},{services:'x'.repeat(2001)},{prices:'x'.repeat(1501)},{faq:'😀'.repeat(1501)},{instructions:'x'.repeat(2001)},{faq:'bad\u0085text'},{transfer_destination:'0123456789'},{saved_at:'infinity'}]){
    await expect(insert(changes)).rejects.toMatchObject({code:'23514'})
  }
  await insert({business_name:'😀'.repeat(40),opening_hours:'x'.repeat(1000),services:'x'.repeat(2000),prices:'x'.repeat(1500),faq:'😀'.repeat(1500),instructions:'x'.repeat(2000),transfer_destination:'+33123456789'})
  expect(await revisions(workspace!.id)).toHaveLength(1)
})
test('failed insertion and caller cancellation produce no committed saved feedback',async()=>{
  const {principal}=await ceremony(),workspace=await personal.ensurePersonalWorkspace(principal)
  await stores.administrator.query("CREATE FUNCTION fixture_activity_abort() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private-activity-marker'; END $$; CREATE TRIGGER fixture_activity_abort AFTER INSERT ON sparra_knowledge_revision FOR EACH ROW EXECUTE FUNCTION fixture_activity_abort()")
  try{await expect(activity.save(principal,input())).rejects.toMatchObject({name:'PgTransactionError'});expect(await revisions(workspace!.id)).toEqual([])}
  finally{await stores.administrator.query('DROP TRIGGER fixture_activity_abort ON sparra_knowledge_revision; DROP FUNCTION fixture_activity_abort()')}
  const blocker=new Client({connectionString:stores.directRuntimeUrl});await blocker.connect()
  try{
    await blocker.query('BEGIN')
    await blocker.query("SELECT set_config('app.tenant_id',$1,true)",[workspace!.id])
    await blocker.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[workspace!.id])
    const controller=new AbortController(), pending=activity.save(principal,input(),controller.signal)
    await expect.poll(async()=> (await stores.administrator.query("SELECT exists(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND (query LIKE 'SELECT app_private.resolve_personal_workspace%' OR query LIKE '%from \"workspace\"%for update')) AS waiting")).rows[0].waiting,{timeout:750,interval:10}).toBe(true)
    controller.abort();await expect(pending).rejects.toMatchObject({name:'PgTransactionError'})
    await blocker.query('ROLLBACK');expect(await revisions(workspace!.id)).toEqual([])
  }finally{await blocker.end()}
})

test('cancellation after recorded native COMMIT rejects saved completion and fresh native read reconciles it',async()=>{
  const {principal}=await ceremony(),workspace=await personal.ensurePersonalWorkspace(principal)
  const controller=new AbortController(),observed:string[]=[]
  const observedPool=new Pool({connectionString:stores.directRuntimeUrl,max:1})
  observedPool.on('connect',client=>client.connection.on('commandComplete',(message:unknown)=>{
    if(typeof message==='object' && message!==null && 'text' in message && message.text==='COMMIT'){
      observed.push('COMMIT');controller.abort();observed.push('cancel')
    }
  }))
  try{
    const observedOwner=createTransactions(observedPool,{maxStatementTimeoutMs:1000,maxCleanupTimeoutMs:1000})
    const save=createActivityOperations(observedOwner).save(principal,input(),controller.signal)
    await expect(save).rejects.toMatchObject({name:'PgTransactionError',phase:'finalize',outcome:'committed'})
    observed.push('rejected')
    expect(observed).toEqual(['COMMIT','cancel','rejected'])
    const state=await activity.read(principal)
    expect(state.workspace).toEqual(workspace)
    expect(state.configuration).toMatchObject({workspaceId:workspace!.id,revision:1,businessName:'Garage Dupont'})
    expect(await revisions(workspace!.id)).toEqual([{revision:1,business_name:'Garage Dupont'}])
    expect(observed).toHaveLength(3)
  }finally{await observedPool.end()}
})
test('built native RPC validates input, authentication, CSRF, conflict and private errors',async()=>{
  const {principal,cookie}=await ceremony()
  const readPath=await authRpcPath('getActivity'),savePath=await authRpcPath('saveActivity')
  const post=(data:unknown,sessionCookie=cookie,requestOrigin=origin)=>rpcBody(data).then(body=>loopbackFetch(origin+savePath,{method:'POST',headers:{origin:requestOrigin,cookie:sessionCookie,'content-type':'application/json','x-tsr-serverFn':'true'},body}))
  const read=()=>loopbackFetch(origin+readPath,{headers:{cookie,'sec-fetch-site':'same-origin','x-tsr-serverFn':'true'}})
  expect((await read()).status).toBe(200)
  expect((await post(input())).status).toBe(404)
  expect((await stores.administrator.query('SELECT count(*)::int AS n FROM workspace WHERE owner_user_id=$1',[principal.userId])).rows[0].n).toBe(0)
  const workspace=await personal.ensurePersonalWorkspace(principal)
  const extraRead=await loopbackFetch(origin+readPath+'?payload='+encodeURIComponent(await rpcBody({workspaceId:workspace!.id})),{headers:{cookie,'sec-fetch-site':'same-origin','x-tsr-serverFn':'true'}})
  expect(extraRead.status).toBe(400)
  for(const data of [{...input(),workspaceId:workspace!.id},{...input(),businessName:'line\nbreak'}])expect((await post(data)).status).toBe(400)
  expect((await post(input(),'')).status).toBe(401)
  expect((await post(input(),cookie,'https://foreign.example')).status).toBe(403)
  const beforeMissingProvenance=await revisions(workspace!.id)
  for(const request of [
    {method:'GET',url:origin+readPath+'?payload='+encodeURIComponent(await rpcBody({})),body:undefined},
    {method:'POST',url:origin+savePath,body:await rpcBody(input())},
  ]){
    // The admitted victim cookie is present; all three provenance headers are absent.
    const refused=await loopbackFetch(request.url,{method:request.method,headers:{cookie,'content-type':'application/json','x-tsr-serverFn':'true'},body:request.body})
    expect(refused.status).toBe(403)
    expect(refused.headers.get('cache-control')).toBe('no-store')
    expect(await revisions(workspace!.id)).toEqual(beforeMissingProvenance)
  }
  const saved=await post(input());expect(saved.status).toBe(200);expect(saved.headers.get('cache-control')).toBe('no-store');expect(saved.headers.get('x-robots-tag')).toBe('noindex')
  expect(saved.headers.get('content-security-policy')).toContain("default-src 'none'")
  expect(saved.headers.get('content-security-policy')).toContain("connect-src 'self'")
  expect(saved.headers.get('referrer-policy')).toBe('no-referrer')
  expect(saved.headers.get('x-content-type-options')).toBe('nosniff')
  expect(await saved.text()).toContain('Garage Dupont')
  expect((await post(input())).status).toBe(409)
  const reload=await read();expect(reload.status).toBe(200);const body=await reload.text();expect(body).toContain('Garage Dupont');expect(body).not.toContain(principal.sessionId)
  expect(await revisions(workspace!.id)).toHaveLength(1)
  await stores.administrator.query("CREATE FUNCTION fixture_activity_rpc_abort() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private-activity-rpc-marker'; END $$; CREATE TRIGGER fixture_activity_rpc_abort AFTER INSERT ON sparra_knowledge_revision FOR EACH ROW EXECUTE FUNCTION fixture_activity_rpc_abort()")
  try{
    const refused=await post(input(1));expect(refused.status).toBe(500);expect(await refused.text()).toBe('Activity unavailable');expect(await revisions(workspace!.id)).toHaveLength(1);expect(app.output()).not.toContain('private-activity-rpc-marker')
  }finally{await stores.administrator.query('DROP TRIGGER fixture_activity_rpc_abort ON sparra_knowledge_revision; DROP FUNCTION fixture_activity_rpc_abort()')}
  await stores.administrator.query('DELETE FROM session WHERE id=$1',[principal.sessionId])
  expect((await read()).status).toBe(401)
})
