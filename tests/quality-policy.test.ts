import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
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
  writeFileSync(join(root,'.fallowrc.json'),readFileSync(join(repositoryRoot,'.fallowrc.json')))
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
test('maintained_doctor_changed_scope_reports_actual_component_rule',()=>{
  const {root,base}=qualityFixture(),result=runQuality('react-doctor',['.','--no-telemetry','--no-dead-code','--no-supply-chain','--blocking','none','--yes','--no-color','--scope','changed','--base',base],root)
  expect(result.error).toBeUndefined();expect(result.status,result.stderr||result.stdout).toBe(0)
  expect(result.stdout+result.stderr).toMatch(/App\.tsx/)
  expect(result.stdout+result.stderr).toContain('react-doctor/no-mirror-prop-effect')
},40000)
