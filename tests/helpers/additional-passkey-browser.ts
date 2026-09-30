import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { AxeBuilder } from '@axe-core/playwright'
import { expect } from 'vitest'
import type { BrowserContext, CDPSession, Page, Route } from 'playwright'
import { authRpcPath } from './auth-rpc'

export async function assertCompiledAdditionalPasskey(input: {
  origin: string; page: Page; context: BrowserContext; cdp: CDPSession; authenticatorId: string
  stores: { administrator: { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> } }
  evidence: Record<string, unknown>; setStage(value: string): void; newContext(): Promise<BrowserContext>
  scanRuntime(values: string[]): boolean; expectedConsole(active: boolean, path: string): void; selectClient(index: number): void
}) {
  const { origin,page,context,cdp,stores,evidence,selectClient }=input
  let currentStage='additional setup'
  const setStage=(value:string)=>{currentStage=value;input.setStage(value)}
  const beginPath=await authRpcPath('beginAdditionalPasskey'),authorizePath=await authRpcPath('authorizeAdditionalPasskey'),finishPath=await authRpcPath('finishAdditionalPasskey')
  const accountPath=await authRpcPath('getAccount')
  const workspaceReadPath=await authRpcPath('getWorkspace'),workspaceEnsurePath=await authRpcPath('ensurePersonalWorkspace')
  const workspaceDiagnostic={ensureRequests:0,readRequests:0,ensureStatuses:[] as number[],readStatuses:[] as number[],elapsedMs:0,
    rowCount:null as number|null,uiPending:false,uiAlert:false,diagnosticAvailable:true}
  evidence.additionalWorkspacePrerequisite=workspaceDiagnostic
  let activeAuthenticator=input.authenticatorId,client=110,captureFailures=0
  const counts={begin:0,authorize:0,finish:0},sensitive=new Set<string>(),captures:Promise<void>[]=[]
  const statuses={begin:[] as number[],authorize:[] as number[],finish:[] as number[]}
  const finishFieldPresence:{publicKeyAlgorithm:boolean;publicKey:boolean;authenticatorData:boolean}[]=[]
  evidence.additionalWire={statuses,finishFieldPresence}
  const captureDiagnostics:{count:number;expectedStatusOnly:number;unexpectedFailures:number;cases:{operation:string;status:number;phase:string;transport:string;observation:string}[]}={count:0,expectedStatusOnly:0,unexpectedFailures:0,cases:[]}
  const successfulBodies={begin:0,authorize:0}
  const plannedRefusals=new Set(['additional pending navigation and observable workspace change',
    'additional invisible HttpOnly cookie removal refuses next command','additional invisible session revocation refuses next command'])
  evidence.additionalCaptureFailures=captureDiagnostics
  const retain=(text:string)=>{for(const match of text.matchAll(/[A-Za-z0-9_-]{32,}/g))sensitive.add(match[0])}
  page.on('request',request=>{
    const path=new URL(request.url()).pathname
    if(path===workspaceReadPath)workspaceDiagnostic.readRequests++
    if(path===workspaceEnsurePath)workspaceDiagnostic.ensureRequests++
    if(path===beginPath)counts.begin++
    if(path===authorizePath)counts.authorize++
    if(path===finishPath){
      counts.finish++
      const body=request.postData()??''
      finishFieldPresence.push({publicKeyAlgorithm:body.includes('"publicKeyAlgorithm"'),publicKey:body.includes('"publicKey"'),authenticatorData:body.includes('"authenticatorData"')})
    }
    if(path===authorizePath||path===finishPath){const body=request.postData();if(body)retain(body)}
  })
  page.on('response',response=>{
    const path=new URL(response.url()).pathname
    if(path===workspaceReadPath)workspaceDiagnostic.readStatuses.push(response.status())
    if(path===workspaceEnsurePath)workspaceDiagnostic.ensureStatuses.push(response.status())
    if(path===beginPath)statuses.begin.push(response.status())
    if(path===authorizePath)statuses.authorize.push(response.status())
    if(path===finishPath)statuses.finish.push(response.status())
    if(path===beginPath||path===authorizePath){
      const phase=currentStage.slice(0,120),operation=path===beginPath?'begin':'authorize'
      captures.push(response.text().then(body=>{retain(body);if(response.status()===200)successfulBodies[operation]++},()=>{
        captureDiagnostics.count++
        const code=response.request().failure()?.errorText
        const transport=code==='net::ERR_ABORTED'?'aborted'
          :code==='net::ERR_CONNECTION_RESET'||code==='net::ERR_CONNECTION_CLOSED'?'connection'
            :code==='net::ERR_TIMED_OUT'?'timeout':code==='net::ERR_CERT_AUTHORITY_INVALID'?'certificate'
              :code===undefined?'body-unavailable':'unclassified-network'
        const expected=operation==='authorize'&&response.status()===401&&transport==='aborted'&&plannedRefusals.has(phase)
        if(expected)captureDiagnostics.expectedStatusOnly++
        else {captureFailures++;captureDiagnostics.unexpectedFailures++}
        if(captureDiagnostics.cases.length<16)captureDiagnostics.cases.push({operation,status:response.status(),phase,transport,
          observation:expected?'expected-status-only':'unexpected-capture-failure'})
      }))
    }
  })
  const fingerprint=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const sessionSnapshot=async()=>fingerprint((await stores.administrator.query('SELECT * FROM session ORDER BY id')).rows)
  async function drain(){await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))))}
  const action=(label:string)=>page.getByRole('button',{name:label,exact:true})
  async function freshAuthenticator(){
    await cdp.send('WebAuthn.removeVirtualAuthenticator',{authenticatorId:activeAuthenticator})
    const added=await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}})
    activeAuthenticator=added.authenticatorId
  }
  async function storedCredentials(){return (await cdp.send('WebAuthn.getCredentials',{authenticatorId:activeAuthenticator})).credentials}
  async function restoreAuthenticator(credentials:Awaited<ReturnType<typeof storedCredentials>>){
    await freshAuthenticator()
    for(const credential of credentials)await cdp.send('WebAuthn.addCredential',{authenticatorId:activeAuthenticator,credential})
  }
  async function prepare(){selectClient(client++);await action('Add a passkey').click();await action('Verify existing key').waitFor()}
  async function prove(){await action('Verify existing key').click();await action('Create new key').waitFor()}
  async function cancelToIdle(){await action('Cancel').click();await action('Add a passkey').waitFor()}
  async function reload(){const response=await page.goto(origin+'/account?lang=en');await action('Add a passkey').waitFor();return response}
  async function witness(){return page.evaluate(()=>{
    const state=Reflect.get(window,'__additionalLifecycleWitness')
    if(!state)throw new Error('Owned lifecycle observer missing')
    return {documentId:String(state.documentId),nativePageshowSeen:state.nativePageshowSeen===true,persisted:state.persisted===true,
      panelRegistrations:Number(state.panelRegistrations),nativePanelHides:Number(state.nativePanelHides),
      controlledPanelHides:Number(state.controlledPanelHides),witnessFailure:state.witnessFailure===true}
  })}
  async function deliveredToPanel(documentId:string){return page.evaluate(id=>{
    const value:unknown=JSON.parse(sessionStorage.getItem('__additionalNativeDepartures')??'[]')
    return Array.isArray(value)&&value.includes(id)
  },documentId)}
  async function deferred(kind:'begin'|'authorize'|'finish'|'finish500'|'assertion'|'registration'|'decode'){
    await page.evaluate(({kind,beginPath,authorizePath,finishPath})=>{
      const fetchOriginal=window.fetch,getOriginal=navigator.credentials.get,createOriginal=navigator.credentials.create
      let release:()=>void=()=>{},paused=false,finished=false,armed=true,nativeStatus=0,returnedStatus=0
      const gate=new Promise<void>(resolve=>{release=resolve})
      const wait=async()=>{paused=true;await gate;finished=true}
      const path=kind==='begin'?beginPath:kind==='authorize'?authorizePath:finishPath
      if(kind==='assertion')navigator.credentials.get=async options=>{const result=await getOriginal.call(navigator.credentials,options);await wait();return result}
      else if(kind==='registration')navigator.credentials.create=async options=>{const result=await createOriginal.call(navigator.credentials,options);await wait();return result}
      else window.fetch=async(resource,init)=>{
        const target=new URL(resource instanceof Request?resource.url:String(resource),location.href).pathname
        if(!armed||target!==path)return fetchOriginal(resource,init)
        armed=false
        const response=await fetchOriginal(resource,init?{...init,signal:undefined}:init)
        nativeStatus=response.status
        if(kind==='decode'){
          const json=response.json.bind(response)
          response.json=async()=>{const value:unknown=await json();await wait();return value}
        }else await wait()
        if(kind==='finish500'){
          returnedStatus=500
          return new Response('Controlled post-commit failure',{status:500,headers:{'x-tss-raw':'true','cache-control':'no-store'}})
        }
        returnedStatus=response.status
        return response
      }
      Reflect.set(window,'__additionalDeferred',{state:()=>({paused,finished,nativeStatus,returnedStatus}),release,restore:()=>{release();window.fetch=fetchOriginal;navigator.credentials.get=getOriginal;navigator.credentials.create=createOriginal}})
    },{kind,beginPath,authorizePath,finishPath})
  }
  const paused=()=>page.waitForFunction(()=>Reflect.get(window,'__additionalDeferred').state().paused)
  async function release(){await page.evaluate(()=>Reflect.get(window,'__additionalDeferred').release());await page.waitForFunction(()=>Reflect.get(window,'__additionalDeferred').state().finished);await drain()}
  async function restore(){await page.evaluate(()=>Reflect.get(window,'__additionalDeferred')?.restore())}

  setStage('additional existing personal workspace prerequisite')
  const workspaceStarted=Date.now()
  let releaseScripts=()=>{},heldScriptRequests=0,scriptFailures=0
  const scriptsReady=new Promise<void>(resolve=>{releaseScripts=resolve}),scriptCalls:Promise<void>[]=[]
  const holdScript=(route:Route)=>{
    const call=(async()=>{
      heldScriptRequests++
      await scriptsReady
      try{await route.continue()}catch{scriptFailures++}
    })()
    scriptCalls.push(call);return call
  }
  await page.route('**/*.js',holdScript)
  try{
    await page.goto(origin+'/workspace?lang=en',{waitUntil:'commit'})
    await action('Create my workspace').waitFor()
    await expect.poll(()=>heldScriptRequests).toBeGreaterThan(0)
    const preHydration={disabled:await action('Create my workspace').isDisabled(),
      realEscapeLink:await page.getByRole('link',{name:'Back to account',exact:true}).getAttribute('href')==='/account?lang=en',
      ensureRequests:workspaceDiagnostic.ensureRequests}
    evidence.additionalPreHydration=preHydration
    expect(preHydration).toEqual({disabled:true,realEscapeLink:true,ensureRequests:0})
    releaseScripts()
    await action('Create my workspace').click()
    await page.getByRole('textbox',{name:/^Display name/}).waitFor()
    expect(workspaceDiagnostic.ensureRequests).toBe(1)
    evidence.additionalHydratedFirstClick={worked:true,requests:workspaceDiagnostic.ensureRequests,heldScriptRequests}
  }finally{
    releaseScripts();await Promise.all(scriptCalls);await page.unroute('**/*.js',holdScript)
    workspaceDiagnostic.elapsedMs=Date.now()-workspaceStarted
    try{
      workspaceDiagnostic.rowCount=Number((await stores.administrator.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n)
      workspaceDiagnostic.uiPending=await page.getByRole('status').filter({hasText:'Saving…'}).isVisible()
      workspaceDiagnostic.uiAlert=await page.getByRole('alert').isVisible()
    }catch{workspaceDiagnostic.diagnosticAvailable=false}
    if(scriptFailures)throw new Error('Owned held-script route failed')
  }
  await reload()
  const original=(await stores.administrator.query('SELECT user_id,credential_id FROM passkey')).rows[0]
  expect(Boolean(original?.user_id&&original.credential_id)).toBe(true)
  const baseline=await sessionSnapshot(),sessionCookie=(await context.cookies()).find(value=>value.name.includes('session_token'))
  if(sessionCookie)sensitive.add(sessionCookie.value)
  setStage('two explicit additional ceremonies with ready options')
  selectClient(client++)
  await action('Add a passkey').click({clickCount:2})
  await action('Verify existing key').waitFor()
  expect(counts).toEqual({begin:1,authorize:0,finish:0})
  await action('Verify existing key').focus();await page.keyboard.press('Enter');await action('Create new key').waitFor()
  expect(counts).toEqual({begin:1,authorize:1,finish:0})
  expect(await sessionSnapshot()===baseline).toBe(true)
  expect((await stores.administrator.query('SELECT counter FROM passkey WHERE user_id=$1',[original.user_id])).rows[0].counter).toBeGreaterThanOrEqual(0)
  await freshAuthenticator()
  await action('Create new key').focus();await page.keyboard.press('Enter')
  await page.getByRole('status').filter({hasText:'Passkey added.'}).waitFor()
  expect(counts).toEqual({begin:1,authorize:1,finish:1})
  expect(statuses.finish).toEqual([200])
  expect(finishFieldPresence).toEqual([{publicKeyAlgorithm:false,publicKey:false,authenticatorData:false}])
  expect(await sessionSnapshot()===baseline).toBe(true)
  expect((await context.cookies()).find(value=>value.name.includes('session_token'))?.value===sessionCookie?.value).toBe(true)
  const persisted=(await stores.administrator.query('SELECT credential_id,user_id FROM passkey ORDER BY id')).rows
  expect({count:persisted.length,sameUser:persisted.every(row=>row.user_id===original.user_id),different: new Set(persisted.map(row=>row.credential_id)).size===2})
    .toEqual({count:2,sameUser:true,different:true})
  const newNative=(await cdp.send('WebAuthn.getCredentials',{authenticatorId:activeAuthenticator})).credentials
  expect(newNative.length).toBe(1)
  const newCredentialId=Buffer.from(newNative[0].credentialId,'base64').toString('base64url')
  expect(persisted.some(row=>row.credential_id===newCredentialId&&row.credential_id!==original.credential_id)).toBe(true)
  setStage('additional new credential logout and Task9A login')
  await action('Sign out').click();await page.waitForURL(origin+'/login?lang=en')
  selectClient(client++);await action('Sign in with a passkey').click();await page.waitForURL(origin+'/account?lang=en');await action('Add a passkey').waitFor()
  const returned=(await stores.administrator.query("SELECT user_id,auth_method FROM session")).rows
  expect({count:returned.length,sameUser:returned[0]?.user_id===original.user_id,passkey:returned[0]?.auth_method==='passkey'})
    .toEqual({count:1,sameUser:true,passkey:true})
  evidence.additionalNewKeyLogin={sameUser:true,differentCredential:true,sessionUnchangedUntilLogout:true}
  const currentSessionCookie=(await context.cookies()).find(value=>value.name.includes('session_token'))
  if(!currentSessionCookie)throw new Error('Owned current session missing')
  sensitive.add(currentSessionCookie.value)

  setStage('additional committed finish raw500 requires reconciliation')
  const priorCommitIntentIds=new Set((await stores.administrator.query('SELECT id FROM additional_passkey_intent WHERE user_id=$1',[original.user_id])).rows.map(row=>row.id))
  const priorCommitKeys=new Set((await stores.administrator.query('SELECT id FROM passkey WHERE user_id=$1',[original.user_id])).rows.map(row=>row.id))
  const priorCommitSession=await sessionSnapshot()
  await prepare();await prove();await freshAuthenticator();await deferred('finish500')
  const beforeCommitReply={...counts}
  try{
    await action('Create new key').click();await paused()
    const intentRows=(await stores.administrator.query('SELECT id,phase FROM additional_passkey_intent WHERE user_id=$1',[original.user_id])).rows.filter(row=>!priorCommitIntentIds.has(row.id))
    const keyRows=(await stores.administrator.query('SELECT id,credential_id FROM passkey WHERE user_id=$1',[original.user_id])).rows.filter(row=>!priorCommitKeys.has(row.id))
    const authenticatorKeys=await storedCredentials()
    const createdCredential=authenticatorKeys.length===1?Buffer.from(authenticatorKeys[0].credentialId,'base64').toString('base64url'):undefined
    const committed={nativeStatus200:await page.evaluate(()=>Reflect.get(window,'__additionalDeferred').state().nativeStatus===200),
      oneConsumedIntent:intentRows.length===1&&intentRows[0].phase==='CONSUMED',oneNewStoredKey:keyRows.length===1&&keyRows[0].credential_id===createdCredential,
      sessionUnchanged:await sessionSnapshot()===priorCommitSession}
    evidence.additionalFinish500Committed=committed
    expect(committed).toEqual({nativeStatus200:true,oneConsumedIntent:true,oneNewStoredKey:true,sessionUnchanged:true})
    await release()
    const result={returned500:await page.evaluate(()=>Reflect.get(window,'__additionalDeferred').state().returnedStatus===500),
      unconfirmedVisible:await page.getByRole('status').filter({hasText:'addition may have completed'}).isVisible(),
      failureVisible:await page.getByRole('alert').filter({hasText:'attempt failed'}).isVisible(),
      addedVisible:await page.getByRole('status').filter({hasText:'Passkey added.'}).isVisible(),
      restartVisible:await action('Restart').isVisible(),addVisible:await action('Add a passkey').isVisible(),refreshVisible:await action('Refresh key list').isVisible(),
      finishCalls:counts.finish-beforeCommitReply.finish,beginCalls:counts.begin-beforeCommitReply.begin,authorizeCalls:counts.authorize-beforeCommitReply.authorize}
    evidence.additionalFinish500Outcome=result
    expect(result).toEqual({returned500:true,unconfirmedVisible:true,failureVisible:false,addedVisible:false,restartVisible:false,addVisible:false,refreshVisible:true,
      finishCalls:1,beginCalls:0,authorizeCalls:0})
    await action('Refresh key list').click();await action('Add a passkey').waitFor()
    const listed=await page.locator('.additional-passkey li').count()
    const reconciled={listedCommittedKey:listed===priorCommitKeys.size+1,normalActionsRestored:await action('Add a passkey').isVisible(),
      finishCalls:counts.finish-beforeCommitReply.finish,beginCalls:counts.begin-beforeCommitReply.begin,authorizeCalls:counts.authorize-beforeCommitReply.authorize}
    evidence.additionalFinish500Reconciled=reconciled
    expect(reconciled).toEqual({listedCommittedKey:true,normalActionsRestored:true,finishCalls:1,beginCalls:0,authorizeCalls:0})
  }finally{await restore()}

  setStage('additional mounted repeated pagehide preserves unconfirmed')
  await prepare();await prove();await freshAuthenticator();await deferred('finish')
  const beforeRepeatedHide={...counts}
  await page.evaluate(()=>Reflect.set(window,'__additionalSameMountedDocument',document))
  try{
    await action('Create new key').click();await paused();await action('Cancel').click()
    const uncertain=page.getByRole('status').filter({hasText:'addition may have completed'})
    await uncertain.waitFor()
    setStage('additional unconfirmed failed account refresh retains outcome')
    await page.evaluate(accountPath=>{
      const previous=window.fetch
      let calls=0,raw=false
      window.fetch=async(resource,init)=>{
        const url=new URL(resource instanceof Request?resource.url:String(resource),location.href)
        if(url.origin===location.origin&&url.pathname===accountPath){
          calls++
          if(raw)return new Response('Controlled account refusal',{status:503,headers:{'x-tss-raw':'true'}})
          throw new Error('Owned account refresh unavailable')
        }
        return previous(resource,init)
      }
      Reflect.set(window,'__additionalRefreshFailure',{calls:()=>calls,raw:()=>{raw=true},restore:()=>{window.fetch=previous}})
    },accountPath)
    const refreshFailures:unknown[]=[];evidence.additionalUnconfirmedRefreshFailures=refreshFailures
    try{
      for(const mode of ['network','raw503'] as const){
        if(mode==='raw503')await page.evaluate(()=>Reflect.get(window,'__additionalRefreshFailure').raw())
        await action('Refresh key list').click()
        await page.waitForFunction(expected=>Reflect.get(window,'__additionalRefreshFailure').calls()===expected,mode==='network'?1:2)
        await page.getByRole('alert').filter({hasText:'key list could not be refreshed'}).waitFor();await drain()
        const result={mode,accountRefreshCalls:await page.evaluate(()=>Reflect.get(window,'__additionalRefreshFailure').calls()),
        sameMountedDocument:await page.evaluate(()=>Reflect.get(window,'__additionalSameMountedDocument')===document),
        unconfirmedVisible:await uncertain.isVisible(),addedVisible:await page.getByRole('status').filter({hasText:'Passkey added.'}).isVisible(),
        restartVisible:await action('Restart').isVisible(),addVisible:await action('Add a passkey').isVisible(),
        refreshVisible:await action('Refresh key list').isVisible(),finishCalls:counts.finish-beforeRepeatedHide.finish,
        beginCalls:counts.begin-beforeRepeatedHide.begin,authorizeCalls:counts.authorize-beforeRepeatedHide.authorize,
        finishStillHeld:await page.evaluate(()=>!Reflect.get(window,'__additionalDeferred').state().finished)}
        refreshFailures.push(result)
        expect(result).toEqual({mode,accountRefreshCalls:mode==='network'?1:2,sameMountedDocument:true,unconfirmedVisible:true,addedVisible:false,
          restartVisible:false,addVisible:false,refreshVisible:true,finishCalls:1,beginCalls:0,authorizeCalls:0,finishStillHeld:true})
      }
    }finally{await page.evaluate(()=>Reflect.get(window,'__additionalRefreshFailure')?.restore())}
    setStage('additional mounted repeated pagehide preserves unconfirmed')
    await page.evaluate(()=>{
      window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}))
      window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}))
    })
    await drain();await release()
    const result={controlledEvent:true,sameMountedDocument:await page.evaluate(()=>Reflect.get(window,'__additionalSameMountedDocument')===document),
      unconfirmedVisible:await uncertain.isVisible(),addedVisible:await page.getByRole('status').filter({hasText:'Passkey added.'}).isVisible(),
      addVisible:await action('Add a passkey').isVisible(),refreshVisible:await action('Refresh key list').isVisible(),
      finishCalls:counts.finish-beforeRepeatedHide.finish,beginCalls:counts.begin-beforeRepeatedHide.begin}
    evidence.additionalRepeatedHide=result
    expect(result).toEqual({controlledEvent:true,sameMountedDocument:true,unconfirmedVisible:true,addedVisible:false,addVisible:false,refreshVisible:true,finishCalls:1,beginCalls:0})
    await action('Refresh key list').click();await action('Add a passkey').waitFor()
    evidence.additionalRefreshRecovered={normalActionsRestored:true,refreshFailureCleared:!await page.getByRole('alert').filter({hasText:'key list could not be refreshed'}).isVisible()}
    expect(evidence.additionalRefreshRecovered).toEqual({normalActionsRestored:true,refreshFailureCleared:true})
  }finally{await restore()}

  const lifecycle:unknown[]=[];evidence.additionalLifecycle=lifecycle
  const allowedCacheReasons=new Set(['CacheControlNoStore','CacheControlNoStoreCookieModified','CacheControlNoStoreHTTPOnlyCookieModified',
    'JsNetworkRequestReceivedCacheControlNoStoreResource','ContentWebAuthenticationAPI','RelatedActiveContentsExist',
    'OutstandingNetworkRequestFetch','OutstandingNetworkRequestXHR','NetworkRequestDatapipeDrainedAsBytesConsumer',
    'UnloadHandler','UnloadHandlerExistsInMainFrame','CacheControlNoStoreDeviceBoundSessionTerminated'])
  setStage('additional genuine idle authenticated account restoration')
  const idleResponse=await reload()
  await expect.poll(()=>action('Add a passkey').isEnabled()).toBe(true)
  const idleBefore=await witness(),idleCounts={...counts}
  expect(idleBefore.panelRegistrations).toBeGreaterThan(0)
  const idleNoStore=(await idleResponse?.headerValue('cache-control'))?.includes('no-store')===true
  const idleDeparture={addEnabled:await action('Add a passkey').isEnabled(),panelRegistrations:idleBefore.panelRegistrations}
  const idleCacheReasons:string[]=[]
  const idleCacheFailure=(event:{notRestoredExplanations?:{reason:string}[]})=>{
    for(const value of event.notRestoredExplanations??[])if(idleCacheReasons.length<16)idleCacheReasons.push(allowedCacheReasons.has(value.reason)?value.reason:'unclassified')
  }
  await cdp.send('Page.enable');cdp.on('Page.backForwardCacheNotUsed',idleCacheFailure)
  try{
    await page.goto(origin+'/account?lang=fr');await page.getByRole('heading',{name:'Votre compte',exact:true}).waitFor()
    await page.evaluate(()=>history.back());await page.waitForFunction(()=>location.pathname==='/account'&&location.search==='?lang=en')
    await action('Add a passkey').waitFor()
  }finally{cdp.off('Page.backForwardCacheNotUsed',idleCacheFailure)}
  const idleAfter=await witness()
  const idleDiagnostic=await page.evaluate(()=>{
    const navigation=performance.getEntriesByType('navigation')[0] as (PerformanceNavigationTiming&{
      notRestoredReasons?:{children:unknown[];reasons:{reason:string}[]|null}|null
    })|undefined
    const reasons=navigation?.notRestoredReasons
    const allowed=new Set(['unload-listener','unload-handler','response-cache-control-no-store','related-active-contents','web-authentication-request','masked'])
    return {navigationType:navigation?.type,reasonObjectPresent:reasons!=null,childCount:reasons?.children.length??0,
      reasons:reasons?.reasons?.slice(0,16).map(value=>allowed.has(value.reason)?value.reason:'unclassified')??[]}
  })
  evidence.additionalIdleRestoreDiagnostic={...idleDiagnostic,cdpReasons:idleCacheReasons,departure:idleDeparture}
  evidence.additionalIdleRestore={persisted:idleAfter.persisted,nativePageshowSeen:idleAfter.nativePageshowSeen,
    sameDocument:idleAfter.documentId===idleBefore.documentId,noStore:idleNoStore,nativePanelHideDelivered:await deliveredToPanel(idleBefore.documentId)}
  expect(counts).toEqual(idleCounts)

  setStage('additional controlled mounted ready-pagehide invalidation')
  await reload();await prepare()
  const readyWitness=await witness(),readyCounts={...counts}
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));await drain()
  await action('Add a passkey').waitFor()
  const readyAfter=await witness()
  expect({sameDocument:readyAfter.documentId===readyWitness.documentId,handlerDelivered:readyAfter.controlledPanelHides>readyWitness.controlledPanelHides,
    oldActionPresent:await action('Verify existing key').count()}).toEqual({sameDocument:true,handlerDelivered:true,oldActionPresent:0})
  expect(counts).toEqual(readyCounts)
  lifecycle.push({phase:'controlled-ready-pagehide',sameDocument:true,handlerDelivered:true,oldActionsRemoved:true})
  for(const kind of ['begin','assertion','authorize'] as const){
    setStage('additional late '+kind+' cannot replace restart')
    await reload();selectClient(client++)
    if(kind!=='begin')await prepare()
    await deferred(kind)
    const before={...counts}
    const priorIntentIds=new Set((await stores.administrator.query('SELECT id FROM additional_passkey_intent WHERE user_id=$1',[original.user_id])).rows.map(row=>row.id))
    let abandonedIntent:unknown,replacementIntent:unknown
    try{
      await action(kind==='begin'?'Add a passkey':'Verify existing key').click();await paused()
      if(kind==='begin'){
        const created=(await stores.administrator.query('SELECT id FROM additional_passkey_intent WHERE user_id=$1',[original.user_id])).rows.filter(row=>!priorIntentIds.has(row.id))
        expect(created.length).toBe(1);abandonedIntent=created[0].id
        const prior=await witness()
        await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));await drain();await action('Add a passkey').waitFor()
        const after=await witness()
        expect(after.documentId===prior.documentId&&after.controlledPanelHides>prior.controlledPanelHides).toBe(true)
      }else await cancelToIdle()
      await prepare()
      if(kind==='begin'){
        const created=(await stores.administrator.query('SELECT id FROM additional_passkey_intent WHERE user_id=$1',[original.user_id])).rows.filter(row=>!priorIntentIds.has(row.id)&&row.id!==abandonedIntent)
        expect(created.length).toBe(1);replacementIntent=created[0].id
      }
      const readyBefore={...counts};await release()
      expect(await action('Verify existing key').isVisible()).toBe(true)
      expect(counts.finish).toBe(before.finish)
      expect(counts).toEqual(readyBefore)
      if(kind==='begin'){
        await prove()
        const rows=(await stores.administrator.query('SELECT id,phase,authorizing_key_id FROM additional_passkey_intent WHERE user_id=$1 AND id IN ($2,$3)',[original.user_id,abandonedIntent,replacementIntent])).rows
        const old=rows.find(row=>row.id===abandonedIntent),replacement=rows.find(row=>row.id===replacementIntent)
        const result={distinct:abandonedIntent!==replacementIntent,oldStillChallenge:old?.phase==='CHALLENGE'&&old.authorizing_key_id===null,
          replacementAuthorized:replacement?.phase==='AUTHORIZED'&&typeof replacement.authorizing_key_id==='string',
          authorizeCalls:counts.authorize-readyBefore.authorize,finishCalls:counts.finish-readyBefore.finish}
        evidence.additionalLateBeginReplacement=result
        expect(result).toEqual({distinct:true,oldStillChallenge:true,replacementAuthorized:true,authorizeCalls:1,finishCalls:0})
      }
      lifecycle.push({phase:kind,lateIgnored:true,automaticFinish:0,controlledPagehide:kind==='begin'})
    }finally{await restore()}
    await cancelToIdle()
  }
  setStage('additional late real registration cannot submit finish')
  await prepare();await prove()
  const saved=(await cdp.send('WebAuthn.getCredentials',{authenticatorId:activeAuthenticator})).credentials
  await freshAuthenticator();await deferred('registration')
  const beforeRegistration=counts.finish
  try{
    await action('Create new key').click();await paused();await cancelToIdle();await release()
    expect(counts.finish).toBe(beforeRegistration);expect(await action('Add a passkey').isVisible()).toBe(true)
    lifecycle.push({phase:'registration',lateIgnored:true,automaticFinish:0})
  }finally{await restore();await restoreAuthenticator(saved)}

  setStage('additional pending navigation and observable workspace change')
  await prepare()
  const beforeLeave={...counts}
  await page.getByRole('link',{name:'My personal workspace',exact:true}).click()
  await page.getByRole('textbox',{name:/^Display name/}).waitFor();await reload()
  expect(counts).toEqual(beforeLeave);expect(await action('Add a passkey').isVisible()).toBe(true)
  await prepare()
  await stores.administrator.query("UPDATE workspace SET lifecycle='deleting' WHERE owner_user_id=$1",[original.user_id])
  const beforeRefusal=counts.finish
  input.expectedConsole(true,authorizePath)
  try{await action('Verify existing key').click();await page.getByRole('alert').filter({hasText:'no longer authorized'}).waitFor()}
  finally{input.expectedConsole(false,authorizePath)}
  expect(counts.finish).toBe(beforeRefusal)
  await action('Refresh key list').click();await page.getByRole('link').filter({hasText:'Open your personal workspace before adding a key.'}).waitFor()
  await stores.administrator.query("UPDATE workspace SET lifecycle='active' WHERE owner_user_id=$1",[original.user_id]);await reload()
  lifecycle.push({phase:'navigation-workspace',invalidated:true,invisibleChangeRefusedAtNextCommand:true})

  setStage('additional observable account projection invalidates ready attempt')
  await prepare()
  const beforeProjection={...counts}
  await page.evaluate(({accountPath,userId})=>{
    const nativeFetch=window.fetch
    window.fetch=async(resource,init)=>{
      const target=new URL(resource instanceof Request?resource.url:String(resource),location.href)
      if(target.origin!==location.origin||target.pathname!==accountPath)return nativeFetch(resource,init)
      try{
        const response=await nativeFetch(resource,init),body=await response.text()
        return new Response(body.replaceAll(userId,'controlled-visible-principal'),{
          status:response.status,statusText:response.statusText,headers:response.headers,
        })
      }catch{throw new Error('Controlled account projection unavailable')}
    }
    Reflect.set(window,'__additionalProjectionRestore',()=>{window.fetch=nativeFetch})
  },{accountPath,userId:String(original.user_id)})
  try{
    await page.evaluate(()=>{const router=window.__TSR_ROUTER__;if(!router)throw new Error('Owned router unavailable');return router.invalidate({sync:true})});await drain()
    await action('Add a passkey').waitFor();expect(await action('Verify existing key').count()).toBe(0)
    expect(counts).toEqual(beforeProjection)
  }finally{await page.evaluate(()=>Reflect.get(window,'__additionalProjectionRestore')?.());await reload()}
  await prepare()
  await stores.administrator.query("UPDATE workspace SET lifecycle='deleting' WHERE owner_user_id=$1",[original.user_id])
  const beforeWorkspace={...counts}
  try{
    await page.evaluate(()=>{const router=window.__TSR_ROUTER__;if(!router)throw new Error('Owned router unavailable');return router.invalidate({sync:true})});await drain()
    await page.getByRole('link').filter({hasText:'Open your personal workspace before adding a key.'}).waitFor()
    expect(await action('Verify existing key').count()).toBe(0);expect(counts).toEqual(beforeWorkspace)
  }finally{await stores.administrator.query("UPDATE workspace SET lifecycle='active' WHERE owner_user_id=$1",[original.user_id]);await reload()}
  lifecycle.push({phase:'observable-principal-workspace',controlledAccountProjection:true,realWorkspaceState:true,invalidatedBeforeMutation:true})

  setStage('additional actual persisted page restore clears ready attempt')
  const readyDocumentResponse=await reload()
  const beginResponse=page.waitForResponse(response=>new URL(response.url()).pathname===beginPath&&response.status()===200)
  await prepare()
  const readyDocumentNoStore=(await readyDocumentResponse?.headerValue('cache-control'))?.includes('no-store')===true
  const readyBeginNoStore=(await (await beginResponse).headerValue('cache-control'))?.includes('no-store')===true
  const departingWitness=await witness()
  const beforeRestore={...counts}
  const cacheReasons:string[]=[]
  const cacheFailure=(event:{notRestoredExplanations?:{reason:string}[]})=>{
    for(const value of event.notRestoredExplanations??[])cacheReasons.push(allowedCacheReasons.has(value.reason)?value.reason:'unclassified')
  }
  await cdp.send('Page.enable');cdp.on('Page.backForwardCacheNotUsed',cacheFailure)
  try{
    await page.goto(origin+'/account?lang=fr');await page.getByRole('heading',{name:'Votre compte',exact:true}).waitFor()
    await page.evaluate(()=>history.back());await page.waitForFunction(()=>location.pathname==='/account'&&location.search==='?lang=en')
  }finally{cdp.off('Page.backForwardCacheNotUsed',cacheFailure)}
  const restoreObservation=await page.evaluate(()=>{
    const navigation=performance.getEntriesByType('navigation')[0] as (PerformanceNavigationTiming&{
      notRestoredReasons?:{children:unknown[];reasons:{reason:string}[]|null}|null
    })|undefined
    const reasons=navigation?.notRestoredReasons
    const allowed=new Set(['unload-listener','unload-handler','response-cache-control-no-store','related-active-contents','web-authentication-request','masked'])
    const state=Reflect.get(window,'__additionalLifecycleWitness')
    return {persisted:state?.persisted===true,nativePageshowSeen:state?.nativePageshowSeen===true,documentId:String(state?.documentId),navigationType:navigation?.type,
      reasonObjectPresent:reasons!=null,childCount:reasons?.children.length??0,
      reasons:reasons?.reasons?.map(value=>allowed.has(value.reason)?value.reason:'unclassified')??[]}
  })
  const safeRestore={persisted:restoreObservation.persisted,nativePageshowSeen:restoreObservation.nativePageshowSeen,
    sameDocument:restoreObservation.documentId===departingWitness.documentId,navigationType:restoreObservation.navigationType,
    reasonObjectPresent:restoreObservation.reasonObjectPresent,childCount:restoreObservation.childCount,reasons:restoreObservation.reasons,
    cdpReasons:cacheReasons,documentNoStore:readyDocumentNoStore,beginNoStore:readyBeginNoStore,
    nativePanelHideDelivered:await deliveredToPanel(departingWitness.documentId)}
  evidence.additionalRestore=safeRestore
  await action('Add a passkey').waitFor();expect(await action('Verify existing key').count()).toBe(0);expect(counts).toEqual(beforeRestore)
  lifecycle.push({phase:'restore',persisted:restoreObservation.persisted,priorAttemptCleared:true})
  expect(safeRestore.documentNoStore&&safeRestore.beginNoStore&&safeRestore.nativePageshowSeen&&safeRestore.nativePanelHideDelivered).toBe(true)
  if(safeRestore.persisted)expect(safeRestore.sameDocument).toBe(true)
  else expect({fresh:!safeRestore.sameDocument,back:safeRestore.navigationType==='back_forward',documentedExclusion:cacheReasons.includes('JsNetworkRequestReceivedCacheControlNoStoreResource')})
    .toEqual({fresh:true,back:true,documentedExclusion:true})
  const afterReturnCounts={...counts};await prepare();expect(counts.begin).toBe(afterReturnCounts.begin+1);await cancelToIdle()

  setStage('additional keyboard error controls and narrow reflow')
  for(const status of [401,429,503,500]){
    await page.route(origin+beginPath,route=>route.fulfill({status,headers:{'retry-after':'2','x-tss-raw':'true'},body:'Controlled refusal'}))
    input.expectedConsole(true,beginPath)
    try{
      await action('Add a passkey').focus();await page.keyboard.press('Enter');await page.getByRole('alert').waitFor()
      const expected=status===401?'no longer authorized':status===429?'Too many attempts':status===503?'temporarily unavailable':'attempt failed'
      expect(await page.getByRole('alert').filter({hasText:expected}).isVisible()).toBe(true)
      expect(await action('Restart').isEnabled()).toBe(true)
      const beforeRestart=counts.begin
      await action('Restart').focus();await page.keyboard.press('Enter')
      await expect.poll(()=>counts.begin).toBe(beforeRestart+1)
      await page.getByRole('alert').filter({hasText:expected}).waitFor()
      await action('Cancel').focus();await page.keyboard.press('Enter');await action('Add a passkey').waitFor()
      expect(await action('Add a passkey').evaluate(element=>element===document.activeElement)).toBe(true)
    }finally{await page.unroute(origin+beginPath);input.expectedConsole(false,beginPath)}
  }
  const accessibility=await new AxeBuilder({page}).include('.additional-passkey').analyze()
  expect(accessibility.violations.map(item=>item.id)).toEqual([])
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true)
  evidence.additionalAccessibility={violations:0,narrowReflow:true,keyboardVerifyCreateCancelRestartRefresh:true}

  const root=resolve('.output/public'),helperPaths:string[]=[]
  for(const entry of await readdir(root,{recursive:true})){
    if(!entry.endsWith('.js'))continue
    const source=await readFile(resolve(root,entry),'utf8')
    if(source.includes('startAuthentication() was not called correctly')&&source.includes('WebAuthnAbortService'))helperPaths.push('/'+relative(root,resolve(root,entry)).replaceAll('\\','/'))
  }
  expect(helperPaths.length).toBe(1)
  for(const mode of ['late-helper','helper-retry','unsupported'] as const){
    setStage('additional '+mode)
    const extra=await input.newContext();await extra.addCookies(await context.cookies())
    let releaseHelper=()=>{},block=true,heldHelperRequests=0
    const helperGate=new Promise<void>(resolve=>{releaseHelper=resolve})
    try{
      if(mode==='unsupported')await extra.addInitScript(()=>Reflect.set(globalThis,'PublicKeyCredential',undefined))
      else await extra.route(origin+helperPaths[0],async route=>{
        if(mode==='helper-retry'&&block)return route.abort()
        if(mode==='late-helper'&&block){heldHelperRequests++;await helperGate}
        return route.continue()
      })
      const child=await extra.newPage();child.setDefaultTimeout(7000);await child.goto(origin+'/account?lang=en')
      const childCommands={begin:0,authorize:0,finish:0}
      child.on('request',request=>{
        const path=new URL(request.url()).pathname
        if(path===beginPath)childCommands.begin++
        if(path===authorizePath)childCommands.authorize++
        if(path===finishPath)childCommands.finish++
      })
      const childAction=(label:string)=>child.getByRole('button',{name:label,exact:true})
      await childAction('Add a passkey').click()
      if(mode==='unsupported')await child.getByRole('alert').filter({hasText:'This browser cannot use passkeys.'}).waitFor()
      else if(mode==='helper-retry'){
        await child.getByRole('alert').filter({hasText:'helper could not load'}).waitFor();block=false
        await childAction('Restart').click();await childAction('Add a passkey').waitFor()
        selectClient(client++);await childAction('Add a passkey').click();await childAction('Verify existing key').waitFor()
      }else{
        await expect.poll(()=>heldHelperRequests).toBe(1)
        await childAction('Cancel').click();await childAction('Add a passkey').waitFor();block=false;releaseHelper()
        const completion=await child.evaluate<{moduleEvaluated:boolean;applicationTurn:boolean}>(`(async()=>{
          let timer
          try{return await Promise.race([
            (async()=>{
              const api=await import(${JSON.stringify(origin+helperPaths[0])})
              const evaluated=typeof api.startAuthentication==='function'&&typeof api.startRegistration==='function'
              await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())))
              return {moduleEvaluated:evaluated,applicationTurn:true}
            })(),
            new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Owned helper completion unavailable')),7000)}),
          ])}finally{clearTimeout(timer)}
        })()`)
        expect(completion).toEqual({moduleEvaluated:true,applicationTurn:true})
        expect(childCommands).toEqual({begin:0,authorize:0,finish:0})
        expect(await childAction('Add a passkey').isVisible()).toBe(true)
        expect(await childAction('Verify existing key').isVisible()).toBe(false)
        evidence.additionalLateHelper={...completion,heldHelperRequests,idle:true,commands:{...childCommands}}
      }
      lifecycle.push({phase:mode,qualified:true})
    }finally{releaseHelper();await extra.close()}
  }

  for(const kind of ['finish','decode'] as const){
    setStage('additional '+kind+' cancellation is unconfirmed')
    await reload();await prepare();await prove();await freshAuthenticator();await deferred(kind)
    const beforeFinish=counts.finish
    try{
      await action('Create new key').click();await paused();await action('Cancel').click()
      const uncertainty=page.getByRole('status').filter({hasText:'addition may have completed'})
      await uncertainty.waitFor();await release()
      expect(await uncertainty.isVisible()).toBe(true);expect(counts.finish-beforeFinish).toBe(1)
      expect(await action('Restart').count()).toBe(0)
      await action('Refresh key list').focus();await page.keyboard.press('Enter');await action('Add a passkey').waitFor()
      lifecycle.push({phase:kind,unconfirmed:true,automaticResends:0})
    }finally{await restore()}
  }
  setStage('additional invisible HttpOnly cookie removal refuses next command')
  await prepare()
  const savedCookie=(await context.cookies()).find(cookie=>cookie.name.includes('session_token'))
  if(!savedCookie)throw new Error('Owned browser session missing')
  const beforeCookie=await sessionSnapshot(),beforeCookieFinish=counts.finish
  await context.clearCookies({name:savedCookie.name})
  input.expectedConsole(true,authorizePath)
  try{await action('Verify existing key').click();await page.getByRole('alert').filter({hasText:'no longer authorized'}).waitFor()}
  finally{input.expectedConsole(false,authorizePath)}
  expect(counts.finish).toBe(beforeCookieFinish);expect(await sessionSnapshot()===beforeCookie).toBe(true)
  await context.addCookies([savedCookie]);await reload()
  lifecycle.push({phase:'HttpOnly-cookie-change',refusedAtNextCommand:true,sessionUnchanged:true})
  setStage('additional invisible session revocation refuses next command')
  await prepare()
  await stores.administrator.query('DELETE FROM session WHERE user_id=$1',[original.user_id])
  const beforeRevocation=counts.finish
  input.expectedConsole(true,authorizePath)
  try{await action('Verify existing key').click();await page.getByRole('alert').filter({hasText:'no longer authorized'}).waitFor()}
  finally{input.expectedConsole(false,authorizePath)}
  expect(counts.finish).toBe(beforeRevocation)
  lifecycle.push({phase:'session-revocation',refusedAtNextCommand:true})
  await Promise.all(captures)
  evidence.additionalSuccessfulBodies={...successfulBodies}
  expect(successfulBodies).toEqual({begin:statuses.begin.filter(status=>status===200).length,authorize:statuses.authorize.filter(status=>status===200).length})
  expect(captureFailures).toBe(0)
  const surface=page.url()+'\n'+await page.content()
  expect([...sensitive].some(value=>surface.includes(value))||input.scanRuntime([...sensitive])).toBe(false)
  evidence.additionalSensitiveLeak=false
  setStage('additional required idle persisted restoration assertion')
  expect(evidence.additionalIdleRestore).toEqual({persisted:true,nativePageshowSeen:true,sameDocument:true,noStore:true,nativePanelHideDelivered:true})
}
