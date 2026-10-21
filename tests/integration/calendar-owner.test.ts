import { afterAll, beforeAll, expect, test } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { MockAgent } from 'undici'
import { createGoogleCalendarClient, CalendarRevocationError } from '../../src/modules/calendar/google.server'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { createPersonalWorkspaces } from '../../src/modules/workspaces/personal.server'
import { createCalendarOperations } from '../../src/modules/calendar/connection.server'
import { calendarFixtureConfig, calendarFixturePolicy, calendarPeer, latch } from '../helpers/calendar-fixture'
import type { AdmittedPrincipal } from '../../src/modules/auth/session.server'

let stores: Awaited<ReturnType<typeof startDisposableStores>>, pool: Pool, owner: ReturnType<typeof createTransactions>
beforeAll(async () => { stores=await startDisposableStores(); await stores.migrate(); pool=new Pool({ connectionString:stores.directRuntimeUrl, max:4 }); owner=createTransactions(pool,{maxStatementTimeoutMs:1000,maxCleanupTimeoutMs:1000}) })
afterAll(async () => { try { await pool?.end() } finally { await stores?.cleanup() } })
async function fixture(workspace=true) {
  const id=randomUUID(), principal:AdmittedPrincipal={userId:id,sessionId:randomUUID(),email:id+'@example.test',name:'Fixture'}
  await stores.administrator.query('INSERT INTO "user" (id,name,email) VALUES ($1,$2,$3)',[id,principal.name,principal.email])
  await stores.administrator.query("INSERT INTO session (id,token,user_id,expires_at,auth_state,auth_method,authenticated_at,recovery_generation,last_activity_at) VALUES ($1,$2,$3,now()+interval '1 day','ACTIVE','google',now(),0,now())",[principal.sessionId,randomUUID(),id])
  const space=workspace?await createPersonalWorkspaces(owner).ensurePersonalWorkspace(principal):null
  const peer=calendarPeer(), operations=createCalendarOperations(owner,calendarFixtureConfig,peer.provider)
  return {principal,space,peer,operations}
}
async function begin(f:Awaited<ReturnType<typeof fixture>>) { const url=new URL(await f.operations.beginConnection(f.principal)); f.peer.state.nonce=url.searchParams.get('nonce')!; return url }
async function connect(f:Awaited<ReturnType<typeof fixture>>) { const url=await begin(f); await f.operations.completeConnection(f.principal,{state:url.searchParams.get('state')!,code:'fixture-code'}) }
const input=(expectedRevision:number, calendarId='primary-calendar')=>({expectedRevision,calendarId,enabled:true,policy:calendarFixturePolicy()})

test('refuses absent/revoked admission or missing Workspace without fabricating saved rules',async()=>{
  const f=await fixture(false)
  expect(await f.operations.read(f.principal)).toMatchObject({status:'disconnected',policy:null,revision:0})
  await expect(f.operations.beginConnection(f.principal)).rejects.toThrow()
  const g=await fixture(); await stores.administrator.query('DELETE FROM session WHERE id=$1',[g.principal.sessionId])
  await expect(g.operations.beginConnection(g.principal)).rejects.toThrow()
  expect(await g.operations.read({...g.principal,userId:'foreign'})).toMatchObject({status:'disconnected',policy:null})
})
test('separate consent uses canonical callback, PKCE, required scopes and one-shot session-bound state',async()=>{
  const f=await fixture(),url=await begin(f)
  expect(url.origin).toBe('https://accounts.google.com')
  expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3000/api/calendar/google/callback')
  expect(url.searchParams.get('code_challenge_method')).toBe('S256'); expect(url.searchParams.get('access_type')).toBe('offline')
  expect(url.searchParams.get('scope')).toContain('openid email'); expect(url.searchParams.get('scope')).not.toMatch(/\/auth\/calendar(?: |$)/)
  const state=url.searchParams.get('state')!
  await expect(f.operations.completeConnection({...f.principal,sessionId:'foreign'},{state,code:'fixture'})).rejects.toThrow()
  await f.operations.completeConnection(f.principal,{state,code:'fixture'})
  await expect(f.operations.completeConnection(f.principal,{state,code:'fixture'})).rejects.toThrow()
  expect(f.peer.state.exchanges).toBe(1)
  const dto=await f.operations.read(f.principal)
  expect(dto).toMatchObject({status:'connected',accountEmail:'owner@example.test',enabled:false,policy:null,selectedCalendar:null})
  expect(JSON.stringify(dto)).not.toMatch(/secret-access|secret-refresh|googleSubject|stateHash|tokenEnvelope|sessionId/)
  const rows=await stores.administrator.query('SELECT token_envelope,state_secret FROM sparra_calendar_connection WHERE workspace_id=$1',[f.space!.id])
  expect(JSON.stringify(rows.rows)).not.toMatch(/secret-access|secret-refresh/); expect(rows.rows[0].state_secret).toBeNull()
})
test('scope denial and absent refresh token cannot create a durable connection',async()=>{
  for(const kind of ['scope','refresh'] as const) { const f=await fixture(),url=await begin(f); if(kind==='scope')f.peer.state.scopes=['openid','email'];else f.peer.state.refresh=false
    await expect(f.operations.completeConnection(f.principal,{state:url.searchParams.get('state')!,code:'fixture'})).rejects.toThrow()
    expect(await f.operations.read(f.principal)).toMatchObject({status:'disconnected',enabled:false})
  }
})
test('save verifies real writable destination and policy revision; no settings inferred from knowledge',async()=>{
  const f=await fixture();await connect(f)
  await expect(f.operations.savePolicy(f.principal,input(0,'foreign-calendar'))).rejects.toThrow()
  const saved=await f.operations.savePolicy(f.principal,input(0));expect(saved).toMatchObject({enabled:true,revision:1,selectedCalendar:{id:'primary-calendar'},policy:{timeZone:'Europe/Paris'}})
  await expect(f.operations.savePolicy(f.principal,input(0))).rejects.toMatchObject({code:'conflict'})
  f.peer.state.writable=false;await expect(f.operations.savePolicy(f.principal,input(1))).rejects.toThrow()
})
test('a subject cannot be active in two Workspaces and RLS excludes foreign connection writes',async()=>{
  const a=await fixture(),b=await fixture();b.peer.state.sub=a.peer.state.sub;await connect(a)
  await expect(connect(b)).rejects.toThrow()
  await owner.withPersonalWorkspacePromise({deadlineAtMs:Date.now()+5000,statementTimeoutMs:1000,cleanupTimeoutMs:1000,correlationId:randomUUID()},b.principal,false,async lease=>{
    const {calendarConnection}=await import('../../src/modules/calendar/schema.server')
    const {eq}=await import('drizzle-orm')
    expect(await lease!.db.select().from(calendarConnection).where(eq(calendarConnection.workspaceId,a.space!.id))).toEqual([])
    expect(await lease!.db.update(calendarConnection).set({enabled:false}).where(eq(calendarConnection.workspaceId,a.space!.id)).returning()).toEqual([])
  })
})
test('disconnect fences delayed OAuth settlement and never revokes later credentials',async()=>{
  const f=await fixture(),url=await begin(f),gate=latch();f.peer.state.exchangeGate=()=>gate.wait
  const pending=f.operations.completeConnection(f.principal,{state:url.searchParams.get('state')!,code:'fixture'})
  await expect.poll(()=>f.peer.state.exchanges).toBe(1)
  await f.operations.disconnect(f.principal)
  gate.release();await expect(pending).rejects.toMatchObject({code:'conflict'})
  expect(f.peer.state.revocations).toBe(0);expect(await f.operations.read(f.principal)).toMatchObject({status:'disconnected'})
  await connect(f);expect(await f.operations.read(f.principal)).toMatchObject({status:'connected'})
})
test('revocation barrier disables immediately and rejects reconnect until settled, across owner instances',async()=>{
  const f=await fixture();await connect(f);await f.operations.savePolicy(f.principal,input(0));const gate=latch();f.peer.state.revokeGate=()=>gate.wait
  const pending=f.operations.disconnect(f.principal);await expect.poll(()=>f.peer.state.revocations).toBe(1)
  expect(await f.operations.read(f.principal)).toMatchObject({status:'revoking',enabled:false,revision:2})
  const other=createCalendarOperations(owner,calendarFixtureConfig,f.peer.provider)
  await expect(other.beginConnection(f.principal)).rejects.toMatchObject({code:'busy'})
  gate.release();await pending;await connect(f);expect(await f.operations.read(f.principal)).toMatchObject({status:'connected',enabled:false})
})
test('refresh is serialized and stale refresh cannot restore disconnected credentials',async()=>{
  const f=await fixture();f.peer.state.expired=true;await connect(f);f.peer.state.expired=false
  const gate=latch();f.peer.state.refreshGate=()=>gate.wait
  const pending=f.operations.read(f.principal);await expect.poll(()=>f.peer.state.refreshes).toBe(1)
  const other=createCalendarOperations(owner,calendarFixtureConfig,f.peer.provider)
  await expect(other.read(f.principal)).rejects.toMatchObject({code:'busy'})
  await f.operations.disconnect(f.principal);gate.release();await expect(pending).rejects.toMatchObject({code:'conflict'})
  expect(await f.operations.read(f.principal)).toMatchObject({status:'disconnected',enabled:false})
})
test('refresh rejects a different subject and disables booking on lost writable calendar access',async()=>{
  const f=await fixture(),originalSubject=f.peer.state.sub;f.peer.state.expired=true;await connect(f);f.peer.state.sub='substituted-subject';f.peer.state.expired=false
  expect(await f.operations.read(f.principal)).toMatchObject({status:'reconnect_required',enabled:false,available:false,accountEmail:'owner@example.test'})
  expect((await stores.administrator.query('SELECT google_subject FROM sparra_calendar_connection WHERE workspace_id=$1',[f.space!.id])).rows).toEqual([{google_subject:originalSubject}])
  expect(await f.operations.read(f.principal)).toMatchObject({status:'reconnect_required',enabled:false})
  const g=await fixture();await connect(g);await g.operations.savePolicy(g.principal,input(0));g.peer.state.writable=false
  expect(await g.operations.read(g.principal)).toMatchObject({status:'connected',enabled:false,revision:2})
})
test('superseded or expired intentions never exchange and consent denial consumes the intention',async()=>{
  const f=await fixture(),old=await begin(f),fresh=await begin(f)
  await expect(f.operations.completeConnection(f.principal,{state:old.searchParams.get('state')!,code:'fixture'})).rejects.toThrow()
  await expect(f.operations.completeConnection(f.principal,{state:fresh.searchParams.get('state')!,error:'access_denied'})).rejects.toThrow()
  await expect(f.operations.completeConnection(f.principal,{state:fresh.searchParams.get('state')!,code:'fixture'})).rejects.toThrow()
  const expired=await begin(f)
  await stores.administrator.query("UPDATE sparra_calendar_connection SET state_expires_at=now()-interval '1 second' WHERE workspace_id=$1",[f.space!.id])
  await expect(f.operations.completeConnection(f.principal,{state:expired.searchParams.get('state')!,code:'fixture'})).rejects.toThrow()
  expect(f.peer.state.exchanges).toBe(0)
})
test('proven pre-dispatch refusal retains subject exclusivity and allows a later safe attempt',async()=>{
  const f=await fixture();await connect(f);f.peer.state.revokeGate=async()=>{throw new CalendarRevocationError('not_sent')}
  await expect(f.operations.disconnect(f.principal)).rejects.toThrow('Calendar unavailable')
  expect(await f.operations.read(f.principal)).toMatchObject({status:'revoking',enabled:false})
  const g=await fixture();g.peer.state.sub=f.peer.state.sub;await expect(connect(g)).rejects.toThrow()
  f.peer.state.revokeGate=async()=>{};await f.operations.disconnect(f.principal);await connect(g)
  expect(await g.operations.read(g.principal)).toMatchObject({status:'connected'})
})
test('provider outages preserve safe account controls and revoked grants explicitly require reconnect',async()=>{
  const {CalendarProviderError}=await import('../../src/modules/calendar/google.server')
  const f=await fixture();await connect(f);await f.operations.savePolicy(f.principal,input(0))
  f.peer.state.listGate=async()=>{throw new CalendarProviderError('unavailable')}
  expect(await f.operations.read(f.principal)).toMatchObject({status:'connected',accountEmail:'owner@example.test',available:false})
  f.peer.state.listGate=async()=>{throw new CalendarProviderError('unauthorized')}
  expect(await f.operations.read(f.principal)).toMatchObject({status:'reconnect_required',enabled:false,revision:2})
})
test('Google canonical userinfo.email grant is accepted for initial consent and renewal',async()=>{
  const f=await fixture();f.peer.state.scopes=f.peer.state.scopes.map(scope=>scope==='email'?'https://www.googleapis.com/auth/userinfo.email':scope)
  f.peer.state.expired=true;await connect(f);f.peer.state.expired=false
  expect(await f.operations.read(f.principal)).toMatchObject({status:'connected',accountEmail:'owner@example.test'})
  expect(f.peer.state.refreshes).toBe(1)
})
test('accepted revoke with lost response keeps its claim across local close and cannot be resent or replaced',async()=>{
  const f=await fixture();await connect(f)
  const agent=new MockAgent({enableCallHistory:true});agent.disableNetConnect()
  const oauth=agent.get('https://oauth2.googleapis.com');let accepted=0
  const client=createGoogleCalendarClient(calendarFixtureConfig,new AbortController().signal,Date.now()+75,agent)
  const operations=createCalendarOperations(owner,calendarFixtureConfig,{...f.peer.provider,revokeToken:client.revokeToken})
  try{
    oauth.intercept({path:'/revoke',method:'POST'}).reply(()=>{accepted++;return {statusCode:200,data:''}}).delay(250)
    await expect(operations.disconnect(f.principal)).rejects.toThrow('Calendar unavailable');await client.close()
    expect(accepted).toBe(1)
    const retryClient=createGoogleCalendarClient(calendarFixtureConfig,new AbortController().signal,Date.now()+5000,agent)
    const retry=createCalendarOperations(owner,calendarFixtureConfig,{...f.peer.provider,revokeToken:retryClient.revokeToken})
    oauth.intercept({path:'/revoke',method:'POST'}).reply(400,{error:'invalid_token'})
    try{
      await expect(retry.disconnect(f.principal)).rejects.toMatchObject({code:'busy'})
      await expect(retry.beginConnection(f.principal)).rejects.toMatchObject({code:'busy'})
      expect(agent.getCallHistory()?.calls()).toHaveLength(1)
      expect(await retry.read(f.principal)).toMatchObject({status:'revoking',enabled:false})
    }finally{await retryClient.close()}
  }finally{await client.close();await agent.close()}
})
test.each(['revoked','expired'] as const)('reconnect retires both stored credentials when the refresh token is already %s',async kind=>{
  const f=await fixture();await connect(f)
  const agent=new MockAgent({enableCallHistory:true});agent.disableNetConnect()
  const oauth=agent.get('https://oauth2.googleapis.com'),client=createGoogleCalendarClient(calendarFixtureConfig,new AbortController().signal,Date.now()+5000,agent)
  const operations=createCalendarOperations(owner,calendarFixtureConfig,{...f.peer.provider,revokeToken:client.revokeToken})
  try{
    oauth.intercept({path:'/revoke',method:'POST',body:'token=secret-refresh'}).reply(400,{error:'invalid_token'})
    oauth.intercept({path:'/revoke',method:'POST',body:'token=secret-access'}).reply(kind==='revoked'?400:200,kind==='revoked'?{error:'invalid_token'}:'').delay(100)
    const pending=operations.disconnect(f.principal)
    await expect.poll(()=>agent.getCallHistory()?.calls().length).toBe(2)
    await expect(operations.beginConnection(f.principal)).rejects.toMatchObject({code:'busy'})
    await pending
    expect(await operations.read(f.principal)).toMatchObject({status:'disconnected',accountEmail:null,enabled:false})
    expect(agent.getCallHistory()?.calls()).toHaveLength(2);agent.assertNoPendingInterceptors()
    const url=new URL(await operations.beginConnection(f.principal));f.peer.state.nonce=url.searchParams.get('nonce')!
    await operations.completeConnection(f.principal,{state:url.searchParams.get('state')!,code:'fixture'})
    expect(await operations.read(f.principal)).toMatchObject({status:'connected',enabled:false})
  }finally{await client.close();await agent.close()}
})
test('invalid refresh token followed by ambiguous access-token revocation keeps the replacement barrier',async()=>{
  const f=await fixture();await connect(f)
  const agent=new MockAgent({enableCallHistory:true});agent.disableNetConnect()
  const oauth=agent.get('https://oauth2.googleapis.com'),client=createGoogleCalendarClient(calendarFixtureConfig,new AbortController().signal,Date.now()+5000,agent)
  const operations=createCalendarOperations(owner,calendarFixtureConfig,{...f.peer.provider,revokeToken:client.revokeToken})
  try{
    oauth.intercept({path:'/revoke',method:'POST',body:'token=secret-refresh'}).reply(400,{error:'invalid_token'})
    oauth.intercept({path:'/revoke',method:'POST',body:'token=secret-access'}).replyWithError(new Error('lost response'))
    await expect(operations.disconnect(f.principal)).rejects.toThrow('Calendar unavailable')
    await expect(operations.disconnect(f.principal)).rejects.toMatchObject({code:'busy'})
    await expect(operations.beginConnection(f.principal)).rejects.toMatchObject({code:'busy'})
    expect(agent.getCallHistory()?.calls()).toHaveLength(2)
  }finally{await client.close();await agent.close()}
})
test('a nonterminal revoke 400 never retires the grant or permits replacement',async()=>{
  const f=await fixture();await connect(f)
  const agent=new MockAgent({enableCallHistory:true});agent.disableNetConnect()
  const client=createGoogleCalendarClient(calendarFixtureConfig,new AbortController().signal,Date.now()+5000,agent)
  const operations=createCalendarOperations(owner,calendarFixtureConfig,{...f.peer.provider,revokeToken:client.revokeToken})
  try{
    agent.get('https://oauth2.googleapis.com').intercept({path:'/revoke',method:'POST'}).reply(400,{error:'invalid_request'})
    await expect(operations.disconnect(f.principal)).rejects.toThrow('Calendar unavailable')
    expect(await operations.read(f.principal)).toMatchObject({status:'revoking',accountEmail:'owner@example.test'})
    await expect(operations.disconnect(f.principal)).rejects.toMatchObject({code:'busy'})
    await expect(operations.beginConnection(f.principal)).rejects.toMatchObject({code:'busy'})
    expect(agent.getCallHistory()?.calls()).toHaveLength(1)
  }finally{await client.close();await agent.close()}
})

test.each(['cancelled-request','before-commit','after-commit','newer-generation','database-unavailable'] as const)('definitive revoke settles locally across %s without another remote revoke',async mode=>{
  const f=await fixture();await connect(f)
  const request=new AbortController()
  let definitive=false,attempts=0
  const operations=createCalendarOperations({...owner,withPersonalWorkspacePromise:async(options,principal,create,run)=>{
    if(definitive){
      attempts++
      if(mode==='database-unavailable'||mode==='before-commit'&&attempts===1)throw new Error('Fixture local transaction failure')
      if(mode==='newer-generation'&&attempts===1){
        await stores.administrator.query("UPDATE sparra_calendar_connection SET generation=generation+1,status='connected',work_id=NULL WHERE workspace_id=$1",[f.space!.id])
        throw new Error('Fixture local transaction ambiguity')
      }
    }
    const value=await owner.withPersonalWorkspacePromise(options,principal,create,run)
    if(definitive&&mode==='after-commit'&&attempts===1)throw new Error('Fixture lost local commit acknowledgement')
    return value
  }},calendarFixtureConfig,{...f.peer.provider,revokeToken:async token=>{
    const result=await f.peer.provider.revokeToken(token);definitive=true
    if(mode==='cancelled-request')request.abort()
    return result
  }})
  if(mode==='newer-generation'||mode==='database-unavailable')await expect(operations.disconnect(f.principal,request.signal)).rejects.toThrow()
  else await operations.disconnect(f.principal,request.signal)
  expect(f.peer.state.revocations).toBe(1)
  expect(attempts).toBeLessThanOrEqual(3)
  const current=(await stores.administrator.query('SELECT generation,status,token_envelope,work_id FROM sparra_calendar_connection WHERE workspace_id=$1',[f.space!.id])).rows[0]
  if(mode==='newer-generation')expect(current).toMatchObject({generation:3,status:'connected',work_id:null})
  else if(mode==='database-unavailable')expect(current).toMatchObject({generation:2,status:'revoking'})
  else expect(current).toMatchObject({generation:2,status:'disconnected',token_envelope:null,work_id:null})
})
