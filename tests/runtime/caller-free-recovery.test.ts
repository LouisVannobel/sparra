import { expect, test } from 'vitest'
import { classifiedSyntheticFields, reconstructionMigrationCount, validateSyntheticReconstruction, type SyntheticReconstruction } from '../helpers/caller-free-reconstruction'

const at='2026-10-12T00:00:00.000Z', wid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', bid='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
function fixture(): SyntheticReconstruction {
  return {schema_version:1,purpose:'caller-free-service-reconstruction',qualification:'synthetic-closed-admission',capture_id:wid,captured_at:at,
    source:{app_commit:'1'.repeat(40),app_tree:'2'.repeat(40),web_digest:'3'.repeat(64),migrator_digest:'4'.repeat(64),migration_source_hash:'5'.repeat(64),postgres_version:'160015',
      journal:Array.from({length:reconstructionMigrationCount},(_,i)=>({id:i+1,hash:i.toString(16).padStart(64,'0'),created_at:String(1000+i)}))},
    relations:{user:[{id:'owner',name:'Synthetic owner',email:'owner@example.test',email_verified:true,image:null,created_at:at,updated_at:at,recovering:true,recovery_generation:7,hold_until:'2027-10-12T00:00:00.000Z'}],
      account:[{id:'account',account_id:'synthetic-subject',provider_id:'google',user_id:'owner',created_at:at,updated_at:at}],
      passkey:[{id:'key',name:null,public_key:'AQ',user_id:'owner',credential_id:'Ag',counter:19,device_type:'singleDevice',backed_up:false,transports:'internal',created_at:at,aaguid:null}],
      recovery_code_batch:[{user_id:'owner',batch_id:bid,format_version:1,recovery_generation:7,issued_at:at}],
      recovery_code:Array.from({length:8},(_,i)=>({id:`cccccccc-cccc-4ccc-8ccc-${String(i).padStart(12,'0')}`,user_id:'owner',batch_id:bid,digest:i.toString(16).padStart(64,'0'),spent_at:i===0?at:null})),
      workspace:[{id:wid,kind:'personal',lifecycle:'active',owner_user_id:'owner',auth_organization_id:null,display_name:'Synthetic workshop',created_at:at,updated_at:at}],
      sparra_knowledge_revision:[{workspace_id:wid,revision:12,business_name:'Synthetic garage',sector:'garage',opening_hours:'Monday',services:'Oil change',prices:'',faq:'',instructions:'',transfer_destination:null,recording_enabled:false,recording_policy:'off',recording_contact_phone:null,saved_at:at}]}}
}

test('strict synthetic projection preserves security values and explicit nulls',()=>{
  const input=fixture(),classified=classifiedSyntheticFields(input.relations)
  expect(validateSyntheticReconstruction(input,input.source,classified)).toEqual(input)
})

test.each([23,25] as const)('strict synthetic projection refuses %i migration entries despite matching source binding',count=>{
  const input=fixture(),expected=fixture()
  const journal=Array.from({length:count},(_,i)=>({id:i+1,hash:i.toString(16).padStart(64,'0'),created_at:String(1000+i)}))
  Object.assign(input.source,{journal})
  Object.assign(expected.source,{journal:journal.map(row=>({...row}))})
  expect(()=>validateSyntheticReconstruction(input,expected.source,classifiedSyntheticFields(input.relations))).toThrow('Synthetic reconstruction refused')
})

test.each([
  ['unknown envelope', (b:SyntheticReconstruction)=>Object.assign(b,{caller_history:[]})],
  ['unknown retained field', (b:SyntheticReconstruction)=>Object.assign(b.relations.user[0],{access_token:'synthetic-token'})],
  ['unknown schema', (b:SyntheticReconstruction)=>Object.assign(b,{schema_version:2})],
  ['missing recovering', (b:SyntheticReconstruction)=>Reflect.deleteProperty(b.relations.user[0],'recovering')],
  ['missing explicit null', (b:SyntheticReconstruction)=>Reflect.deleteProperty(b.relations.user[0],'hold_until')],
  ['missing batch', (b:SyntheticReconstruction)=>Object.assign(b.relations,{recovery_code_batch:[]})],
  ['missing spent code', (b:SyntheticReconstruction)=>Object.assign(b.relations,{recovery_code:b.relations.recovery_code.slice(1)})],
  ['generation mismatch', (b:SyntheticReconstruction)=>Object.assign(b.relations.recovery_code_batch[0],{recovery_generation:6})],
  ['cross owner passkey', (b:SyntheticReconstruction)=>Object.assign(b.relations.passkey[0],{user_id:'foreign'})],
  ['subject bytes changed', (b:SyntheticReconstruction)=>Object.assign(b.relations.account[0],{account_id:'retired-subject'})],
  ['classification bound to revision', (b:SyntheticReconstruction)=>Object.assign(b.relations.sparra_knowledge_revision[0],{revision:13})],
  ['classification bound to recovery state', (b:SyntheticReconstruction)=>Object.assign(b.relations.user[0],{recovering:false})],
  ['negative counter', (b:SyntheticReconstruction)=>Object.assign(b.relations.passkey[0],{counter:-1})],
  ['fractional generation', (b:SyntheticReconstruction)=>Object.assign(b.relations.user[0],{recovery_generation:1.5})],
  ['nonfinite date', (b:SyntheticReconstruction)=>Object.assign(b.relations.user[0],{created_at:'2026-02-30T00:00:00.000Z'})],
  ['non UTC milliseconds', (b:SyntheticReconstruction)=>Object.assign(b,{captured_at:'2026-10-12T00:00:00Z'})],
  ['caller text', (b:SyntheticReconstruction)=>Object.assign(b.relations.sparra_knowledge_revision[0],{faq:'Caller Alice +33600000000'})],
  ['wrong image', (b:SyntheticReconstruction)=>Object.assign(b.source,{web_digest:'9'.repeat(64)})],
  ['wrong ordered journal', (b:SyntheticReconstruction)=>Object.assign(b.source,{journal:[...b.source.journal].reverse()})],
  ['missing authoritative continuity cannot be real qualified', (b:SyntheticReconstruction)=>Object.assign(b,{qualification:'real-qualified'})],
  ['stale invented continuity cannot reopen', (b:SyntheticReconstruction)=>Object.assign(b,{security_floor:{generation:7},admission_enabled:true})],
] as const)('%s refuses before output',(_name,change)=>{
  const expected=fixture(),input=fixture(),classified=classifiedSyntheticFields(expected.relations)
  change(input)
  expect(()=>validateSyntheticReconstruction(input,expected.source,classified)).toThrow('Synthetic reconstruction refused')
})

test('unclassified and wrong ownership with reclassified bytes still refuse',()=>{
  const input=fixture()
  expect(()=>validateSyntheticReconstruction(input,input.source,new Map())).toThrow('Synthetic reconstruction refused')
  Object.assign(input.relations.recovery_code[0],{user_id:'foreign'})
  expect(()=>validateSyntheticReconstruction(input,input.source,classifiedSyntheticFields(input.relations))).toThrow('Synthetic reconstruction refused')
})

test('selected owner cannot omit the entire current security batch',()=>{
  const input=fixture()
  Object.assign(input.relations,{recovery_code_batch:[],recovery_code:[]})
  expect(()=>validateSyntheticReconstruction(input,input.source,classifiedSyntheticFields(input.relations))).toThrow('Synthetic reconstruction refused')
})

test.each([
  ['duplicate Google subject', (b:SyntheticReconstruction)=>Object.assign(b.relations,{account:[...b.relations.account,{...b.relations.account[0],id:'second-account'}]})],
  ['noncanonical owner email', (b:SyntheticReconstruction)=>Object.assign(b.relations.user[0],{email:'Owner@example.test'})],
  ['foreign Workspace owner', (b:SyntheticReconstruction)=>Object.assign(b.relations.workspace[0],{owner_user_id:'foreign'})],
  ['current batch generation mismatch', (b:SyntheticReconstruction)=>Object.assign(b.relations.recovery_code_batch[0],{recovery_generation:6})],
  ['incomplete current batch', (b:SyntheticReconstruction)=>Object.assign(b.relations,{recovery_code:b.relations.recovery_code.slice(1)})],
  ['unknown revision Workspace', (b:SyntheticReconstruction)=>Object.assign(b.relations.sparra_knowledge_revision[0],{workspace_id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd'})],
  ['incoherent local recording policy', (b:SyntheticReconstruction)=>Object.assign(b.relations.sparra_knowledge_revision[0],{recording_policy:'local_30d',recording_enabled:true})],
  ['duplicate journal timestamp', (b:SyntheticReconstruction)=>Object.assign(b.source.journal[1],{created_at:b.source.journal[0].created_at})],
] as const)('classified bytes cannot authorize %s',(_name,change)=>{
  const input=fixture();change(input)
  expect(()=>validateSyntheticReconstruction(input,input.source,classifiedSyntheticFields(input.relations))).toThrow('Synthetic reconstruction refused')
})

test('caller-free qualification has a strict test-owned validator before any native write', async () => {
  const path = '../helpers/caller-free-reconstruction'
  const helper = await import(path).catch(() => null)
  expect(typeof helper?.validateSyntheticReconstruction, 'Feature absence: strict synthetic reconstruction validator missing').toBe('function')
})
