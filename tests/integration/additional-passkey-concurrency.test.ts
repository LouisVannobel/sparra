import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool } from 'pg'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { createApplicationAuth, readAuthConfig } from '../../src/modules/auth/auth.server'
import { createAuthEmailEnvelope } from '../../src/modules/auth/auth-email-envelope.server'
import { magicConsumeResponse, magicEnrollmentResponse } from '../../src/modules/auth/http-boundary.server'
import { createAuthRateLimiter, readRateLimitConfig } from '../../src/modules/auth/rate-limit.server'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { PgTransactionError } from '../../src/platform/db/auth-pg-lease.server'
import { createPersonalWorkspaces } from '../../src/modules/workspaces/personal.server'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { pgRelay } from '../fixtures/db/pg-relay'
import { registrationCredentialFixture } from '../helpers/registration-ceremony'
import type { AdditionalPasskeyInvocation } from '../../src/modules/auth/additional-passkey.server'

const observed=vi.hoisted(()=>({token:'',holdPath:'',held:false,entered:Promise.resolve(),enter:()=>{},gate:Promise.resolve(),release:()=>{},
  authority:undefined as AdditionalPasskeyInvocation|undefined,request:undefined as Request|undefined}))
vi.mock('../../src/modules/auth/mail-snapshot.server',async importOriginal=>{
  const actual=await importOriginal<typeof import('../../src/modules/auth/mail-snapshot.server')>()
  return {...actual,createMailSnapshot(...args:Parameters<typeof actual.createMailSnapshot>){const value=actual.createMailSnapshot(...args);observed.token=args[3].toString('base64url');return value}}
})
vi.mock('../../src/modules/auth/admission.server',async importOriginal=>{
  const actual=await importOriginal<typeof import('../../src/modules/auth/admission.server')>(),{createAuthMiddleware}=await import('better-auth/api')
  return {...actual,googleAdmission(...args:Parameters<typeof actual.googleAdmission>){
    const plugin=actual.googleAdmission(...args),before=plugin.hooks.before[0].handler
    return {...plugin,hooks:{...plugin.hooks,before:[{matcher:()=>true,handler:createAuthMiddleware(async ctx=>{
      const result=await before({...ctx,returnHeaders:false}),authority=args[5]?.(ctx.request)
      if(authority && ctx.path===observed.holdPath && !observed.held){
        observed.held=true;observed.authority=authority;observed.request=ctx.request;observed.enter();await observed.gate
      }
      return result
    })}]}}
  }}
})

const origin='https://app.example.test',profile={appOrigin:origin,apiOrigin:'https://mail.example.test',projectId:'fixture',credentialId:'fixture',
  from:{name:'Fixture',email:'auth@example.test'},reply:'support@example.test',replayWindowSeconds:null}
let stores:Awaited<ReturnType<typeof startDisposableStores>>,poolA:Pool,poolB:Pool,ownerA:ReturnType<typeof createTransactions>,ownerB:ReturnType<typeof createTransactions>
let limiter:ReturnType<typeof createAuthRateLimiter>,appA:ReturnType<typeof createApplicationAuth>,appB:ReturnType<typeof createApplicationAuth>,config:Parameters<typeof createApplicationAuth>[1],ip=1
const commitObservations: { phase: string; outcome: string; status: number; committedObserved: boolean }[]=[]
const cookies=(headers:Headers)=>headers.getSetCookie().map(value=>value.split(';')[0]).join('; ')
function request(cookie=''){
  const value=Object.assign(new Request(origin+'/additional',{method:'POST',headers:{origin,cookie,'sec-fetch-site':'same-origin','x-real-ip':`198.19.${Math.floor(ip/250)}.${ip++%250+1}`}}),
    {runtime:{node:{req:{socket:{remoteAddress:'127.0.0.1'}}}}})
  Object.defineProperty(value,'appAuthDeadlineAtMs',{value:Date.now()+10000});return value
}
async function status(call:Promise<unknown>){try{await call;return 200}catch(error){return appA.additionalPasskeyErrorResponse(error)?.status??limiter.errorResponse(error)?.status??500}}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
async function snapshot(userId:string,db:{query(text:string,values?:unknown[]):Promise<{rows:unknown[]}>}=stores.administrator){
  return digest((await db.query(`SELECT row_to_json(t) FROM (
    SELECT 'session' AS kind,to_jsonb(s) AS value FROM session s WHERE user_id=$1 UNION ALL
    SELECT 'key',to_jsonb(p) FROM passkey p WHERE user_id=$1 UNION ALL
    SELECT 'intent',to_jsonb(i) FROM additional_passkey_intent i WHERE user_id=$1
  ) t ORDER BY kind,value::text`,[userId])).rows)
}
async function enroll(){
  const email=`additional-race-${randomUUID()}@example.test`
  await appA.requestMagicLink(request(),{email,locale:'en'})
  const proof={token:observed.token,intendedEmail:email},options=await magicConsumeResponse(request(),proof,appA,limiter)
  expect(options.status).toBe(200)
  const credential=registrationCredentialFixture((await options.json()).options,origin)
  const enrolled=await magicEnrollmentResponse(request(cookies(options.headers)),{...proof,response:credential.response},appA,limiter)
  expect(enrolled.status).toBe(200)
  const cookie=cookies(enrolled.headers),principal=await appA.requirePrincipal(request(cookie))
  const workspace=await createPersonalWorkspaces(ownerA).ensurePersonalWorkspace(principal)
  if(!workspace)throw new Error('Fixture workspace missing')
  return {credential,cookie,principal,workspace}
}
beforeAll(async()=>{
  stores=await startDisposableStores();await stores.migrate()
  await stores.administrator.query(`GRANT USAGE ON SCHEMA public TO runtime;
    GRANT SELECT,INSERT,UPDATE,DELETE ON public."user",public.account,public.session,public.verification,public.additional_passkey_intent TO runtime;
    GRANT SELECT,INSERT ON public.passkey TO runtime; GRANT UPDATE(counter) ON public.passkey TO runtime;
    GRANT SELECT,INSERT,UPDATE ON public.auth_email_request TO runtime; GRANT SELECT,INSERT ON public.auth_email_command TO runtime;
    GRANT SELECT ON public.email_delivery,public.auth_email_outbox TO runtime;
    GRANT INSERT(id,command_id,state,verifier_hash,key_id,ciphertext,nonce,tag,snapshot_format,snapshot_hash,replay_window_seconds) ON public.email_delivery TO runtime;
    GRANT UPDATE(state,verifier_hash,ciphertext,nonce,tag) ON public.email_delivery TO runtime; GRANT INSERT(id,delivery_id) ON public.auth_email_outbox TO runtime`)
  poolA=new Pool({connectionString:stores.directRuntimeUrl,max:1});poolB=new Pool({connectionString:stores.directRuntimeUrl,max:1})
  ownerA=createTransactions(poolA,{maxStatementTimeoutMs:1000,maxCleanupTimeoutMs:1000});ownerB=createTransactions(poolB,{maxStatementTimeoutMs:1000,maxCleanupTimeoutMs:1000})
  limiter=createAuthRateLimiter(readRateLimitConfig({REDIS_URL:stores.redisUrl,RATE_LIMIT_HMAC_SECRET:stores.hmac,RATE_LIMIT_KEY_ID:'additional-race',TRUSTED_PROXY_IPS:'127.0.0.1',NODE_ENV:'test'}));await limiter.connect()
  config={...readAuthConfig({APP_ORIGIN:origin,AUTH_SECRET:randomBytes(48).toString('hex')})!,magic:{profile,envelope:createAuthEmailEnvelope({currentKeyId:'fixture',keys:{fixture:randomBytes(32)}})}}
  appA=createApplicationAuth(ownerA,config,limiter);appB=createApplicationAuth(ownerB,config,limiter)
})
afterAll(async()=>{
  observed.release();const failures:string[]=[]
  for(const [name,close] of [['app-a',()=>appA?.close()],['app-b',()=>appB?.close()],['limiter',()=>limiter?.close()],['pool-a',()=>poolA?.end()],['pool-b',()=>poolB?.end()],['stores',()=>stores?.cleanup()]] as const)
    try{await close()}catch{failures.push(name)}
  if(stores){try{const dir=resolve('.superpowers/sdd/2026-09-10-functional-auth/task-9b-evidence');await mkdir(dir,{recursive:true});await writeFile(resolve(dir,`concurrency-${stores.evidence.runId}.json`),JSON.stringify({stores:stores.evidence,cleanupFailures:failures,commitObservations},null,2)+'\n',{flag:'wx'})}catch{failures.push('receipt')}}
  if(failures.length)throw new Error('Additional concurrency cleanup failed: '+failures.join(','))
})
function hold(path:string){observed.holdPath=path;observed.held=false;observed.entered=new Promise(resolve=>{observed.enter=resolve});observed.gate=new Promise(resolve=>{observed.release=resolve})}
async function overlap(first:()=>Promise<unknown>,second:()=>Promise<unknown>,path:string){
  hold(path);const one=status(first());let two:Promise<number>|undefined
  try{
    await Promise.race([observed.entered,delay(2000).then(()=>{throw new Error('Owned first backend did not reach hold')})]);two=status(second())
    await expect.poll(async()=> (await stores.administrator.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity w JOIN pg_stat_activity b ON b.pid=ANY(pg_blocking_pids(w.pid))
      WHERE w.usename='runtime' AND b.usename='runtime' AND w.pid<>b.pid AND w.wait_event_type='Lock') AS overlap`)).rows[0].overlap,{timeout:700,interval:10}).toBe(true)
    observed.release();return await Promise.all([one,two])
  }finally{observed.release();observed.holdPath='';await Promise.allSettled([one,...two?[two]:[]])}
}
test('same_intent_zero_counter_authorizes_once',async()=>{
  const f=await enroll(),begin=await appA.beginAdditionalPasskey(request(f.cookie)),input={intentId:begin.intentId,response:f.credential.authenticationResponse(begin.options,{counter:0})}
  const codes=await overlap(()=>appA.authorizeAdditionalPasskey(request(f.cookie),input),()=>appB.authorizeAdditionalPasskey(request(f.cookie),input),'/passkey/generate-register-options')
  expect(codes.sort()).toEqual([200,401]);expect((await stores.administrator.query('SELECT counter FROM passkey WHERE user_id=$1',[f.principal.userId])).rows[0].counter).toBe(0)
  expect((await stores.administrator.query('SELECT phase FROM additional_passkey_intent WHERE id=$1',[begin.intentId])).rows[0].phase).toBe('AUTHORIZED')
})
test('distinct_challenges_never_overwrite_newer_counter',async()=>{
  for(const order of [[1,2],[2,1]]){
    const f=await enroll(),one=await appA.beginAdditionalPasskey(request(f.cookie)),two=await appB.beginAdditionalPasskey(request(f.cookie))
    const codes=await overlap(()=>appA.authorizeAdditionalPasskey(request(f.cookie),{intentId:one.intentId,response:f.credential.authenticationResponse(one.options,{counter:order[0]})}),
      ()=>appB.authorizeAdditionalPasskey(request(f.cookie),{intentId:two.intentId,response:f.credential.authenticationResponse(two.options,{counter:order[1]})}),'/passkey/generate-register-options')
    expect(codes).toEqual(order[0]===1?[200,200]:[200,500])
    expect((await stores.administrator.query('SELECT counter FROM passkey WHERE user_id=$1',[f.principal.userId])).rows[0].counter).toBe(2)
  }
})
test('two_finishes_insert_once',async()=>{
  const f=await enroll(),begin=await appA.beginAdditionalPasskey(request(f.cookie)),authorized=await appA.authorizeAdditionalPasskey(request(f.cookie),{intentId:begin.intentId,response:f.credential.authenticationResponse(begin.options)})
  const input={intentId:begin.intentId,response:registrationCredentialFixture(authorized.options,origin).response},cookie=f.cookie+'; '+cookies(authorized.headers)
  expect((await overlap(()=>appA.finishAdditionalPasskey(request(cookie),input),()=>appB.finishAdditionalPasskey(request(cookie),input),'/passkey/verify-registration')).sort()).toEqual([200,401])
  expect((await stores.administrator.query('SELECT count(*)::int AS n FROM passkey WHERE user_id=$1',[f.principal.userId])).rows[0].n).toBe(2)
})
test('get_session_exception_rejects_foreign_lease_and_invocation',async()=>{
  const f=await enroll();hold('/get-session');const call=status(appA.beginAdditionalPasskey(request(f.cookie)))
  try{
    await Promise.race([observed.entered,delay(2000).then(()=>{throw new Error('Private reader hold missing')})])
    const options={deadlineAtMs:Date.now()+10000,statementTimeoutMs:1000,cleanupTimeoutMs:1000,correlationId:randomUUID()}
    await ownerB.withAuthPromise(options,async()=>{expect(()=>observed.authority!.assert('session',observed.request)).toThrow()})
    await ownerA.runAuthInvocation(options,async()=>{expect(()=>observed.authority!.assert('session',observed.request)).toThrow()})
    observed.release();expect(await call).toBe(200)
  }finally{observed.release();observed.holdPath='';await call}
})
test('waiting_transition_rechecks_state_and_database_time',async()=>{
  for(const phase of ['begin','authorize','finish'] as const){
    for(const mutation of ['recovering','generation','hold','session-delete','session-expiry','workspace-lifecycle','workspace-owner',...phase==='begin'?[]:['key-delete','key-material','intent-expiry','natural-intent-expiry'],...phase==='finish'?['native-expiry']:[]]){
      const f=await enroll(),begin=phase==='begin'?undefined:await appA.beginAdditionalPasskey(request(f.cookie))
      const authorized=phase==='finish'&&begin?await appA.authorizeAdditionalPasskey(request(f.cookie),{intentId:begin.intentId,response:f.credential.authenticationResponse(begin.options)}):undefined
      const response=authorized?registrationCredentialFixture(authorized.options,origin).response:begin?f.credential.authenticationResponse(begin.options):undefined
      const table=mutation.startsWith('session')?'session':mutation.startsWith('workspace')?'workspace':mutation.startsWith('key')?'passkey':mutation.includes('intent-expiry')?'additional_passkey_intent':mutation==='native-expiry'?'verification':'"user"'
      const selector=table==='session'?f.principal.sessionId:table==='workspace'?f.workspace.id:table==='passkey'?(await stores.administrator.query('SELECT id FROM passkey WHERE user_id=$1',[f.principal.userId])).rows[0].id
        :table==='additional_passkey_intent'?begin!.intentId:table==='verification'?(await stores.administrator.query('SELECT v.id FROM verification v JOIN additional_passkey_intent i ON i.registration_verification_identifier=v.identifier WHERE i.id=$1',[begin!.intentId])).rows[0].id:f.principal.userId
      let pending:Promise<number>|undefined, settled=false
      const admin=stores.administrator
      const administratorPid=(await admin.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      if(mutation==='natural-intent-expiry')await admin.query("UPDATE additional_passkey_intent SET expires_at=clock_timestamp()+interval '300 milliseconds' WHERE id=$1",[selector])
      await admin.query('BEGIN');await admin.query(`SELECT id FROM ${table} WHERE id=$1 FOR UPDATE`,[selector])
      try{
        const cookie=f.cookie+(authorized?'; '+cookies(authorized.headers):'')
        pending=status(phase==='begin'?appA.beginAdditionalPasskey(request(cookie)):phase==='authorize'?appA.authorizeAdditionalPasskey(request(cookie),{intentId:begin!.intentId,response}):appA.finishAdditionalPasskey(request(cookie),{intentId:begin!.intentId,response})).finally(()=>{settled=true})
        await expect.poll(async()=> (await poolB.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity w WHERE w.usename='runtime' AND $1=ANY(pg_blocking_pids(w.pid))) AS waiting`,[administratorPid])).rows[0].waiting,{timeout:700,interval:10}).toBe(true)
        if(mutation==='natural-intent-expiry')await delay(350)
        else if(mutation==='recovering')await admin.query('UPDATE "user" SET recovering=true WHERE id=$1',[selector])
        else if(mutation==='generation')await admin.query('UPDATE "user" SET recovery_generation=recovery_generation+1 WHERE id=$1',[selector])
        else if(mutation==='hold')await admin.query('UPDATE "user" SET hold_until=clock_timestamp()+interval \'1 hour\' WHERE id=$1',[selector])
        else if(mutation.endsWith('delete'))await admin.query(`DELETE FROM ${table} WHERE id=$1`,[selector])
        else if(mutation.endsWith('expiry'))await admin.query(`UPDATE ${table} SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,[selector])
        else if(mutation==='workspace-lifecycle')await admin.query("UPDATE workspace SET lifecycle='deleting' WHERE id=$1",[selector])
        else if(mutation==='workspace-owner'){
          const other=randomUUID();await admin.query('INSERT INTO "user"(id,name,email) VALUES($1,\'Fixture\',$2)',[other,other+'@example.test']);await admin.query('UPDATE workspace SET owner_user_id=$2 WHERE id=$1',[selector,other])
        }else await admin.query("UPDATE passkey SET public_key='changed' WHERE id=$1",[selector])
        const expected=await snapshot(f.principal.userId,admin)
        expect(settled).toBe(false)
        await admin.query('COMMIT')
        const code=await pending;expect(code).toBe(401);expect(await snapshot(f.principal.userId)===expected).toBe(true)
      }finally{await admin.query('ROLLBACK');if(pending)await pending}
    }
  }
},180000)
test('ambiguous_commit_never_resends_or_claims_rollback',async()=>{
  const f=await enroll(),begin=await appA.beginAdditionalPasskey(request(f.cookie)),authorized=await appA.authorizeAdditionalPasskey(request(f.cookie),{intentId:begin.intentId,response:f.credential.authenticationResponse(begin.options)})
  const relay=await pgRelay(stores.directRuntimeUrl,'before-command-complete'),pool=new Pool({connectionString:relay.url,max:1})
  const owner=createTransactions(pool,{maxStatementTimeoutMs:1000,maxCleanupTimeoutMs:1000}),app=createApplicationAuth(owner,config,limiter)
  try{
    const response=registrationCredentialFixture(authorized.options,origin).response
    const error=await app.finishAdditionalPasskey(request(f.cookie+'; '+cookies(authorized.headers)),{intentId:begin.intentId,response}).then(()=>undefined,error=>error)
    expect(app.additionalPasskeyErrorResponse(error)?.status).toBe(409)
    expect(error instanceof PgTransactionError).toBe(true)
    if(error instanceof PgTransactionError)commitObservations.push({phase:error.phase,outcome:error.outcome,status:app.additionalPasskeyErrorResponse(error)!.status,
      committedObserved:(await stores.administrator.query('SELECT phase FROM additional_passkey_intent WHERE id=$1',[begin.intentId])).rows[0].phase==='CONSUMED'})
    expect(relay.controls.filter(value=>value==='COMMIT').length).toBe(1)
    expect(relay.commitCompletions()).toBe(1)
    expect((await stores.administrator.query('SELECT count(*)::int AS n FROM passkey WHERE user_id=$1',[f.principal.userId])).rows[0].n).toBe(2)
    expect((await stores.administrator.query('SELECT phase FROM additional_passkey_intent WHERE id=$1',[begin.intentId])).rows[0].phase).toBe('CONSUMED')
  }finally{const results=await Promise.allSettled([app.close(),pool.end()]);await relay.close();if(results.some(item=>item.status==='rejected'))throw new Error('Ambiguous fixture cleanup failed')}
})
test('remaining_waited_session_replacement_and_generation_are_refused',async()=>{
  for(const phase of ['begin','authorize','finish'] as const){
    for(const mutation of ['session-replacement','session-generation',...phase==='begin'?[]:['paired-generation']]){
      const f=await enroll()
      let replacementCookie:string|undefined
      if(mutation==='session-replacement'){
        const options=await appA.beginPasskeySignIn(request())
        const signed=await appA.finishPasskeySignIn(request(cookies(options.headers)),{response:f.credential.authenticationResponse(options.options)})
        replacementCookie=cookies(signed.headers)
      }
      const counter=(await stores.administrator.query('SELECT counter FROM passkey WHERE user_id=$1',[f.principal.userId])).rows[0].counter+1
      const begin=phase==='begin'?undefined:await appA.beginAdditionalPasskey(request(f.cookie))
      const authorized=phase==='finish'?await appA.authorizeAdditionalPasskey(request(f.cookie),{intentId:begin!.intentId,response:f.credential.authenticationResponse(begin!.options,{counter})}):undefined
      const response=authorized?registrationCredentialFixture(authorized.options,origin).response:begin?f.credential.authenticationResponse(begin.options,{counter}):undefined
      if(replacementCookie&&begin){
        const replacement=await appB.requirePrincipal(request(replacementCookie))
        expect(replacement.sessionId!==f.principal.sessionId).toBe(true)
        expect((await stores.administrator.query('SELECT count(*)::int AS n FROM session WHERE id=ANY($1::text[])',[ [replacement.sessionId,f.principal.sessionId] ])).rows[0].n).toBe(2)
        const before=await snapshot(f.principal.userId),cookie=replacementCookie+(authorized?'; '+cookies(authorized.headers):'')
        const attempt=phase==='authorize'?appB.authorizeAdditionalPasskey(request(cookie),{intentId:begin.intentId,response})
          :appB.finishAdditionalPasskey(request(cookie),{intentId:begin.intentId,response})
        expect(await status(attempt)).toBe(401)
        expect(await snapshot(f.principal.userId)===before).toBe(true)
      }
      const admin=stores.administrator,pid=(await admin.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      const table=mutation==='paired-generation'?'"user"':'session',id=mutation==='paired-generation'?f.principal.userId:f.principal.sessionId
      await admin.query('BEGIN');await admin.query(`SELECT id FROM ${table} WHERE id=$1 FOR UPDATE`,[id])
      let settled=false,pending:Promise<number>|undefined
      try{
        const cookie=f.cookie+(authorized?'; '+cookies(authorized.headers):'')
        pending=status(phase==='begin'?appA.beginAdditionalPasskey(request(cookie)):phase==='authorize'?appA.authorizeAdditionalPasskey(request(cookie),{intentId:begin!.intentId,response}):appA.finishAdditionalPasskey(request(cookie),{intentId:begin!.intentId,response})).finally(()=>{settled=true})
        await expect.poll(async()=> (await poolB.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity w WHERE w.usename='runtime' AND $1=ANY(pg_blocking_pids(w.pid))) AS waiting`,[pid])).rows[0].waiting,{timeout:700,interval:10}).toBe(true)
        if(mutation==='session-replacement')await admin.query('DELETE FROM session WHERE id=$1',[f.principal.sessionId])
        else{
          if(mutation==='paired-generation')await admin.query('UPDATE "user" SET recovery_generation=recovery_generation+1 WHERE id=$1',[f.principal.userId])
          await admin.query('UPDATE session SET recovery_generation=recovery_generation+1 WHERE id=$1',[f.principal.sessionId])
        }
        const expected=await snapshot(f.principal.userId,admin);expect(settled).toBe(false);await admin.query('COMMIT')
        expect(await pending).toBe(401);expect(await snapshot(f.principal.userId)===expected).toBe(true)
        if(replacementCookie){const principal=await appB.requirePrincipal(request(replacementCookie));expect(principal.userId===f.principal.userId&&principal.sessionId!==f.principal.sessionId).toBe(true)}
      }finally{await admin.query('ROLLBACK');if(pending)await pending}
    }
  }
},60000)
test('ambiguous_authorize_commit_does_not_publish_cookie_or_repeat',async()=>{
  const f=await enroll(),begin=await appA.beginAdditionalPasskey(request(f.cookie))
  const relay=await pgRelay(stores.directRuntimeUrl,'before-command-complete'),pool=new Pool({connectionString:relay.url,max:1})
  const owner=createTransactions(pool,{maxStatementTimeoutMs:1000,maxCleanupTimeoutMs:1000}),app=createApplicationAuth(owner,config,limiter)
  try{
    let published=false,headers=0
    const error=await app.authorizeAdditionalPasskey(request(f.cookie),{intentId:begin.intentId,response:f.credential.authenticationResponse(begin.options)})
      .then(result=>{published=true;headers=result.headers.getSetCookie().length;return undefined},error=>error)
    expect(app.additionalPasskeyErrorResponse(error)?.status).toBe(409)
    expect({published,headers}).toEqual({published:false,headers:0})
    expect(relay.controls.filter(value=>value==='COMMIT').length).toBe(1)
    const row=(await stores.administrator.query(`SELECT phase,EXISTS(SELECT 1 FROM verification v WHERE v.identifier=i.registration_verification_identifier) AS challenge
      FROM additional_passkey_intent i WHERE id=$1`,[begin.intentId])).rows[0]
    expect(row).toEqual({phase:'AUTHORIZED',challenge:true})
    expect((await stores.administrator.query('SELECT counter FROM passkey WHERE user_id=$1',[f.principal.userId])).rows[0].counter).toBe(1)
    expect(error instanceof PgTransactionError).toBe(true)
    if(error instanceof PgTransactionError)commitObservations.push({phase:error.phase,outcome:error.outcome,status:409,committedObserved:row.phase==='AUTHORIZED'})
  }finally{const results=await Promise.allSettled([app.close(),pool.end()]);await relay.close();if(results.some(item=>item.status==='rejected'))throw new Error('Authorize relay cleanup failed')}
})
