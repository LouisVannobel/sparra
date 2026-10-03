import { afterAll, beforeAll, expect, test } from 'vitest'
import { createServer, request as httpRequest } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { chromium, type Browser, type BrowserContext } from 'playwright'
import AxeBuilder from '@axe-core/playwright'
import { Client } from 'pg'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { startWeb, bounded, unusedLoopbackPort } from '../helpers/web-process'
import { authRpcPath, rpcBody } from '../helpers/auth-rpc'
import { cryptoFixture, nativeVoiceTurn } from '../helpers/sparra-crypto-fixture'

let stores: Awaited<ReturnType<typeof startDisposableStores>>, app: ReturnType<typeof startWeb>, proxy: ReturnType<typeof createServer>, browser: Browser
let origin: string, upstreamPort: number, appEnv: ReturnType<typeof environment>, crypto: Awaited<ReturnType<typeof cryptoFixture>>
const foreignCallId=randomUUID()
const fixtureClients=new Map<string,string>()
function environment(){return { NODE_ENV:'test',APP_ORIGIN:origin,DATABASE_URL:stores.runtimeUrl,REDIS_URL:stores.redisUrl,RATE_LIMIT_HMAC_SECRET:stores.hmac,RATE_LIMIT_KEY_ID:'sparra-browser',TRUSTED_PROXY_IPS:'127.0.0.2',AUTH_SECRET:randomBytes(48).toString('hex'),GOOGLE_CLIENT_ID:'fixture.apps.googleusercontent.com',GOOGLE_CLIENT_SECRET:'fixture-only',FIXTURE_GOOGLE_PROTOCOL:'yes',REQUEST_TIMEOUT_MS:'10000',SPARRA_AEAD_KEYRING_PATH:crypto.path }}
beforeAll(async () => {
  await mkdir('.output/test-evidence/sparra', { recursive: true })
  stores = await startDisposableStores(); await stores.migrate(); crypto = await cryptoFixture()
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
  await new Promise<void>(done => proxy.listen(port,'127.0.0.1',done)); browser = await chromium.launch({headless:true})
})
afterAll(async () => {
  const failures: unknown[] = []
  for (const close of [() => browser?.close(), () => proxy && new Promise(done => proxy.close(done)), () => app?.cleanup(), () => crypto?.cleanup(), () => stores?.cleanup()]) { try { await close() } catch (error) { failures.push(error) } }
  if (failures.length) throw new AggregateError(failures,'Sparra browser cleanup failed')
})
async function signedIn(subject:string) {
  const fixtureClient=randomUUID();fixtureClients.set(fixtureClient,`127.0.1.${fixtureClients.size+1}`)
  const context = await browser.newContext({viewport:{width:320,height:720},extraHTTPHeaders:{'x-fixture-client':fixtureClient}}), page = await context.newPage()
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
  page.setDefaultTimeout(8000); page.setDefaultNavigationTimeout(8000)
  await page.route('https://accounts.google.com/o/oauth2/v2/auth*',async route => {
    const target = new URL(route.request().url()),code = await app.registerGoogle(target.href,subject)
    return route.fulfill({status:302,headers:{location:origin+'/api/auth/callback/google?code='+code+'&state='+target.searchParams.get('state')}})
  })
  await page.goto(origin+'/login?lang=en'); await page.getByRole('button',{name:'Continue with Google'}).click(); await page.waitForURL(origin+'/account?lang=en')
  return {context,page}
}
async function rpc(context:BrowserContext,name:Parameters<typeof authRpcPath>[0],data:unknown) {
  return context.request.post(origin+await authRpcPath(name),{headers:{origin,'content-type':'application/json','x-tsr-serverFn':'true'},data:await rpcBody(data)})
}
test('compiled private inbox creates only by POST, saves knowledge across restart, keeps conflicting draft, treats and reloads durable erasure',async()=>{
  const {context,page}=await signedIn('sparra-owner'), errors:string[]=[]
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
    const editorAxe=await new AxeBuilder({page}).analyze();expect(editorAxe.violations).toEqual([])
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
    await page.screenshot({path:'.output/test-evidence/sparra/business-en-320.png',fullPage:true})
    await page.getByRole('textbox',{name:'Services',exact:true}).fill('Vidange sur rendez-vous')
    await page.getByRole('button',{name:'Save',exact:true}).focus();await page.keyboard.press('Enter')
    await page.getByText('Configuration saved.',{exact:true}).waitFor()
    await page.reload();expect(await page.getByRole('textbox',{name:/^Business name/}).inputValue()).toBe('Garage persisted')
    const tab=await context.newPage();await tab.goto(origin+'/app/entreprise?lang=en')
    await page.getByRole('textbox',{name:'Services',exact:true}).fill('Draft retained')
    await tab.getByRole('textbox',{name:'Services',exact:true}).fill('Latest services');await tab.getByRole('button',{name:'Save',exact:true}).click();await tab.getByText('Configuration saved.',{exact:true}).waitFor()
    await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByRole('alert').waitFor()
    expect(await page.getByRole('textbox',{name:'Services',exact:true}).inputValue()).toBe('Draft retained')
    expect(await page.getByRole('alert').textContent()).toContain('configuration changed')
    await page.getByRole('button',{name:'Check latest version',exact:true}).click();await page.getByText('Latest saved version: 2',{exact:true}).waitFor()
    expect(await page.getByRole('textbox',{name:'Services',exact:true}).inputValue()).toBe('Draft retained');await tab.close()
    await app.shutdown();expect(await bounded(app.exit)).toBe(0);await app.cleanup();app=startWeb(appEnv);upstreamPort=(await bounded(app.ready)).port
    await page.reload();expect(await page.getByRole('textbox',{name:'Services',exact:true}).inputValue()).toBe('Latest services')
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
  const {context,page}=await signedIn('sparra-owner'),blocker=new Client({connectionString:stores.directRuntimeUrl})
  await page.goto(origin+'/app/entreprise?lang=en')
  if(await page.getByRole('button',{name:'Create my workspace'}).count()){
    await page.getByRole('button',{name:'Create my workspace'}).click();await page.getByRole('textbox',{name:/^Business name/}).fill('Cancellation fixture');await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Configuration saved.',{exact:true}).waitFor()
  }
  const workspace=(await stores.administrator.query('SELECT id FROM workspace WHERE owner_user_id=(SELECT id FROM "user" WHERE email=$1)',['sparra-owner@example.test'])).rows[0]
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
    const before=(await stores.administrator.query('SELECT max(revision)::int revision FROM sparra_knowledge_revision WHERE workspace_id=$1',[workspace.id])).rows[0].revision
    await lock();await page.getByRole('button',{name:'Save',exact:true}).click()
    await expect.poll(async()=>(await blocked()).rowCount,{timeout:750,interval:10}).toBeGreaterThan(0)
    await page.getByRole('button',{name:'Cancel',exact:true}).click()
    await expect.poll(()=>cancelled.includes(savePath),{timeout:750,interval:10}).toBe(true)
    await page.getByRole('alert').filter({hasText:'The save outcome is unknown.'}).waitFor()
    expect(await page.getByRole('textbox',{name:'Services',exact:true}).inputValue()).toBe('Must not commit')
    expect(await page.getByRole('button',{name:'Save',exact:true}).isDisabled()).toBe(true)
    await page.getByRole('link',{name:'Account',exact:true}).click()
    await blocker.query('ROLLBACK');await page.getByRole('heading',{name:'Your account',exact:true}).waitFor()
    expect((await stores.administrator.query('SELECT max(revision)::int revision FROM sparra_knowledge_revision WHERE workspace_id=$1',[workspace.id])).rows[0].revision).toBe(before)
    await page.goto(origin+'/app/entreprise?lang=en')
    const held=new Promise<void>(done=>{release=done}),committed=new Promise<void>(done=>{
      void page.route('**'+savePath,async route=>{const response=await route.fetch();expect(response.status()).toBe(200);done();await held;await route.fulfill({response}).catch(()=>{})},{times:1})
    })
    await page.getByRole('textbox',{name:'Services',exact:true}).fill('Committed old attempt');await page.getByRole('button',{name:'Save',exact:true}).click();await bounded(committed)
    expect(await page.getByText('Configuration saved.',{exact:true}).count()).toBe(0)
    expect((await stores.administrator.query('SELECT max(revision)::int revision FROM sparra_knowledge_revision WHERE workspace_id=$1',[workspace.id])).rows[0].revision).toBe(before+1)
    await page.getByRole('button',{name:'Cancel',exact:true}).click()
    await page.getByRole('alert').filter({hasText:'The save outcome is unknown. Check the latest version before saving again.'}).waitFor()
    expect(page.url()).toBe(origin+'/app/entreprise?lang=en')
    expect(await page.getByRole('textbox',{name:'Services',exact:true}).inputValue()).toBe('Committed old attempt')
    expect(await page.getByRole('button',{name:'Save',exact:true}).isDisabled()).toBe(true)
    await page.getByRole('textbox',{name:'Services',exact:true}).fill('Retained reconciliation draft')
    release()
    await page.getByRole('button',{name:'Check latest version',exact:true}).click();await page.getByText('Latest saved version: '+(before+1),{exact:true}).waitFor()
    expect(await page.getByText('Configuration saved.',{exact:true}).count()).toBe(0)
    expect(await page.getByRole('textbox',{name:'Services',exact:true}).inputValue()).toBe('Retained reconciliation draft')
    expect(await page.getByRole('button',{name:'Save',exact:true}).isDisabled()).toBe(true)
    expect((await stores.administrator.query('SELECT max(revision)::int revision FROM sparra_knowledge_revision WHERE workspace_id=$1',[workspace.id])).rows[0].revision).toBe(before+1)
    await page.getByRole('button',{name:'Replace draft with latest version',exact:true}).click()
    expect(await page.getByRole('alert').count()).toBe(0)
    expect(await page.getByRole('textbox',{name:'Services',exact:true}).inputValue()).toBe('Committed old attempt')
    await page.getByRole('textbox',{name:'Services',exact:true}).fill('Newest attempt');await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Configuration saved.',{exact:true}).waitFor()
    release();await page.reload();expect(await page.getByRole('textbox',{name:'Services',exact:true}).inputValue()).toBe('Newest attempt')
    expect((await stores.administrator.query('SELECT max(revision)::int revision FROM sparra_knowledge_revision WHERE workspace_id=$1',[workspace.id])).rows[0].revision).toBe(before+2)
  }finally{release();await blocker.query('ROLLBACK').catch(()=>{});await blocker.end();await context.close()}
},60000)

test('saved feedback clears after every editable business field changes',async()=>{
  const {context,page}=await signedIn('sparra-saved-feedback')
  try{
    await page.goto(origin+'/app/entreprise?lang=en');await page.getByRole('button',{name:'Create my workspace'}).click()
    await page.getByRole('textbox',{name:/^Business name/}).fill('Saved feedback fixture')
    const edits=[()=>page.getByRole('textbox',{name:/^Business name/}).fill('Edited feedback fixture'),()=>page.getByRole('combobox',{name:'Sector',exact:true}).click(),...['Opening hours','Services','Prices','Frequently asked questions','Instructions','Transfer number'].map(name=>()=>page.getByRole('textbox',{name,exact:true}).fill(name==='Transfer number'?'+33123456789':'Edited '+name))]
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
    await page.getByRole('button',{name:'Create my workspace'}).click();await page.getByText('Configuration unavailable.',{exact:true}).waitFor()
    expect(await page.getByText('The save outcome is unknown.',{exact:false}).count()).toBe(0)
    expect(await page.getByRole('button',{name:'Check latest version',exact:true}).count()).toBe(0)
    expect(await page.getByRole('button',{name:'Create my workspace'}).isDisabled()).toBe(false)
    await page.getByRole('button',{name:'Create my workspace'}).click()
    await page.getByRole('textbox',{name:/^Business name/}).fill('Delivery fixture');await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Configuration saved.',{exact:true}).waitFor()
    const workspace=(await stores.administrator.query('SELECT id FROM workspace WHERE owner_user_id=(SELECT id FROM "user" WHERE email=$1)',['sparra-save-delivery@example.test'])).rows[0]
    const revision=async()=>(await stores.administrator.query('SELECT max(revision)::int revision FROM sparra_knowledge_revision WHERE workspace_id=$1',[workspace.id])).rows[0].revision
    expect(await revision()).toBe(1)
    // Native validation proves non-commit and permits correcting the same draft.
    const invalidResponse=page.waitForResponse(response=>new URL(response.url()).pathname===savePath)
    await page.getByRole('textbox',{name:/^Business name/}).fill('x'.repeat(81));await page.getByRole('button',{name:'Save',exact:true}).click();expect((await invalidResponse).status()).toBe(400)
    await page.getByText('Check the configuration fields.',{exact:true}).waitFor()
    expect(await page.getByRole('textbox',{name:/^Business name/}).inputValue()).toBe('x'.repeat(81))
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
    expect(await page.getByRole('button',{name:'Save',exact:true}).isDisabled()).toBe(false)
    await page.getByRole('textbox',{name:'Services',exact:true}).fill('Explicit reconciled save');await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Configuration saved.',{exact:true}).waitFor()
    await page.reload();expect(await page.getByRole('textbox',{name:'Services',exact:true}).inputValue()).toBe('Explicit reconciled save');expect(await revision()).toBe(3)
  }finally{release();await context.close()}
},40000)

test('inbox native cursor loads the remaining owned call shells exactly once',async()=>{
  const {context,page}=await signedIn('sparra-owner')
  try{
    const workspace=(await stores.administrator.query('SELECT id FROM workspace WHERE owner_user_id=(SELECT id FROM "user" WHERE email=$1)',['sparra-owner@example.test'])).rows[0]
    const ids=Array.from({length:51},()=>randomUUID())
    await stores.administrator.query(`INSERT INTO sparra_call(id,workspace_id,deployment_id,provider_call_control_id,admitted_at,retention_until,status) SELECT id,$2::uuid,'fixture','page-'||id::text,clock_timestamp(),clock_timestamp()+interval '30 days','pending' FROM unnest($1::uuid[]) AS id`,[ids,workspace.id])
    await page.goto(origin+'/app?lang=en');await page.getByRole('heading',{name:'Call inbox',exact:true}).waitFor()
    expect(await page.locator('.sparra-inbox > li').count()).toBe(50)
    await page.getByRole('button',{name:'Show more calls',exact:true}).click()
    await expect.poll(()=>page.locator('.sparra-inbox > li').count()).toBe(52)
    expect(await page.getByRole('button',{name:'Show more calls',exact:true}).count()).toBe(0)
    const links=await page.locator('.sparra-inbox > li > a').evaluateAll(elements=>elements.map(element=>element.getAttribute('href')))
    expect(new Set(links).size).toBe(52);expect(await page.getByText('Partial summary',{exact:true}).count()).toBe(0)
  }finally{await context.close()}
},20000)

test('compiled native result DTO shows category and caller/provider/missing callback provenance without confirmation',async()=>{
  const {context,page}=await signedIn('sparra-provenance-owner')
  try{
    await page.goto(origin+'/app/entreprise?lang=en');await page.getByRole('button',{name:'Create my workspace'}).click()
    await page.getByRole('textbox',{name:/^Business name/}).fill('Provenance fixture garage');await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Configuration saved.',{exact:true}).waitFor()
    const workspace=(await stores.administrator.query('SELECT id FROM workspace WHERE owner_user_id=(SELECT id FROM "user" WHERE email=$1)',['sparra-provenance-owner@example.test'])).rows[0]
    const native=await nativeVoiceTurn(crypto)
    const cases=[{source:'caller',number:'+33123456789',category:'appointment_to_confirm',summary:'Fictional caller appointment',categoryEn:'Appointment to confirm',categoryFr:'Rendez-vous à confirmer',sourceEn:'Number stated by the caller',sourceFr:'Numéro déclaré par l’appelant'},{source:'provider',number:'+33234567890',category:'declared_urgent',summary:'Fictional provider callback',categoryEn:'Declared urgent request',categoryFr:'Urgence déclarée',sourceEn:'Number supplied by the phone provider',sourceFr:'Numéro fourni par le fournisseur téléphonique'},{source:'missing',number:null,category:'information',summary:'Fictional missing number',categoryEn:'Information request',categoryFr:'Demande d’information',sourceEn:'No number available',sourceFr:'Aucun numéro disponible'}] as const
    const calls=[]
    for(const fixture of cases){
      const id=randomUUID(),inner={...crypto.inner,category:fixture.category,summary:fixture.summary,contact:{...crypto.inner.contact,callback_e164:fixture.number,callback_source:fixture.source}}
      const result={schema_version:1,...crypto.encrypt(JSON.stringify(inner),'result:'+id)}
      await stores.administrator.query(`INSERT INTO sparra_call(id,workspace_id,deployment_id,provider_call_control_id,admitted_at,retention_until,status,configuration_revision,encrypted_turns,encrypted_message_result) VALUES($1::uuid,$2::uuid,'fixture',$1::text,clock_timestamp(),clock_timestamp()+interval '30 days','closing',1,$3,$4)`,[id,workspace.id,{[crypto.turnId]:native},result])
      calls.push({id,...fixture})
    }
    for(const locale of ['en','fr'] as const){
      await page.goto(origin+'/app?lang='+locale)
      expect(await page.locator('.sparra-inbox > li').count()).toBe(3)
      for(const call of calls){
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
    }
  }finally{await context.close()}
},40000)
