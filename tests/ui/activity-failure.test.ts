import { expect, test } from 'vitest'
import { classifyActivityFailure } from '../../src/ui/sparra/activity-panel'
import type { ActivityConfigurationDto, SaveActivityInput } from '../../src/modules/sparra/sparra.functions'

test.each(['ensure','save','latest'] as const)('activity %s keeps native refusal, conflict and validation outcomes distinct',async mode=>{
  expect(classifyActivityFailure,'activity failure classification is required before applying UI effects').toBeTypeOf('function')
  expect(classifyActivityFailure(mode,new Response(null,{status:401}))).toEqual({kind:'refused'})
  expect(classifyActivityFailure(mode,new Response(null,{status:409}))).toEqual({kind:'error',reason:'conflict'})
  expect(classifyActivityFailure(mode,new Response(null,{status:400}))).toEqual({kind:'error',reason:'invalid'})
})

test('only the exact native recording-unavailable 409 save response is classified separately from revision conflict',()=>{
  const response=new Response('Local audio unavailable',{status:409,headers:{'x-sparra-activity-error':'recording-unavailable'}})
  expect(classifyActivityFailure('save',response)).toEqual({kind:'error',reason:'recordingUnavailable'})
  expect(classifyActivityFailure('latest',response)).toEqual({kind:'error',reason:'conflict'})
  for(const marker of ['','other','recording-unavailable-extra'])expect(classifyActivityFailure('save',new Response('Local audio unavailable',{status:409,headers:{'x-sparra-activity-error':marker}}))).toEqual({kind:'error',reason:'conflict'})
  expect(classifyActivityFailure('save',new Response('Local audio unavailable',{status:409}))).toEqual({kind:'error',reason:'conflict'})
  expect(classifyActivityFailure('save',new Response(null,{status:500,headers:{'x-sparra-activity-error':'recording-unavailable'}}))).toEqual({kind:'uncertain'})
})

const validDraft=():SaveActivityInput=>({expectedRevision:7,businessName:'Observed garage',sector:'garage',knowledge:{openingHours:'',services:'',prices:'',faq:'',instructions:''},transferDestination:null,recordingEnabled:false})

test('activity local validation catches a blank name, an oversized name and a non-international phone without rejecting valid input',async()=>{
  const {activityDraftIssues}=await import('../../src/ui/sparra/activity-panel')
  expect(activityDraftIssues,'bounded UI validation must guard submit before native mutation').toBeTypeOf('function')
  expect(activityDraftIssues(validDraft())).toEqual({})
  expect(activityDraftIssues({...validDraft(),businessName:'   '})).toEqual({businessName:'required'})
  expect(activityDraftIssues({...validDraft(),businessName:'x'.repeat(81)})).toEqual({businessName:'nameTooLong'})
  expect(activityDraftIssues({...validDraft(),businessName:' '+ 'x'.repeat(80)+' '})).toEqual({})
  for(const transferDestination of ['0612345678','+33 123456789','+0123456789','+1234567890123456'])expect(activityDraftIssues({...validDraft(),transferDestination})).toEqual({transferDestination:'phoneFormat'})
  for(const transferDestination of [null,undefined,'+33123456789'])expect(activityDraftIssues({...validDraft(),transferDestination})).toEqual({})
})

test('activity local text bounds follow server CRLF normalization and JavaScript lengths for every knowledge field',async()=>{
  const {activityDraftIssues}=await import('../../src/ui/sparra/activity-panel')
  expect(activityDraftIssues).toBeTypeOf('function')
  for(const [field,maximum] of [['openingHours',1000],['services',2000],['prices',1500],['faq',3000],['instructions',2000]] as const){
    expect(activityDraftIssues({...validDraft(),knowledge:{...validDraft().knowledge,[field]:'x'.repeat(maximum)}})).toEqual({})
    expect(activityDraftIssues({...validDraft(),knowledge:{...validDraft().knowledge,[field]:'x'.repeat(maximum+1)}})).toEqual({[field]:'tooLong'})
  }
  expect(activityDraftIssues({...validDraft(),knowledge:{...validDraft().knowledge,openingHours:'x\r\n'.repeat(500),services:'😀'.repeat(1000)}})).toEqual({})
  expect(activityDraftIssues({...validDraft(),knowledge:{...validDraft().knowledge,openingHours:'x\r\n'.repeat(501),services:'😀'.repeat(1001)}})).toEqual({openingHours:'tooLong',services:'tooLong'})
})

test('activity equivalence compares editable information rather than saved timestamps or revisions and notices every field',async()=>{
  const {activityMatchesConfiguration}=await import('../../src/ui/sparra/activity-panel')
  expect(activityMatchesConfiguration,'latest-read comparison must use actual business information').toBeTypeOf('function')
  const {expectedRevision:_,...values}=validDraft()
  const configuration:ActivityConfigurationDto={...values,workspaceId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',revision:99,savedAt:'2026-10-05T10:00:00.000Z',transferDestination:null,recordingPolicy:'off',recordingContactPhone:null}
  expect(activityMatchesConfiguration(validDraft(),configuration)).toBe(true)
  expect(activityMatchesConfiguration(validDraft(),null)).toBe(false)
  expect(activityMatchesConfiguration({...validDraft(),businessName:'Different'},configuration)).toBe(false)
  expect(activityMatchesConfiguration({...validDraft(),sector:'controle-technique'},configuration)).toBe(false)
  expect(activityMatchesConfiguration({...validDraft(),transferDestination:'+33123456789'},configuration)).toBe(false)
  expect(activityMatchesConfiguration({...validDraft(),recordingEnabled:true},configuration)).toBe(false)
  for(const field of ['openingHours','services','prices','faq','instructions'] as const)expect(activityMatchesConfiguration({...validDraft(),knowledge:{...validDraft().knowledge,[field]:'Changed'}},configuration)).toBe(false)
  const {recordingEnabled:__,...legacy}=configuration
  expect(activityMatchesConfiguration(validDraft(),legacy)).toBe(true)
})

test.each([
  {mode:'ensure' as const,expected:{kind:'error',reason:'unavailable'}},
  {mode:'save' as const,expected:{kind:'uncertain'}},
  {mode:'latest' as const,expected:{kind:'error',reason:'unavailable'}},
])('activity $mode treats an unconfirmed outcome according to the attempted operation',async({mode,expected})=>{
  expect(classifyActivityFailure,'activity failure classification is required before applying UI effects').toBeTypeOf('function')
  for(const failure of [Response.error(),new Response(null,{status:500}),new Error('Response delivery failed'),{status:401},null]){
    expect(classifyActivityFailure(mode,failure)).toEqual(expected)
  }
})

test('local recording validation requires an explicit canonical business contact for ON independently of transfer',async()=>{
  const {activityDraftIssues}=await import('../../src/ui/sparra/activity-panel')
  const on={...validDraft(),recordingPolicy:'local_30d' as const,recordingContactPhone:null,transferDestination:'+33102030405'}
  expect(activityDraftIssues(on)).toEqual({recordingContactPhone:'recordingContactRequired'})
  for(const recordingContactPhone of ['0612345678',' +33123456789','+33123456789\n','+33 123456789','+0123456789','+1234567890123456']){
    expect(activityDraftIssues({...on,recordingContactPhone})).toEqual({recordingContactPhone:'phoneFormat'})
  }
  expect(activityDraftIssues({...on,recordingContactPhone:'+33123456789'})).toEqual({})
  expect(activityDraftIssues({...on,recordingPolicy:'off',recordingContactPhone:null})).toEqual({})
})

test('local recording policy and contact edits participate in latest-read and saved draft equality',async()=>{
  const {activityMatchesConfiguration}=await import('../../src/ui/sparra/activity-panel')
  const editable:SaveActivityInput={...validDraft(),recordingPolicy:'local_30d',recordingContactPhone:'+33123456789'}
  const {expectedRevision:_,...values}=editable
  const configuration:ActivityConfigurationDto={...values,workspaceId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',revision:99,savedAt:'2026-10-07T10:00:00.000Z',transferDestination:null,recordingPolicy:'local_30d',recordingContactPhone:'+33123456789'}
  expect(activityMatchesConfiguration(editable,configuration)).toBe(true)
  expect(activityMatchesConfiguration({...editable,recordingContactPhone:'+33102030405'},configuration)).toBe(false)
  expect(activityMatchesConfiguration({...editable,recordingPolicy:'off'},configuration)).toBe(false)
  expect(activityMatchesConfiguration(validDraft(),configuration)).toBe(false)
})
