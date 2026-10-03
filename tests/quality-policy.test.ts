import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { API } from 'typescript/unstable/sync'
import { createScanner, isFunctionDeclaration, LanguageVariant, SyntaxKind } from 'typescript/unstable/ast'
import { afterAll, beforeAll, expect, test } from 'vitest'

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
  writeFileSync(join(root,'src/main.tsx'),readFileSync(join(root,'src/main.tsx'),'utf8')+"import './genuinely-missing';\n")
  const fixtureConfig: {health:{coverage:string|null}} = JSON.parse(readFileSync(join(repositoryRoot,'.fallowrc.json'),'utf8'))
  fixtureConfig.health.coverage = null
  writeFileSync(join(root,'.fallowrc.json'),JSON.stringify(fixtureConfig))
  const result=runQuality('fallow',['audit','--no-css','--base',base],root)
  expect(result.error).toBeUndefined();expect(result.status,result.stderr||result.stdout).toBe(1)
  const output=result.stdout+result.stderr
  expect(output).toMatch(/src[\\/]unused\.ts/)
  expect(output).toContain('./genuinely-missing')
  expect(output).toContain('../.output/server/genuinely-missing.mjs')
  expect(output).not.toContain('generate-native-voice-envelope.ts')
  expect(output).not.toContain('runtime-probe.mjs')
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
},40000)

test('maintained_doctor_changed_scope_reports_actual_component_rule',()=>{
  const {root,base}=qualityFixture(),result=runQuality('react-doctor',['.','--no-telemetry','--no-dead-code','--no-supply-chain','--blocking','none','--yes','--no-color','--scope','changed','--base',base],root)
  expect(result.error).toBeUndefined();expect(result.status,result.stderr||result.stdout).toBe(0)
  expect(result.stdout+result.stderr).toMatch(/App\.tsx/)
  expect(result.stdout+result.stderr).toContain('react-doctor/no-mirror-prop-effect')
},40000)
