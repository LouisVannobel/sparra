import { afterAll, beforeAll, expect, test } from 'vitest'
import { nativeImage } from '../helpers/native-image'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { Schema } from 'effect'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { createPersonalWorkspaces } from '../../src/modules/workspaces/personal.server'
import { createAuthRateLimiter,readRateLimitConfig } from '../../src/modules/auth/rate-limit.server'
import { startGoogleProtocolPeer } from '../helpers/google-protocol-peer.mjs'
import { googleCeremony } from '../helpers/google-ceremony'
import { unusedLoopbackPort } from '../helpers/web-process'
import { fetch } from 'undici'
import { retireWebImageCeremony } from '../helpers/web-image-retirement'
let image: string
let stores: Awaited<ReturnType<typeof startDisposableStores>>
const qualifiedPorts:number[]=[]
beforeAll(async () => { image = await nativeImage('web'); stores=await startDisposableStores(); await stores.migrate() }, 600000)
afterAll(async()=>{if(stores){await stores.cleanup();expect(stores.evidence.unrelatedUnchanged).toBe(true);expect(stores.evidence.inventoryDelta).toEqual([])}})
test('failed_limiter_setup_after_actual_peer_acquisition_retires_all_handles',async()=>{
  let pool:Pool|undefined,peer:Awaited<ReturnType<typeof startGoogleProtocolPeer>>|undefined,limiter:ReturnType<typeof createAuthRateLimiter>|undefined
  const port=await unusedLoopbackPort()
  await expect((async()=>{
    try{
      pool=new Pool({connectionString:stores.directRuntimeUrl})
      peer=await startGoogleProtocolPeer({ports:[port]})
      limiter=createAuthRateLimiter(readRateLimitConfig({REDIS_URL:'redis://:synthetic@127.0.0.1:'+port,RATE_LIMIT_HMAC_SECRET:stores.hmac,RATE_LIMIT_KEY_ID:'failed-image-setup',TRUSTED_PROXY_IPS:'127.0.0.1',NODE_ENV:'test',REDIS_CONNECT_TIMEOUT_MS:'100',REDIS_CLEANUP_TIMEOUT_MS:'100'}))
      await limiter.connect()
    }finally{await retireWebImageCeremony({limiter:limiter?()=>limiter!.close():undefined,pool:pool?()=>pool!.end():undefined,peer:peer?()=>peer!.close():undefined})}
  })()).rejects.toThrow()
  expect(pool?.ended).toBe(true);expect(limiter?.isReady()).toBe(false);expect(peer?.evidence().activeSockets).toBe(0)
})
test('complete_output_boots_without_repo', async() => {
  const app=await stores.startWebImage(image)
  qualifiedPorts.push(Number(new URL(app.url).port))
  expect((await fetch(app.url+'/health/ready')).status).toBe(200)
  const html=await (await fetch(app.url+'/')).text()
  expect(html).toContain('Sparra')
  expect((await fetch(app.url+'/login')).status).toBe(200)
  expect((await fetch(app.url+'/demos/garage-revision.mp3')).status).toBe(200)
  const metadata=await stores.imageMetadata(app.id)
  expect(metadata.user).toBe('10001:10001');expect(metadata.readonly).toBe(true)
  expect(metadata.mounts.map((mount:{Destination:string})=>mount.Destination)).toEqual(['/run/secrets'])
  const closure=await stores.command(app.id,['node','-e',"const fs=require('node:fs');for(const p of ['src','tests','node_modules','probe.mjs'])if(fs.existsSync('/app/'+p))process.exit(1);for(const p of ['npm','npx','corepack','yarn','pnpm'])if(fs.existsSync('/usr/local/bin/'+p))process.exit(2);if(process.getuid()!==10001||process.getgid()!==10001)process.exit(3);for(const p of ['.output/server/index.mjs','.output/public/demos/garage-revision.mp3'])if(!fs.existsSync('/app/'+p))process.exit(4);console.log('native-closure')"])
  expect(closure).toBe('native-closure')
  await stores.signalWeb(app.id,'SIGTERM');expect(await stores.waitWeb(app.id)).toBe(0)
})
test.each(['empty-env','missing','malformed','oversized','symlink','mode','empty','newline','nul','whitespace','utf8','uid','gid','directory','parent-mode'] as const)('invalid_file_never_imports_or_leaks: %s',async mutation=>{
  const app=await stores.startWebImage(image,mutation)
  qualifiedPorts.push(Number(new URL(app.url).port))
  expect(await stores.waitWeb(app.id)).toBe(1)
  expect(await stores.imageLogs(app.id)).toEqual({stdout:'',stderr:'Web credential loading failed\n'})
})
test('actual_image_contains_direct_serve_ingress',async()=>{
  const app=await stores.startWebImage(image,'valid',undefined,undefined,true)
  qualifiedPorts.push(Number(new URL(app.url).port))
  try{
    expect(await stores.directImageStatus(app.id,'/health/ready')).toBe(200)
    expect(await stores.directImageStatus(app.id,'/health/ready',true)).toBe(400)
    expect(await stores.directImageStatus(app.id,'/login')).toBe(200)
  }finally{await stores.signalWeb(app.id,'SIGTERM');expect(await stores.waitWeb(app.id)).toBe(0)}
})
test('native_voice_envelope_decrypts_in_image_and_restart_rereads_credentials',async()=>{
  const fixture=Schema.decodeUnknownSync(Schema.Struct({producer_commit:Schema.String,plaintext:Schema.String,call_id:Schema.String,turn_id:Schema.String,turn:Schema.Unknown,keyring:Schema.Unknown}))(JSON.parse(await readFile('tests/fixtures/sparra/native-voice-envelope.json','utf8')))
  expect(fixture.producer_commit).toBe('52d6502991090d55aa94ee97fb38ebba656a4139')
  const secret=randomBytes(48).toString('hex'),authInput={secret,googleClientId:'fixture.apps.googleusercontent.com',googleClientSecret:'fixture-only'}
  await stores.administrator.query('GRANT USAGE ON SCHEMA public TO runtime; GRANT SELECT,INSERT,UPDATE,DELETE ON "user",account,session,verification TO runtime')
  const imagePort=await unusedLoopbackPort(),ports=[...qualifiedPorts,imagePort,...[stores.directRuntimeUrl,stores.runtimeUrl,stores.redisUrl].map(url=>Number(new URL(url).port))]
  const {createApplicationAuth,readAuthConfig}=await import('../../src/modules/auth/auth.server')
  let pool:Pool|undefined,peer:Awaited<ReturnType<typeof startGoogleProtocolPeer>>|undefined,limiter:ReturnType<typeof createAuthRateLimiter>|undefined,auth:ReturnType<typeof createApplicationAuth>|undefined
  let rotatedAuth:ReturnType<typeof createApplicationAuth>|undefined
  let app:Awaited<ReturnType<typeof stores.startWebImage>>|undefined
  try{
    pool=new Pool({connectionString:stores.directRuntimeUrl,max:4})
    const owner=createTransactions(pool,{maxStatementTimeoutMs:1000,maxCleanupTimeoutMs:1000})
    peer=await startGoogleProtocolPeer({ports})
    limiter=createAuthRateLimiter(readRateLimitConfig({REDIS_URL:stores.redisUrl,RATE_LIMIT_HMAC_SECRET:stores.hmac,RATE_LIMIT_KEY_ID:'image-ceremony',TRUSTED_PROXY_IPS:'127.0.0.1',NODE_ENV:'test'}))
    await limiter.connect()
    auth=createApplicationAuth(owner,readAuthConfig({APP_ORIGIN:'http://localhost:3000',NODE_ENV:'test',AUTH_SECRET:secret,GOOGLE_CLIENT_ID:authInput.googleClientId,GOOGLE_CLIENT_SECRET:authInput.googleClientSecret})!,limiter)
    const account=await googleCeremony(auth,owner,peer)(),personal=createPersonalWorkspaces(owner),workspace=await personal.ensurePersonalWorkspace(account.principal)
    expect(workspace).not.toBeNull()
    await stores.administrator.query("INSERT INTO sparra_call(id,workspace_id,deployment_id,provider_call_control_id,admitted_at,retention_until,status,encrypted_turns) VALUES($1::uuid,$2,'synthetic',$1::text,clock_timestamp(),clock_timestamp()+interval '30 days','pending',$3)",[fixture.call_id,workspace!.id,{[fixture.turn_id]:fixture.turn}])
    app=await stores.startWebImage(image,'valid',authInput,JSON.stringify(fixture.keyring),false,imagePort)
    const metadata=await stores.imageMetadata(app.id)
    expect(JSON.stringify(metadata)).not.toContain(secret)
    const response=await fetch(app.url+'/app/demandes/'+fixture.call_id,{headers:{cookie:account.cookie},redirect:'manual'})
    expect(response.status).toBe(200)
    const html=await response.text();expect(html).toContain('Rappelez-moi');expect(html).not.toContain('ciphertext_b64')
    await stores.signalWeb(app.id,'SIGTERM');expect(await stores.waitWeb(app.id)).toBe(0)
    await stores.replaceWebCredentials(app.id,authInput,'{}')
    await stores.restartWebImage(app.id)
    for(let attempt=0;attempt<50;attempt++){try{if((await fetch(app.url+'/health/ready')).status===200)break}catch{}await new Promise(resolve=>setTimeout(resolve,100))}
    const unavailable=await fetch(app.url+'/app/demandes/'+fixture.call_id,{headers:{cookie:account.cookie},redirect:'manual'})
    expect(unavailable.status).toBe(200);expect(await unavailable.text()).not.toContain('Rappelez-moi')
    await stores.signalWeb(app.id,'SIGTERM');expect(await stores.waitWeb(app.id)).toBe(0)
    const rotatedSecret=randomBytes(48).toString('hex')
    await stores.replaceWebCredentials(app.id,{...authInput,secret:rotatedSecret})
    await stores.restartWebImage(app.id)
    for(let attempt=0;attempt<50;attempt++){try{if((await fetch(app.url+'/health/ready')).status===200)break}catch{}await new Promise(resolve=>setTimeout(resolve,100))}
    const after=await fetch(app.url+'/app/demandes/'+fixture.call_id,{headers:{cookie:account.cookie},redirect:'manual'})
    expect(after.status).toBe(307);expect(after.headers.get('location')).toContain('/login')
    rotatedAuth=createApplicationAuth(owner,readAuthConfig({APP_ORIGIN:'http://localhost:3000',NODE_ENV:'test',AUTH_SECRET:rotatedSecret,GOOGLE_CLIENT_ID:authInput.googleClientId,GOOGLE_CLIENT_SECRET:authInput.googleClientSecret})!,limiter)
    const current=await googleCeremony(rotatedAuth,owner,peer)()
    expect((await fetch(app.url+'/app',{headers:{cookie:current.cookie},redirect:'manual'})).status).toBe(200)
    expect(JSON.stringify(await stores.imageLogs(app.id))).not.toContain(secret)
  }finally{
    await retireWebImageCeremony({
      image:app?async()=>{await stores.signalWeb(app!.id,'SIGTERM');if(await stores.waitWeb(app!.id)!==0)throw Error('Image shutdown failed')}:undefined,
      rotatedAuth:rotatedAuth?()=>rotatedAuth!.close():undefined,auth:auth?()=>auth!.close():undefined,
      limiter:limiter?()=>limiter!.close():undefined,pool:pool?()=>pool!.end():undefined,peer:peer?()=>peer!.close():undefined,
    })
  }
},45000)
