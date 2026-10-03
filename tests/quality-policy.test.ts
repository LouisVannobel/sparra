import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { API } from 'typescript/unstable/sync'
import { createScanner, getLeadingCommentRanges, getTokenAtPosition, getTrailingCommentRanges, isArrowFunction, isBlock, isCallExpression, isExpressionStatement, isFunctionDeclaration, isIdentifier, isImportDeclaration, isNamedImports, isStringLiteral, LanguageVariant, SyntaxKind } from 'typescript/unstable/ast'
import type { CallExpression, Node, SourceFile } from 'typescript/unstable/ast'
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
  function actualComments(candidate:Map<string,string>) {
    // Every maintained file is inspected; parse only text candidates so strings cannot become comments.
    const potential=[...candidate].filter(([,text])=>text.toLowerCase().includes('fallow-ignore'))
    const overlays=new Map(potential.map(([file,text])=>[resolve(repositoryRoot,file).toLowerCase(),text]))
    const api=new API({cwd:repositoryRoot,fs:{readFile:file=>overlays.get(resolve(file).toLowerCase()),fileExists:file=>overlays.has(resolve(file).toLowerCase())?true:undefined}})
    const markers=new Map<string,{file:string;start:number;end:number;text:string}>()
    try {
      const snapshot=api.updateSnapshot({openFiles:potential.map(([file])=>join(repositoryRoot,file))})
      try {
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
      } finally {snapshot.dispose()}
    } finally {api.close()}
    return [...markers.values()]
  }
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
    const markers=actualComments(candidate)
    expect(markers,'Reviewed SSR marker count expired').toHaveLength(4)
    expect(markers.every(marker=>marker.file===ssrFile),'Reviewed SSR marker file expired').toBe(true)
    expect(markers.map(marker=>marker.text).sort(),'Reviewed SSR canonical markers expired').toEqual(targets.map(target=>target[1]).sort())
    const text=candidate.get(ssrFile)
    const api=new API({cwd:repositoryRoot,fs:{readFile:file=>resolve(file).toLowerCase()===path.toLowerCase()?text:undefined}})
    try {
      const snapshot=api.updateSnapshot({openFiles:[path]})
      try {
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
        expect(digest(reconstructed),'Reviewed SSR whole file expired').toBe('fa8993933c52afcba57e7d0fc21543a72bb72582935a371918782d44d30768b3')
      } finally {snapshot.dispose()}
    } finally {api.close()}
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
  const extraFile=new Map(sources);extraFile.set('tests/unreviewed-ssr.test.ts',directive+'\nvoid 0\n')
  expect(()=>reviewedCallbacks(extraFile)).toThrow('Reviewed SSR marker count expired')
  const moved=changed(original.replace(directive+'\n',''));moved.set('tests/unreviewed-ssr.test.ts',directive+'\nvoid 0\n')
  expect(()=>reviewedCallbacks(moved)).toThrow('Reviewed SSR marker file expired')
  const appendedString=changed(original+`\nconst markerText = ${JSON.stringify(directive)}\n`)
  expect(actualComments(appendedString)).toEqual(actualComments(sources))
  expect(()=>reviewedCallbacks(appendedString)).toThrow('Reviewed SSR whole file expired')
},50000)

test('maintained_doctor_changed_scope_reports_actual_component_rule',()=>{
  const {root,base}=qualityFixture(),result=runQuality('react-doctor',['.','--no-telemetry','--no-dead-code','--no-supply-chain','--blocking','none','--yes','--no-color','--scope','changed','--base',base],root)
  expect(result.error).toBeUndefined();expect(result.status,result.stderr||result.stdout).toBe(0)
  expect(result.stdout+result.stderr).toMatch(/App\.tsx/)
  expect(result.stdout+result.stderr).toContain('react-doctor/no-mirror-prop-effect')
},40000)
