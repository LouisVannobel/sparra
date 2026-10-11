import { expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { generateRegistrationOptions, verifyRegistrationResponse } from '@simplewebauthn/server'
import { Client, Pool } from 'pg'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { registrationCredentialFixture } from '../helpers/registration-ceremony'
import { classifiedSyntheticFields, fieldHash, projectSyntheticReconstruction, rebuildSyntheticReconstruction, type SyntheticReconstruction, type SyntheticRelations, type SyntheticSourceBinding } from '../helpers/caller-free-reconstruction'
import { createApplicationAuth, readAuthConfig } from '../../src/modules/auth/auth.server'
import { createAuthRateLimiter, readRateLimitConfig } from '../../src/modules/auth/rate-limit.server'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { createPersonalWorkspaces } from '../../src/modules/workspaces/personal.server'
import { createActivityOperations } from '../../src/modules/sparra/activity.server'

const origin='https://app.example.test', at='2026-10-12T00:00:00.000Z'
const owners=['owner-a','owner-b','owner-recovering']
const workspaceIds=['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','cccccccc-cccc-4ccc-8ccc-cccccccccccc']
const cookie=(headers:Headers)=>headers.getSetCookie().map(value=>value.split(';')[0]).join('; ')
let ip=30
function request(path:string, cookies='',body?:unknown,method='POST') {
  const result=Object.assign(new Request(origin+path,{method,body:body===undefined?undefined:JSON.stringify(body),headers:{origin,cookie:cookies,'content-type':'application/json','sec-fetch-site':'same-origin','x-real-ip':`192.0.2.${ip++}`}}),
    {runtime:{node:{req:{socket:{remoteAddress:'127.0.0.1'}}}}})
  Object.defineProperty(result,'appAuthDeadlineAtMs',{value:Date.now()+10000})
  return result
}
async function securityCatalog(client:Client) {
  return (await client.query(`SELECT
    (SELECT jsonb_agg(jsonb_build_array(n.nspname,c.relname,r.rolname,c.relrowsecurity,c.relforcerowsecurity,c.relacl::text) ORDER BY n.nspname,c.relname)
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner
      WHERE n.nspname IN ('public','voice_private') AND c.relkind='r') tables,
    (SELECT jsonb_agg(jsonb_build_array(n.nspname,p.proname,pg_get_function_identity_arguments(p.oid),r.rolname,p.prosecdef,p.proconfig,pg_get_functiondef(p.oid),p.proacl::text) ORDER BY n.nspname,p.proname,pg_get_function_identity_arguments(p.oid))
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
      WHERE n.nspname IN ('app_private','voice','voice_private')) functions,
    (SELECT jsonb_agg(jsonb_build_array(rolname,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolinherit,rolcanlogin) ORDER BY rolname)
      FROM pg_roles WHERE rolname IN ('runtime','workspace_owner','workspace_bootstrap','auth_mail_owner','auth_mail_definer','auth_mail_relay','auth_mail_worker','sparra_voice_definer')) roles`)).rows[0]
}
async function emptyExcluded(client:Client) {
  return (await client.query(`SELECT
    (SELECT count(*)::int FROM session) sessions,(SELECT count(*)::int FROM verification) verifications,
    (SELECT count(*)::int FROM additional_passkey_intent)+(SELECT count(*)::int FROM first_google_passkey_intent)+(SELECT count(*)::int FROM google_account_intent)+(SELECT count(*)::int FROM recovery_attempt) intents,
    (SELECT count(*)::int FROM auth_email_request)+(SELECT count(*)::int FROM auth_email_command)+(SELECT count(*)::int FROM email_delivery)+(SELECT count(*)::int FROM auth_email_outbox) mail,
    (SELECT count(*)::int FROM sparra_call)+(SELECT count(*)::int FROM sparra_erasure) callers,
    (SELECT count(*)::int FROM sparra_audio_chunk)+(SELECT count(*)::int FROM sparra_audio_quota)+(SELECT count(*)::int FROM sparra_audio_reader) audio,
    (SELECT count(*)::int FROM voice_private.operation_receipt)+(SELECT count(*)::int FROM voice_private.recording_purge) replay,
    (SELECT count(*)::int FROM workspace_audit)+(SELECT count(*)::int FROM auth_session_revocation)+(SELECT count(*)::int FROM recovery_code_rotation_fact) facts`)).rows[0]
}

// Catches native ownership/grant regressions, copied session authority, dropped
// counters/holds/spent codes, old configuration fallback and caller restoration.
test('isolated native reconstruction preserves source security/configuration, authenticates fresh passkeys and keeps Voice closed',async()=>{
  const credentials:ReturnType<typeof registrationCredentialFixture>[]=[]
  const keys:SyntheticRelations['passkey'][number][]=[]
  for(const owner of owners) {
    const options=await generateRegistrationOptions({rpName:'Synthetic qualification',rpID:new URL(origin).hostname,userName:owner,attestationType:'direct',authenticatorSelection:{userVerification:'required'}})
    const credential=registrationCredentialFixture(options,origin)
    const proof=await verifyRegistrationResponse({response:{...credential.response,response:{...credential.response.response,transports:['internal']}},expectedChallenge:options.challenge,expectedOrigin:origin,expectedRPID:new URL(origin).hostname,requireUserVerification:true})
    if(!proof.verified || !proof.registrationInfo)throw new Error('Synthetic native registration refused')
    credentials.push(credential)
    keys.push({id:'key-'+owner,name:'Synthetic key',public_key:Buffer.from(proof.registrationInfo.credential.publicKey).toString('base64'),user_id:owner,credential_id:proof.registrationInfo.credential.id,counter:7,device_type:proof.registrationInfo.credentialDeviceType,backed_up:proof.registrationInfo.credentialBackedUp,transports:'internal',created_at:at,aaguid:proof.registrationInfo.aaguid})
  }
  const hold=new Date(Date.now()+86400000).toISOString()
  const batches=owners.map(user_id=>({user_id,batch_id:randomUUID(),format_version:1 as const,recovery_generation:4,issued_at:at}))
  const data:SyntheticRelations={
    user:owners.map((id,index)=>({id,name:'Synthetic owner',email:id+'@example.test',email_verified:true,image:null,created_at:at,updated_at:at,recovering:index===2,recovery_generation:4,hold_until:index===0?hold:null})),
    account:[{id:'account-a',account_id:'synthetic-google-subject',provider_id:'google',user_id:owners[0],created_at:at,updated_at:at}],passkey:keys,
    recovery_code_batch:batches,recovery_code:batches.flatMap(batch=>Array.from({length:8},(_,i)=>({id:randomUUID(),user_id:batch.user_id,batch_id:batch.batch_id,digest:createHash('sha256').update(batch.user_id+':synthetic:'+i).digest('hex'),spent_at:i===0?at:null}))).sort((a,b)=>a.id.localeCompare(b.id)),
    workspace:owners.map((owner_user_id,i)=>({id:workspaceIds[i],kind:'personal',lifecycle:'active',owner_user_id,auth_organization_id:null,display_name:'Synthetic workshop '+i,created_at:at,updated_at:at})),
    sparra_knowledge_revision:workspaceIds.map(workspace_id=>({workspace_id,revision:12,business_name:'Synthetic garage',sector:'garage',opening_hours:'Monday',services:'Oil change',prices:'',faq:'',instructions:'',transfer_destination:null,recording_enabled:false,recording_policy:'off',recording_contact_phone:null,saved_at:at}))}
  const classified=classifiedSyntheticFields(data)
  let stores:Awaited<ReturnType<typeof startDisposableStores>>|undefined, pool:Pool|undefined,voice:Client|undefined
  let limiter:ReturnType<typeof createAuthRateLimiter>|undefined,auth:ReturnType<typeof createApplicationAuth>|undefined
  let bundle:SyntheticReconstruction
  try {
    stores=await startDisposableStores();await stores.migrate()
    const migrations=readMigrationFiles({migrationsFolder:'drizzle'})
    expect(migrations).toHaveLength(23)
    const journal=(await stores.administrator.query<SyntheticSourceBinding['journal'][number]>('SELECT id,hash,created_at::text FROM drizzle.__drizzle_migrations ORDER BY id')).rows
    expect(journal.map(r=>r.hash)).toEqual(migrations.map(r=>r.hash))
    const source:SyntheticSourceBinding={app_commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),app_tree:execFileSync('git',['rev-parse','HEAD^{tree}'],{encoding:'utf8',windowsHide:true}).trim(),
      web_digest:fieldHash('synthetic web binding; no OCI qualification'),migrator_digest:fieldHash('synthetic migrator binding; native source CLI only'),migration_source_hash:fieldHash(JSON.stringify(migrations.map(m=>({hash:m.hash,created_at:m.folderMillis})))),postgres_version:'160015',journal}
    bundle={schema_version:1,purpose:'caller-free-service-reconstruction',qualification:'synthetic-closed-admission',capture_id:randomUUID(),captured_at:at,source,relations:data}
    await rebuildSyntheticReconstruction(stores.administrator,bundle,source,classified)
    // All excluded records are real synthetic PostgreSQL rows, never fixtures
    // pretending to be queries. Token values remain transient within this store.
    await stores.administrator.query(`UPDATE account SET access_token='synthetic-excluded-access',refresh_token='synthetic-excluded-refresh',id_token='synthetic-excluded-id',scope='synthetic-scope';
      INSERT INTO session(id,token,user_id,expires_at,auth_state,auth_method,authenticated_at,recovery_generation,last_activity_at) VALUES('source-session','synthetic-old-cookie','owner-a',now()+interval '1 day','ACTIVE','passkey',now(),4,now());
      INSERT INTO verification(id,identifier,value,expires_at) VALUES('source-oauth','auth-state:synthetic-old-state','synthetic-old-oauth',now()+interval '1 day')`)
    await stores.administrator.query("INSERT INTO additional_passkey_intent(id,user_id,session_id,workspace_id,recovery_generation,phase,expires_at,authentication_challenge) VALUES($1,'owner-a','source-session',$2,4,'CHALLENGE',now()+interval '1 minute','synthetic-old-challenge')",[randomUUID(),workspaceIds[0]])
    await stores.administrator.query("INSERT INTO workspace_audit(action,actor_user_id,workspace_id,correlation_id) VALUES('personal-created','owner-a',$1,$2)",[workspaceIds[0],randomUUID()])
    await stores.administrator.query(`INSERT INTO sparra_knowledge_revision(workspace_id,revision,business_name,sector,opening_hours,services,prices,faq,instructions,saved_at) VALUES($1,11,'Old synthetic garage','garage','','','','Caller details never selected','',$2)`,[workspaceIds[0],at])
    const callId=randomUUID(),recordingId=randomUUID()
    await stores.administrator.query(`INSERT INTO sparra_call(id,workspace_id,configuration_revision,deployment_id,provider_call_control_id,admitted_at,retention_until,from_e164,recording_id,audio_state) VALUES($1,$2,12,'synthetic-source','synthetic-source-call',$3,$3::timestamptz+interval '2592000 seconds','+33600000000',$4,'pending')`,[callId,workspaceIds[0],at,recordingId])
    await stores.administrator.query(`INSERT INTO sparra_audio_chunk(workspace_id,call_id,recording_id,deployment_id,sequence,configuration_revision,retention_until,sample_count,sample_rate,channels,sample_format,crypto_version,key_version,nonce,ciphertext,charged_bytes) VALUES($1,$2,$3,'synthetic-source',0,12,$4::timestamptz+interval '2592000 seconds',1,8000,2,'s16le',1,1,decode(repeat('00',12),'hex'),decode(repeat('00',20),'hex'),32)`,[workspaceIds[0],callId,recordingId,at])
    const excluded=await emptyExcluded(stores.administrator)
    expect(excluded).toMatchObject({sessions:1,verifications:1,intents:1,callers:1,audio:1,facts:1})
    bundle=await projectSyntheticReconstruction(stores.administrator,owners,workspaceIds,bundle,classified)
    expect(fieldHash(JSON.stringify(bundle.relations))).toBe(fieldHash(JSON.stringify(data)))
    expect(JSON.stringify(bundle)).not.toMatch(/synthetic-excluded|synthetic-old|source-call|Caller details/)
    // A later unclassified highest revision must refuse, never fall back to 12.
    await stores.administrator.query("INSERT INTO sparra_knowledge_revision(workspace_id,revision,business_name,sector,opening_hours,services,prices,faq,instructions,saved_at) VALUES($1,13,'Synthetic garage','garage','','','','Caller details never approved','',$2)",[workspaceIds[0],at])
    await expect(projectSyntheticReconstruction(stores.administrator,owners,workspaceIds,bundle,classified)).rejects.toThrow('Synthetic reconstruction refused')
    const retiredSource=stores;stores=undefined;await retiredSource.cleanup()

    // Source is retired before target creation: only one bounded fixture owns
    // the existing exact-inventory guard at any time.
    stores=await startDisposableStores();await stores.migrate()
    const before=fieldHash(JSON.stringify(await securityCatalog(stores.administrator)))
    const invalid={...bundle,qualification:'real-qualified'}
    await expect(rebuildSyntheticReconstruction(stores.administrator,invalid,source,classified)).rejects.toThrow('Synthetic reconstruction refused')
    expect((await stores.administrator.query('SELECT count(*)::int AS n FROM public."user"')).rows[0].n).toBe(0)
    await stores.administrator.query("INSERT INTO verification(id,identifier,value,expires_at) VALUES('owned-target-nonempty','synthetic-target-state','synthetic-target-value',now()+interval '1 minute')")
    await expect(rebuildSyntheticReconstruction(stores.administrator,bundle,source,classified)).rejects.toThrow('Synthetic reconstruction refused')
    expect((await stores.administrator.query('SELECT count(*)::int AS n FROM public."user"')).rows[0].n).toBe(0)
    expect((await stores.administrator.query('SELECT count(*)::int AS n FROM verification')).rows[0].n).toBe(1)
    await stores.administrator.query("DELETE FROM verification WHERE id='owned-target-nonempty'")
    await rebuildSyntheticReconstruction(stores.administrator,bundle,source,classified)
    expect(fieldHash(JSON.stringify(await securityCatalog(stores.administrator)))).toBe(before)
    expect(fieldHash(JSON.stringify((await projectSyntheticReconstruction(stores.administrator,owners,workspaceIds,bundle,classified)).relations))).toBe(fieldHash(JSON.stringify(data)))
    expect(await emptyExcluded(stores.administrator)).toEqual({sessions:0,verifications:0,intents:0,mail:0,callers:0,audio:0,replay:0,facts:0})
    expect((await stores.administrator.query('SELECT access_token,refresh_token,id_token,scope,password FROM account')).rows).toEqual([{access_token:null,refresh_token:null,id_token:null,scope:null,password:null}])
    await expect(rebuildSyntheticReconstruction(stores.administrator,bundle,source,classified)).rejects.toThrow('Synthetic reconstruction refused')
    expect(fieldHash(JSON.stringify((await projectSyntheticReconstruction(stores.administrator,owners,workspaceIds,bundle,classified)).relations))).toBe(fieldHash(JSON.stringify(data)))

    pool=new Pool({connectionString:stores.directRuntimeUrl,max:2})
    const owner=createTransactions(pool,{maxStatementTimeoutMs:1000,maxCleanupTimeoutMs:1000})
    limiter=createAuthRateLimiter(readRateLimitConfig({REDIS_URL:stores.redisUrl,RATE_LIMIT_HMAC_SECRET:stores.hmac,RATE_LIMIT_KEY_ID:'caller-free',TRUSTED_PROXY_IPS:'127.0.0.1',NODE_ENV:'test'}));await limiter.connect()
    auth=createApplicationAuth(owner,readAuthConfig({APP_ORIGIN:origin,AUTH_SECRET:randomBytes(48).toString('hex'),NODE_ENV:'test'})!,limiter)
    const application=auth
    async function login(index:number) {
      const begin=await application.beginPasskeySignIn(request('/auth/passkey/begin'))
      const response=credentials[index].authenticationResponse(begin.options,{counter:8,uv:true})
      const finish=await application.finishPasskeySignIn(request('/auth/passkey/finish',cookie(begin.headers),{response}),{response})
      const principal=await application.readPrincipal(request('/account',cookie(finish.headers),undefined,'GET'))
      if(!principal)throw new Error('Native fresh passkey principal missing')
      return {principal,cookies:cookie(finish.headers)}
    }
    expect(await auth.readPrincipal(request('/account','better-auth.session_token=synthetic-old-cookie',undefined,'GET'))).toBeNull()
    const first=await login(0), second=await login(1)
    expect(first.principal.userId).toBe(owners[0]);expect(second.principal.userId).toBe(owners[1])
    const personal=createPersonalWorkspaces(owner),activity=createActivityOperations(owner)
    expect(await personal.readWorkspace(first.principal,workspaceIds[0])).toEqual({id:workspaceIds[0],displayName:'Synthetic workshop 0'})
    const state=await activity.read(first.principal)
    expect(state.configuration).toEqual({workspaceId:workspaceIds[0],revision:12,savedAt:at,businessName:'Synthetic garage',sector:'garage',knowledge:{openingHours:'Monday',services:'Oil change',prices:'',faq:'',instructions:''},transferDestination:null,recordingEnabled:false,recordingPolicy:'off',recordingContactPhone:null})
    expect(state.localAudioAvailable).toBe(false)
    expect(await personal.readWorkspace(second.principal,workspaceIds[0])).toBeNull()
    expect(await personal.renameWorkspace(second.principal,workspaceIds[0],'Forbidden rename')).toBeNull()
    const rls=await pool.connect()
    try {await rls.query('BEGIN');await rls.query("SELECT set_config('app.tenant_id',$1,true)",[workspaceIds[1]])
      expect((await rls.query('SELECT revision FROM sparra_knowledge_revision WHERE workspace_id=$1',[workspaceIds[0]])).rows).toHaveLength(0)
      expect((await rls.query('UPDATE workspace SET display_name=$1 WHERE id=$2',['Forbidden rename',workspaceIds[0]])).rowCount).toBe(0)
    } finally {await rls.query('ROLLBACK');rls.release()}
    await expect(auth.beginAdditionalPasskey(request('/auth/passkey/additional/begin',first.cookies))).rejects.toThrow('Authentication rejected')
    const recoveringBegin=await auth.beginPasskeySignIn(request('/auth/passkey/begin'))
    const recoveringResponse=credentials[2].authenticationResponse(recoveringBegin.options,{counter:8,uv:true})
    await expect(auth.finishPasskeySignIn(request('/auth/passkey/finish',cookie(recoveringBegin.headers),{response:recoveringResponse}),{response:recoveringResponse})).rejects.toThrow('Authentication rejected')
    expect((await stores.administrator.query('SELECT recovering,recovery_generation,hold_until FROM public."user" ORDER BY id')).rows.map(r=>({recovering:r.recovering,generation:r.recovery_generation,hold:r.hold_until?.toISOString()??null}))).toEqual([{recovering:false,generation:4,hold},{recovering:false,generation:4,hold:null},{recovering:true,generation:4,hold:null}])
    expect((await stores.administrator.query('SELECT counter FROM passkey ORDER BY id')).rows).toEqual([{counter:8},{counter:8},{counter:7}])
    expect((await stores.administrator.query('SELECT count(*)::int AS n FROM recovery_code WHERE spent_at=$1',[at])).rows[0].n).toBe(3)
    expect((await stores.administrator.query('SELECT count(*)::int AS n FROM session')).rows[0].n).toBe(2)
    const native=(await stores.administrator.query(`SELECT has_schema_privilege('runtime','voice_private','USAGE') private_schema,has_table_privilege('runtime','voice_private.deployment_binding','SELECT') binding_read,
      (SELECT bool_and(relrowsecurity AND relforcerowsecurity) FROM pg_class WHERE oid IN ('public.workspace'::regclass,'public.sparra_knowledge_revision'::regclass,'voice_private.deployment_binding'::regclass)) forced,
      (SELECT prosecdef AND pg_get_userbyid(proowner)='sparra_voice_definer' FROM pg_proc WHERE oid='voice.begin_call_v1(text,uuid,jsonb)'::regprocedure) definer`)).rows[0]
    expect(native).toEqual({private_schema:false,binding_read:false,forced:true,definer:true})
    await stores.administrator.query("GRANT USAGE ON SCHEMA voice TO sparra_voice_a;GRANT EXECUTE ON FUNCTION voice.begin_call_v1(text,uuid,jsonb) TO sparra_voice_a")
    await stores.administrator.query("INSERT INTO voice_private.deployment_binding(service_login,service_role_oid,deployment_id,workspace_id,connection_id,to_e164,admission_enabled,audio_enabled,local_audio_enabled) SELECT 'sparra_voice_a',oid,'synthetic-closed',$1,'synthetic-connection','+33123456789',false,false,false FROM pg_roles WHERE rolname='sparra_voice_a'",[workspaceIds[0]])
    voice=new Client({connectionString:stores.voiceUrlA});await voice.connect()
    await expect(voice.query('SELECT voice.begin_call_v1($1,$2,$3)',['synthetic-closed',randomUUID(),{}])).rejects.toMatchObject({code:'PV202'})
    expect((await stores.administrator.query('SELECT count(*)::int AS n FROM sparra_call')).rows[0].n).toBe(0)
    expect((await stores.administrator.query('SELECT admission_enabled,audio_enabled,local_audio_enabled FROM voice_private.deployment_binding')).rows).toEqual([{admission_enabled:false,audio_enabled:false,local_audio_enabled:false}])
  } finally {
    const failures:string[]=[]
    for(const [name,close] of [['voice',()=>voice?.end()],['auth',()=>auth?.close()],['limiter',()=>limiter?.close()],['pool',()=>pool?.end()]] as const)try{await close()}catch{failures.push(name)}
    if(stores)try{await stores.cleanup()}catch{failures.push('stores')}
    if(failures.length)throw new Error('Caller-free owned cleanup failed: '+failures.join(','))
  }
},180000)

test('native caller-free rebuild has a one-shot fixed insert consumer', async () => {
  const path = '../helpers/caller-free-reconstruction'
  const helper = await import(path).catch(() => null)
  expect(typeof helper?.rebuildSyntheticReconstruction, 'Feature absence: isolated fixed native reconstruction consumer missing').toBe('function')
})
