import { afterAll, beforeAll, expect, test } from 'vitest'
import { createServer, request as httpRequest } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { chromium, type Browser } from 'playwright'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { startWeb, bounded, unusedLoopbackPort } from '../helpers/web-process'
import { cryptoFixture } from '../helpers/sparra-crypto-fixture'
import { startConnectedVoice } from '../helpers/sparra-voice-driver'

const artifacts='C:/Users/louis/Documents/ChatGPT/.worktrees/sparra-voice-pilot/.superpowers/sdd/2026-10-01-sparra-voice-bridge/bridge-final-fix-evidence'
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
  if(stores)await writeFile(artifacts+'/cleanup.json',JSON.stringify(stores.evidence,null,2))
  if(failures.length)throw new AggregateError(failures,'Connected fixture cleanup failed')
})
test('bridge erasure and terminal retention use actual native owners and ACKs',async()=>{
  const context=await browser.newContext(),page=await context.newPage()
  page.setDefaultTimeout(12000)
  await page.route('https://accounts.google.com/o/oauth2/v2/auth*',async route=>{const target=new URL(route.request().url()),code=await app.registerGoogle(target.href,'connected-owner');await route.fulfill({status:302,headers:{location:origin+'/api/auth/callback/google?code='+code+'&state='+target.searchParams.get('state')}})})
  try{
    async function eraseOwned(requestId:string|undefined){expect(requestId).toBeDefined();await page.goto(origin+'/app/demandes/'+requestId+'?lang=en');await page.getByRole('button',{name:'Erase this call',exact:true}).click();await page.getByRole('button',{name:'Confirm erasure',exact:true}).click();await page.getByText('Erasure queued. Other copies are awaiting deletion.',{exact:true}).waitFor()}
    await page.goto(origin+'/login?lang=en');await page.getByRole('button',{name:'Continue with Google',exact:true}).click();await page.waitForURL(origin+'/account?lang=en')
    await page.goto(origin+'/app/entreprise?lang=en');await page.getByRole('button',{name:'Create my workspace',exact:true}).click()
    await page.getByRole('textbox',{name:/^Business name/}).fill('Garage connecté')
    await page.getByRole('textbox',{name:'Services',exact:true}).fill('Vidange N')
    await page.getByRole('textbox',{name:'Transfer number',exact:true}).fill('+33102030406')
    await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Configuration saved.',{exact:true}).waitFor()
    const workspace=(await stores.administrator.query('SELECT id FROM workspace WHERE owner_user_id=(SELECT id FROM "user" WHERE email=$1)',['connected-owner@example.test'])).rows[0]
    await stores.administrator.query('GRANT USAGE ON SCHEMA voice TO sparra_voice_a; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA voice TO sparra_voice_a')
    await stores.administrator.query(`INSERT INTO voice_private.deployment_binding(service_login,service_role_oid,deployment_id,workspace_id,connection_id,to_e164,admission_enabled) SELECT 'sparra_voice_a',oid,'fixture-a',$1,'connection-a','+33123456789',true FROM pg_roles WHERE rolname='sparra_voice_a'`,[workspace.id])
    const voiceInput={url:stores.voiceUrlA,keyring_path:crypto.path,evidence_path:artifacts,state_path:crypto.directory+'/voice-final-fix'}
    voice=startConnectedVoice(voiceInput);expect(await voice.ready).toMatchObject({ready:true})
    const human=await voice.command('human-takeover');expect(human.no_hangup).toBe(true)
    await voice.command('final-fix-recording');await eraseOwned(human.call_id)
    expect(await voice.command('final-fix-bridge-erased')).toMatchObject({cleaned:true,recording_ack:true,no_hangup:true})
    await page.reload();await page.getByText('Erasure completed.',{exact:true}).waitFor()
    await voice.command('final-fix-original-end')
    expect(await voice.command('final-fix-gc-before')).toMatchObject({stable:true})
    expect(await voice.command('final-fix-original-end-observer')).toMatchObject({stable:true})
    const unsettled=await voice.command('final-fix-prepare-unsettled');await eraseOwned(unsettled.call_id)
    expect(await voice.command('final-fix-unsettled')).toMatchObject({stable:true})
    expect(await voice.command('final-fix-intent-departure')).toMatchObject({stable:true,no_hangup:true})
    const race=await voice.command('final-fix-prepare-bridge-race');await eraseOwned(race.call_id)
    expect(await voice.command('final-fix-finish-bridge-race')).toMatchObject({cleaned:true,no_hangup:true})
    await voice.crash();voice=startConnectedVoice({...voiceInput,recovery_case:'final-fix'});expect(await voice.ready).toMatchObject({ready:true})
    expect(await voice.command('final-fix-gc-after')).toMatchObject({cleaned:true,stable:true,no_hangup:true})
    await voice.command('stop')
    await writeFile(artifacts+'/connected-final-fix.json',JSON.stringify({schema_version:1,controlled_peers:true,human,race,native:JSON.parse(await readFile(artifacts+'/native.json','utf8'))},null,2))
  }finally{await context.close()}
},180000)
