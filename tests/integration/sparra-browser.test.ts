import { afterAll, beforeAll, expect, test } from 'vitest'
import { createServer, request as httpRequest } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { chromium, type Browser, type BrowserContext, type Page, type Request } from 'playwright'
import AxeBuilder from '@axe-core/playwright'
import { Client } from 'pg'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { startWeb, bounded, unusedLoopbackPort } from '../helpers/web-process'
import { authRpcPath, rpcBody } from '../helpers/auth-rpc'
import { cryptoFixture, nativeVoiceTurn } from '../helpers/sparra-crypto-fixture'
import { observePrivateLoginBootstrap, capturePrivateLoginBootstrapFailure } from '../helpers/private-login-bootstrap-diagnostic'
import { startPrivateNetworkEventProbe } from '../helpers/private-network-event-probe'

let stores: Awaited<ReturnType<typeof startDisposableStores>>, app: ReturnType<typeof startWeb>, proxy: ReturnType<typeof createServer>, browser: Browser
let origin: string, upstreamPort: number, appEnv: ReturnType<typeof environment>, crypto: Awaited<ReturnType<typeof cryptoFixture>>
let networkProbe: ReturnType<typeof startPrivateNetworkEventProbe> | undefined
const foreignCallId=randomUUID()
const fixtureClients=new Map<string,string>()
function environment(){return { NODE_ENV:'test',APP_ORIGIN:origin,DATABASE_URL:stores.runtimeUrl,REDIS_URL:stores.redisUrl,RATE_LIMIT_HMAC_SECRET:stores.hmac,RATE_LIMIT_KEY_ID:'sparra-browser',TRUSTED_PROXY_IPS:'127.0.0.2',AUTH_SECRET:randomBytes(48).toString('hex'),GOOGLE_CLIENT_ID:'fixture.apps.googleusercontent.com',GOOGLE_CLIENT_SECRET:'fixture-only',FIXTURE_GOOGLE_PROTOCOL:'yes',REQUEST_TIMEOUT_MS:'10000',SPARRA_AEAD_KEYRING_PATH:crypto.path }}
beforeAll(async () => {
  await mkdir('.output/test-evidence/sparra', { recursive: true })
  networkProbe = startPrivateNetworkEventProbe(); networkProbe.mark('fixture-create-start')
  stores = await startDisposableStores(); networkProbe.ownNetwork(stores.evidence.network); networkProbe.mark('fixture-ready')
  await stores.migrate(); networkProbe.mark('migration-done'); crypto = await cryptoFixture()
  await stores.administrator.query('GRANT USAGE ON SCHEMA public TO runtime; GRANT SELECT,INSERT,UPDATE,DELETE ON "user",account,session,verification TO runtime; GRANT SELECT ON public.passkey TO runtime')
  const port = await unusedLoopbackPort(); origin = `http://localhost:${port}`
  appEnv = environment()
  app = startWeb(appEnv); upstreamPort = (await bounded(app.ready)).port
  proxy = createServer((incoming,outgoing) => {
    // Each owned browser context models its own client. Keep the native
    // per-IP auth throttle enabled without coupling independent cases to time.
    const {'x-fixture-client':fixtureClient,...headers}=incoming.headers
    const clientAddress=typeof fixtureClient==='string'?fixtureClients.get(fixtureClient):undefined
    const call = httpRequest({ hostname:'127.0.0.1',port:upstreamPort,method:incoming.method,path:incoming.url,localAddress:'127.0.0.2',headers:{ ...headers,'x-real-ip':clientAddress??incoming.socket.remoteAddress } }, response => { outgoing.writeHead(response.statusCode!,response.headers); response.pipe(outgoing) })
    incoming.on('aborted',()=>call.destroy()); outgoing.on('close',()=>{if(!outgoing.writableEnded)call.destroy()})
    call.on('error',() => { if(!outgoing.destroyed){outgoing.writeHead(502); outgoing.end()} }); incoming.pipe(call)
  })
  await new Promise<void>(done => proxy.listen(port,'127.0.0.1',done)); networkProbe.mark('chromium-launch-start')
  browser = await chromium.launch({headless:true}); networkProbe.mark('chromium-launch-done')
})
afterAll(async () => {
  const failures: unknown[] = []
  if(networkProbe) {
    try {
      const result=await networkProbe.finish('setup-incomplete'); console.error(result.line)
      if(result.cleanup==='unknown')failures.push(new Error('Private network observer cleanup unconfirmed'))
    } catch(error) { failures.push(error) }
  }
  for (const close of [() => browser?.close(), () => proxy && new Promise(done => proxy.close(done)), () => app?.cleanup(), () => crypto?.cleanup(), () => stores?.cleanup()]) { try { await close() } catch (error) { failures.push(error) } }
  if (failures.length) throw new AggregateError(failures,'Sparra browser cleanup failed')
})
async function signedIn(subject:string,observeBootstrap=false) {
  const fixtureClient=randomUUID();fixtureClients.set(fixtureClient,`127.0.1.${fixtureClients.size+1}`)
  const context = await browser.newContext({viewport:{width:320,height:720},extraHTTPHeaders:{'x-fixture-client':fixtureClient}}), page = await context.newPage()
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
  page.setDefaultTimeout(8000); page.setDefaultNavigationTimeout(8000)
  await page.route('https://accounts.google.com/o/oauth2/v2/auth*',async route => {
    const target = new URL(route.request().url()),code = await app.registerGoogle(target.href,subject)
    return route.fulfill({status:302,headers:{location:origin+'/api/auth/callback/google?code='+code+'&state='+target.searchParams.get('state')}})
  })
  const observer=observeBootstrap?await observePrivateLoginBootstrap(page,origin):undefined
  const networkChanged=(request:Request)=>{
    if(request.resourceType()==='script'&&request.failure()?.errorText==='net::ERR_NETWORK_CHANGED')networkProbe?.mark('first-script-network-change')
  }
  if(observeBootstrap)page.on('requestfailed',networkChanged)
  try {
    if(observeBootstrap)networkProbe?.mark('goto-start')
    await page.goto(origin+'/login?lang=en')
    if(observeBootstrap)networkProbe?.mark('goto-done')
    await page.getByRole('button',{name:'Continue with Google'}).click(); await page.waitForURL(origin+'/account?lang=en')
    if(observeBootstrap)void networkProbe?.finish('signed-in')
  } catch(error) {
    if(observeBootstrap)void networkProbe?.finish('native-failure')
    if(observer)await capturePrivateLoginBootstrapFailure(page,observer,error)
    throw error
  } finally {
    if(observeBootstrap) { try { page.off('requestfailed',networkChanged) } catch { /* Preserve the native failure. */ } }
    observer?.stop()
  }
  return {context,page}
}
async function rpc(context:BrowserContext,name:Parameters<typeof authRpcPath>[0],data:unknown) {
  return context.request.post(origin+await authRpcPath(name),{headers:{origin,'content-type':'application/json','x-tsr-serverFn':'true'},data:await rpcBody(data)})
}
test('compiled private inbox creates only by POST, saves knowledge across restart, keeps conflicting draft, treats and reloads durable erasure',async()=>{
  const {context,page}=await signedIn('sparra-owner',true), errors:string[]=[]
  let releaseMutation=()=>{}
  page.on('pageerror',e=>errors.push(e.message))
  try {
    for(const name of ['getWorkspace','getActivity','listRequests'] as const){const probe=await context.request.get(origin+await authRpcPath(name)+'?payload='+encodeURIComponent(await rpcBody({})),{headers:{'sec-fetch-site':'same-origin','x-tsr-serverFn':'true'}});expect(probe.status(),name).toBe(200)}
    expect((await page.goto(origin+'/workspace?lang=en'))?.status()).toBe(200)
    const response=await page.goto(origin+'/app?lang=en')
    expect(response?.status(),await page.locator('body').innerText()).toBe(200)
    await page.getByRole('heading',{name:'Call inbox',exact:true}).waitFor()
    const skip=page.getByRole('link',{name:'Skip to content',exact:true});expect((await skip.boundingBox())?.y).toBeLessThan(0);await skip.focus();expect((await skip.boundingBox())?.y).toBe(0)
    expect((await stores.administrator.query('SELECT count(*)::int n FROM workspace')).rows[0].n).toBe(0)
    expect(response?.headers()['cache-control']).toBe('no-store');expect(response?.headers()['x-robots-tag']).toBe('noindex')
    expect(response?.headers()['content-security-policy']).toContain("connect-src 'self'")
    await page.getByRole('link',{name:'Business',exact:true}).click()
    await page.getByRole('button',{name:'Create my workspace'}).click()
    await page.getByRole('textbox',{name:/^Business name/}).waitFor()
    await page.getByRole('textbox',{name:/^Business name/}).fill('Garage persisted')
    const recording=page.getByRole('checkbox',{name:'Keep audio from future calls for 30 days',exact:true})
    expect(await recording.isChecked()).toBe(false)
    expect(await recording.isDisabled()).toBe(true)
    // Historical provider settings are seeded through the native owner RPC;
    // the local policy remains OFF until explicit owner configuration.
    expect((await rpc(context,'saveActivity',{expectedRevision:0,businessName:'Garage persisted',sector:'garage',knowledge:{openingHours:'',services:'Vidange sur rendez-vous',prices:'',faq:'',instructions:''},transferDestination:null,recordingEnabled:true})).status()).toBe(200)
    await page.reload();expect(await recording.isChecked()).toBe(false);expect(await recording.isDisabled()).toBe(true)
    const editorAxe=await new AxeBuilder({page}).analyze();expect(editorAxe.violations).toEqual([])
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
    await page.screenshot({path:'.output/test-evidence/sparra/business-en-320.png',fullPage:true})
    await page.getByRole('button',{name:'Use local recording settings',exact:true}).click()
    await page.getByRole('textbox',{name:'Services',exact:true}).fill('Vidange sur rendez-vous')
    await page.getByRole('button',{name:'Save',exact:true}).focus();await page.keyboard.press('Enter')
    await page.getByText('Configuration saved.',{exact:true}).waitFor()
    await page.reload();expect(await page.getByRole('textbox',{name:/^Business name/}).inputValue()).toBe('Garage persisted');expect(await recording.isChecked()).toBe(false)
    const tab=await context.newPage();await tab.goto(origin+'/app/entreprise?lang=en')
    await page.getByRole('textbox',{name:'Services',exact:true}).fill('Draft retained')
    expect(await tab.getByRole('checkbox',{name:'Keep audio from future calls for 30 days',exact:true}).isDisabled()).toBe(true)
    await tab.getByRole('textbox',{name:'Services',exact:true}).fill('Latest services');await tab.getByRole('button',{name:'Save',exact:true}).click();await tab.getByText('Configuration saved.',{exact:true}).waitFor()
    const configurationConflict=page.getByRole('alert').filter({hasText:'The configuration changed.'})
    await page.getByRole('button',{name:'Save',exact:true}).click();await configurationConflict.waitFor()
    expect(await page.getByRole('textbox',{name:'Services',exact:true}).inputValue()).toBe('Draft retained')
    expect(await recording.isChecked()).toBe(false)
    expect(await configurationConflict.textContent()).toContain('configuration changed')
    expect(await page.getByRole('alert').filter({hasText:'Audio recording is unavailable for your business.'}).count()).toBe(1)
    await page.getByRole('button',{name:'Check latest version',exact:true}).click();await page.getByText('Latest saved version: 3',{exact:true}).waitFor()
    expect(await configurationConflict.textContent()).toContain('configuration changed')
    await page.getByRole('status').filter({hasText:'The saved information is different from your draft.'}).waitFor()
    expect(await page.getByRole('textbox',{name:'Services',exact:true}).inputValue()).toBe('Draft retained');await tab.close()
    await app.shutdown();expect(await bounded(app.exit)).toBe(0);await app.cleanup();app=startWeb(appEnv);upstreamPort=(await bounded(app.ready)).port
    await page.reload();expect(await page.getByRole('textbox',{name:'Services',exact:true}).inputValue()).toBe('Latest services');expect(await recording.isChecked()).toBe(false)
    await page.getByRole('link',{name:'Call inbox',exact:true}).click();await page.getByText('No calls yet.',{exact:true}).waitFor()
    const workspace=(await stores.administrator.query('SELECT id FROM workspace WHERE owner_user_id=(SELECT user_id FROM session LIMIT 1)')).rows[0]
    const native=await nativeVoiceTurn(crypto)
    const unavailableId=randomUUID()
    await stores.administrator.query(`INSERT INTO sparra_call(id,workspace_id,deployment_id,provider_call_control_id,admitted_at,retention_until,status,configuration_revision,encrypted_turns,encrypted_message_result) VALUES($1::uuid,$2::uuid,'fixture',$1::text,clock_timestamp(),clock_timestamp()+interval '30 days','closing',1,$3,$4)`,[crypto.callId,workspace.id,{[crypto.turnId]:native,[unavailableId]:{...native,turn_id:unavailableId,turn_no:2}},crypto.result()])
    await stores.administrator.query(`INSERT INTO sparra_call(id,workspace_id,deployment_id,provider_call_control_id,admitted_at,retention_until,status) VALUES($1::uuid,$2::uuid,'fixture',$1::text,clock_timestamp(),clock_timestamp()+interval '30 days','pending')`,[foreignCallId,workspace.id])
    await page.reload();await page.getByRole('link',{name:'Demande de rappel',exact:true}).click()
    await page.getByRole('heading',{name:'Call details',exact:true}).waitFor();await page.getByText('Rappelez-moi',{exact:true}).waitFor()
    expect(await page.locator('[data-configuration-snapshot]').textContent()).toContain('Vidange sur rendez-vous')
    await page.getByText('Partial summary',{exact:true}).waitFor()
    await page.getByText('Partial transcript: 1 unavailable turns.',{exact:true}).waitFor()
    await expect.poll(()=>page.getByRole('button',{name:'Mark as treated',exact:true}).isEnabled()).toBe(true)
    await expect.poll(()=>page.getByRole('button',{name:'Erase this call',exact:true}).isEnabled()).toBe(true)
    await expect.poll(()=>page.getByRole('button',{name:'Mark as treated',exact:true}).evaluate(button=>getComputedStyle(button).opacity)).toBe('1')
    await expect.poll(()=>page.getByRole('button',{name:'Erase this call',exact:true}).evaluate(button=>getComputedStyle(button).opacity)).toBe('1')
    const detailAxe=await new AxeBuilder({page}).analyze();expect(detailAxe.violations).toEqual([])
    await page.screenshot({path:'.output/test-evidence/sparra/detail-en-320.png',fullPage:true})
    const treatPath=await authRpcPath('markRequestTreated'),erasePath=await authRpcPath('eraseRequest'),erasures:string[]=[]
    page.on('request',request=>{if(new URL(request.url()).pathname===erasePath)erasures.push(request.method())})
    expect(await page.getByRole('button',{name:'Mark as treated',exact:true}).isDisabled()).toBe(false)
    await page.getByRole('button',{name:'Erase this call',exact:true}).click();await page.getByRole('button',{name:'Cancel',exact:true}).click()
    expect(erasures).toEqual([]);expect(await page.getByRole('button',{name:'Confirm erasure',exact:true}).count()).toBe(0)
    await page.getByRole('button',{name:'Erase this call',exact:true}).click()
    const treatmentHeld=new Promise<void>(done=>{releaseMutation=done}),treatmentCommitted=new Promise<void>(done=>{
      void page.route('**'+treatPath,async route=>{const response=await route.fetch();expect(response.status()).toBe(200);done();await treatmentHeld;await route.fulfill({response})},{times:1})
    })
    await page.getByRole('button',{name:'Mark as treated',exact:true}).click();await bounded(treatmentCommitted)
    await page.getByText('Working…',{exact:true}).waitFor()
    for(const name of ['Mark as treated','Confirm erasure','Cancel'])expect(await page.getByRole('button',{name,exact:true}).isDisabled()).toBe(true)
    expect(await page.getByText('Rappelez-moi',{exact:true}).count()).toBe(1)
    releaseMutation();await page.getByText('Treated',{exact:true}).waitFor();await page.reload();await page.getByText('Treated',{exact:true}).waitFor()
    expect((await stores.administrator.query('SELECT treated_at,ended_at FROM sparra_call WHERE id=$1',[crypto.callId])).rows[0]).toMatchObject({ended_at:null})
    await page.getByRole('button',{name:'Erase this call',exact:true}).click()
    const erasureHeld=new Promise<void>(done=>{releaseMutation=done}),erasureCommitted=new Promise<void>(done=>{
      void page.route('**'+erasePath,async route=>{const response=await route.fetch();expect(response.status()).toBe(200);done();await erasureHeld;await route.fulfill({response})},{times:1})
    })
    await page.getByRole('button',{name:'Confirm erasure',exact:true}).click();await bounded(erasureCommitted)
    for(const name of ['Confirm erasure','Cancel'])expect(await page.getByRole('button',{name,exact:true}).isDisabled()).toBe(true)
    expect(await page.getByText('Rappelez-moi',{exact:true}).count()).toBe(1)
    releaseMutation()
    await page.getByText('Erasure queued. Other copies are awaiting deletion.',{exact:true}).waitFor();expect(await page.getByText('Rappelez-moi',{exact:true}).count()).toBe(0)
    await page.reload();await page.getByText('Erasure queued. Other copies are awaiting deletion.',{exact:true}).waitFor()
    for(const name of ['getActivity','saveActivity','listRequests','getRequestDetail','markRequestTreated','eraseRequest','getRequestErasure'] as const)expect(await authRpcPath(name)).toMatch(/^\/_serverFn\/[a-f0-9]{64}$/)
    expect((await stores.administrator.query('SELECT count(*)::int n FROM sparra_call WHERE id=$1',[crypto.callId])).rows[0].n).toBe(0)
    const axe=await new AxeBuilder({page}).analyze();expect(axe.violations).toEqual([])
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
    await page.getByRole('link',{name:'Français'}).click();await page.getByText('Effacement en attente. Les autres copies restent à supprimer.',{exact:true}).waitFor()
    await page.screenshot({path:'.output/test-evidence/sparra/erasure-fr-320.png',fullPage:true})
    await page.goto(origin+'/app/demandes/'+foreignCallId+'?lang=en');await page.getByText('Transcript unavailable',{exact:true}).waitFor();await page.getByRole('heading',{name:'Summary unavailable',exact:true}).waitFor()
    expect(await page.content()).not.toContain('Call completed')
    expect(errors).toEqual([])
  }finally{releaseMutation();await context.close()}
},90000)

test('request unmount aborts held native delivery, failure retains confirmation and auth refusal hides content before navigation',async()=>{
  const {context,page}=await signedIn('sparra-request-refusal'),treatPath=await authRpcPath('markRequestTreated'),erasePath=await authRpcPath('eraseRequest'),loginPath=await authRpcPath('getLoginAvailability'),id=randomUUID()
  let releaseLogin=()=>{},releaseTreatment=()=>{},cleanupRefusal=async()=>{}
  try{
    await page.goto(origin+'/app/entreprise?lang=en');await page.getByRole('button',{name:'Create my workspace'}).click()
    await page.getByRole('textbox',{name:/^Business name/}).fill('Request refusal fixture');await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Configuration saved.',{exact:true}).waitFor()
    const workspace=(await stores.administrator.query('SELECT id FROM workspace WHERE owner_user_id=(SELECT id FROM "user" WHERE email=$1)',['sparra-request-refusal@example.test'])).rows[0]
    const result={schema_version:1,...crypto.encrypt(JSON.stringify({...crypto.inner,summary:'Private refusal request'}),'result:'+id)}
    await stores.administrator.query(`INSERT INTO sparra_call(id,workspace_id,deployment_id,provider_call_control_id,admitted_at,retention_until,status,configuration_revision,encrypted_turns,encrypted_message_result) VALUES($1::uuid,$2::uuid,'fixture',$1::text,clock_timestamp(),clock_timestamp()+interval '30 days','closing',1,$3,$4)`,[id,workspace.id,{[crypto.turnId]:crypto.turn},result])
    await page.goto(origin+'/app/demandes/'+id+'?lang=en');await page.getByText('Private refusal request',{exact:true}).waitFor()
    const treatmentHeld=new Promise<void>(done=>{releaseTreatment=done}),treatmentCommitted=new Promise<void>(done=>{
      void page.route('**'+treatPath,async route=>{const response=await route.fetch();expect(response.status()).toBe(200);done();await treatmentHeld;await route.fulfill({response}).catch(()=>{})},{times:1})
    })
    const cancelled=page.waitForEvent('requestfailed',{predicate:request=>new URL(request.url()).pathname===treatPath})
    await page.getByRole('button',{name:'Mark as treated',exact:true}).click();await bounded(treatmentCommitted)
    await page.getByRole('link',{name:'Account',exact:true}).click();await cancelled;await page.getByRole('heading',{name:'Your account',exact:true}).waitFor()
    releaseTreatment();expect(await page.getByText('Private refusal request',{exact:true}).count()).toBe(0);expect(await page.getByText('Treated',{exact:true}).count()).toBe(0)
    await page.goto(origin+'/app/demandes/'+id+'?lang=en');await page.getByText('Private refusal request',{exact:true}).waitFor();await page.getByText('Treated',{exact:true}).waitFor()
    await page.getByRole('button',{name:'Erase this call',exact:true}).click()
    await page.route('**'+erasePath,route=>route.abort('failed'),{times:1})
    await page.getByRole('button',{name:'Confirm erasure',exact:true}).click();await page.getByRole('alert').filter({hasText:'Data unavailable. Reload the page or sign in again.'}).waitFor()
    expect(await page.getByText('Private refusal request',{exact:true}).count()).toBe(1)
    expect(await page.getByRole('button',{name:'Confirm erasure',exact:true}).isDisabled()).toBe(false)
    expect(await page.getByRole('button',{name:'Cancel',exact:true}).isDisabled()).toBe(false)
    expect((await stores.administrator.query('SELECT count(*)::int n FROM sparra_call WHERE id=$1',[id])).rows[0].n).toBe(1)
    await stores.administrator.query('DELETE FROM session WHERE user_id=(SELECT id FROM "user" WHERE email=$1)',['sparra-request-refusal@example.test'])
    const loginHeld=new Promise<void>(done=>{releaseLogin=done}),loginStarted=new Promise<void>(done=>{
      void page.route('**'+loginPath+'*',async route=>{done();await loginHeld;await route.continue()},{times:1})
    })
    const refusalRender=await page.evaluateHandle(()=>{
      let finish=(observed:boolean)=>{void observed}
      const observed=new Promise<boolean>(resolve=>{finish=resolve})
      const settle=(value:boolean)=>{observer.disconnect();clearTimeout(timeout);window.removeEventListener('pagehide',unload);finish(value)}
      const inspect=()=>{
        const alert=[...document.querySelectorAll('[role="alert"]')].some(element=>element.textContent==='Data unavailable. Reload the page or sign in again.')
        const signIn=[...document.querySelectorAll('a[href="/login?lang=en"]')].some(element=>element.textContent==='Go to sign in')
        const privateAbsent=!document.querySelector('.sparra-request-actions')&&!document.body.textContent?.includes('Private refusal request')&&!document.body.textContent?.includes('Rappelez-moi')
        if(alert&&signIn&&privateAbsent)settle(true)
      }
      const observer=new MutationObserver(inspect),unload=()=>settle(false),timeout=setTimeout(()=>settle(false),6000)
      observer.observe(document.body,{childList:true,subtree:true,characterData:true});window.addEventListener('pagehide',unload)
      return {observed,dispose:()=>settle(false)}
    })
    cleanupRefusal=async()=>{try{await refusalRender.evaluate(({dispose})=>dispose())}finally{await refusalRender.dispose()}}
    const refusal=page.waitForResponse(response=>new URL(response.url()).pathname===erasePath)
    await page.getByRole('button',{name:'Confirm erasure',exact:true}).click();expect((await refusal).status()).toBe(401);await bounded(loginStarted)
    expect(await refusalRender.evaluate(({observed})=>observed)).toBe(true)
    expect(await page.getByText('Private refusal request',{exact:true}).count()).toBe(0)
    expect(await page.getByText('Rappelez-moi',{exact:true}).count()).toBe(0)
    expect(await page.locator('.sparra-request-actions').count()).toBe(0)
    releaseLogin();await page.waitForURL(origin+'/login?lang=en');await page.getByRole('button',{name:'Continue with Google',exact:true}).waitFor()
    expect((await stores.administrator.query('SELECT count(*)::int n FROM sparra_call WHERE id=$1',[id])).rows[0].n).toBe(1)
  }finally{releaseTreatment();releaseLogin();await cleanupRefusal().catch(()=>{});await context.close()}
},30000)

test('activity native mutation refusal renders private unavailable before login navigation completes',async()=>{
  const {context,page}=await signedIn('sparra-activity-refusal'),savePath=await authRpcPath('saveActivity'),loginPath=await authRpcPath('getLoginAvailability')
  let releaseLogin=()=>{},cleanupRefusal=async()=>{}
  try{
    await page.goto(origin+'/app/entreprise?lang=en');await page.getByRole('button',{name:'Create my workspace'}).click()
    await page.getByRole('textbox',{name:/^Business name/}).fill('Private activity refusal fixture')
    await page.getByRole('textbox',{name:'Services',exact:true}).fill('Private activity knowledge')
    await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Configuration saved.',{exact:true}).waitFor()
    const workspace=(await stores.administrator.query('SELECT id FROM workspace WHERE owner_user_id=(SELECT id FROM "user" WHERE email=$1)',['sparra-activity-refusal@example.test'])).rows[0]
    await stores.administrator.query('DELETE FROM session WHERE user_id=(SELECT id FROM "user" WHERE email=$1)',['sparra-activity-refusal@example.test'])
    const loginHeld=new Promise<void>(done=>{releaseLogin=done}),loginStarted=new Promise<void>(done=>{
      void page.route('**'+loginPath+'*',async route=>{done();await loginHeld;await route.continue()},{times:1})
    })
    const refusalRender=await page.evaluateHandle(()=>{
      let finish=(observed:boolean)=>{void observed}
      const observed=new Promise<boolean>(resolve=>{finish=resolve})
      const settle=(value:boolean)=>{observer.disconnect();clearTimeout(timeout);window.removeEventListener('pagehide',unload);finish(value)}
      const inspect=()=>{
        const alert=[...document.querySelectorAll('[role="alert"]')].some(element=>element.textContent==='Data unavailable. Reload the page or sign in again.')
        const signIn=[...document.querySelectorAll('a[href="/login?lang=en"]')].some(element=>element.textContent==='Go to sign in')
        const privateAbsent=!document.querySelector('.sparra-business-form')&&!document.body.textContent?.includes('Private activity refusal fixture')&&!document.body.textContent?.includes('Private activity knowledge')
        if(alert&&signIn&&privateAbsent)settle(true)
      }
      const observer=new MutationObserver(inspect),unload=()=>settle(false),timeout=setTimeout(()=>settle(false),6000)
      observer.observe(document.body,{childList:true,subtree:true,characterData:true});window.addEventListener('pagehide',unload)
      return {observed,dispose:()=>settle(false)}
    })
    cleanupRefusal=async()=>{try{await refusalRender.evaluate(({dispose})=>dispose())}finally{await refusalRender.dispose()}}
    await page.getByRole('textbox',{name:'Services',exact:true}).fill('Private activity knowledge pending edit')
    const refusal=page.waitForResponse(response=>new URL(response.url()).pathname===savePath)
    await page.getByRole('button',{name:'Save',exact:true}).click();expect((await refusal).status()).toBe(401);await bounded(loginStarted)
    expect(await refusalRender.evaluate(({observed})=>observed)).toBe(true)
    expect(await page.locator('.sparra-business-form').count()).toBe(0)
    expect(await page.getByRole('textbox',{name:/^Business name/}).count()).toBe(0)
    releaseLogin();await page.waitForURL(origin+'/login?lang=en');await page.getByRole('button',{name:'Continue with Google',exact:true}).waitFor()
    expect((await stores.administrator.query('SELECT max(revision)::int revision FROM sparra_knowledge_revision WHERE workspace_id=$1',[workspace.id])).rows[0].revision).toBe(1)
  }finally{releaseLogin();await cleanupRefusal().catch(()=>{});await context.close()}
},30000)

test('unknown and foreign receipts reveal no private data; revoked native sessions redirect and CSRF refuses POST',async()=>{
  const {context,page}=await signedIn('sparra-other')
  try {
    await page.goto(origin+'/app/demandes/'+crypto.callId+'?lang=en');await page.getByRole('alert').waitFor()
    expect(await page.content()).not.toContain('Rappelez-moi');expect(await page.content()).not.toContain('Erasure queued.')
    await page.goto(origin+'/app/demandes/'+randomUUID()+'?lang=en');await page.getByRole('alert').waitFor()
    await page.goto(origin+'/app/demandes/'+foreignCallId+'?lang=en');await page.getByRole('alert').waitFor()
    expect(await page.content()).not.toContain('Information known during the call')
    for(const name of ['markRequestTreated','eraseRequest'] as const)expect((await rpc(context,name,{requestId:crypto.callId})).status()).toBe(404)
    const denied=await context.request.post(origin+await authRpcPath('saveActivity'),{headers:{origin:'https://foreign.example','content-type':'application/json','x-tsr-serverFn':'true'},data:await rpcBody({})});expect(denied.status()).toBe(403)
    await stores.administrator.query('DELETE FROM session WHERE user_id=(SELECT id FROM "user" WHERE email=$1)',['sparra-other@example.test'])
    await page.goto(origin+'/app/entreprise?lang=en');await page.waitForURL(origin+'/login?lang=en')
    expect(await page.content()).not.toContain('Garage persisted')
    expect((await app.googleEvidence()).disallowed).toBe(0)
  }finally{await context.close()}
},30000)

test('native loader and mutation cancellation witness blocked Workspace and reconcile cancelled committed completion in the editor',async()=>{
  const {context,page}=await signedIn('sparra-cancellation-owner'),blocker=new Client({connectionString:stores.directRuntimeUrl})
  await page.goto(origin+'/app/entreprise?lang=en')
  if(await page.getByRole('button',{name:'Create my workspace'}).count()){
    await page.getByRole('button',{name:'Create my workspace'}).click();await page.getByRole('textbox',{name:/^Business name/}).fill('Cancellation fixture');await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Configuration saved.',{exact:true}).waitFor()
  }
  const workspace=(await stores.administrator.query('SELECT id FROM workspace WHERE owner_user_id=(SELECT id FROM "user" WHERE email=$1)',['sparra-cancellation-owner@example.test'])).rows[0]
  const savePath=await authRpcPath('saveActivity'),readPath=await authRpcPath('getActivity'),cancelled:string[]=[]
  page.on('requestfailed',r=>{if(r.url().includes('/_serverFn/'))cancelled.push(new URL(r.url()).pathname)})
  const blocked=()=>stores.administrator.query("SELECT pid FROM pg_stat_activity WHERE wait_event_type='Lock' AND (query LIKE 'SELECT app_private.resolve_personal_workspace%' OR query LIKE '%from \"workspace\"%for update')")
  async function lock(){await blocker.query('BEGIN');await blocker.query("SELECT set_config('app.tenant_id',$1,true)",[workspace.id]);await blocker.query('SELECT id FROM workspace WHERE id=$1 FOR UPDATE',[workspace.id])}
  let release=()=>{}
  try{
    await blocker.connect();await page.goto(origin+'/app?lang=en')
    await lock();await page.getByRole('link',{name:'Business',exact:true}).click()
    await expect.poll(async()=>(await blocked()).rowCount,{timeout:750,interval:10}).toBeGreaterThan(0)
    await page.getByRole('link',{name:'Account',exact:true}).click()
    await expect.poll(()=>cancelled.includes(readPath),{timeout:750,interval:10}).toBe(true)
    await blocker.query('ROLLBACK');await page.getByRole('heading',{name:'Your account',exact:true}).waitFor()
    await page.goto(origin+'/app/entreprise?lang=en');await page.getByRole('textbox',{name:'Services',exact:true}).fill('Must not commit')
    let before=(await stores.administrator.query('SELECT max(revision)::int revision FROM sparra_knowledge_revision WHERE workspace_id=$1',[workspace.id])).rows[0].revision
    await lock();await page.getByRole('button',{name:'Save',exact:true}).click()
    await expect.poll(async()=>(await blocked()).rowCount,{timeout:750,interval:10}).toBeGreaterThan(0)
    await page.getByRole('button',{name:'Stop waiting',exact:true}).click()
    await expect.poll(()=>cancelled.includes(savePath),{timeout:750,interval:10}).toBe(true)
    await page.getByRole('alert').filter({hasText:'The save outcome is unknown.'}).waitFor()
    expect(await page.getByRole('textbox',{name:'Services',exact:true}).inputValue()).toBe('Must not commit')
    expect(await page.getByRole('button',{name:'Save',exact:true}).isDisabled()).toBe(true)
    await page.getByRole('link',{name:'Account',exact:true}).click()
    await blocker.query('ROLLBACK');await page.getByRole('heading',{name:'Your account',exact:true}).waitFor()
    expect((await stores.administrator.query('SELECT max(revision)::int revision FROM sparra_knowledge_revision WHERE workspace_id=$1',[workspace.id])).rows[0].revision).toBe(before)
    expect((await rpc(context,'saveActivity',{expectedRevision:before,businessName:'Cancellation fixture',sector:'garage',knowledge:{openingHours:'',services:'',prices:'',faq:'',instructions:''},transferDestination:null,recordingEnabled:true})).status()).toBe(200)
    before++
    await page.goto(origin+'/app/entreprise?lang=en')
    const held=new Promise<void>(done=>{release=done}),committed=new Promise<void>(done=>{
      void page.route('**'+savePath,async route=>{const response=await route.fetch();expect(response.status()).toBe(200);done();await held;await route.fulfill({response}).catch(()=>{})},{times:1})
    })
    const recording=page.getByRole('checkbox',{name:'Keep audio from future calls for 30 days',exact:true})
    expect(await recording.isChecked()).toBe(false)
    await page.getByRole('button',{name:'Use local recording settings',exact:true}).click()
    await page.getByRole('textbox',{name:'Services',exact:true}).fill('Committed old attempt');await page.getByRole('button',{name:'Save',exact:true}).click();await bounded(committed)
    expect(await recording.isDisabled()).toBe(true)
    expect(await page.getByText('Configuration saved.',{exact:true}).count()).toBe(0)
    expect((await stores.administrator.query('SELECT max(revision)::int revision FROM sparra_knowledge_revision WHERE workspace_id=$1',[workspace.id])).rows[0].revision).toBe(before+1)
    await page.getByRole('button',{name:'Stop waiting',exact:true}).click()
    await page.getByRole('alert').filter({hasText:'The save outcome is unknown. Check the latest version before saving again.'}).waitFor()
    expect(page.url()).toBe(origin+'/app/entreprise?lang=en')
    expect(await page.getByRole('textbox',{name:'Services',exact:true}).inputValue()).toBe('Committed old attempt')
    expect(await recording.isChecked()).toBe(false)
    expect(await page.getByRole('button',{name:'Save',exact:true}).isDisabled()).toBe(true)
    await page.getByRole('textbox',{name:'Services',exact:true}).fill('Retained reconciliation draft')
    release()
    await page.getByRole('button',{name:'Check latest version',exact:true}).click();await page.getByText('Latest saved version: '+(before+1),{exact:true}).waitFor()
    expect(await page.getByText('Configuration saved.',{exact:true}).count()).toBe(0)
    expect(await page.getByRole('textbox',{name:'Services',exact:true}).inputValue()).toBe('Retained reconciliation draft')
    expect(await page.getByRole('button',{name:'Save',exact:true}).isDisabled()).toBe(true)
    expect((await stores.administrator.query('SELECT max(revision)::int revision FROM sparra_knowledge_revision WHERE workspace_id=$1',[workspace.id])).rows[0].revision).toBe(before+1)
    await page.getByRole('button',{name:'Replace draft with latest version',exact:true}).click()
    await expect.poll(()=>page.getByRole('alert').allTextContents()).toEqual(['Audio recording is unavailable for your business. You can turn off a previously saved setting.'])
    expect(await recording.isChecked()).toBe(false)
    expect(await recording.isDisabled()).toBe(true)
    expect(await page.getByRole('button',{name:'Save',exact:true}).isDisabled()).toBe(true)
    expect(await page.getByRole('textbox',{name:'Services',exact:true}).inputValue()).toBe('Committed old attempt')
    await page.getByRole('textbox',{name:'Services',exact:true}).fill('Newest attempt');await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Configuration saved.',{exact:true}).waitFor()
    release();await page.reload();expect(await page.getByRole('textbox',{name:'Services',exact:true}).inputValue()).toBe('Newest attempt')
    expect((await stores.administrator.query('SELECT max(revision)::int revision FROM sparra_knowledge_revision WHERE workspace_id=$1',[workspace.id])).rows[0].revision).toBe(before+2)
  }finally{release();await blocker.query('ROLLBACK').catch(()=>{});await blocker.end();await context.close()}
},60000)

test('native unavailable audio prevents enabling OFF and lets a historical provider setting be explicitly corrected and persisted',async()=>{
  const {context,page}=await signedIn('sparra-audio-presentation-guard')
  try{
    await page.goto(origin+'/app/entreprise?lang=en');await page.getByRole('button',{name:'Create my workspace'}).click()
    const recording=page.getByRole('checkbox',{name:'Keep audio from future calls for 30 days',exact:true})
    expect(await recording.isChecked()).toBe(false)
    expect(await recording.isDisabled()).toBe(true)
    const initial={expectedRevision:0,businessName:'Audio policy fixture',sector:'garage',knowledge:{openingHours:'',services:'',prices:'',faq:'',instructions:''},transferDestination:null,recordingEnabled:true}
    expect((await rpc(context,'saveActivity',initial)).status()).toBe(200)
    await page.reload()
    expect(await recording.isChecked()).toBe(false)
    expect(await recording.isDisabled()).toBe(true)
    expect(await page.getByRole('button',{name:'Save',exact:true}).isDisabled()).toBe(true)
    await page.getByRole('alert').filter({hasText:'An old audio setting is saved.'}).waitFor()
    const before=(await stores.administrator.query('SELECT max(revision)::int revision FROM sparra_knowledge_revision WHERE workspace_id=(SELECT id FROM workspace WHERE owner_user_id=(SELECT id FROM "user" WHERE email=$1))',['sparra-audio-presentation-guard@example.test'])).rows[0].revision
    await page.getByRole('textbox',{name:/^Business name/}).press('Enter')
    expect((await stores.administrator.query('SELECT max(revision)::int revision FROM sparra_knowledge_revision WHERE workspace_id=(SELECT id FROM workspace WHERE owner_user_id=(SELECT id FROM "user" WHERE email=$1))',['sparra-audio-presentation-guard@example.test'])).rows[0].revision).toBe(before)
    const correction=page.getByRole('button',{name:'Use local recording settings',exact:true})
    await correction.focus();await page.keyboard.press('Enter')
    expect(await recording.isChecked()).toBe(false)
    expect(await recording.isDisabled()).toBe(true)
    await page.getByRole('status').filter({hasText:'Existing recordings keep their original expiry.'}).waitFor()
    expect(await page.getByRole('button',{name:'Save',exact:true}).isDisabled()).toBe(false)
    await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Configuration saved.',{exact:true}).waitFor()
    await page.reload()
    expect(await recording.isChecked()).toBe(false)
    expect(await recording.isDisabled()).toBe(true)
    const configuration=(await stores.administrator.query('SELECT recording_enabled,recording_policy,recording_contact_phone FROM sparra_knowledge_revision WHERE workspace_id=(SELECT id FROM workspace WHERE owner_user_id=(SELECT id FROM "user" WHERE email=$1)) ORDER BY revision DESC LIMIT 1',['sparra-audio-presentation-guard@example.test'])).rows[0]
    expect(configuration).toEqual({recording_enabled:false,recording_policy:'off',recording_contact_phone:null})
  }finally{await context.close()}
},30000)

async function bindLocalAudioFixture(subject:string){
  const role='fixture_local_'+randomUUID().replaceAll('-','')
  const {rows:[workspace]}=await stores.administrator.query('SELECT id FROM workspace WHERE owner_user_id=(SELECT id FROM "user" WHERE email=$1)',[subject+'@example.test'])
  expect(workspace?.id).toBeTypeOf('string')
  await stores.administrator.query('CREATE ROLE "'+role+'" LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION')
  await stores.administrator.query(`INSERT INTO voice_private.deployment_binding
    (service_login,service_role_oid,deployment_id,workspace_id,connection_id,to_e164,admission_enabled,audio_enabled,contract_version,local_audio_enabled)
    SELECT $1::name,oid,$1::text,$2::uuid,'fixture-local-connection','+33123456789',true,false,2,true FROM pg_roles WHERE rolname=$1::name`,[role,workspace.id])
  return {role,workspaceId:workspace.id}
}

test('setup clarity hides empty OFF contact, retains draft and saved values through keyboard toggles, and clears only after a known save',async()=>{
  const subject='sparra-setup-contact',{context,page}=await signedIn(subject)
  try{
    await page.goto(origin+'/app/entreprise?lang=en');await page.getByRole('button',{name:'Create my workspace'}).click()
    const name=page.getByRole('textbox',{name:/^Business name/}),recording=page.getByRole('checkbox',{name:'Keep audio from future calls for 30 days',exact:true}),phone=page.getByRole('textbox',{name:/^Recording contact phone/})
    await name.waitFor();await bindLocalAudioFixture(subject);await page.reload()
    expect(await phone.count()).toBe(0)
    await name.fill('Setup contact fixture')
    await recording.focus();await page.keyboard.press('Space')
    await phone.waitFor();expect(await phone.getAttribute('aria-required')).toBeNull()
    await phone.fill('+33123456789')
    await recording.focus();await page.keyboard.press('Space')
    expect(await recording.isChecked()).toBe(false)
    expect(await phone.inputValue()).toBe('+33123456789')
    await recording.check();expect(await phone.inputValue()).toBe('+33123456789');await recording.uncheck()
    await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Configuration saved.',{exact:true}).waitFor()
    await page.reload();expect(await recording.isChecked()).toBe(false);expect(await phone.inputValue()).toBe('+33123456789')
    await phone.fill('+33102030405');await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Configuration saved.',{exact:true}).waitFor()
    await phone.fill('');expect(await phone.isVisible()).toBe(true)
    await recording.check();await recording.uncheck();expect(await phone.isVisible()).toBe(true)
    await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Configuration saved.',{exact:true}).waitFor()
    expect(await phone.count()).toBe(0)
    await page.reload();expect(await phone.count()).toBe(0)
    expect((await new AxeBuilder({page}).analyze()).violations).toEqual([])
  }finally{await context.close()}
},30000)

test('setup clarity unchanged saved draft blocks keyboard and direct form submit while exact edits and initial save remain possible',async()=>{
  const {context,page}=await signedIn('sparra-setup-noop'),savePath=await authRpcPath('saveActivity')
  let saves=0
  page.on('request',request=>{if(new URL(request.url()).pathname===savePath)saves++})
  try{
    await page.goto(origin+'/app/entreprise?lang=en');await page.getByRole('button',{name:'Create my workspace'}).click()
    const name=page.getByRole('textbox',{name:/^Business name/}),save=page.getByRole('button',{name:'Save',exact:true})
    expect(await save.isDisabled()).toBe(false)
    await name.fill('Setup no-op fixture');await save.click();await page.getByText('Configuration saved.',{exact:true}).waitFor()
    expect(saves).toBe(1);expect(await save.isDisabled()).toBe(true)
    await name.press('Enter');await page.locator('.sparra-business-form').evaluate((form:HTMLFormElement)=>form.requestSubmit())
    await name.fill('Setup no-op fixture ');expect(await save.isDisabled()).toBe(false)
    await name.fill('Setup no-op fixture');expect(await save.isDisabled()).toBe(true)
    await page.getByRole('textbox',{name:'Services',exact:true}).fill('Explicit later edit')
    expect(await save.isDisabled()).toBe(false);await save.focus();await page.keyboard.press('Enter');await page.getByText('Configuration saved.',{exact:true}).waitFor()
    expect(saves).toBe(2);expect(await save.isDisabled()).toBe(true)
    await page.reload();expect(await save.isDisabled()).toBe(true)
    expect((await stores.administrator.query('SELECT count(*)::int n FROM sparra_knowledge_revision WHERE workspace_id=(SELECT id FROM workspace WHERE owner_user_id=(SELECT id FROM "user" WHERE email=$1))',['sparra-setup-noop@example.test'])).rows[0].n).toBe(2)
  }finally{await context.close()}
},30000)

test('setup clarity clearing a stored OFF contact preserves the field and recovery until known latest replacement',async()=>{
  const subject='sparra-setup-clear-unknown',{context,page}=await signedIn(subject),savePath=await authRpcPath('saveActivity')
  let release=()=>{}
  try{
    await page.goto(origin+'/app/entreprise?lang=en');await page.getByRole('button',{name:'Create my workspace'}).click()
    await page.getByRole('textbox',{name:/^Business name/}).waitFor();const binding=await bindLocalAudioFixture(subject);await page.reload()
    await page.getByRole('textbox',{name:/^Business name/}).fill('Clear contact recovery')
    const recording=page.getByRole('checkbox',{name:'Keep audio from future calls for 30 days',exact:true}),phone=page.getByRole('textbox',{name:/^Recording contact phone/})
    await recording.check();await phone.fill('+33123456789');await recording.uncheck()
    await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Configuration saved.',{exact:true}).waitFor()
    await phone.fill('')
    const held=new Promise<void>(done=>{release=done}),committed=new Promise<void>(done=>{
      void page.route('**'+savePath,async route=>{const response=await route.fetch();expect(response.status()).toBe(200);done();await held;await route.fulfill({response}).catch(()=>{})},{times:1})
    })
    await page.getByRole('button',{name:'Save',exact:true}).click();await bounded(committed)
    await page.getByRole('button',{name:'Stop waiting',exact:true}).click();release()
    await page.getByRole('alert').filter({hasText:'The save outcome is unknown.'}).waitFor()
    expect(await phone.isVisible()).toBe(true);expect(await phone.inputValue()).toBe('')
    expect(await page.getByRole('button',{name:'Save',exact:true}).isDisabled()).toBe(true)
    await page.getByRole('button',{name:'Check latest version',exact:true}).click();await page.getByRole('status').filter({hasText:'Your draft matches the saved information.'}).waitFor()
    expect(await phone.isVisible()).toBe(true)
    await page.getByRole('button',{name:'Replace draft with latest version',exact:true}).click()
    expect(await phone.count()).toBe(0);expect(await page.getByRole('button',{name:'Save',exact:true}).isDisabled()).toBe(true)
    expect((await stores.administrator.query('SELECT revision,recording_policy,recording_contact_phone FROM sparra_knowledge_revision WHERE workspace_id=$1 ORDER BY revision',[binding.workspaceId])).rows).toEqual([{revision:1,recording_policy:'off',recording_contact_phone:'+33123456789'},{revision:2,recording_policy:'off',recording_contact_phone:null}])
  }finally{release();await context.close()}
},30000)

test('compiled local recording accepts empty contact, validates supplied phones and permits OFF after capability withdrawal without history rewrite',async()=>{
  const subject='sparra-local-recording-config',{context,page}=await signedIn(subject),savePath=await authRpcPath('saveActivity')
  let saves=0
  page.on('request',request=>{if(new URL(request.url()).pathname===savePath)saves++})
  try{
    await page.goto(origin+'/app/entreprise?lang=en');await page.getByRole('button',{name:'Create my workspace'}).click()
    await page.getByRole('textbox',{name:/^Business name/}).waitFor()
    const binding=await bindLocalAudioFixture(subject)
    await page.reload()
    const recording=page.getByRole('checkbox',{name:'Keep audio from future calls for 30 days',exact:true}),phone=page.getByRole('textbox',{name:/^Recording contact phone/})
    await expect.poll(()=>recording.isDisabled()).toBe(false)
    await page.getByRole('textbox',{name:/^Business name/}).fill('Native recording configuration')
    await recording.check();await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Configuration saved.',{exact:true}).waitFor()
    expect(await phone.getAttribute('aria-required')).toBeNull()
    expect(await phone.inputValue()).toBe('')
    expect(saves).toBe(1)
    await phone.fill('0612345678');await page.getByRole('button',{name:'Save',exact:true}).click()
    expect(await phone.inputValue()).toBe('0612345678')
    expect(await phone.getAttribute('aria-invalid')).toBe('true')
    expect(saves).toBe(1)
    await phone.fill('+33123456789');await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Configuration saved.',{exact:true}).waitFor()
    expect(saves).toBe(2)
    await page.reload()
    expect(await recording.isChecked()).toBe(true)
    expect(await phone.inputValue()).toBe('+33123456789')
    expect(await page.getByRole('textbox',{name:/^Transfer number/}).inputValue()).toBe('')
    const recordingAxe=await new AxeBuilder({page}).analyze();expect(recordingAxe.violations).toEqual([])
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
    await page.screenshot({path:'.output/test-evidence/sparra/local-recording-en-320.png',fullPage:true})
    const previous=(await stores.administrator.query('SELECT revision,recording_policy,recording_contact_phone,recording_enabled FROM sparra_knowledge_revision WHERE workspace_id=$1 ORDER BY revision',[binding.workspaceId])).rows
    expect(previous).toEqual([{revision:1,recording_policy:'local_30d',recording_contact_phone:null,recording_enabled:false},{revision:2,recording_policy:'local_30d',recording_contact_phone:'+33123456789',recording_enabled:false}])
    await phone.fill('+33102030405');await page.getByRole('status').filter({hasText:'Unsaved changes.'}).waitFor()
    await stores.administrator.query('UPDATE voice_private.deployment_binding SET admission_enabled=false WHERE service_login=$1',[binding.role])
    await page.getByRole('button',{name:'Save',exact:true}).click()
    await page.getByRole('alert').filter({hasText:'Audio recording is unavailable for your business'}).first().waitFor()
    expect(await page.getByRole('alert').filter({hasText:'Audio recording is unavailable for your business'}).count()).toBe(1)
    expect(await page.getByText('The configuration changed.',{exact:false}).count()).toBe(0)
    expect(await page.getByRole('button',{name:'Check latest version',exact:true}).count()).toBe(0)
    expect(await phone.inputValue()).toBe('+33102030405')
    expect(await recording.isChecked()).toBe(true)
    expect((await stores.administrator.query('SELECT revision,recording_policy,recording_contact_phone,recording_enabled FROM sparra_knowledge_revision WHERE workspace_id=$1 ORDER BY revision',[binding.workspaceId])).rows).toEqual(previous)
    await recording.uncheck();await page.getByRole('status').filter({hasText:'Existing recordings keep their original expiry.'}).waitFor()
    await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Configuration saved.',{exact:true}).waitFor()
    await page.reload();expect(await recording.isChecked()).toBe(false);expect(await recording.isDisabled()).toBe(true)
    expect((await stores.administrator.query('SELECT recording_policy,recording_contact_phone,recording_enabled FROM sparra_knowledge_revision WHERE workspace_id=$1 AND revision=3',[binding.workspaceId])).rows).toEqual([{recording_policy:'off',recording_contact_phone:'+33102030405',recording_enabled:false}])
    expect((await stores.administrator.query('SELECT revision,recording_policy,recording_contact_phone,recording_enabled FROM sparra_knowledge_revision WHERE workspace_id=$1 AND revision<=2 ORDER BY revision',[binding.workspaceId])).rows).toEqual(previous)
  }finally{await context.close()}
},30000)

test('compiled recording contact-only save with a lost reply remains unknown until deliberate latest read and draft replacement',async()=>{
  const subject='sparra-local-recording-unknown',{context,page}=await signedIn(subject),savePath=await authRpcPath('saveActivity')
  let release=()=>{}
  try{
    await page.goto(origin+'/app/entreprise?lang=en');await page.getByRole('button',{name:'Create my workspace'}).click()
    await page.getByRole('textbox',{name:/^Business name/}).waitFor()
    const binding=await bindLocalAudioFixture(subject)
    await page.reload()
    await page.getByRole('textbox',{name:/^Business name/}).fill('Recording reconciliation')
    await page.getByRole('checkbox',{name:'Keep audio from future calls for 30 days',exact:true}).check()
    const phone=page.getByRole('textbox',{name:/^Recording contact phone/})
    await phone.fill('+33123456789');await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Configuration saved.',{exact:true}).waitFor()
    await phone.fill('+33102030405');await page.getByRole('status').filter({hasText:'Unsaved changes.'}).waitFor()
    const held=new Promise<void>(done=>{release=done}),committed=new Promise<void>(done=>{
      void page.route('**'+savePath,async route=>{const response=await route.fetch();expect(response.status()).toBe(200);done();await held;await route.fulfill({response}).catch(()=>{})},{times:1})
    })
    await page.getByRole('button',{name:'Save',exact:true}).click();await bounded(committed)
    await page.getByRole('button',{name:'Stop waiting',exact:true}).click();await page.getByRole('alert').filter({hasText:'The save outcome is unknown.'}).waitFor()
    release()
    expect(await phone.inputValue()).toBe('+33102030405')
    expect(await page.getByRole('button',{name:'Save',exact:true}).isDisabled()).toBe(true)
    expect((await stores.administrator.query('SELECT revision,recording_contact_phone FROM sparra_knowledge_revision WHERE workspace_id=$1 ORDER BY revision DESC LIMIT 1',[binding.workspaceId])).rows).toEqual([{revision:2,recording_contact_phone:'+33102030405'}])
    await page.getByRole('button',{name:'Check latest version',exact:true}).click();await page.getByRole('status').filter({hasText:'Your draft matches the saved information.'}).waitFor()
    await phone.fill('+33123456789');await page.getByRole('status').filter({hasText:'The saved information is different from your draft.'}).waitFor()
    expect(await phone.inputValue()).toBe('+33123456789')
    await page.getByRole('button',{name:'Replace draft with latest version',exact:true}).click()
    expect(await phone.inputValue()).toBe('+33102030405')
    expect(await page.getByRole('button',{name:'Save',exact:true}).isDisabled()).toBe(true)
  }finally{release();await context.close()}
},30000)

test('business operation waits explain their mode and uncertain latest reads compare actual draft values without automatic replacement',async()=>{
  const {context,page}=await signedIn('sparra-operation-feedback'),readPath=await authRpcPath('getActivity'),savePath=await authRpcPath('saveActivity')
  let release=()=>{}
  try{
    await page.goto(origin+'/app/entreprise?lang=en')
    let held=new Promise<void>(done=>{release=done})
    await page.route('**'+readPath+'*',async route=>{await held;await route.continue()},{times:1})
    await page.getByRole('button',{name:'Create my workspace'}).click()
    await page.getByRole('status').filter({hasText:'Creating your workspace…'}).waitFor()
    expect(await page.getByText('Saving…',{exact:true}).count()).toBe(0)
    release();await page.getByRole('textbox',{name:/^Business name/}).fill('Operation feedback fixture')
    held=new Promise<void>(done=>{release=done})
    const committed=new Promise<void>(done=>{
      void page.route('**'+savePath,async route=>{const response=await route.fetch();expect(response.status()).toBe(200);done();await held;await route.fulfill({response}).catch(()=>{})},{times:1})
    })
    await page.getByRole('button',{name:'Save',exact:true}).click();await bounded(committed)
    await page.getByRole('status').filter({hasText:'Saving…'}).waitFor()
    await page.getByText('Saving may still complete if you stop waiting.',{exact:true}).waitFor()
    await page.getByRole('button',{name:'Stop waiting',exact:true}).click()
    await page.getByRole('alert').filter({hasText:'The save outcome is unknown.'}).waitFor()
    release()
    held=new Promise<void>(done=>{release=done})
    await page.route('**'+readPath+'*',async route=>{await held;await route.continue()},{times:1})
    await page.getByRole('button',{name:'Check latest version',exact:true}).click()
    await page.getByRole('status').filter({hasText:'Checking saved information…'}).waitFor()
    expect(await page.getByRole('button',{name:'Save',exact:true}).isDisabled()).toBe(true)
    release();await page.getByRole('status').filter({hasText:'Your draft matches the saved information.'}).waitFor()
    expect(await page.getByRole('button',{name:'Save',exact:true}).isDisabled()).toBe(true)
    expect(await page.getByText('Configuration saved.',{exact:true}).count()).toBe(0)
    await page.getByRole('textbox',{name:/^Business name/}).fill('Locally changed after verification')
    await page.getByRole('status').filter({hasText:'The saved information is different from your draft.'}).waitFor()
    await page.getByText('Replacing your draft will discard your local changes.',{exact:true}).waitFor()
    expect(await page.getByRole('textbox',{name:/^Business name/}).inputValue()).toBe('Locally changed after verification')
    await page.getByRole('button',{name:'Replace draft with latest version',exact:true}).click()
    expect(await page.getByRole('textbox',{name:/^Business name/}).inputValue()).toBe('Operation feedback fixture')
    expect(await page.getByRole('button',{name:'Save',exact:true}).isDisabled()).toBe(true)
  }finally{release();await context.close()}
},40000)

test('business local validation keeps invalid input, focuses the first affected field and avoids native saves for common errors',async()=>{
  const {context,page}=await signedIn('sparra-local-validation'),savePath=await authRpcPath('saveActivity')
  let saves=0
  page.on('request',request=>{if(new URL(request.url()).pathname===savePath)saves++})
  try{
    await page.goto(origin+'/app/entreprise?lang=en');await page.getByRole('button',{name:'Create my workspace'}).click()
    const name=page.getByRole('textbox',{name:/^Business name/}),hours=page.getByRole('textbox',{name:'Opening hours',exact:true}),services=page.getByRole('textbox',{name:'Services',exact:true}),phone=page.getByRole('textbox',{name:/^Transfer number/})
    await name.fill('   ');await page.getByRole('button',{name:'Save',exact:true}).click()
    expect(await name.getAttribute('aria-invalid')).toBe('true')
    expect(await name.evaluate(element=>document.activeElement===element)).toBe(true)
    expect(await name.inputValue()).toBe('   ')
    expect(saves).toBe(0)
    await name.fill('x'.repeat(81));await page.getByRole('button',{name:'Save',exact:true}).click()
    expect(await name.getAttribute('aria-invalid')).toBe('true')
    expect(await name.inputValue()).toBe('x'.repeat(81))
    expect(saves).toBe(0)
    await name.fill('Validation fixture');await hours.fill('x'.repeat(1001));await services.fill('x'.repeat(2001));await phone.fill('0612345678')
    await page.getByRole('button',{name:'Save',exact:true}).click()
    expect(await hours.getAttribute('aria-invalid')).toBe('true')
    expect(await services.getAttribute('aria-invalid')).toBe('true')
    expect(await phone.getAttribute('aria-invalid')).toBe('true')
    expect(await hours.evaluate(element=>document.activeElement===element)).toBe(true)
    expect(await hours.inputValue()).toBe('x'.repeat(1001))
    expect(saves).toBe(0)
    await hours.fill('Weekdays');await services.fill('Observed service');await phone.fill('+33123456789')
    await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Configuration saved.',{exact:true}).waitFor()
    expect(saves).toBe(1)
    expect(await name.getAttribute('aria-invalid')).toBeNull()
    expect(await hours.getAttribute('aria-invalid')).toBeNull()
    expect(await phone.getAttribute('aria-invalid')).toBeNull()
  }finally{await context.close()}
},30000)

test('business draft status returns to saved when all edited values match the persisted configuration',async()=>{
  const {context,page}=await signedIn('sparra-draft-status')
  try{
    await page.goto(origin+'/app/entreprise?lang=en');await page.getByRole('button',{name:'Create my workspace'}).click()
    const name=page.getByRole('textbox',{name:/^Business name/}),services=page.getByRole('textbox',{name:'Services',exact:true})
    await name.fill('Draft status fixture');await services.fill('Observed service')
    await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Configuration saved.',{exact:true}).waitFor()
    await page.reload()
    await page.getByRole('status').filter({hasText:'No unsaved changes.'}).waitFor()
    await name.fill('Changed name');await services.fill('Changed service')
    await page.getByRole('status').filter({hasText:'Unsaved changes.'}).waitFor()
    await name.fill('Draft status fixture')
    expect(await page.getByRole('status').filter({hasText:'Unsaved changes.'}).count()).toBe(1)
    await services.fill('Observed service')
    await page.getByRole('status').filter({hasText:'No unsaved changes.'}).waitFor()
    expect(await page.getByRole('status').filter({hasText:/^Unsaved changes\.$/}).count()).toBe(0)
  }finally{await context.close()}
},30000)

test('saved feedback clears after every editable business information field changes',async()=>{
  const {context,page}=await signedIn('sparra-saved-feedback')
  try{
    await page.goto(origin+'/app/entreprise?lang=en');await page.getByRole('button',{name:'Create my workspace'}).click()
    await page.getByRole('textbox',{name:/^Business name/}).fill('Saved feedback fixture')
    const edits=[()=>page.getByRole('textbox',{name:/^Business name/}).fill('Edited feedback fixture'),()=>page.getByRole('combobox',{name:/^Sector/}).click(),...['Opening hours','Services','Prices','Frequently asked questions','Response instructions','Transfer number (optional)'].map(name=>()=>page.getByRole('textbox',{name,exact:true}).fill(name==='Transfer number (optional)'?'+33123456789':'Edited '+name))]
    for(const [index,edit] of edits.entries()){
      await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Configuration saved.',{exact:true}).waitFor()
      await edit()
      if(index===1)await page.getByRole('option',{name:'Vehicle inspection',exact:true}).click()
      await expect.poll(()=>page.getByText('Configuration saved.',{exact:true}).count()).toBe(0)
    }
  }finally{await context.close()}
},40000)

test('native committed save delivery failure retains draft and requires reconciliation while validation and read failures stay distinct',async()=>{
  const {context,page}=await signedIn('sparra-save-delivery'),savePath=await authRpcPath('saveActivity'),readPath=await authRpcPath('getActivity')
  let release=()=>{}
  try{
    await page.goto(origin+'/app/entreprise?lang=en')
    // A failed native read transport during ensure is unavailable, not an ambiguous save.
    await page.route('**'+readPath+'*',route=>route.abort('failed'),{times:1})
    await page.getByRole('button',{name:'Create my workspace'}).click();await page.getByText('Information unavailable. Try again or reload the page.',{exact:true}).waitFor()
    expect(await page.getByText('The save outcome is unknown.',{exact:false}).count()).toBe(0)
    expect(await page.getByRole('button',{name:'Check latest version',exact:true}).count()).toBe(0)
    expect(await page.getByRole('button',{name:'Create my workspace'}).isDisabled()).toBe(false)
    await page.getByRole('button',{name:'Create my workspace'}).click()
    await page.getByRole('textbox',{name:/^Business name/}).fill('Delivery fixture');await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Configuration saved.',{exact:true}).waitFor()
    const workspace=(await stores.administrator.query('SELECT id FROM workspace WHERE owner_user_id=(SELECT id FROM "user" WHERE email=$1)',['sparra-save-delivery@example.test'])).rows[0]
    const revision=async()=>(await stores.administrator.query('SELECT max(revision)::int revision FROM sparra_knowledge_revision WHERE workspace_id=$1',[workspace.id])).rows[0].revision
    expect(await revision()).toBe(1)
    // An invalid control character remains a native-validator concern beyond common UI bounds.
    const invalidResponse=page.waitForResponse(response=>new URL(response.url()).pathname===savePath)
    await page.getByRole('textbox',{name:/^Business name/}).fill('Invalid\u0001name');await page.getByRole('button',{name:'Save',exact:true}).click();expect((await invalidResponse).status()).toBe(400)
    await page.getByText('Some information could not be saved. Check the fields and try again.',{exact:true}).waitFor()
    expect(await page.getByRole('textbox',{name:/^Business name/}).inputValue()).toBe('Invalid\u0001name')
    expect(await page.getByRole('button',{name:'Save',exact:true}).isDisabled()).toBe(false)
    expect(await page.getByRole('button',{name:'Check latest version',exact:true}).count()).toBe(0)
    expect(await revision()).toBe(1)
    await page.getByRole('textbox',{name:/^Business name/}).fill('Delivery fixture')
    const held=new Promise<void>(done=>{release=done}),committed=new Promise<void>(done=>{
      void page.route('**'+savePath,async route=>{const response=await route.fetch();expect(response.status()).toBe(200);done();await held;await route.abort('failed')},{times:1})
    })
    const failedDelivery=page.waitForEvent('requestfailed',{predicate:request=>new URL(request.url()).pathname===savePath})
    await page.getByRole('textbox',{name:'Services',exact:true}).fill('Committed before lost delivery');await page.getByRole('button',{name:'Save',exact:true}).click();await bounded(committed)
    expect(await revision()).toBe(2)
    release() // Fail only delivery of the actual committed native response; no Cancel.
    await failedDelivery
    await page.getByRole('alert').filter({hasText:'The save outcome is unknown. Check the latest version before saving again.'}).waitFor()
    expect(await page.getByRole('textbox',{name:'Services',exact:true}).inputValue()).toBe('Committed before lost delivery')
    expect(await page.getByText('Configuration saved.',{exact:true}).count()).toBe(0)
    expect(await page.getByRole('button',{name:'Save',exact:true}).isDisabled()).toBe(true)
    await page.getByRole('textbox',{name:'Services',exact:true}).fill('Draft retained after delivery failure')
    await page.getByRole('button',{name:'Check latest version',exact:true}).click();await page.getByText('Latest saved version: 2',{exact:true}).waitFor()
    expect(await page.getByRole('textbox',{name:'Services',exact:true}).inputValue()).toBe('Draft retained after delivery failure')
    expect(await page.getByRole('button',{name:'Save',exact:true}).isDisabled()).toBe(true)
    expect(await revision()).toBe(2)
    await page.getByRole('button',{name:'Replace draft with latest version',exact:true}).click()
    expect(await page.getByRole('textbox',{name:'Services',exact:true}).inputValue()).toBe('Committed before lost delivery')
    expect(await page.getByRole('button',{name:'Save',exact:true}).isDisabled()).toBe(true)
    await page.getByRole('textbox',{name:'Services',exact:true}).fill('Explicit reconciled save');await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Configuration saved.',{exact:true}).waitFor()
    await page.reload();expect(await page.getByRole('textbox',{name:'Services',exact:true}).inputValue()).toBe('Explicit reconciled save');expect(await revision()).toBe(3)
  }finally{release();await context.close()}
},40000)

test('inbox native cursor loads the remaining owned call shells exactly once',async()=>{
  const {context,page}=await signedIn('sparra-pagination-owner')
  try{
    await page.goto(origin+'/app/entreprise?lang=en');await page.getByRole('button',{name:'Create my workspace'}).click()
    await page.getByRole('textbox',{name:/^Business name/}).waitFor()
    const workspace=(await stores.administrator.query('SELECT id FROM workspace WHERE owner_user_id=(SELECT id FROM "user" WHERE email=$1)',['sparra-pagination-owner@example.test'])).rows[0]
    expect((await stores.administrator.query('SELECT count(*)::int n FROM sparra_call WHERE workspace_id=$1',[workspace.id])).rows[0].n).toBe(0)
    const ids=Array.from({length:52},()=>randomUUID())
    await stores.administrator.query(`INSERT INTO sparra_call(id,workspace_id,deployment_id,provider_call_control_id,admitted_at,retention_until,status) SELECT id,$2::uuid,'fixture','page-'||id::text,clock_timestamp(),clock_timestamp()+interval '30 days','pending' FROM unnest($1::uuid[]) AS id`,[ids,workspace.id])
    await page.goto(origin+'/app?lang=en');await page.getByRole('heading',{name:'Call inbox',exact:true}).waitFor()
    expect(await page.locator('.sparra-inbox > li').count()).toBe(50)
    await page.getByRole('button',{name:'Show more calls',exact:true}).click()
    await expect.poll(()=>page.locator('.sparra-inbox > li').count()).toBe(52)
    expect(await page.getByRole('button',{name:'Show more calls',exact:true}).count()).toBe(0)
    const links=await page.locator('.sparra-inbox-row-heading > a').evaluateAll(elements=>elements.map(element=>element.getAttribute('href')))
    expect(new Set(links).size).toBe(52);expect(new Set(links)).toEqual(new Set(ids.map(id=>`/app/demandes/${id}?lang=en`)));expect(await page.getByText('Partial summary',{exact:true}).count()).toBe(0)
    const visibleId=links[0]!.split('/').at(-1)!.split('?')[0],expiredId=links[1]!.split('/').at(-1)!.split('?')[0]
    await stores.administrator.query("UPDATE sparra_call SET status='closed',ended_at=clock_timestamp(),treated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",[workspace.id,visibleId])
    await stores.administrator.query("UPDATE sparra_call SET admitted_at=admitted_at-interval '31 days',retention_until=retention_until-interval '31 days' WHERE workspace_id=$1 AND id=$2",[workspace.id,expiredId])
    const listPath=await authRpcPath('listRequests'),read=page.waitForRequest(request=>new URL(request.url()).pathname===listPath)
    await page.getByRole('button',{name:'Refresh calls',exact:true}).click()
    expect((await read).method()).toBe('GET')
    await expect.poll(()=>page.locator('.sparra-inbox > li').count()).toBe(50)
    await page.locator('.sparra-inbox > li').filter({has:page.locator(`a[href="/app/demandes/${visibleId}?lang=en"]`)}).getByText('Closed — Treated',{exact:true}).waitFor()
    expect(await page.locator(`a[href="/app/demandes/${expiredId}?lang=en"]`).count()).toBe(0)
    await page.getByRole('button',{name:'Show more calls',exact:true}).click()
    await expect.poll(()=>page.locator('.sparra-inbox > li').count()).toBe(51)
    expect(await page.getByRole('button',{name:'Show more calls',exact:true}).count()).toBe(0)
  }finally{await context.close()}
},20000)

const provenanceCases=[{source:'caller',number:'+33123456789',category:'appointment_to_confirm',summary:'Fictional caller appointment',categoryEn:'Appointment to confirm',categoryFr:'Rendez-vous à confirmer',sourceEn:'Number stated by the caller',sourceFr:'Numéro déclaré par l’appelant'},{source:'provider',number:'+33234567890',category:'declared_urgent',summary:'Fictional provider callback',categoryEn:'Declared urgent request',categoryFr:'Urgence déclarée',sourceEn:'Number supplied by the phone provider',sourceFr:'Numéro fourni par le fournisseur téléphonique'},{source:'missing',number:null,category:'information',summary:'Fictional missing number',categoryEn:'Information request',categoryFr:'Demande d’information',sourceEn:'No number available',sourceFr:'Aucun numéro disponible'}] as const
type ProvenanceCall=(typeof provenanceCases)[number]&{id:string}

async function assertProvenanceOnInboxAndDetail(page:Page,call:ProvenanceCall,locale:'en'|'fr'){
  const row=page.locator('.sparra-inbox > li').filter({hasText:call.summary})
  await row.getByRole('link',{name:call.summary,exact:true}).waitFor()
  await row.getByText(locale==='en'?call.categoryEn:call.categoryFr,{exact:true}).waitFor()
  await row.getByText(locale==='en'?call.sourceEn:call.sourceFr,{exact:true}).waitFor()
  if(call.number)expect(await row.textContent()).toContain(call.number)
  expect(await row.textContent()).toContain(locale==='en'?'Partial summary':'Résumé partiel')
  expect(await row.textContent()).toContain(locale==='en'?'Request and number are unconfirmed.':'Demande et numéro non confirmés.')
  await page.goto(origin+'/app/demandes/'+call.id+'?lang='+locale)
  await page.getByText(locale==='en'?call.categoryEn:call.categoryFr,{exact:true}).waitFor()
  await page.getByText(locale==='en'?call.sourceEn:call.sourceFr,{exact:true}).waitFor()
  if(call.number)expect(await page.locator('.sparra-request-summary').textContent()).toContain(call.number)
  await page.getByText(locale==='en'?'Request and number are unconfirmed.':'Demande et numéro non confirmés.',{exact:true}).waitFor()
  expect(await page.getByRole('heading',{name:locale==='en'?'Partial summary':'Résumé partiel',exact:true}).count()).toBe(1)
  expect(await page.content()).not.toContain('Appointment booked')
  if(locale==='fr'&&call.source==='provider'){
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
    await page.screenshot({path:'.output/test-evidence/sparra/provenance-provider-fr-320.png',fullPage:true})
  }
  await page.goto(origin+'/app?lang='+locale)
}

test('compiled native result DTO shows category and caller/provider/missing callback provenance without confirmation',async()=>{
  const {context,page}=await signedIn('sparra-provenance-owner')
  try{
    await page.goto(origin+'/app/entreprise?lang=en');await page.getByRole('button',{name:'Create my workspace'}).click()
    await page.getByRole('textbox',{name:/^Business name/}).fill('Provenance fixture garage');await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Configuration saved.',{exact:true}).waitFor()
    const workspace=(await stores.administrator.query('SELECT id FROM workspace WHERE owner_user_id=(SELECT id FROM "user" WHERE email=$1)',['sparra-provenance-owner@example.test'])).rows[0]
    const native=await nativeVoiceTurn(crypto)
    const calls:ProvenanceCall[]=[]
    for(const fixture of provenanceCases){
      const id=randomUUID(),inner={...crypto.inner,category:fixture.category,summary:fixture.summary,contact:{...crypto.inner.contact,callback_e164:fixture.number,callback_source:fixture.source}}
      const result={schema_version:1,...crypto.encrypt(JSON.stringify(inner),'result:'+id)}
      await stores.administrator.query(`INSERT INTO sparra_call(id,workspace_id,deployment_id,provider_call_control_id,admitted_at,retention_until,status,configuration_revision,encrypted_turns,encrypted_message_result) VALUES($1::uuid,$2::uuid,'fixture',$1::text,clock_timestamp(),clock_timestamp()+interval '30 days','closing',1,$3,$4)`,[id,workspace.id,{[crypto.turnId]:native},result])
      calls.push({id,...fixture})
    }
    for(const locale of ['en','fr'] as const){
      await page.goto(origin+'/app?lang='+locale)
      expect(await page.locator('.sparra-inbox > li').count()).toBe(3)
      for(const call of calls)await assertProvenanceOnInboxAndDetail(page,call,locale)
    }
  }finally{await context.close()}
},40000)
