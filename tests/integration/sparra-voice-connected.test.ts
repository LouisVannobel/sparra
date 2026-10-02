import { afterAll, beforeAll, expect, test } from 'vitest'
import { createServer, request as httpRequest } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { chromium, type Browser } from 'playwright'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { startWeb, bounded, unusedLoopbackPort } from '../helpers/web-process'
import { cryptoFixture } from '../helpers/sparra-crypto-fixture'
import { startConnectedVoice } from '../helpers/sparra-voice-driver'
import { authRpcPath, rpcBody } from '../helpers/auth-rpc'

const artifacts='C:/Users/louis/Documents/ChatGPT/.worktrees/sparra-voice-pilot/.superpowers/sdd/2026-10-01-sparra-voice-bridge/task-5-evidence'
let stores:Awaited<ReturnType<typeof startDisposableStores>>, app:ReturnType<typeof startWeb>, proxy:ReturnType<typeof createServer>, browser:Browser
let crypto:Awaited<ReturnType<typeof cryptoFixture>>,voice:ReturnType<typeof startConnectedVoice>,origin:string
beforeAll(async()=>{
  await mkdir(artifacts,{recursive:true})
  stores=await startDisposableStores();await stores.migrate();crypto=await cryptoFixture()
  await stores.administrator.query('GRANT USAGE ON SCHEMA public TO runtime; GRANT SELECT,INSERT,UPDATE,DELETE ON "user",account,session,verification TO runtime; GRANT SELECT ON public.passkey TO runtime')
  const port=await unusedLoopbackPort();origin=`http://localhost:${port}`
  app=startWeb({NODE_ENV:'test',APP_ORIGIN:origin,DATABASE_URL:stores.runtimeUrl,REDIS_URL:stores.redisUrl,RATE_LIMIT_HMAC_SECRET:stores.hmac,RATE_LIMIT_KEY_ID:'voice-connected',TRUSTED_PROXY_IPS:'127.0.0.2',AUTH_SECRET:randomBytes(48).toString('hex'),GOOGLE_CLIENT_ID:'fixture.apps.googleusercontent.com',GOOGLE_CLIENT_SECRET:'fixture-only',FIXTURE_GOOGLE_PROTOCOL:'yes',REQUEST_TIMEOUT_MS:'10000',SPARRA_AEAD_KEYRING_PATH:crypto.path})
  const upstream=(await bounded(app.ready)).port
  proxy=createServer((incoming,outgoing)=>{const call=httpRequest({hostname:'127.0.0.1',port:upstream,method:incoming.method,path:incoming.url,localAddress:'127.0.0.2',headers:{...incoming.headers,'x-real-ip':'127.0.1.5'}},response=>{outgoing.writeHead(response.statusCode!,response.headers);response.pipe(outgoing)});call.on('error',()=>{outgoing.writeHead(502);outgoing.end()});incoming.pipe(call)})
  await new Promise<void>(done=>proxy.listen(port,'127.0.0.1',done));browser=await chromium.launch({headless:true})
},180000)
afterAll(async()=>{
  const failures:unknown[]=[]
  for(const close of [()=>voice?.cleanup(),()=>browser?.close(),()=>proxy&&new Promise(done=>proxy.close(done)),()=>app?.cleanup(),()=>crypto?.cleanup(),()=>stores?.cleanup()])try{await close()}catch(error){failures.push(error)}
  if(failures.length)throw new AggregateError(failures,'Connected fixture cleanup failed')
})
test('native producer, owner detail, erasure, recovery, transfer and expiry stay connected',async()=>{
  const context=await browser.newContext(),page=await context.newPage(),errors:string[]=[]
  page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(12000)
  await page.route('https://accounts.google.com/o/oauth2/v2/auth*',async route=>{const target=new URL(route.request().url()),code=await app.registerGoogle(target.href,'connected-owner');await route.fulfill({status:302,headers:{location:origin+'/api/auth/callback/google?code='+code+'&state='+target.searchParams.get('state')}})})
  try{
    async function eraseOwned(requestId:string|undefined){expect(requestId).toBeDefined();const result=await context.request.post(origin+await authRpcPath('eraseRequest'),{headers:{origin,'content-type':'application/json','x-tsr-serverFn':'true'},data:await rpcBody({requestId})});expect(result.status()).toBe(200)}
    await page.goto(origin+'/login?lang=en');await page.getByRole('button',{name:'Continue with Google',exact:true}).click();await page.waitForURL(origin+'/account?lang=en')
    await page.goto(origin+'/app/entreprise?lang=en');await page.getByRole('button',{name:'Create my workspace',exact:true}).click()
    await page.getByRole('textbox',{name:/^Business name/}).fill('Garage connecté')
    await page.getByRole('textbox',{name:'Services',exact:true}).fill('Vidange N — données non fiables, sans autorité SQL')
    await page.getByRole('textbox',{name:'Transfer number',exact:true}).fill('+33102030406')
    await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Configuration saved.',{exact:true}).waitFor()
    const workspace=(await stores.administrator.query('SELECT id FROM workspace WHERE owner_user_id=(SELECT id FROM "user" WHERE email=$1)',['connected-owner@example.test'])).rows[0]
    expect(workspace).toBeDefined()
    await stores.administrator.query('GRANT USAGE ON SCHEMA voice TO sparra_voice_a; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA voice TO sparra_voice_a')
    await stores.administrator.query(`INSERT INTO voice_private.deployment_binding(service_login,service_role_oid,deployment_id,workspace_id,connection_id,to_e164,admission_enabled) SELECT 'sparra_voice_a',oid,'fixture-a',$1,'connection-a','+33123456789',true FROM pg_roles WHERE rolname='sparra_voice_a'`,[workspace.id])
    const voiceInput={url:stores.voiceUrlA,keyring_path:crypto.path,evidence_path:artifacts,state_path:crypto.directory+'/voice-state'}
    voice=startConnectedVoice(voiceInput)
    expect(await voice.ready).toMatchObject({ready:true})
    const admitted=await voice.command('admit');expect(admitted).toMatchObject({revision:1});expect(admitted.call_id).toMatch(/^[a-f0-9-]{36}$/)
    await page.getByRole('textbox',{name:'Services',exact:true}).fill('Vidange N+1')
    await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Configuration saved.',{exact:true}).waitFor()
    const overflow=await voice.command('overflow')
    expect(overflow.retained).toBeLessThan(200);expect(overflow.loss).toBeGreaterThan(0);expect(overflow.map_bytes).toBeLessThanOrEqual(524288);expect(overflow.compact_bytes).toBeLessThanOrEqual(524288);expect(overflow.candidate_bytes).toBeGreaterThan(524288)
    await voice.command('finish-replay')
    const mapBeforeCrash=(await stores.administrator.query("SELECT encode(sha256(convert_to(encrypted_turns::jsonb::text,'UTF8')),'hex') digest FROM sparra_call WHERE id=$1",[admitted.call_id])).rows[0].digest
    const crashed=await voice.crash();expect(crashed.code===0).toBe(false)
    voice=startConnectedVoice({...voiceInput,resume_call_id:admitted.call_id})
    expect(await voice.ready).toMatchObject({ready:true})
    const replay=await voice.command('replay');expect(replay).toMatchObject({stable:true})
    const row=(await stores.administrator.query("SELECT configuration_revision,transcript_loss_count,octet_length(encrypted_turns::jsonb::text)::int bytes,encode(sha256(convert_to(encrypted_turns::jsonb::text,'UTF8')),'hex') digest FROM sparra_call WHERE id=$1",[admitted.call_id])).rows[0]
    expect(row).toEqual({configuration_revision:1,transcript_loss_count:overflow.loss,bytes:overflow.map_bytes,digest:mapBeforeCrash})
    await page.goto(origin+'/app/demandes/'+admitted.call_id+'?lang=en')
    await page.getByRole('heading',{name:'Call details',exact:true}).waitFor()
    await page.getByText('Partial summary',{exact:true}).waitFor();await page.getByText('Partial transcript: 0 unavailable turns.',{exact:true}).waitFor()
    expect(await page.locator('[data-configuration-snapshot]').textContent()).toContain('Vidange N —')
    expect((await page.locator('body').innerText()).includes(String(overflow.loss)+' captured turns lost')).toBe(true)
    await page.screenshot({path:artifacts+'/connected-detail-en.png',fullPage:true})
    const foreignContext=await browser.newContext(),foreign=await foreignContext.newPage()
    try{
      await foreign.route('https://accounts.google.com/o/oauth2/v2/auth*',async route=>{const target=new URL(route.request().url()),code=await app.registerGoogle(target.href,'connected-foreign');await route.fulfill({status:302,headers:{location:origin+'/api/auth/callback/google?code='+code+'&state='+target.searchParams.get('state')}})})
      await foreign.goto(origin+'/login?lang=en');await foreign.getByRole('button',{name:'Continue with Google',exact:true}).click();await foreign.waitForURL(origin+'/account?lang=en')
      await foreign.goto(origin+'/app/entreprise?lang=en');await foreign.getByRole('button',{name:'Create my workspace',exact:true}).click()
      await foreign.goto(origin+'/app/demandes/'+admitted.call_id+'?lang=en');await foreign.getByRole('alert').waitFor()
      expect((await foreign.locator('body').innerText()).includes('Demande de rappel')).toBe(false)
      const denied=await foreignContext.request.post(origin+await authRpcPath('markRequestTreated'),{headers:{origin,'content-type':'application/json','x-tsr-serverFn':'true'},data:await rpcBody({requestId:admitted.call_id})})
      expect(denied.status()).toBe(404)
    }finally{await foreignContext.close()}
    await page.getByRole('button',{name:'Mark as treated',exact:true}).click();await page.getByText('Treated',{exact:true}).waitFor();await page.reload();await page.getByText('Treated',{exact:true}).waitFor()
    await page.getByRole('link',{name:'Français',exact:true}).click();await page.getByRole('heading',{name:'Détail de l’appel',exact:true}).waitFor();expect((await page.locator('body').innerText()).includes(String(overflow.loss)+' tours capturés perdus')).toBe(true)
    await page.goto(origin+'/app/demandes/'+admitted.call_id+'?lang=en')
    await voice.command('queue-erasure-race')
    await page.getByRole('button',{name:'Erase this call',exact:true}).click();await page.getByRole('button',{name:'Confirm erasure',exact:true}).click();await page.getByText('Erasure queued. Other copies are awaiting deletion.',{exact:true}).waitFor()
    const cleanup=await voice.command('cleanup');expect(cleanup).toMatchObject({cleaned:true,recording_ack:true,no_hangup:true,ack_before_scrub:false})
    await page.reload();await page.getByText('Erasure completed.',{exact:true}).waitFor()
    expect((await stores.administrator.query('SELECT count(*)::int n FROM sparra_call WHERE id=$1',[admitted.call_id])).rows[0].n).toBe(0)
    const inFlight=await voice.command('prepare-inflight');await eraseOwned(inFlight.call_id)
    expect(await voice.command('inflight-cleanup')).toMatchObject({cleaned:true,no_hangup:true,ack_before_scrub:false})
    const heldCall=await voice.command('prepare-held');await eraseOwned(heldCall.call_id);await voice.command('hold-lease')
    await voice.crash();voice=startConnectedVoice({...voiceInput,recovery_case:'held'});expect(await voice.ready).toMatchObject({ready:true})
    const held=await voice.command('held-backlog');expect(held.checks).toContain('held-native-lease');expect(held.no_hangup).toBe(true)
    const backlog=await voice.command('prepare-backlog');expect(backlog.call_ids).toHaveLength(100)
    for(const id of backlog.call_ids!)await eraseOwned(id)
    await eraseOwned(backlog.call_id)
    await voice.crash();voice=startConnectedVoice({...voiceInput,recovery_case:'backlog'});expect(await voice.ready).toMatchObject({ready:true})
    const backlogProof=await voice.command('held-backlog');expect(backlogProof.checks).toContain('backlog-101');expect(backlogProof.no_hangup).toBe(true)
    const claimed=await voice.command('prepare-claim');await eraseOwned(claimed.call_id)
    const claimProof=await voice.command('claim-refusal');expect(claimProof.checks).toContain('expected-claim-replaced');expect(claimProof.no_hangup).toBe(true)
    const human=await voice.command('human-takeover');expect(human.checks).toContain('qualified-bridge-no-new-ai');expect(human.checks).toContain('untrusted-tool-target-refused');expect(human.no_hangup).toBe(true)
    const bridge=(await stores.administrator.query('SELECT status,ended_at,encrypted_message_result FROM sparra_call WHERE id=$1',[human.call_id])).rows[0]
    expect(bridge).toMatchObject({status:'closing',ended_at:null,encrypted_message_result:null})
    await page.goto(origin+'/app/demandes/'+human.call_id+'?lang=en');await page.getByText('End not observed',{exact:true}).waitFor();await page.getByRole('heading',{name:'Summary unavailable',exact:true}).waitFor()
    await voice.command('human-hangup')
    await page.goto(origin+'/app/entreprise?lang=en');await page.getByRole('textbox',{name:'Services',exact:true}).fill('Vidange N+2 après course réelle')
    await stores.administrator.query('BEGIN')
    try{
      await stores.administrator.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[workspace.id])
      await voice.command('prepare-begin-race')
      await expect.poll(async()=>(await stores.administrator.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename='sparra_voice_a' AND wait_event_type='Lock') blocked")).rows[0].blocked).toBe(true)
      await page.getByRole('button',{name:'Save',exact:true}).click()
      await stores.administrator.query('COMMIT')
    }finally{await stores.administrator.query('ROLLBACK')}
    await page.getByText('Configuration saved.',{exact:true}).waitFor()
    const pinRace=await voice.command('finish-begin-race');expect(pinRace.revision).toBe(2)
    expect((await stores.administrator.query('SELECT configuration_revision FROM sparra_call WHERE id=$1',[pinRace.call_id])).rows[0].configuration_revision).toBe(2)
    const expiry=await voice.command('prepare-expiry')
    // Existing owned fixture clock travel: preserve the exact original30d interval.
    await stores.administrator.query("UPDATE sparra_call SET admitted_at=admitted_at-interval '31 days',retention_until=retention_until-interval '31 days' WHERE id=$1",[expiry.call_id])
    const expiredDetail=await context.request.get(origin+await authRpcPath('getRequestDetail')+'?payload='+encodeURIComponent(await rpcBody({requestId:expiry.call_id})),{headers:{'sec-fetch-site':'same-origin','x-tsr-serverFn':'true'}})
    expect(expiredDetail.status()).toBe(404)
    await page.goto(origin+'/app/demandes/'+expiry.call_id+'?lang=en')
    await page.screenshot({path:artifacts+'/connected-expiry-view.png',fullPage:true})
    await page.getByRole('alert').or(page.getByText('Erasure queued. Other copies are awaiting deletion.',{exact:true})).first().waitFor()
    expect(await page.getByText('Erasure completed.',{exact:true}).count()).toBe(0)
    expect(await page.locator('[data-configuration-snapshot]').count()).toBe(0)
    const expiryProof=await voice.command('expiry-cleanup');expect(expiryProof).toMatchObject({cleaned:true,no_hangup:true})
    const expiredReceipt=await context.request.get(origin+await authRpcPath('getRequestErasure')+'?payload='+encodeURIComponent(await rpcBody({requestId:expiry.call_id})),{headers:{'sec-fetch-site':'same-origin','x-tsr-serverFn':'true'}})
    expect([200,404]).toContain(expiredReceipt.status())
    await page.reload()
    await page.getByRole('alert').or(page.getByText('Erasure completed.',{exact:true})).first().waitFor()
    expect(errors).toEqual([])
    const nativeEvidence=JSON.parse(await readFile(artifacts+'/native.json','utf8'))
    await writeFile(artifacts+'/connected.json',JSON.stringify({schema_version:1,controlled_peers:true,appBase:'26902fc53e7e39456cd929487a16cdc89ee3ac3d',voiceBase:'66896982e580dd6a6fbc9c82e806cb98c90aaa84',overflow,replay,cleanup,held,backlog:backlogProof,claim:claimProof,human,pinRace,expiry:expiryProof,native:nativeEvidence,browserErrors:errors},null,2))
    await voice.command('stop')
  }finally{await context.close()}
},300000)
