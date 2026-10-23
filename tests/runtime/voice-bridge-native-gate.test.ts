import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

const modulePath='../../scripts/native-coverage-inputs.mjs'
const roots:string[]=[]
type BridgeReportLeaf={fullName:string;status:string;failureMessages:string[]}
const names=[
  'native session_user and execute-only catalog including restricted Workspace column locks',
  'real native begin pin is committed, stable on retry, and read through the authenticated Node owner',
  'pending-before-begin and begin-before-pending preserve one identity, retention and pin',
  'strict operations, deterministic digest, conflict, monotone facts, loss and first immutable result',
  'whole JSONB map is bounded atomically; duplicate turns and ordinal/body conflicts do not lose retained content',
  'native erasure and recording acknowledgements are actual SQL NULL and join local with remote cleanup',
  'maintenance expires content with audio off and preserves original expiry fences while admission is disabled',
  'same native call survives a lost successful COMMIT reply; failed COMMIT retains neither fact nor receipt',
  'native save/begin and erase/ingest serialize on the actual Workspace lock',
  'recording failed/retry stays queued; replaced tokens fail, deleting Workspace still cleans, and completed fence GC never revives original expiry',
  'binding tuple cannot change and a renamed or recreated login does not inherit the old role OID',
  'same Workspace deployments retain hidden revision references without aborting either native cleanup lease',
  'native company policy pin survives ON and OFF saves while deployment capability independently denies ON',
  'native sector snapshots V1 garage preserves native snapshots, concurrent revisions and Inbox ownership',
  'native sector snapshots V1 controle-technique preserves native snapshots, concurrent revisions and Inbox ownership',
  'native sector snapshots V1 diagnostic-immobilier preserves native snapshots, concurrent revisions and Inbox ownership',
  'native sector snapshots V2 garage preserves native snapshots, concurrent revisions and Inbox ownership',
  'native sector snapshots V2 controle-technique preserves native snapshots, concurrent revisions and Inbox ownership',
  'native sector snapshots V2 diagnostic-immobilier preserves native snapshots, concurrent revisions and Inbox ownership',
]
async function gate(){
  const source:unknown=await import(modulePath)
  if(typeof source!=='object'||source===null||!('assertVoiceBridgeReport' in source)||typeof source.assertVoiceBridgeReport!=='function'
    ||!('assertVoiceBridgeQualification' in source)||typeof source.assertVoiceBridgeQualification!=='function')throw new Error('Native Voice bridge report admission missing')
  return {report:source.assertVoiceBridgeReport,qualification:source.assertVoiceBridgeQualification}
}
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'sparra-voice-bridge-gate-'));roots.push(root)
  const startedAt=Date.UTC(2026,0,1),path=join(root,'voice-bridge-qualification.json')
  const report={success:true,startTime:startedAt,numTotalTests:19,numPassedTests:19,numPendingTests:0,numTodoTests:0,numFailedTests:0,numFailedTestSuites:0,numPendingTestSuites:0,
    testResults:[{name:join(root,'tests/integration/sparra-voice-bridge.test.ts').replaceAll('\\','/'),startTime:startedAt,status:'passed',message:'',assertionResults:names.map((fullName):BridgeReportLeaf=>({fullName,status:'passed',failureMessages:[]}))}]}
  writeFileSync(path,JSON.stringify(report))
  // Explicit synthetic phase/file times avoid racing Linux filesystem mtime
  // against the wall clock; actual production freshness admission stays strict.
  const writtenAt=new Date(startedAt+1000)
  utimesSync(path,writtenAt,writtenAt)
  return {root,path,startedAt,report}
}
afterEach(()=>{
  for(const root of roots.splice(0)){
    if(dirname(root)!==tmpdir()||!basename(root).startsWith('sparra-voice-bridge-gate-'))throw new Error('Refusing foreign bridge gate retirement')
    rmSync(root,{recursive:true})
  }
})

test('bridge admission accepts exactly the retained native security leaves and six current V1/V2 sector consumers',async()=>{
  const item=fixture(),admit=await gate()
  expect(()=>admit.report(item.report,item.root,item.startedAt)).not.toThrow()
  expect(()=>admit.qualification(item.path,item.root,item.startedAt)).not.toThrow()
})

test.each(['success','numTotalTests','numPassedTests','numPendingTests','numTodoTests','numFailedTests','numFailedTestSuites','numPendingTestSuites'] as const)('bridge admission refuses inconsistent %s even with all named leaves present',async field=>{
  const item=fixture(),admit=await gate()
  Object.assign(item.report,{[field]:field==='success'?false:item.report[field]+1})
  expect(()=>admit.report(item.report,item.root,item.startedAt)).toThrow('Native Voice bridge requires its exact nineteen passing leaves')
})

test.each(['missing','extra','duplicate','renamed','reordered','skipped','todo','failed','message'] as const)('bridge admission refuses %s leaves despite a successful nineteen-pass summary',async kind=>{
  const item=fixture(),admit=await gate(),leaves=item.report.testResults[0].assertionResults
  if(kind==='missing')leaves.pop()
  else if(kind==='extra')leaves.push(structuredClone(leaves[0]))
  else if(kind==='duplicate')leaves[18]=structuredClone(leaves[17])
  else if(kind==='renamed')leaves[18].fullName='V2 diagnostic consumer omitted'
  else if(kind==='reordered')leaves.reverse()
  else if(kind==='message')leaves[18].failureMessages=['Owned native failure']
  else leaves[18].status=kind
  expect(()=>admit.report(item.report,item.root,item.startedAt)).toThrow('Native Voice bridge requires its exact nineteen passing leaves')
})

test.each(['missing','extra','duplicate','foreign','failed','message'] as const)('bridge admission refuses %s file identity despite retained passing leaf totals',async kind=>{
  const item=fixture(),admit=await gate(),files=item.report.testResults
  if(kind==='missing')files.pop()
  else if(kind==='extra')files.push({...structuredClone(files[0]),name:join(item.root,'tests/integration/unreviewed.test.ts')})
  else if(kind==='duplicate')files.push(structuredClone(files[0]))
  else if(kind==='foreign')files[0].name=join(item.root,'foreign/tests/integration/sparra-voice-bridge.test.ts').replaceAll('\\','/')
  else if(kind==='message')files[0].message='Owned afterAll failure'
  else files[0].status=kind
  expect(()=>admit.report(item.report,item.root,item.startedAt)).toThrow('Native Voice bridge requires its exact nineteen passing leaves')
})

test.each(['stale-report','stale-file','missing-report-time','missing-file-time','invalid-report-time','invalid-file-time'] as const)('bridge admission refuses %s within a freshly written successful report',async kind=>{
  const item=fixture(),admit=await gate(),file=item.report.testResults[0]
  if(kind==='stale-report')item.report.startTime=item.startedAt-1
  else if(kind==='stale-file')file.startTime=item.startedAt-1
  else if(kind==='missing-report-time')Reflect.deleteProperty(item.report,'startTime')
  else if(kind==='missing-file-time')Reflect.deleteProperty(file,'startTime')
  else if(kind==='invalid-report-time')Object.assign(item.report,{startTime:null})
  else Object.assign(file,{startTime:null})
  expect(()=>admit.report(item.report,item.root,item.startedAt)).toThrow('Native Voice bridge requires its exact nineteen passing leaves')
})

test.each(['absent','empty','oversized','stale','directory','link','malformed'] as const)('bridge qualification refuses %s report bytes before publication',async kind=>{
  const item=fixture(),admit=await gate(),refused=join(item.root,'refused.json')
  if(kind==='directory')mkdirSync(refused)
  else if(kind==='link')symlinkSync(item.root,refused,process.platform==='win32'?'junction':'dir')
  else if(kind!=='absent'){
    writeFileSync(refused,kind==='malformed'?'invalid json':kind==='empty'?'':readFileSync(item.path))
    if(kind==='oversized')truncateSync(refused,268435457)
    if(kind==='stale')utimesSync(refused,new Date(item.startedAt-10000),new Date(item.startedAt-10000))
  }
  expect(()=>admit.qualification(refused,item.root,item.startedAt)).toThrow()
  expect(readFileSync(item.path,'utf8')).toBe(JSON.stringify(item.report))
})

test('bridge admission binds the exact owned App root even when all security and V2 cases pass',async()=>{
  const item=fixture(),admit=await gate()
  expect(()=>admit.report(item.report,join(item.root,'other-app'),item.startedAt)).toThrow('Native Voice bridge requires its exact nineteen passing leaves')
})
