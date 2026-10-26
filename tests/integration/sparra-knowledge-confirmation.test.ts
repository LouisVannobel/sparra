import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { createPersonalWorkspaces } from '../../src/modules/workspaces/personal.server'
import { createActivityOperations } from '../../src/modules/sparra/activity.server'
import { createAuthRateLimiter, readRateLimitConfig } from '../../src/modules/auth/rate-limit.server'
import type { createApplicationAuth } from '../../src/modules/auth/auth.server'
import { startGoogleProtocolPeer } from '../helpers/google-protocol-peer.mjs'
import { googleCeremony } from '../helpers/google-ceremony'
import type { WebsiteCapture } from '../../src/modules/sparra/website-capture.server'

const capture = vi.hoisted(() => vi.fn())
vi.mock('../../src/modules/sparra/website-capture.server', () => ({ captureWebsite: capture }))
let stores: Awaited<ReturnType<typeof startDisposableStores>>, pool: Pool
let owner: ReturnType<typeof createTransactions>, personal: ReturnType<typeof createPersonalWorkspaces>, activity: ReturnType<typeof createActivityOperations>
let auth: ReturnType<typeof createApplicationAuth>, limiter: ReturnType<typeof createAuthRateLimiter>, peer: Awaited<ReturnType<typeof startGoogleProtocolPeer>>, ceremony: ReturnType<typeof googleCeremony>
let module: typeof import('../../src/modules/sparra/knowledge-confirmation.server') | undefined
const source: WebsiteCapture = {url:'https://example.org/services',capturedAt:new Date().toISOString(),title:'Garage',sha256:'a'.repeat(64),passages:[{id:'p1',text:'Vidange à 99 euros'}]}
const input = (expectedRevision = 0) => ({draftId:randomUUID(),draftVersion:1,confirmed:true as const,decisions:[],activity:{expectedRevision,businessName:' Garage ',sector:'garage' as const,knowledge:{openingHours:'Lundi\r\nMardi',services:'Vidange',prices:'',faq:'',instructions:'Préserver les consignes'},transferDestination:'+33123456789',recordingEnabled:false,recordingPolicy:'off' as const,recordingContactPhone:'+33123456780'}})
const admin = (query:string, values?:unknown[]) => stores.administrator.query(query,values)
async function fixture() { const {principal}=await ceremony(); const workspace=await personal.ensurePersonalWorkspace(principal); return {principal,workspace:workspace!} }
function operations() { expect(module,'confirmation module is implemented').toBeDefined(); return module!.createKnowledgeConfirmationOperations(owner) }
beforeAll(async()=>{
  module = await import('../../src/modules/sparra/knowledge-confirmation.server')
  stores=await startDisposableStores();await stores.migrate()
  await admin('GRANT USAGE ON SCHEMA public TO runtime; GRANT SELECT,INSERT,UPDATE,DELETE ON "user",account,session,verification TO runtime')
  peer=await startGoogleProtocolPeer({ports:[3000,...[stores.runtimeUrl,stores.directRuntimeUrl,stores.redisUrl].map(url=>Number(new URL(url).port))]})
  pool=new Pool({connectionString:stores.directRuntimeUrl,max:4});owner=createTransactions(pool,{maxStatementTimeoutMs:1000,maxCleanupTimeoutMs:1000})
  const {createApplicationAuth,readAuthConfig}=await import('../../src/modules/auth/auth.server')
  limiter=createAuthRateLimiter(readRateLimitConfig({REDIS_URL:stores.redisUrl,RATE_LIMIT_HMAC_SECRET:stores.hmac,RATE_LIMIT_KEY_ID:'knowledge-confirm',TRUSTED_PROXY_IPS:'127.0.0.1',NODE_ENV:'test'}));await limiter.connect()
  auth=createApplicationAuth(owner,readAuthConfig({APP_ORIGIN:'http://localhost:3000',NODE_ENV:'test',AUTH_SECRET:randomBytes(48).toString('hex'),GOOGLE_CLIENT_ID:'fixture.apps.googleusercontent.com',GOOGLE_CLIENT_SECRET:'fixture-only'})!,limiter)
  ceremony=googleCeremony(auth,owner,peer);personal=createPersonalWorkspaces(owner);activity=createActivityOperations(owner)
},180000)
afterAll(async()=>{ for(const close of [()=>auth?.close(),()=>limiter?.close(),()=>pool?.end(),()=>peer?.close(),()=>stores?.cleanup()]) await close() })

test('native confirmation is atomic, owner scoped, normalized and serialized',async()=>{
  const ops=operations(), a=await fixture(), b=await fixture(), value=input()
  const [one,two]=await Promise.all([ops.confirm(a.principal,value),ops.confirm(a.principal,value)])
  expect(one).toEqual(two);expect(one).toMatchObject({status:'confirmed',revision:1})
  expect(await ops.lookup(b.principal,value)).toEqual({status:'unverifiable'})
  await expect(ops.confirm(a.principal,{...value,activity:{...value.activity,businessName:'Different'}})).rejects.toMatchObject({name:'KnowledgeConfirmationConflict'})
  expect(await ops.confirm(a.principal,{...value,activity:{...value.activity,businessName:'Garage',knowledge:{...value.activity.knowledge,openingHours:'Lundi\nMardi'}}})).toEqual(one)
  const concurrent=await Promise.allSettled([ops.confirm(a.principal,input(1)),ops.confirm(a.principal,input(1))])
  expect(concurrent.filter(x=>x.status==='fulfilled')).toHaveLength(1)
  await admin(`CREATE FUNCTION public.fixture_receipt_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture receipt failure';END $$;CREATE TRIGGER fixture_receipt_fail BEFORE INSERT ON sparra_knowledge_confirmation FOR EACH ROW EXECUTE FUNCTION public.fixture_receipt_fail()`)
  try {await expect(ops.confirm(a.principal,input(2))).rejects.toThrow()} finally {await admin('DROP TRIGGER fixture_receipt_fail ON sparra_knowledge_confirmation;DROP FUNCTION public.fixture_receipt_fail()')}
  expect((await activity.read(a.principal)).configuration?.revision).toBe(2)
  expect((await admin('SELECT count(*)::int n FROM sparra_knowledge_confirmation WHERE workspace_id=$1',[a.workspace.id])).rows[0].n).toBe(2)
})

test('seven day historical receipt survives K9 and actual maintenance purge of K8 and capture',async()=>{
  const ops=operations(),a=await fixture();capture.mockResolvedValue(source)
  const imported=await ops.importPage(a.principal,{url:source.url},'https://sparra.example')
  for(let revision=0;revision<7;revision++) await activity.save(a.principal,input(revision).activity)
  const value={...input(7),captureId:imported.captureId,decisions:[{passageId:'p1',target:'services' as const,action:'use' as const}]}
  const receipt=await ops.confirm(a.principal,value);await activity.save(a.principal,input(8).activity)
  await admin(`UPDATE sparra_knowledge_capture SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1`,[a.workspace.id])
  await admin(`INSERT INTO voice_private.deployment_binding(service_login,service_role_oid,deployment_id,workspace_id,connection_id,to_e164,admission_enabled) SELECT 'sparra_voice_a',oid,'fixture-confirm',$1,'conn','+33123456789',true FROM pg_roles WHERE rolname='sparra_voice_a'`,[a.workspace.id])
  await admin('GRANT USAGE ON SCHEMA voice TO sparra_voice_a;GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA voice TO sparra_voice_a')
  const voice=new Pool({connectionString:stores.voiceUrlA})
  try {await voice.query("SELECT * FROM voice.lease_recording_purge_v1('fixture',30,1)")} finally {await voice.end()}
  expect((await admin('SELECT revision FROM sparra_knowledge_revision WHERE workspace_id=$1',[a.workspace.id])).rows).toEqual([{revision:9}])
  expect((await admin('SELECT * FROM sparra_knowledge_capture WHERE workspace_id=$1',[a.workspace.id])).rows).toHaveLength(0)
  expect(await ops.confirm(a.principal,value)).toEqual(receipt);expect(await ops.lookup(a.principal,value)).toEqual(receipt)
  expect((await activity.read(a.principal)).configuration?.revision).toBe(9)
  const stored=(await admin('SELECT provenance FROM sparra_knowledge_confirmation WHERE workspace_id=$1',[a.workspace.id])).rows[0].provenance
  expect(stored.source).toMatchObject({url:source.url,sha256:source.sha256});expect(stored.decisions).toEqual(value.decisions)
})

test('server acquisition owns one pending import, refuses cancellation/replacement and foreign captures',async()=>{
  capture.mockReset()
  const ops=operations(),a=await fixture(),b=await fixture();let release!:(value:WebsiteCapture)=>void
  capture.mockImplementationOnce(()=>new Promise<WebsiteCapture>(resolve=>{release=resolve}))
  const pending=ops.importPage(a.principal,{url:source.url},'https://sparra.example')
  await vi.waitFor(()=>expect(release).toBeTypeOf('function'))
  await expect(ops.importPage(a.principal,{url:source.url},'https://sparra.example')).rejects.toMatchObject({name:'KnowledgeImportBusy'})
  release(source);const old=await pending;expect(capture).toHaveBeenLastCalledWith(source.url,expect.objectContaining({blockedHosts:['sparra.example']}))
  capture.mockResolvedValue(source);const fresh=await ops.importPage(a.principal,{url:source.url},'https://sparra.example')
  for(const [principal,captureId] of [[a.principal,old.captureId],[b.principal,fresh.captureId]] as const) await expect(ops.confirm(principal,{...input(),captureId})).rejects.toMatchObject({name:'KnowledgeCaptureUnavailable'})
  const abort=new AbortController();capture.mockImplementationOnce(async()=>{abort.abort();return source})
  await expect(ops.importPage(a.principal,{url:source.url},'https://sparra.example',abort.signal)).rejects.toThrow()
  await expect(ops.importPage(a.principal,{url:'x'.repeat(2049)},'https://sparra.example')).rejects.toMatchObject({name:'InvalidKnowledgeInput'})
  capture.mockImplementationOnce(()=>new Promise<WebsiteCapture>(resolve=>{release=resolve}))
  const lostOwner=ops.importPage(b.principal,{url:source.url},'https://sparra.example')
  await vi.waitFor(()=>expect(capture).toHaveBeenCalledTimes(4))
  await admin("UPDATE workspace SET lifecycle='deleting' WHERE id=$1",[b.workspace.id])
  release(source)
  await expect(lostOwner).rejects.toMatchObject({name:'KnowledgeWorkspaceUnavailable'})
  expect((await admin('SELECT source FROM sparra_knowledge_capture WHERE workspace_id=$1',[b.workspace.id])).rows).toEqual([{source:null}])
  const c=await fixture();let releaseStale!:(value:WebsiteCapture)=>void
  capture.mockImplementationOnce(()=>new Promise<WebsiteCapture>(resolve=>{releaseStale=resolve}))
  const stale=ops.importPage(c.principal,{url:source.url},'https://sparra.example')
  await vi.waitFor(()=>expect(releaseStale).toBeTypeOf('function'))
  await admin("UPDATE sparra_knowledge_capture SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1",[c.workspace.id])
  capture.mockResolvedValue(source)
  const replacement=await ops.importPage(c.principal,{url:source.url},'https://sparra.example')
  releaseStale(source)
  await expect(stale).rejects.toMatchObject({name:'KnowledgeCaptureUnavailable'})
  expect((await admin('SELECT capture_id FROM sparra_knowledge_capture WHERE workspace_id=$1',[c.workspace.id])).rows).toEqual([{capture_id:replacement.captureId}])
})

test('expiry is fixed, cleanup is bounded and Workspace cleanup preserves its contract and activity settings',async()=>{
  const ops=operations(),a=await fixture(),base=input(),value={...base,activity:{...base.activity,recordingPolicy:'local_30d' as const}}
  await admin(`INSERT INTO voice_private.deployment_binding(service_login,service_role_oid,deployment_id,workspace_id,connection_id,to_e164,admission_enabled,audio_enabled,contract_version,local_audio_enabled) SELECT 'sparra_voice_b',oid,'fixture-confirm-audio',$1,'conn','+33123456789',true,false,2,true FROM pg_roles WHERE rolname='sparra_voice_b'`,[a.workspace.id])
  const receipt=await ops.confirm(a.principal,value)
  const {expectedRevision,...settings}=value.activity;expect(expectedRevision).toBe(0)
  expect((await activity.read(a.principal)).configuration).toMatchObject({...settings,revision:1,businessName:'Garage',knowledge:{...value.activity.knowledge,openingHours:'Lundi\nMardi'}})
  await expect(ops.confirm(a.principal,{...input(1),activity:{...input(1).activity,recordingPolicy:undefined}})).rejects.toMatchObject({name:'InvalidKnowledgeInput'})
  await expect(ops.confirm(a.principal,{...input(1),confirmed:false})).rejects.toMatchObject({name:'InvalidKnowledgeInput'})
  const before=(await admin('SELECT expires_at FROM sparra_knowledge_confirmation WHERE workspace_id=$1',[a.workspace.id])).rows[0].expires_at
  await ops.lookup(a.principal,value);expect((await admin('SELECT expires_at FROM sparra_knowledge_confirmation WHERE workspace_id=$1',[a.workspace.id])).rows[0].expires_at).toEqual(before)
  expect(new Date(before).getTime()-new Date(receipt.savedAt).getTime()).toBe(7*86400000)
  // Fixture time travel preserves immutable receipt values relative to each other.
  await admin('ALTER TABLE sparra_knowledge_confirmation DISABLE TRIGGER sparra_confirmation_immutable')
  try {await admin(`UPDATE sparra_knowledge_confirmation SET saved_at=saved_at-interval '8 days',expires_at=expires_at-interval '8 days' WHERE workspace_id=$1`,[a.workspace.id])} finally {await admin('ALTER TABLE sparra_knowledge_confirmation ENABLE TRIGGER sparra_confirmation_immutable')}
  expect(await ops.lookup(a.principal,value)).toEqual({status:'unverifiable'})
  expect((await admin('SELECT * FROM sparra_knowledge_confirmation WHERE workspace_id=$1',[a.workspace.id])).rows).toHaveLength(0)
  await admin(`WITH stamp AS (SELECT date_trunc('milliseconds',clock_timestamp())-interval '8 days' saved)
    INSERT INTO sparra_knowledge_confirmation(workspace_id,draft_id,draft_version,revision,input_hash,provenance,saved_at,expires_at)
    SELECT $1,gen_random_uuid(),1,1,repeat('a',64),'{"confirmed":true,"source":null,"decisions":[]}'::jsonb,saved,saved+interval '7 days' FROM stamp,generate_series(1,101)`,[a.workspace.id])
  await ops.lookup(a.principal,value)
  expect((await admin('SELECT count(*)::int n FROM sparra_knowledge_confirmation WHERE workspace_id=$1',[a.workspace.id])).rows[0].n).toBe(1)
  const b=await fixture();capture.mockResolvedValue(source)
  const imported=await ops.importPage(b.principal,{url:source.url},'https://sparra.example')
  await admin("UPDATE sparra_knowledge_capture SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1",[b.workspace.id])
  await expect(ops.confirm(b.principal,{...input(),captureId:imported.captureId})).rejects.toMatchObject({name:'KnowledgeCaptureUnavailable'})
  await ops.lookup(b.principal,{draftId:randomUUID(),draftVersion:1})
  expect((await admin('SELECT * FROM sparra_knowledge_capture WHERE workspace_id=$1',[b.workspace.id])).rows).toHaveLength(0)
  await ops.importPage(b.principal,{url:source.url},'https://sparra.example')
  await admin(`WITH stamp AS (SELECT date_trunc('milliseconds',clock_timestamp()) saved)
    INSERT INTO sparra_knowledge_confirmation(workspace_id,draft_id,draft_version,revision,input_hash,provenance,saved_at,expires_at)
    SELECT $1,gen_random_uuid(),1,1,repeat('a',64),'{"confirmed":true,"source":null,"decisions":[]}'::jsonb,saved,saved+interval '7 days' FROM stamp`,[b.workspace.id])
  // Deleting an otherwise empty Workspace cascades the capture. The native
  // revision FK still blocks deleting a Workspace with retained activity.
  await admin('DELETE FROM workspace WHERE id=$1',[b.workspace.id])
  expect((await admin('SELECT * FROM sparra_knowledge_capture WHERE workspace_id=$1',[b.workspace.id])).rows).toHaveLength(0)
  expect((await admin('SELECT * FROM sparra_knowledge_confirmation WHERE workspace_id=$1',[b.workspace.id])).rows).toHaveLength(0)
  await expect(admin('DELETE FROM workspace WHERE id=$1',[a.workspace.id])).rejects.toMatchObject({code:'23503'})
  await admin("UPDATE workspace SET lifecycle='deleting' WHERE id=$1",[a.workspace.id])
  expect(await ops.lookup(a.principal,value)).toEqual({status:'unverifiable'})
  await expect(ops.confirm(a.principal,input(1))).rejects.toMatchObject({name:'KnowledgeWorkspaceUnavailable'})
})
