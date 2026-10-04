import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { API, type Snapshot } from 'typescript/unstable/sync'
import type { FileChangeSummary } from 'typescript/unstable/proto'
import { createScanner, getLeadingCommentRanges, getTokenAtPosition, getTrailingCommentRanges, isArrowFunction, isBlock, isCallExpression, isExpressionStatement, isFunctionDeclaration, isIdentifier, isImportDeclaration, isNamedImports, isStringLiteral, LanguageVariant, SyntaxKind } from 'typescript/unstable/ast'
import type { CallExpression, Node, SourceFile } from 'typescript/unstable/ast'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { admitCommonGeometry, assertDirectory, assertRunTree, assertRequestsReport, readNativeBlob, sourceIdentity } from '../scripts/native-coverage-inputs.mjs'

const repositoryRoot = process.cwd()
const fixtureRoot = mkdtempSync(join(repositoryRoot, 'src', '.anti-slop-canary-'))
const oxlint = join(repositoryRoot, 'node_modules', 'oxlint', 'bin', 'oxlint')
let acceptedFiles: string[], rejectedFiles: string[]

function writeFixture(name: string, source: string): string {
  const path = join(fixtureRoot, name)
  writeFileSync(path, source)
  return relative(repositoryRoot, path).replaceAll('\\', '/')
}
function runOxlint(files: string[]) {
  return spawnSync(process.execPath, [oxlint, '--threads=1', '--format', 'json', ...files], {
    cwd: repositoryRoot, encoding: 'utf8', windowsHide: true, timeout: 15000,
  })
}
beforeAll(() => {
  acceptedFiles = [
    writeFixture('boundaries.ts', "export function decode(input: unknown): string { return typeof input === 'string' ? input : ''; }\nexport const browser = typeof window !== 'undefined';\n"),
    writeFixture('service.test.ts', "import { makeMarketingService } from './marketing-service';\nvoid makeMarketingService;\n"),
  ]
  rejectedFiles = [
    writeFixture('assertion.ts', 'declare const input: unknown;\ninterface User { id: string }\nexport const user = input as object as User;\n'),
    writeFixture('service.ts', "import { makeMarketingService } from './marketing-service';\nvoid makeMarketingService;\n"),
  ]
})
afterAll(() => {
  const target = resolve(fixtureRoot)
  if (dirname(target) !== join(repositoryRoot, 'src') || !basename(target).startsWith('.anti-slop-canary-')) throw new Error('Refusing non-owned canary cleanup')
  rmSync(target, { recursive: true, force: true })
})

test('accepts narrowed boundaries and test-only service constructors', () => {
  const result = runOxlint(acceptedFiles)
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr || result.stdout).toBe(0)
  expect(JSON.parse(result.stdout).diagnostics).toEqual([])
})

test.each([
  [0, 'anti-slop(no-chained-type-assertions)'],
  [1, 'anti-slop-effect(no-service-constructor-imports)'],
])('rejects runtime canary %i with its selected rule', (index, expectedCode) => {
  const result = runOxlint([rejectedFiles[index]!])
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr || result.stdout).toBe(1)
  const report = JSON.parse(result.stdout)
  expect(report.diagnostics.map((item: { code: string }) => item.code)).toContain(expectedCode)
  expect(report.diagnostics.every((item: { code: string }) => item.code.startsWith('anti-slop'))).toBe(true)
  expect(report.diagnostics.every((item: { filename: string }) => item.filename.replaceAll('\\', '/') === rejectedFiles[index])).toBe(true)
})

const qualityRoots:string[]=[]
function qualityFixture() {
  const root=mkdtempSync(join(tmpdir(),'sparra-quality-canary-'));qualityRoots.push(root)
  mkdirSync(join(root,'src'))
  writeFileSync(join(root,'package.json'),JSON.stringify({name:'synthetic-quality-canary',private:true,type:'module',main:'src/main.tsx',dependencies:{react:'19.2.8','react-dom':'19.2.8'},devDependencies:{vite:'8.2.2'}}))
  writeFileSync(join(root,'.gitignore'),'node_modules/\n')
  writeFileSync(join(root,'index.html'),'<div id="root"></div><script type="module" src="/src/main.tsx"></script>')
  writeFileSync(join(root,'src/main.tsx'),"import {createRoot} from 'react-dom/client';import {App} from './App';createRoot(document.getElementById('root')!).render(<App value='synthetic' />);\n")
  writeFileSync(join(root,'src/App.tsx'),"export function App({value}:{value:string}){return <div>{value}</div>}\n")
  const git=(args:string[])=>{
    const result=spawnSync('git',['-C',root,...args],{encoding:'utf8',windowsHide:true,timeout:5000})
    if(result.error||result.status!==0)throw new Error('Owned canary Git setup failed')
    return result.stdout.trim()
  }
  git(['init','--quiet']);git(['add','.']);git(['-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','-c','commit.gpgsign=false','commit','--quiet','-m','synthetic baseline'])
  const base=git(['rev-parse','HEAD'])
  writeFileSync(join(root,'src/unused.ts'),'export const unusedSparraCanary = 1;\n')
  writeFileSync(join(root,'src/App.tsx'),"import {useEffect,useState} from 'react';export function App({value}:{value:string}){const [derived,setDerived]=useState(value);useEffect(()=>{setDerived(value)},[value]);return <div>{derived}</div>}\n")
  git(['add','.'])
  symlinkSync(join(repositoryRoot,'node_modules'),join(root,'node_modules'),process.platform==='win32'?'junction':'dir')
  return {root,base}
}
function qualityBinary(tool:'fallow'|'react-doctor') {
  const packageRoot=join(repositoryRoot,'node_modules',tool),metadata:unknown=JSON.parse(readFileSync(join(packageRoot,'package.json'),'utf8'))
  if(typeof metadata!=='object'||metadata===null||!('bin' in metadata))throw new Error('Missing native quality consumer')
  const bin=metadata.bin
  if(typeof bin==='string')return resolve(packageRoot,bin)
  if(typeof bin!=='object'||bin===null)throw new Error('Missing native quality binary')
  const selected=Object.entries(bin).find(([key])=>key===tool)?.[1]
  if(typeof selected!=='string')throw new Error('Missing native quality binary')
  return resolve(packageRoot,selected)
}
function runQuality(tool:'fallow'|'react-doctor',args:string[],cwd:string) {
  const path=qualityBinary(tool),header=readFileSync(path).subarray(0,128).toString('utf8')
  const node=/^#![^\n]*node/.test(header)||/\.[cm]?js$/.test(path)
  return spawnSync(node?process.execPath:path,node?[path,...args]:args,{cwd,encoding:'utf8',windowsHide:true,timeout:30000,
    env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,HOME:process.env.HOME,USERPROFILE:process.env.USERPROFILE}})
}
afterAll(()=>{for(const root of qualityRoots){if(dirname(root)!==tmpdir()||!basename(root).startsWith('sparra-quality-canary-'))throw new Error('Non-owned quality cleanup');rmSync(root,{recursive:true})}})

function nativeCoverageFixture(activityAfterAll = '') {
  const {root}=qualityFixture()
  for(const name of ['App.tsx','main.tsx','unused.ts'])rmSync(join(root,'src',name))
  for(const directory of ['scripts','tests/integration','drizzle','.output/server','.output/public','coverage'])mkdirSync(join(root,directory),{recursive:true})
  const packageFile=join(root,'package.json'),metadata=JSON.parse(readFileSync(join(repositoryRoot,'package.json'),'utf8'))
  writeFileSync(packageFile,JSON.stringify({name:'native-coverage-canary',private:true,type:'module',engines:metadata.engines,devDependencies:{vitest:'4.1.11','@vitest/coverage-istanbul':'4.1.11'}}))
  writeFileSync(join(root,'pnpm-lock.yaml'),'lockfileVersion: 9.0\n')
  for(const config of ['vitest.config.ts','vitest.integration.config.ts'])writeFileSync(join(root,config),readFileSync(join(repositoryRoot,config)))
  writeFileSync(join(root,'scripts/test-prerequisites.mjs'),readFileSync(join(repositoryRoot,'scripts/test-prerequisites.mjs')))
  // Test-only resource adapter for the miniature merger canary. These named
  // tests exercise runner wiring; they are not native Voice qualification.
  writeFileSync(join(root,'scripts/prepare-voice-source.mjs'),`import {existsSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
export async function prepareVoiceSource({appRoot}){const scope=join(appRoot,'coverage/canary-voice-owner');mkdirSync(scope);return {root:scope,fixturePython:process.execPath,testEnvironment:{HOME:scope,APPDATA:scope,NLTK_DATA:scope},tokenizerArchive:join(scope,'synthetic-tokenizer.zip'),assertIdentity:async()=>{if(!existsSync(scope))throw new Error('Synthetic canary Voice owner missing')},retire:async()=>{if(existsSync(scope)){if(existsSync(join(scope,'retirement-failure')))throw new Error('Synthetic canary Voice retirement failed');rmSync(scope,{recursive:true});writeFileSync(join(appRoot,'canary-voice-retired.txt'),'retired')}}}}\n`)
  writeFileSync(join(root,'tests/integration/sparra-voice-crypto.test.ts'),"import {expect,test} from 'vitest';test('synthetic runner Crypto wiring',()=>expect(process.env.SPARRA_VOICE_TEST_ROOT).toContain('canary-voice-owner'));\n")
  const requestNames=[
    'native owner reads absent state, actual Voice ciphertext and pinned configuration without inventing pending results',
    'equal-millisecond pagination returns all 103 calls exactly once in tuple order',
    'treat active preserves inventory and stamp, erase deletes native content and survives retention',
    'treat closed preserves inventory and stamp, erase deletes native content and survives retention',
    'expired content stays unreadable including a Workspace lock held across retention; queued receipt outlives fence deadline',
    'native runtime UPDATE RETURNING cooperates with narrow definer, FORCE RLS and column grants',
    'fence insertion failure and cancellation roll back; recorded COMMIT cancellation rejects completion and reload resolves',
    'built native RPC enforces strict input, auth, missing and foreign Origin, bounded failures and no-store',
  ]
  writeFileSync(join(root,'tests/integration/sparra-requests.test.ts'),"import {expect,test} from 'vitest';import {selectBranch} from '../../src/covered';// Synthetic runner selection canary only.\n"+requestNames.map(name=>'test('+JSON.stringify(name)+",()=>{expect(process.env.SPARRA_VOICE_TEST_ROOT).toContain('canary-voice-owner');expect(selectBranch(true)).toBe(7)});\n").join(''))
  writeFileSync(join(root,'.output/server/index.mjs'),'export const build = 1\n')
  writeFileSync(join(root,'src/covered.ts'),'export function selectBranch(value: boolean): number {\n  if (value) return 7\n  return 9\n}\n')
  writeFileSync(join(root,'src/unexecuted.ts'),'export function unexecuted(): number {\n  return 13\n}\n')
  writeFileSync(join(root,'tests/ordinary.test.ts'),"import {expect,test} from 'vitest';import {selectBranch} from '../src/covered';test('ordinary true branch',()=>expect(selectBranch(true)).toBe(7));\n")
  writeFileSync(join(root,'tests/integration/sparra-activity.test.ts'),"import {afterAll,expect,test} from 'vitest';import {selectBranch} from '../../src/covered';import {appendFileSync,readFileSync,readdirSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';import {join} from 'node:path';test.each(Array.from({length:12},(_,index)=>index))('activity false branch %i',()=>expect(selectBranch(false)).toBe(9));afterAll(()=>{"+activityAfterAll+'});\n')
  return root
}

function runNativeCoverage(root:string,args:string[]) {
  return spawnSync(process.execPath,[join(repositoryRoot,'node_modules/vitest/vitest.mjs'),...args],{cwd:root,encoding:'utf8',windowsHide:true,timeout:12000})
}

test('native_activity_blob_admits_twelve_complete_pass_cases_and_refuses_missing_or_extra',()=>{
  const root=nativeCoverageFixture(),blob=join(root,'coverage/activity.json'),startedAt=Date.now()
  const result=runNativeCoverage(root,['run','--config','vitest.integration.config.ts','tests/integration/sparra-activity.test.ts','--maxWorkers=1','--coverage','--reporter=default','--reporter=blob','--outputFile.blob='+blob,'--coverage.reportsDirectory='+join(root,'coverage/activity')])
  expect(result.error).toBeUndefined();expect(result.status,result.stdout+result.stderr).toBe(0)
  const bytes=readFileSync(blob),table=JSON.parse(bytes.toString('utf8')),files=table[Number(table[0][1])]
  expect(files).toHaveLength(1)
  const file=table[Number(files[0])],tasksIndex=Number(file.tasks),tasks=table[tasksIndex]
  expect(table[Number(file.filepath)]).toBe(join(root,'tests/integration/sparra-activity.test.ts').replaceAll('\\','/'))
  expect(tasks).toHaveLength(12)
  for(const reference of tasks) {
    const task=table[Number(reference)]
    expect(table[Number(task.type)]).toBe('test')
    expect(table[Number(table[Number(task.result)].state)]).toBe('pass')
  }
  expect(()=>readNativeBlob(blob,'activity',root,startedAt,'4.1.11')).not.toThrow()
  for(const count of [11,13]) {
    const changed=JSON.parse(bytes.toString('utf8')),cases=changed[tasksIndex]
    if(count===11)cases.pop()
    else cases.push(cases[0])
    expect(cases).toHaveLength(count)
    expect(changed.filter((_:unknown,index:number)=>index!==tasksIndex)).toEqual(table.filter((_:unknown,index:number)=>index!==tasksIndex))
    const refusal=join(root,'coverage/activity-'+count+'.json')
    writeFileSync(refusal,JSON.stringify(changed))
    expect(()=>readNativeBlob(refusal,'activity',root,startedAt,'4.1.11'),String(count)+' complete PASS cases').toThrow('Native coverage test cardinality mismatch')
  }
  expect(readFileSync(blob)).toEqual(bytes)
},25000)

test('native_requests_blob_admits_eight_passes_and_refuses_missing_extra_or_foreign_consumers',()=>{
  const root=nativeCoverageFixture(),blob=join(root,'coverage/requests.json'),startedAt=Date.now()
  const fixture=join(root,'tests/integration/sparra-requests.test.ts')
  writeFileSync(fixture,readFileSync(fixture,'utf8').replaceAll("expect(process.env.SPARRA_VOICE_TEST_ROOT).toContain('canary-voice-owner');",''))
  const result=runNativeCoverage(root,['run','--config','vitest.integration.config.ts','tests/integration/sparra-requests.test.ts','--maxWorkers=1','--coverage','--reporter=blob','--outputFile.blob='+blob,'--coverage.reportsDirectory='+join(root,'coverage/requests')])
  expect(result.error).toBeUndefined();expect(result.status,result.stdout+result.stderr).toBe(0)
  const bytes=readFileSync(blob),table=JSON.parse(bytes.toString('utf8'))
  expect(()=>readNativeBlob(blob,'requests',root,startedAt,'4.1.11')).not.toThrow()
  const files=table[Number(table[0][1])],file=table[Number(files[0])],tasksIndex=Number(file.tasks)
  for(const count of [7,9]){
    const changed=JSON.parse(bytes.toString('utf8')),tasks=changed[tasksIndex]
    if(count===7)tasks.pop();else tasks.push(tasks[0])
    const path=join(root,'coverage/requests-'+count+'.json');writeFileSync(path,JSON.stringify(changed))
    expect(()=>readNativeBlob(path,'requests',root,startedAt,'4.1.11')).toThrow('Native coverage test cardinality mismatch')
  }
  const changed=JSON.parse(bytes.toString('utf8'));changed[Number(file.filepath)]=join(root,'tests/integration/sparra-activity.test.ts').replaceAll('\\','/')
  const foreign=join(root,'coverage/requests-foreign.json');writeFileSync(foreign,JSON.stringify(changed))
  expect(()=>readNativeBlob(foreign,'requests',root,startedAt,'4.1.11')).toThrow('Native requests blob has an unexpected consumer')
},25000)

test('native_requests_report_preserves_exact_summary_consumer_and_leaf_admission',()=>{
  const root=nativeCoverageFixture(),reportPath=join(root,'coverage/native-requests.json')
  const fixture=join(root,'tests/integration/sparra-requests.test.ts')
  writeFileSync(fixture,readFileSync(fixture,'utf8').replaceAll("expect(process.env.SPARRA_VOICE_TEST_ROOT).toContain('canary-voice-owner');",''))
  const result=runNativeCoverage(root,['run','--config','vitest.integration.config.ts','tests/integration/sparra-requests.test.ts','--maxWorkers=1','--reporter=json','--outputFile.json='+reportPath])
  expect(result.error).toBeUndefined();expect(result.status,result.stdout+result.stderr).toBe(0)
  const report=JSON.parse(readFileSync(reportPath,'utf8'))
  expect(()=>assertRequestsReport(report,root)).not.toThrow()
  for(const field of ['success','numTotalTests','numPassedTests','numPendingTests','numTodoTests','numFailedTests','numFailedTestSuites','numPendingTestSuites']){
    const wrong={...report,[field]:field==='success'?false:report[field]+1}
    expect(()=>assertRequestsReport(wrong,root)).toThrow('Native Requests requires its exact eight passing leaves')
  }
  for(const mutate of [
    (value:typeof report)=>{value.testResults=[]},
    (value:typeof report)=>{value.testResults[0].name=join(root,'tests/foreign.ts')},
    (value:typeof report)=>{value.testResults[0].status='failed'},
    (value:typeof report)=>{value.testResults[0].message='failure'},
    (value:typeof report)=>{value.testResults[0].assertionResults.pop()},
    (value:typeof report)=>{value.testResults[0].assertionResults[0].fullName='wrong leaf'},
    (value:typeof report)=>{value.testResults[0].assertionResults[0].status='skipped'},
    (value:typeof report)=>{value.testResults[0].assertionResults[0].failureMessages=['failure']},
  ]){const wrong=structuredClone(report);mutate(wrong);expect(()=>assertRequestsReport(wrong,root)).toThrow('Native Requests requires its exact eight passing leaves')}
},25000)

test('native_blob_coverage_keeps_additive_counts_zero_entries_and_source_geometry',()=>{
  const root=nativeCoverageFixture(),blobs=join(root,'coverage/blobs'),ordinary=join(root,'coverage/ordinary'),activity=join(root,'coverage/activity'),final=join(root,'coverage/final')
  const startedAt=Date.now(),identity=sourceIdentity(root)
  expect(sourceIdentity(root)).toBe(identity)
  for(const path of [join(root,'src/covered.ts'),join(root,'.output/server/index.mjs')]) {
    const original=readFileSync(path)
    try {writeFileSync(path,Buffer.concat([original,Buffer.from('\nexport const directConsumerDrift = 1\n')]))
      expect(sourceIdentity(root)).not.toBe(identity)
    } finally {writeFileSync(path,original)}
    expect(sourceIdentity(root)).toBe(identity)
  }
  mkdirSync(blobs);mkdirSync(ordinary);writeFileSync(join(ordinary,'stale.txt'),'old output')
  const phase=(config:string,report:string,output:string,files:string[])=>runNativeCoverage(root,['run','--config',config,...files,'--maxWorkers=1','--coverage','--reporter=default','--reporter=blob','--outputFile.blob='+join(blobs,report),'--coverage.reportsDirectory='+output])
  const first=phase('vitest.config.ts','ordinary.json',ordinary,[])
  expect(first.error).toBeUndefined();expect(first.status,first.stdout+first.stderr).toBe(0)
  expect(existsSync(join(ordinary,'stale.txt'))).toBe(false)
  const second=phase('vitest.integration.config.ts','activity.json',activity,['tests/integration/sparra-activity.test.ts'])
  expect(second.error).toBeUndefined();expect(second.status,second.stdout+second.stderr).toBe(0)
  expect(readdirSync(blobs).sort()).toEqual(['activity.json','ordinary.json'])
  expect(sourceIdentity(root)).toBe(identity)
  const ordinaryPath=join(blobs,'ordinary.json'),activityPath=join(blobs,'activity.json')
  const coverageDirectory=join(root,'coverage'),witnessDirectory=join(root,'owned-input-witness'),witness=join(witnessDirectory,'preserved.txt')
  const witnessBytes=Buffer.from('owned coverage input preservation witness\n')
  mkdirSync(witnessDirectory);writeFileSync(witness,witnessBytes)
  for(const directory of [coverageDirectory,blobs,ordinary,activity]) {
    const owner=assertDirectory(directory)
    expect(owner.isDirectory()).toBe(true)
    expect(assertDirectory(directory,owner)).toMatchObject({dev:owner.dev,ino:owner.ino})
    expect(()=>assertDirectory(directory,{dev:owner.dev===0?1:0,ino:owner.ino})).toThrow('Native coverage directory ownership changed')
    expect(readFileSync(witness)).toEqual(witnessBytes)
    expect(()=>assertDirectory(directory,{dev:owner.dev,ino:owner.ino===0?1:0})).toThrow('Native coverage directory ownership changed')
    expect(readFileSync(witness)).toEqual(witnessBytes)
  }
  expect(()=>assertDirectory(ordinaryPath)).toThrow('Native coverage directory ownership changed')
  expect(readFileSync(witness)).toEqual(witnessBytes)
  expect(()=>assertRunTree(coverageDirectory)).not.toThrow()
  const ownedLink=join(blobs,'owned-input-link')
  symlinkSync(witnessDirectory,ownedLink,process.platform==='win32'?'junction':'dir')
  try {
    expect(()=>assertDirectory(ownedLink)).toThrow('Native coverage directory ownership changed')
    expect(readFileSync(witness)).toEqual(witnessBytes)
    expect(()=>assertRunTree(coverageDirectory)).toThrow('Unsafe native coverage run entry')
    expect(readFileSync(witness)).toEqual(witnessBytes)
  } finally {rmSync(ownedLink)}
  expect(()=>assertRunTree(coverageDirectory)).not.toThrow()
  expect(readFileSync(witness)).toEqual(witnessBytes)
  const nativeOrdinary=readNativeBlob(ordinaryPath,'ordinary',root,startedAt,'4.1.11'),nativeActivity=readNativeBlob(activityPath,'activity',root,startedAt,'4.1.11')
  expect(nativeOrdinary.digest).toBe(createHash('sha256').update(readFileSync(ordinaryPath)).digest('hex'))
  expect(nativeActivity.digest).toBe(createHash('sha256').update(readFileSync(activityPath)).digest('hex'))
  expect(()=>admitCommonGeometry(nativeOrdinary,nativeActivity)).not.toThrow()
  expect(()=>readNativeBlob(ordinaryPath,'ordinary',root,Date.now()+60000,'4.1.11')).toThrow('Native coverage blob is stale or invalid')
  expect(()=>readNativeBlob(ordinaryPath,'ordinary',join(root,'foreign-root'),startedAt,'4.1.11')).toThrow('Native blob source root mismatch')
  expect(()=>readNativeBlob(ordinaryPath,'activity',root,startedAt,'4.1.11')).toThrow('Native activity blob has an unexpected consumer')
  const refusal=join(root,'coverage/direct-refusal.json')
  const foreign=JSON.parse(readFileSync(ordinaryPath,'utf8')),foreignFiles=foreign[Number(foreign[0][1])],foreignFile=foreign[Number(foreignFiles[0])]
  foreign[Number(foreignFile.filepath)]=process.platform==='win32'?'D:/sparra-foreign/ordinary.test.ts':'/sparra-foreign/ordinary.test.ts'
  writeFileSync(refusal,JSON.stringify(foreign))
  expect(()=>readNativeBlob(refusal,'ordinary',root,startedAt,'4.1.11')).toThrow('Native blob source root mismatch')
  const alias=JSON.parse(readFileSync(ordinaryPath,'utf8')),aliasCoverage=alias[Number(alias[0][3])],key=Object.keys(aliasCoverage).find(path=>path.endsWith('/src/covered.ts'))!
  aliasCoverage[key+'.alias']=aliasCoverage[key];delete aliasCoverage[key]
  writeFileSync(refusal,JSON.stringify(alias))
  expect(()=>readNativeBlob(refusal,'ordinary',root,startedAt,'4.1.11')).toThrow('Native coverage record identity mismatch')
  for(const field of ['statementMap','fnMap','branchMap']) {
    const changed=JSON.parse(readFileSync(ordinaryPath,'utf8')),entries=changed[Number(changed[0][3])],record=changed[Number(entries[key])],geometry=changed[Number(record[field])]
    const location=changed[Number(geometry['0'])]
    location.directConsumerMetadata=1
    writeFileSync(refusal,JSON.stringify(changed))
    const admitted=readNativeBlob(refusal,'ordinary',root,startedAt,'4.1.11')
    expect(()=>admitCommonGeometry(admitted,nativeActivity)).toThrow('Native coverage common-file geometry mismatch')
  }
  const merge=(directory:string)=>runNativeCoverage(root,['--config','vitest.config.ts','--coverage','--mergeReports='+directory,'--reporter=default','--coverage.reportsDirectory='+final])
  const merged=merge(blobs)
  expect(merged.error).toBeUndefined();expect(merged.status,merged.stdout+merged.stderr).toBe(0)
  const coverage=JSON.parse(readFileSync(join(final,'coverage-final.json'),'utf8'))
  const covered=coverage[join(root,'src/covered.ts').replaceAll('\\','/')],unexecuted=coverage[join(root,'src/unexecuted.ts').replaceAll('\\','/')]
  expect(covered.f).toEqual({'0':13});expect(covered.s).toEqual({'0':13,'1':1,'2':12})
  expect(covered.b).toEqual({'0':[1,12]})
  expect(covered.fnMap['0'].decl.start).toEqual({line:1,column:16})
  expect(covered.statementMap['1']).toEqual({start:{line:2,column:13},end:{line:2,column:null}})
  expect(covered.branchMap['0'].loc.start.line).toBe(2)
  expect(unexecuted.f).toEqual({'0':0});expect(unexecuted.s).toEqual({'0':0})
  const single=join(root,'coverage/single');mkdirSync(single)
  writeFileSync(join(single,'ordinary.json'),readFileSync(join(blobs,'ordinary.json')))
  expect(merge(single).status).toBe(0)
  const empty=join(root,'coverage/empty');mkdirSync(empty)
  for(const directory of [empty,join(root,'coverage/missing')])expect(merge(directory).status).not.toBe(0)
  writeFileSync(join(single,'ordinary.json'),'invalid blob')
  expect(()=>readNativeBlob(join(single,'ordinary.json'),'ordinary',root,startedAt,'4.1.11')).toThrow()
  expect(merge(single).status).not.toBe(0)
  const incompatible=JSON.parse(readFileSync(join(blobs,'ordinary.json'),'utf8'))
  incompatible[Number(incompatible[0][0])]='0.0.0'
  writeFileSync(join(single,'ordinary.json'),JSON.stringify(incompatible))
  expect(()=>readNativeBlob(join(single,'ordinary.json'),'ordinary',root,startedAt,'4.1.11')).toThrow('Native coverage blob version mismatch')
  expect(merge(single).status).not.toBe(0)
  const ordinaryTest=join(root,'tests/ordinary.test.ts')
  writeFileSync(ordinaryTest,readFileSync(ordinaryTest,'utf8').replace('.toBe(7)','.toBe(9)'))
  const failed=phase('vitest.config.ts','ordinary.json',ordinary,[])
  expect(failed.error).toBeUndefined();expect(failed.status).not.toBe(0)
},60000)

function runCoverageConsumer(root:string,preload?:string) {
  writeFileSync(join(root,'scripts/test.mjs'),readFileSync(join(repositoryRoot,'scripts/test.mjs')))
  writeFileSync(join(root,'scripts/native-coverage-inputs.mjs'),readFileSync(join(repositoryRoot,'scripts/native-coverage-inputs.mjs')))
  writeFileSync(join(root,'scripts/native-test-phase.mjs'),readFileSync(join(repositoryRoot,'scripts/native-test-phase.mjs')))
  writeFileSync(join(root,'coverage/coverage-final.json'),'{"stale":true}')
  const args=preload?['--import',pathToFileURL(preload).href,'scripts/test.mjs']:['scripts/test.mjs']
  return spawnSync(process.execPath,args,{cwd:root,encoding:'utf8',windowsHide:true,timeout:20000})
}

test('actual_coverage_runner_publishes_only_native_complete_map_after_retirement',()=>{
  const root=nativeCoverageFixture(),result=runCoverageConsumer(root)
  expect(result.error).toBeUndefined();expect(result.status,result.stdout+result.stderr).toBe(0)
  expect(readdirSync(join(root,'coverage'))).toEqual(['coverage-final.json'])
  expect(readFileSync(join(root,'canary-voice-retired.txt'),'utf8')).toBe('retired')
  expect(existsSync(join(root,'coverage/canary-voice-owner'))).toBe(false)
  const coverage=JSON.parse(readFileSync(join(root,'coverage/coverage-final.json'),'utf8'))
  expect(coverage.stale).toBeUndefined()
  expect(coverage[join(root,'src/covered.ts').replaceAll('\\','/')].f).toEqual({'0':21})
  expect(coverage[join(root,'src/covered.ts').replaceAll('\\','/')].s).toEqual({'0':21,'1':9,'2':12})
  expect(coverage[join(root,'src/covered.ts').replaceAll('\\','/')].b).toEqual({'0':[9,12]})
  expect(coverage[join(root,'src/unexecuted.ts').replaceAll('\\','/')].f).toEqual({'0':0})
},25000)

test('actual_coverage_runner_refuses_requests_missing_or_extra_leaves_before_publication',()=>{
  for(const count of [7,9]){
    const root=nativeCoverageFixture(),path=join(root,'tests/integration/sparra-requests.test.ts')
    const lines=readFileSync(path,'utf8').trimEnd().split('\n')
    if(count===7)lines.pop();else lines.push(lines.at(-1)!.replace('built native RPC','extra native RPC'))
    writeFileSync(path,lines.join('\n')+'\n')
    const result=runCoverageConsumer(root)
    expect(result.error).toBeUndefined();expect(result.status,result.stdout+result.stderr).toBe(1)
    expect(result.stderr).toContain('Native Requests requires its exact eight passing leaves')
    expect(existsSync(join(root,'coverage/coverage-final.json'))).toBe(false)
  }
},25000)

test('actual_coverage_runner_accepts_native_coverage_bearing_requests_json_above_one_MiB',()=>{
  const root=nativeCoverageFixture()
  writeFileSync(join(root,'src/large-unexecuted.ts'),Array.from({length:3600},(_,index)=>'export function unexecuted'+index+'(){return '+index+'}\n').join(''))
  const preload=join(root,'observe-native-report-size.mjs')
  writeFileSync(preload,"import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {join} from 'node:path';const original=fs.lstatSync;fs.lstatSync=(path,...args)=>{const value=original(path,...args);if(typeof path==='string'&&path.endsWith('requests-qualification.json'))fs.writeFileSync(join(process.cwd(),'native-report-size.txt'),String(value.size));return value};syncBuiltinESMExports();\n")
  const result=runCoverageConsumer(root,preload)
  expect(Number(readFileSync(join(root,'native-report-size.txt'),'utf8'))).toBeGreaterThan(1048576)
  expect(result.error).toBeUndefined();expect(result.status,result.stdout+result.stderr).toBe(0)
  expect(existsSync(join(root,'coverage/coverage-final.json'))).toBe(true)
},25000)

test.each([
  ['afterAll failure',"throw new Error('Owned afterAll failure')"],
  ['single blob',"const run=readdirSync('coverage').find(name=>name.startsWith('.native-'));rmSync(join('coverage',run!,'blobs/ordinary.json'))"],
  ['extra blob',"const run=readdirSync('coverage').find(name=>name.startsWith('.native-'));writeFileSync(join('coverage',run!,'blobs/extra.json'),'{}')"],
  ['source drift',"appendFileSync('src/covered.ts','\\nexport const drift = 1\\n')"],
  ['build drift',"appendFileSync('.output/server/index.mjs','\\nexport const drift = 1\\n')"],
  ['unsafe retirement',"const run=readdirSync('coverage').find(name=>name.startsWith('.native-'));symlinkSync(process.cwd(),join('coverage',run!,'ordinary/foreign'),process.platform==='win32'?'junction':'dir')"],
  ['raw blob common geometry drift',"const run=readdirSync('coverage').find(name=>name.startsWith('.native-'));const path=join('coverage',run!,'blobs/ordinary.json');const table=JSON.parse(readFileSync(path,'utf8'));const coverage=table[Number(table[0][3])];const file=table[Number(coverage[Object.keys(coverage).find(name=>name.endsWith('/src/covered.ts'))!])];const statements=table[Number(file.statementMap)];const location=table[Number(statements['1'])];table[Number(location.start)].line+=1;writeFileSync(path,JSON.stringify(table))"],
  ['raw blob foreign root',"const run=readdirSync('coverage').find(name=>name.startsWith('.native-'));const path=join('coverage',run!,'blobs/ordinary.json');const table=JSON.parse(readFileSync(path,'utf8'));const files=table[Number(table[0][1])];const file=table[Number(files[0])];table[Number(file.filepath)]=process.platform==='win32'?'D:/sparra-foreign/ordinary.test.ts':'/sparra-foreign/ordinary.test.ts';writeFileSync(path,JSON.stringify(table))"],
  ['raw blob coverage key alias',"const run=readdirSync('coverage').find(name=>name.startsWith('.native-'));const path=join('coverage',run!,'blobs/ordinary.json');const table=JSON.parse(readFileSync(path,'utf8'));const coverage=table[Number(table[0][3])];const key=Object.keys(coverage).find(name=>name.endsWith('/src/covered.ts'))!;const file=table[Number(coverage[key])];const statements=table[Number(file.statementMap)];const location=table[Number(statements['1'])];table[Number(location.start)].line+=1;coverage[key+'.alias']=coverage[key];delete coverage[key];writeFileSync(path,JSON.stringify(table))"],
])('actual_coverage_runner_invalidates_stale_publication_on_%s',(name,afterAllSource)=>{
  const root=nativeCoverageFixture(afterAllSource),result=runCoverageConsumer(root)
  expect(result.error).toBeUndefined();expect(result.status,result.stdout+result.stderr).toBe(1)
  expect(existsSync(join(root,'coverage/coverage-final.json')),name).toBe(false)
  expect(readdirSync(join(root,'coverage')).some(file=>file.endsWith('.pending')),name).toBe(false)
},25000)

test('actual_coverage_runner_refuses_pruned_admitted_ordinary_blob',()=>{
  const root=nativeCoverageFixture("const run=readdirSync('coverage').find(name=>name.startsWith('.native-'));const path=join('coverage',run!,'blobs/ordinary.json');const table=JSON.parse(readFileSync(path,'utf8'));const files=table[Number(table[0][1])];const index=files.findIndex((reference:string)=>table[Number(table[Number(reference)].filepath)].endsWith('/tests/ordinary.test.ts'));if(index<0||files.length!==2)throw new Error('Expected two genuine ordinary test files');files.splice(index,1);const coverage=table[Number(table[0][3])];delete coverage[Object.keys(coverage).find(name=>name.endsWith('/src/covered.ts'))!];writeFileSync(path,JSON.stringify(table))")
  writeFileSync(join(root,'tests/second-ordinary.test.ts'),"import {expect,test} from 'vitest';test('second ordinary witness',()=>expect(1+1).toBe(2));\n")
  const result=runCoverageConsumer(root),final=join(root,'coverage/coverage-final.json')
  const published=existsSync(final)?JSON.parse(readFileSync(final,'utf8'))[join(root,'src/covered.ts').replaceAll('\\','/')].f:null
  expect(result.error).toBeUndefined();expect(result.status,result.stdout+result.stderr+'\nAccepted native function counts: '+JSON.stringify(published)).toBe(1)
  expect(existsSync(final)).toBe(false)
  expect(readdirSync(join(root,'coverage')).some(file=>file.endsWith('.pending'))).toBe(false)
},25000)

test('actual_coverage_runner_preserves_foreign_pending_collision_marker',()=>{
  const root=nativeCoverageFixture("const run=readdirSync('coverage').find(name=>name.startsWith('.native-'));writeFileSync(join('coverage','.coverage-final-'+run!.slice('.native-'.length)+'.pending'),'foreign pending marker')")
  const result=runCoverageConsumer(root)
  expect(result.error).toBeUndefined();expect(result.status,result.stdout+result.stderr).toBe(1)
  expect(existsSync(join(root,'coverage/coverage-final.json'))).toBe(false)
  const pending=readdirSync(join(root,'coverage')).filter(file=>file.endsWith('.pending'))
  expect(pending).toHaveLength(1)
  expect(readFileSync(join(root,'coverage',pending[0]!),'utf8')).toBe('foreign pending marker')
},25000)

test('actual_coverage_runner_retains_its_producer_after_a_forced_phase_timeout',()=>{
  const root=nativeCoverageFixture(),preload=join(root,'phase-timeout-preload.mjs')
  writeFileSync(preload,"import {existsSync} from 'node:fs';const original=setTimeout;globalThis.setTimeout=(callback,delay,...args)=>{if(delay!==600000)return original(callback,delay,...args);const watcher=setInterval(()=>{if(existsSync('phase-owned-child.txt')){clearInterval(watcher);callback(...args)}},20);const deadline=original(()=>clearInterval(watcher),delay);deadline.unref();return watcher};\n")
  writeFileSync(join(root,'tests/ordinary.test.ts'),"import {test} from 'vitest';import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';test('owned blocked consumer',()=>{const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync('phase-owned-child.txt',String(child.pid));return new Promise(()=>{});},300000);\n")
  const result=runCoverageConsumer(root,preload)
  expect(result.error).toBeUndefined();expect(result.status,result.stdout+result.stderr).toBe(1)
  expect(result.stderr).toContain('consumer resource cleanup is unconfirmed')
  expect(existsSync(join(root,'coverage/coverage-final.json'))).toBe(false)
  expect(existsSync(join(root,'coverage/canary-voice-owner'))).toBe(true)
  expect(existsSync(join(root,'canary-voice-retired.txt'))).toBe(false)
  const pid=Number(readFileSync(join(root,'phase-owned-child.txt'),'utf8'))
  expect(()=>process.kill(pid,0)).toThrow()
},10000)

test('actual_coverage_runner_retires_owned_pending_after_partial_write_failure',()=>{
  const root=nativeCoverageFixture(),preload=join(root,'coverage/partial-write-preload.mjs')
  writeFileSync(preload,`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {join} from 'node:path';
const open=fs.openSync,write=fs.writeFileSync,close=fs.closeSync,stat=fs.fstatSync,descriptors=new Set();
const pending=path=>typeof path==='string'&&path.startsWith(join(process.cwd(),'coverage','.coverage-final-'))&&path.endsWith('.pending');
fs.openSync=(path,flags,...args)=>{const descriptor=open(path,flags,...args);if(pending(path)&&flags==='wx')descriptors.add(descriptor);return descriptor};
const partial=(descriptor,bytes)=>{write(descriptor,bytes.subarray(0,16));write(join(process.cwd(),'coverage/partial-write-observed.txt'),String(stat(descriptor).size));throw new Error('Owned partial pending write failure')};
fs.writeFileSync=(file,bytes,...args)=>{if(typeof file==='number'&&descriptors.has(file))return partial(file,bytes);if(pending(file)){const descriptor=open(file,'wx',0o600);try{return partial(descriptor,bytes)}finally{close(descriptor)}}return write(file,bytes,...args)};
syncBuiltinESMExports();\n`)
  const result=runCoverageConsumer(root,preload)
  expect(result.error).toBeUndefined();expect(result.status,result.stdout+result.stderr).toBe(1)
  expect(readFileSync(join(root,'coverage/partial-write-observed.txt'),'utf8')).toBe('16')
  expect(existsSync(join(root,'coverage/coverage-final.json'))).toBe(false)
  expect(readdirSync(join(root,'coverage')).some(file=>file.endsWith('.pending'))).toBe(false)
},25000)

test('maintained_fallow_audit_scans_actual_changed_canary',()=>{
  const {root,base}=qualityFixture(),result=runQuality('fallow',['audit','--no-css','--base',base],root)
  expect(result.error).toBeUndefined();expect(result.status,result.stderr||result.stdout).toBe(1)
  expect(result.stdout+result.stderr).toMatch(/src[\\/]unused\.ts/)
  expect(result.stdout+result.stderr).toMatch(/unused.?file|unused.?export|dead.?code/i)
},40000)

test('fallow_declares_only_native_subprocess_roots_and_exact_generated_import',()=>{
  const {root,base}=qualityFixture()
  mkdirSync(join(root,'tests/helpers'),{recursive:true});mkdirSync(join(root,'scripts'))
  writeFileSync(join(root,'tests/helpers/generate-native-voice-envelope.ts'),"console.log('synthetic generator');\n")
  writeFileSync(join(root,'tests/helpers/runtime-probe.mjs'),"console.log('synthetic preload');\n")
  writeFileSync(join(root,'scripts/start-web.mjs'),"await import('../.output/server/index.mjs');\nawait import('../.output/server/genuinely-missing.mjs');\n")
  writeFileSync(join(root,'scripts/test-prerequisites.mjs'),"console.log('synthetic prerequisite decoder');\n")
  writeFileSync(join(root,'scripts/undeclared-prerequisite-sibling.mjs'),"console.log('synthetic undeclared sibling');\n")
  writeFileSync(join(root,'src/main.tsx'),readFileSync(join(root,'src/main.tsx'),'utf8')+"import './genuinely-missing';\n")
  const fixtureConfig: {entry:string[];health:{coverage:string|null}} = JSON.parse(readFileSync(join(repositoryRoot,'.fallowrc.json'),'utf8'))
  expect(fixtureConfig.entry).toEqual(['scripts/start-web.mjs','scripts/test-prerequisites.mjs','tests/helpers/generate-native-voice-envelope.ts'])
  fixtureConfig.health.coverage = null
  writeFileSync(join(root,'.fallowrc.json'),JSON.stringify(fixtureConfig))
  const result=runQuality('fallow',['audit','--no-css','--base',base],root)
  expect(result.error).toBeUndefined();expect(result.status,result.stderr||result.stdout).toBe(1)
  const output=result.stdout+result.stderr
  expect(output).toMatch(/src[\\/]unused\.ts/)
  expect(output).toContain('undeclared-prerequisite-sibling.mjs')
  expect(output).toContain('./genuinely-missing')
  expect(output).toContain('../.output/server/genuinely-missing.mjs')
  expect(output).not.toContain('generate-native-voice-envelope.ts')
  expect(output).not.toContain('runtime-probe.mjs')
  expect(output).not.toMatch(/(?:^|[\\/])test-prerequisites\.mjs/)
  expect(output).not.toContain('../.output/server/index.mjs')
},40000)

test('fallow_ignores_only_generated_route_tree_clones_and_keeps_handwritten_clones',()=>{
  const {root}=qualityFixture()
  const body=Array.from({length:18},(_,index)=>`  console.log('synthetic clone step ${index}');`).join('\n')
  const source=`export function cloned(){\n${body}\n}\n`
  for(const name of ['routeTree.gen.ts','handwritten-a.ts','handwritten-b.ts'])writeFileSync(join(root,'src',name),source)
  writeFileSync(join(root,'.fallowrc.json'),readFileSync(join(repositoryRoot,'.fallowrc.json')))
  const result=runQuality('fallow',['dupes','--format','json','--quiet'],root)
  expect(result.error).toBeUndefined();expect([0,1]).toContain(result.status)
  expect(result.stdout).toContain('handwritten-a.ts');expect(result.stdout).toContain('handwritten-b.ts')
  expect(result.stdout).not.toContain('routeTree.gen.ts')
},40000)

test('reviewed_fixed_authority_clone_exemption_expires_on_predicate_or_occurrence_change',()=>{
  const {root}=qualityFixture()
  mkdirSync(join(root,'scripts'))
  const web=readFileSync(join(repositoryRoot,'scripts/web-credentials.mjs'),'utf8')
  const migration=readFileSync(join(repositoryRoot,'scripts/migration-credentials.mjs'),'utf8')
  const webPath=join(root,'scripts/web-credentials.mjs'),migrationPath=join(root,'scripts/migration-credentials.mjs')
  writeFileSync(webPath,web);writeFileSync(migrationPath,migration)
  writeFileSync(join(root,'.fallowrc.json'),readFileSync(join(repositoryRoot,'.fallowrc.json')))
  function groups(){
    const result=runQuality('fallow',['dupes','--format','json','--quiet'],root)
    expect(result.error).toBeUndefined();expect([0,1]).toContain(result.status)
    const report: {clone_groups:{fingerprint:string;instances:{file:string}[]}[]} = JSON.parse(result.stdout)
    return report.clone_groups
  }
  expect(groups().some(group=>group.fingerprint==='dup:2cc8a7df')).toBe(false)
  const changedWeb=web.replace('url.pathname.length < 2','url.pathname.length < 3')
  const changedMigration=migration.replace('url.pathname.length < 2','url.pathname.length < 3')
  expect(changedWeb).not.toBe(web);expect(changedMigration).not.toBe(migration)
  writeFileSync(webPath,changedWeb);writeFileSync(migrationPath,changedMigration)
  expect(groups().some(group=>group.instances.some(instance=>instance.file.endsWith('web-credentials.mjs'))&&group.instances.some(instance=>instance.file.endsWith('migration-credentials.mjs')))).toBe(true)
  writeFileSync(webPath,web);writeFileSync(migrationPath,migration)
  writeFileSync(join(root,'scripts/third-credential-consumer.mjs'),web)
  expect(groups().some(group=>group.fingerprint==='dup:2cc8a7df'&&group.instances.length===3)).toBe(true)
},40000)
test('native_complexity_comment_is_function_scoped_and_expires_on_content_or_count_change',()=>{
  const {root,base}=qualityFixture(),path=join(root,'src/scenario.ts')
  rmSync(join(root,'src/unused.ts'))
  writeFileSync(join(root,'src/App.tsx'),"export function App({value}:{value:string}){return <div>{value}</div>}\n")
  writeFileSync(join(root,'src/main.tsx'),readFileSync(join(root,'src/main.tsx'),'utf8')+"import {cohesiveScenario} from './scenario';console.log(cohesiveScenario([1,2,3]));\n")
  const fixtureConfig: {health:{coverage:string|null}} = JSON.parse(readFileSync(join(repositoryRoot,'.fallowrc.json'),'utf8'))
  fixtureConfig.health.coverage=null
  writeFileSync(join(root,'.fallowrc.json'),JSON.stringify(fixtureConfig))
  const scenario=`export function cohesiveScenario(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    if (value >= 0 && value < 100 && Number.isFinite(value)) {
      if (value % 2 === 0 || value % 3 === 0 || value % 5 === 0) total += value;
      else if (value % 7 === 0 || value % 11 === 0 || value % 13 === 0) total -= value;
      else if (value % 17 === 0 || value % 19 === 0) total *= 2;
    } else if (value < -100 || value > 1000 || !Number.isInteger(value)) {
      if (total > 0 && total < 100 && value < 0) total = 0;
      else if (total < 0 && value > 0) total = -total;
    } else if (value === 100 || value === -100 || value === 1000) total++;
  }
  return total;
}
`
  function audit(source:string) {
    writeFileSync(path,source)
    const result=runQuality('fallow',['audit','--no-css','--base',base,'--format','json','--quiet'],root)
    expect(result.error).toBeUndefined()
    const report:{version:string;verdict:string;complexity:{findings:{name:string;cyclomatic:number;cognitive:number;introduced:boolean}[]}}=JSON.parse(result.stdout)
    expect(report.version).toBe('3.18.0')
    return {result,report}
  }
  const unsuppressed=audit(scenario)
  expect(unsuppressed.result.status,unsuppressed.result.stderr||unsuppressed.result.stdout).toBe(1)
  expect(unsuppressed.report.verdict).toBe('fail')
  const finding=unsuppressed.report.complexity.findings.find(item=>item.name==='cohesiveScenario')
  expect(finding?.cyclomatic).toBeGreaterThan(20);expect(finding?.cognitive).toBeGreaterThan(15)
  expect(finding?.introduced).toBe(true)
  const directive='// fallow-ignore-next-line complexity -- synthetic cohesive scenario; reviewed canary only'
  const suppressedSource=directive+'\n'+scenario
  const suppressed=audit(suppressedSource)
  expect(suppressed.result.status,suppressed.result.stderr||suppressed.result.stdout).toBe(0)
  expect(suppressed.report.verdict).toBe('pass')
  expect(suppressed.report.complexity.findings).toEqual([])
  // This expiry consumer is deliberately limited to the owned synthetic fixture.
  function reviewedSyntheticScenario() {
    const api=new API({cwd:root})
    try {
      const snapshot=api.updateSnapshot({openFiles:[path]})
      try {
        const program=snapshot.getDefaultProjectForFile(path)?.program,source=program?.getSourceFile(path)
        if(!program||!source)throw new Error('Synthetic exception source was not parsed')
        expect(program.getSyntacticDiagnostics(path)).toEqual([])
        const targets=source.statements.filter(isFunctionDeclaration).filter(item=>item.name?.getText(source)==='cohesiveScenario')
        const scanner=createScanner(false,LanguageVariant.Standard,source.text),markers:{start:number;end:number;text:string}[]=[]
        for(let token=scanner.scan();token!==SyntaxKind.EndOfFile;token=scanner.scan()) {
          if(token!==SyntaxKind.SingleLineCommentTrivia&&token!==SyntaxKind.MultiLineCommentTrivia)continue
          const text=scanner.getTokenText()
          if(text.includes('fallow-ignore')&&text.includes('complexity'))markers.push({start:scanner.getTokenStart(),end:scanner.getTokenEnd(),text})
        }
        expect(targets,'Synthetic exception target or marker count expired').toHaveLength(1)
        expect(markers,'Synthetic exception target or marker count expired').toHaveLength(1)
        const target=targets[0]!,marker=markers[0]!,body=target.body,start=target.getStart(source),end=target.getEnd()
        if(!body)throw new Error('Synthetic exception function has no body')
        expect(start).toBeGreaterThanOrEqual(0);expect(end).toBeLessThanOrEqual(source.text.length)
        expect(body.getStart(source)).toBeGreaterThanOrEqual(start);expect(body.getEnd()).toBeLessThanOrEqual(end)
        expect(marker.text).toBe(directive);expect(marker.start).toBeLessThan(start)
        expect(source.text.slice(marker.end,start)).toMatch(/^\r?\n[ \t]*$/)
        const digest=(text:string)=>createHash('sha256').update(text,'utf8').digest('hex')
        expect(digest(source.text.slice(start,end)),'Synthetic exception content expired').toBe('c007313ff9709021b819cbede0f1d868fc054a8f46700daf33b18d3172d9ef2c')
        expect(digest(source.text.slice(body.getStart(source),body.getEnd())),'Synthetic exception content expired').toBe('e95d4c7d20acba56e2d57c036e574f6a516034c6fc701b55afdfaf6d313dea96')
      } finally {snapshot.dispose()}
    } finally {api.close()}
  }
  expect(()=>reviewedSyntheticScenario()).not.toThrow()
  const changed=audit(suppressedSource.replace('total *= 2','total *= 3'))
  expect(changed.result.status,changed.result.stderr||changed.result.stdout).toBe(0)
  expect(changed.report.verdict).toBe('pass')
  expect(()=>reviewedSyntheticScenario()).toThrow('Synthetic exception content expired')
  for(const source of [scenario,suppressedSource.replace('reviewed canary only','unreviewed'),directive+'\n\n'+scenario]) {
    writeFileSync(path,source)
    expect(()=>reviewedSyntheticScenario()).toThrow()
  }
  writeFileSync(path,suppressedSource+'\nfunction cohesiveScenario(value:number){return value}\n')
  expect(()=>reviewedSyntheticScenario()).toThrow('Synthetic exception target or marker count expired')
  const other=`export function otherScenario(value: number): string {
  if ((value > 0 && value < 10) || (value > 20 && value < 30) || (value > 40 && value < 50) || (value > 60 && value < 70) || (value > 80 && value < 90) || (value > 100 && value < 110) || (value > 120 && value < 130) || (value > 140 && value < 150) || (value > 160 && value < 170) || (value > 180 && value < 190) || (value > 200 && value < 210)) return 'bounded';
  return 'outside';
}
`
  writeFileSync(join(root,'src/main.tsx'),readFileSync(join(root,'src/main.tsx'),'utf8')+"import {otherScenario} from './scenario';console.log(otherScenario(25));\n")
  const additional=audit(suppressedSource+other)
  expect(additional.result.status,additional.result.stderr||additional.result.stdout).toBe(1)
  expect(additional.report.verdict).toBe('fail')
  expect(additional.report.complexity.findings.map(item=>item.name)).toEqual(['otherScenario'])
  const broadened=audit(suppressedSource+directive+'\n'+other)
  expect(broadened.result.status,broadened.result.stderr||broadened.result.stdout).toBe(0)
  expect(broadened.report.verdict).toBe('pass')
  expect(()=>reviewedSyntheticScenario()).toThrow('Synthetic exception target or marker count expired')
  const fixturePackage=join(root,'package.json')
  writeFileSync(fixturePackage,readFileSync(fixturePackage,'utf8').replace('"vite":"8.2.2"','"vite":"8.2.2","vitest":"4.1.11"'))
  mkdirSync(join(root,'tests'))
  const testPath=join(root,'tests/scenario.test.ts')
  const callback=`async()=>{\n  const values = [1, 2, 3];${scenario.slice(scenario.indexOf('{')+1).trimEnd()}`
  const reviewedCall=`test('synthetic reviewed SSR callback',${callback})\n`
  const adjacentCall=`test('synthetic adjacent unmarked callback',${callback})\n`
  function callbackAudit(source:string) {
    writeFileSync(testPath,"import {test} from 'vitest';\n"+source)
    const result=runQuality('fallow',['audit','--no-css','--base',base,'--format','json','--quiet'],root)
    expect(result.error).toBeUndefined()
    const report:{version:string;verdict:string;complexity:{findings:{path:string;line:number;name:string;cyclomatic:number;cognitive:number}[]}}=JSON.parse(result.stdout)
    expect(report.version).toBe('3.18.0')
    return {result,report}
  }
  const unmarkedCallbacks=callbackAudit(reviewedCall+adjacentCall)
  expect(unmarkedCallbacks.result.status,unmarkedCallbacks.result.stderr||unmarkedCallbacks.result.stdout).toBe(1)
  expect(unmarkedCallbacks.report.complexity.findings).toHaveLength(2)
  const markedCallback=callbackAudit(directive+'\n'+reviewedCall)
  expect(markedCallback.result.status,markedCallback.result.stderr||markedCallback.result.stdout).toBe(0)
  expect(markedCallback.report.verdict).toBe('pass')
  expect(markedCallback.report.complexity.findings).toEqual([])
  const adjacent=callbackAudit(directive+'\n'+reviewedCall+adjacentCall)
  expect(adjacent.result.status,adjacent.result.stderr||adjacent.result.stdout).toBe(1)
  expect(adjacent.report.verdict).toBe('fail')
  expect(adjacent.report.complexity.findings).toHaveLength(1)
  expect(adjacent.report.complexity.findings[0]?.path.replaceAll('\\','/')).toBe('tests/scenario.test.ts')
  expect(adjacent.report.complexity.findings[0]?.line).toBe(unmarkedCallbacks.report.complexity.findings[1]!.line+1)
},40000)

test('reviewed_static_ssr_comments_expire_on_source_placement_or_global_count_change',()=>{
  const ssrFile='tests/ui/sparra-panels.test.tsx',path=join(repositoryRoot,ssrFile)
  // Fixed candidates from TASK5_REAL_RESIDUAL_TEST_TARGET_SCOPE_20261003; hashes are literal review anchors.
  const targets=[
    ['detail and inbox preserve the translated native category and observed number source in both locales',
      '// fallow-ignore-next-line complexity -- reviewed SSR A; TASK5_REAL_RESIDUAL_TEST_TARGET_SCOPE_20261003',
      '505579469d6fcd93024a08634ca20b61b2045b429b8f4bb327ff8252abe0fe47',
      '1525a9d0d8cb26f1dcd23aa55114ff2a59a44f4fe17e6ae951aa8c50ba4cc1a2',
      '2926e5a873fd35194ddb20d0c08a8240b4821283054779465679a486c2b8eef4'],
    ['request detail keeps observed metadata, ordered partial turns, pinned knowledge and disabled SSR actions in both locales',
      '// fallow-ignore-next-line complexity -- reviewed SSR B; TASK5_REAL_RESIDUAL_TEST_TARGET_SCOPE_20261003',
      '28993a944f29073f6d662ba6467c7e2a74bc1ad94df5c24a70c165699b0f840d',
      'd95fc9a956b2aa87bd13d88ce92ead38e0ef940f0c16b1d89ea963fffee5a70c',
      'f31e755efa9a7314df161505f4371327ac90d37f6db8054661dded761f76932b'],
    ['request detail retains empty contact and absent snapshot fallbacks without treating complete quality as partial',
      '// fallow-ignore-next-line complexity -- reviewed SSR C; TASK5_REAL_RESIDUAL_TEST_TARGET_SCOPE_20261003',
      '93940b392350ec531f4d0b6194a3fef3528d19e782d44571b1c6347749ec39f6',
      'b3eb03bb218eb136a82a27ee99aaca705b75bc98e3a6c1e2189cc5122d0bdf3e',
      'f79a2173697ebb9cefb6bd5a449566c6b4d274a11d079aef9097b5783f1f59f7'],
    ['queued and completed erasure receipts take precedence over loaded private detail in both locales',
      '// fallow-ignore-next-line complexity -- reviewed SSR D; TASK5_REAL_RESIDUAL_TEST_TARGET_SCOPE_20261003',
      '992924250fb09143e0bfe0988cd328d0ce854971d0099bb5953b9b2bf2c18247',
      '5559034fd25363629d37782321bce1567af1691425f466d72178ee356cd6057f',
      'b020ca6f8f8583790de40e94f6c6f18cd026d64e1dc674c64ee232e74c13d698'],
  ] as const
  const inventory=spawnSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:repositoryRoot,encoding:'utf8',windowsHide:true,timeout:5000})
  expect(inventory.error).toBeUndefined();expect(inventory.status,inventory.stderr).toBe(0)
  const config:{ignorePatterns:string[]}=JSON.parse(readFileSync(join(repositoryRoot,'.fallowrc.json'),'utf8'))
  expect(config.ignorePatterns).toEqual(['tools/oxlint/anti-slop/**','coverage/**'])
  const files=[...new Set(inventory.stdout.split('\0'))].filter(file=>/\.[cm]?[jt]sx?$/.test(file)&&!file.startsWith('tools/oxlint/anti-slop/')&&!file.startsWith('coverage/'))
  const sources=new Map(files.map(file=>{
    const sourcePath=join(repositoryRoot,file)
    if(lstatSync(sourcePath).isSymbolicLink())throw new Error('Reviewed SSR audit scope contains a symlink')
    return [file,readFileSync(sourcePath,'utf8')]
  }))
  function actualMarkerRanges(source:SourceFile,offset:number) {
    const text=source.text,token=getTokenAtPosition(source,offset)
    if(token.kind===SyntaxKind.JsxText)return []
    const ranges=[...(getLeadingCommentRanges(text,token.getFullStart())??[]),...(getTrailingCommentRanges(text,token.getFullStart())??[])]
    let doc=token
    while(doc.parent&&doc.kind!==SyntaxKind.JSDoc)doc=doc.parent
    if(doc.kind===SyntaxKind.JSDoc)ranges.push(...(getLeadingCommentRanges(text,doc.pos)??[]))
    return ranges.filter(range=>range.pos<=offset&&offset<range.end)
  }
  let overlays=new Map<string,string>(),openPaths=new Set<string>()
  let latestSnapshot:Snapshot|undefined
  const api=new API({cwd:repositoryRoot,fs:{readFile:file=>overlays.get(resolve(file).toLowerCase()),fileExists:file=>overlays.has(resolve(file).toLowerCase())?true:undefined}})
  function collectCommentMarkers(snapshot:Snapshot,potential:[string,string][]) {
    const markers=new Map<string,{file:string;start:number;end:number;text:string}>()
    for(const [file,text] of potential) {
      const filePath=join(repositoryRoot,file),program=snapshot.getDefaultProjectForFile(filePath)?.program,source=program?.getSourceFile(filePath)
      if(!program||!source)throw new Error('Reviewed SSR comment source was not parsed')
      expect(source.text,'Reviewed SSR comment source overlay expired').toBe(text)
      expect(program.getSyntacticDiagnostics(filePath),'Reviewed SSR comment source syntax expired').toEqual([])
      for(const match of text.matchAll(/fallow-ignore/gi)) {
        for(const range of actualMarkerRanges(source,match.index)) {
          expect(range.pos).toBeGreaterThanOrEqual(0);expect(range.end).toBeLessThanOrEqual(text.length)
          markers.set(`${file}:${range.pos}:${range.end}`,{file,start:range.pos,end:range.end,text:text.slice(range.pos,range.end)})
        }
      }
    }
    return [...markers.values()]
  }
  function parsedCommentSources(candidate:Map<string,string>) {
    // Every maintained file is inspected; parse only text candidates so strings cannot become comments.
    const potential=[...candidate].filter(([,text])=>text.toLowerCase().includes('fallow-ignore'))
    const nextOverlays=new Map(potential.map(([file,text])=>[resolve(repositoryRoot,file).toLowerCase(),text]))
    const nextOpenPaths=new Set(potential.map(([file])=>join(repositoryRoot,file)))
    const closePaths=[...openPaths].filter(file=>!nextOpenPaths.has(file)||nextOverlays.get(resolve(file).toLowerCase())!==overlays.get(resolve(file).toLowerCase()))
    const fileChanges:Required<FileChangeSummary>={changed:[],created:[],deleted:[]}
    for(const file of new Set([...openPaths,...nextOpenPaths])) {
      const key=resolve(file).toLowerCase()
      if(nextOverlays.get(key)===overlays.get(key))continue
      // Real-file overlays restore disk content; existing virtual overlays must reload changed text.
      if(existsSync(file)||(overlays.has(key)&&nextOverlays.has(key)))fileChanges.changed.push(file)
      else if(nextOverlays.has(key))fileChanges.created.push(file)
      else fileChanges.deleted.push(file)
    }
    overlays=nextOverlays
    // Keep the diff base alive; a membership transition makes the server rebuild its default project.
    if(closePaths.length) {
      const previous=latestSnapshot
      latestSnapshot=api.updateSnapshot({closeFiles:closePaths,fileChanges})
      for(const file of closePaths)openPaths.delete(file)
      previous?.dispose()
    }
    const previous=latestSnapshot
    latestSnapshot=api.updateSnapshot({openFiles:[...nextOpenPaths].filter(file=>!openPaths.has(file)),fileChanges})
    openPaths=nextOpenPaths
    previous?.dispose()
    const snapshot=latestSnapshot
    return {snapshot,markers:collectCommentMarkers(snapshot,potential)}
  }
  function actualComments(candidate:Map<string,string>) {
    return parsedCommentSources(candidate).markers
  }
  try {
    const directive=targets[0][1]
    const textOnly=[
      `const plain = ${JSON.stringify(directive)};`,
      'const template = `value ${1} '+directive+'`;',
      'const regex = /fallow-ignore #/;',
      'const jsx = <p>'+directive+'</p>;',
    ].join('\n')
    expect(actualComments(new Map([[ssrFile,textOnly]]))).toEqual([])
    for(const source of [
      'function orphan(){ /* fallow-ignore complexity -- unknown empty block */ }',
      'const nested = `value ${(()=>{ /* fallow-ignore complexity -- unknown template expression */ return 1 })()}`;',
      'const jsxComment = <p>{/* fallow-ignore complexity -- unknown JSX expression */}{1}</p>;',
      '/** fallow-ignore complexity -- unknown JSDoc */\nconst value = 1;',
      '// fallow-ignore complexity -- unknown EOF',
    ])expect(actualComments(new Map([[ssrFile,source]]))).toHaveLength(1)
    function reviewedCallbacks(candidate:Map<string,string>) {
      const {snapshot,markers}=parsedCommentSources(candidate)
      expect(markers,'Reviewed SSR marker count expired').toHaveLength(4)
      expect(markers.every(marker=>marker.file===ssrFile),'Reviewed SSR marker file expired').toBe(true)
      expect(markers.map(marker=>marker.text).sort(),'Reviewed SSR canonical markers expired').toEqual(targets.map(target=>target[1]).sort())
      const text=candidate.get(ssrFile)
      const project=snapshot.getDefaultProjectForFile(path),program=project?.program,source=program?.getSourceFile(path)
      if(!project||!program||!source)throw new Error('Reviewed SSR source was not parsed')
      expect(source.text,'Reviewed SSR source overlay expired').toBe(text)
      expect(program.getSyntacticDiagnostics(path),'Reviewed SSR syntax expired').toEqual([])
      const imports=source.statements.filter(isImportDeclaration).filter(item=>isStringLiteral(item.moduleSpecifier)&&item.moduleSpecifier.text==='vitest')
      expect(imports,'Reviewed SSR import expired').toHaveLength(1)
      const vitestImport=imports[0]!,clause=vitestImport.importClause,bindings=clause?.namedBindings
      expect(vitestImport.getText(source),'Reviewed SSR import expired').toBe("import { expect, test } from 'vitest'")
      if(!clause||clause.phaseModifier!==undefined||!bindings||!isNamedImports(bindings))throw new Error('Reviewed SSR import expired')
      const importedTests=bindings.elements.filter(item=>item.name.text==='test'&&!item.propertyName&&!item.isTypeOnly)
      expect(importedTests,'Reviewed SSR import expired').toHaveLength(1)
      const checker=project.checker,binding=checker.getSymbolAtLocation(importedTests[0]!.name)
      expect(binding?.declarations,'Reviewed SSR import binding expired').toHaveLength(1)
      const calls:CallExpression[]=[]
      function visit(node:Node) {if(isCallExpression(node))calls.push(node);node.forEachChild(visit)}
      visit(source)
      const digest=(text:string)=>createHash('sha256').update(text,'utf8').digest('hex')
      function reviewedTarget(source:SourceFile,[title,directive,bodyHash,arrowHash,callHash]:typeof targets[number]) {
        const matches=calls.filter(call=>call.arguments[0]&&isStringLiteral(call.arguments[0])&&call.arguments[0].text===title)
        expect(matches,'Reviewed SSR target count expired').toHaveLength(1)
        const call=matches[0]!,statement=source.statements.find(item=>isExpressionStatement(item)&&item.expression===call),callback=call.arguments[1]
        if(!statement||!isIdentifier(call.expression)||call.expression.text!=='test'||call.arguments.length!==2||!callback||!isArrowFunction(callback)||callback.parameters.length!==0||!isBlock(callback.body)||callback.modifiers?.length!==1||callback.modifiers[0]?.kind!==SyntaxKind.AsyncKeyword)throw new Error('Reviewed SSR callback shape expired')
        expect(checker.getSymbolAtLocation(call.expression)?.id,'Reviewed SSR import binding expired').toBe(binding?.id)
        expect(digest(callback.body.getText(source)),'Reviewed SSR body expired').toBe(bodyHash)
        expect(digest(callback.getText(source)),'Reviewed SSR callback expired').toBe(arrowHash)
        expect(digest(call.getText(source)),'Reviewed SSR whole call expired').toBe(callHash)
        const marker=markers.find(item=>item.text===directive)!,start=statement.getStart(source)
        expect(marker.start,'Reviewed SSR marker placement expired').toBeLessThan(start)
        expect(source.text.slice(marker.end,start),'Reviewed SSR marker placement expired').toMatch(/^\r?\n[ \t]*$/)
      }
      for(const target of targets)reviewedTarget(source,target)
      let reconstructed=source.text
      for(const marker of [...markers].sort((left,right)=>right.start-left.start)) {
        expect(marker.start===0||source.text[marker.start-1]==='\n','Reviewed SSR marker line expired').toBe(true)
        const newlineLength=source.text.slice(marker.end,marker.end+2)==='\r\n'?2:1
        expect(source.text.slice(marker.end,marker.end+newlineLength),'Reviewed SSR marker line expired').toMatch(/^\r?\n$/)
        reconstructed=reconstructed.slice(0,marker.start)+reconstructed.slice(marker.end+newlineLength)
      }
      expect(digest(reconstructed),'Reviewed SSR whole file expired').toBe('3b6cf333378bf4961dd7b735ecabe478c4631fb9338758e8e6bf18f75737168f')
    }
    expect(()=>reviewedCallbacks(sources)).not.toThrow()
    const original=sources.get(ssrFile)!,title=targets[0][0]
    function changed(source:string) {const candidate=new Map(sources);candidate.set(ssrFile,source);return candidate}
    const blockStart=original.indexOf(directive),blockEnd=original.indexOf('\n\nconst requestDetail:',blockStart)
    expect(blockStart).toBeGreaterThanOrEqual(0);expect(blockEnd).toBeGreaterThan(blockStart)
    const markedBlock=original.slice(blockStart,blockEnd)
    for(const source of [
      original.replace("configurationRevision:7,treatedAt:null,resultAvailability:'available'","configurationRevision:8,treatedAt:null,resultAvailability:'available'"),
      original.replace("from 'react-dom/server'","from 'react-dom/client'"),
      original.replace("const unavailable=async():Promise<never>=>{throw new Error('SSR must not mutate')}","const unavailable=async():Promise<never>=>await new Promise<never>(()=>{})"),
      original.slice(0,blockStart)+original.slice(blockEnd)+'\n'+markedBlock+'\n',
    ]) {
      expect(source,'Outside-call mutation must change the reviewed context').not.toBe(original)
      expect(()=>reviewedCallbacks(changed(source))).toThrow('Reviewed SSR whole file expired')
    }
    for(const source of [
      original.replace(directive+'\n',''),
      original.replace(directive+'\n',directive+'\n\n'),
      original.replace(directive,directive.replace('reviewed SSR A','unreviewed SSR A')),
      original.replace(directive,directive.replace('fallow-ignore-next-line','fallow-ignore-file')),
      original.replace(directive,'/* '+directive.slice(3)+' */'),
      original.replace(title,'unreviewed SSR title'),
      original.replace(`test('${title}',`,`expect('${title}',`),
      original.replace("from 'vitest'","from './unreviewed-vitest'"),
      original.replace('Demande fictive','Changed request'),
      original.replace(`test('${title}',async()=>{`,`test('${title}',()=>{`),
      original.replace(`test('${title}',async()=>{`,`test('${title}',async(value)=>{`),
      original+`\ntest('${title}',async()=>{})\n`,
      original+'\ntest(',
      original+'\n'+directive+'\nvoid 0\n',
    ])expect(()=>reviewedCallbacks(changed(source))).toThrow()
    expect(()=>reviewedCallbacks(sources)).not.toThrow()
    const extraFile=new Map(sources);extraFile.set('tests/unreviewed-ssr.test.ts',directive+'\nvoid 0\n')
    expect(()=>reviewedCallbacks(extraFile)).toThrow('Reviewed SSR marker count expired')
    const moved=changed(original.replace(directive+'\n',''));moved.set('tests/unreviewed-ssr.test.ts',directive+'\nvoid 0\n')
    expect(()=>reviewedCallbacks(moved)).toThrow('Reviewed SSR marker file expired')
    expect(()=>reviewedCallbacks(sources)).not.toThrow()
    const appendedString=changed(original+`\nconst markerText = ${JSON.stringify(directive)}\n`)
    expect(actualComments(appendedString)).toEqual(actualComments(sources))
    expect(()=>reviewedCallbacks(appendedString)).toThrow('Reviewed SSR whole file expired')
    const virtualFile='tests/unreviewed-ssr-virtual-edit.test.ts'
    expect(existsSync(join(repositoryRoot,virtualFile))).toBe(false)
    const virtualCreated=new Map(sources);virtualCreated.set(virtualFile,'// fallow-ignore complexity -- virtual initial\nvoid 0\n')
    expect(actualComments(virtualCreated).filter(marker=>marker.file===virtualFile).map(marker=>marker.text)).toEqual(['// fallow-ignore complexity -- virtual initial'])
    const virtualChanged=new Map(virtualCreated);virtualChanged.set(virtualFile,'// fallow-ignore complexity -- virtual revised\nvoid 0\n')
    expect(actualComments(virtualChanged).filter(marker=>marker.file===virtualFile).map(marker=>marker.text)).toEqual(['// fallow-ignore complexity -- virtual revised'])
    expect(()=>reviewedCallbacks(sources)).not.toThrow()
  } finally {try {latestSnapshot?.dispose()} finally {api.close()}}
},50000)

test('maintained_doctor_changed_scope_reports_actual_component_rule',()=>{
  const {root,base}=qualityFixture(),result=runQuality('react-doctor',['.','--no-telemetry','--no-dead-code','--no-supply-chain','--blocking','none','--yes','--no-color','--scope','changed','--base',base],root)
  expect(result.error).toBeUndefined();expect(result.status,result.stderr||result.stdout).toBe(0)
  expect(result.stdout+result.stderr).toMatch(/App\.tsx/)
  expect(result.stdout+result.stderr).toContain('react-doctor/no-mirror-prop-effect')
},40000)
