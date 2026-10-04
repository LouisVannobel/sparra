import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { readVoiceSourceFixture } from '../../scripts/voice-source-fixture.mjs'
import { installVoiceTokenizer } from '../../scripts/prepare-voice-source.mjs'

const modulePath='../../scripts/prepare-voice-source.mjs'

test('native tokenizer preparation verifies the public corpus and keeps it inside its owner',async()=>{
  const parent=await mkdtemp(join(tmpdir(),'sparra-tokenizer-test-'))
  try{
    const executable=process.env.SPARRA_VOICE_FIXTURE_PYTHON??(process.platform==='win32'?'C:/Users/louis/Documents/ChatGPT/.worktrees/sparra-voice-pilot/.venv/Scripts/python.exe':undefined)
    if(typeof executable!=='string')throw new Error('Missing qualified Voice fixture interpreter')
    const archive=await readFile(process.env.SPARRA_VOICE_TOKENIZER_ARCHIVE??'C:/Users/louis/.codex/artifacts/sparra/2026-10-04/public-test-prerequisites/punkt_tab.zip')
    const prepared=await installVoiceTokenizer(parent,executable,archive)
    expect(await readdir(join(prepared.NLTK_DATA,'tokenizers/punkt_tab'))).toEqual(['english','french'])
    expect(prepared.HOME).toBe(join(parent,'home'))
    const before=await readdir(parent),damaged=Buffer.from(archive);damaged[0]^=1
    await expect(installVoiceTokenizer(parent,executable,damaged)).rejects.toThrow('Native Voice preparation failed')
    expect(await readdir(parent)).toEqual(before)
  }finally{await rm(parent,{recursive:true,force:true})}
})

async function preparation(){
  const source:unknown=await import(modulePath).catch(()=>({}))
  if(typeof source!=='object'||source===null||!('prepareVoiceSource' in source)||typeof source.prepareVoiceSource!=='function')throw new Error('Missing runner-owned Voice preparation')
  return source.prepareVoiceSource
}

test('invalid explicit producer root fails without fixture fallback or deleting the external root',async()=>{
  const root=await mkdtemp(join(tmpdir(),'sparra-external-voice-'))
  try{
    await writeFile(join(root,'owner.txt'),'external')
    const prepare=await preparation()
    await expect(prepare({appRoot:process.cwd(),explicitRoot:root})).rejects.toThrow('Voice producer requires its canonical source and pinned virtual environment')
    expect(await readFile(join(root,'owner.txt'),'utf8')).toBe('external')
  }finally{await rm(root,{recursive:true,force:true})}
})

test('a relative explicit producer root cannot initiate hosted bootstrap',async()=>{
  const prepare=await preparation()
  await expect(prepare({appRoot:process.cwd(),explicitRoot:'relative'})).rejects.toThrow('Voice producer requires an explicit absolute root')
})

test('unsupported missing producer refuses downloads and leaves caller-owned directory unchanged',async()=>{
  const prepare=await preparation()
  const root=await mkdtemp(join(tmpdir(),'sparra-caller-voice-'))
  const platform=Object.getOwnPropertyDescriptor(process,'platform')
  if(!platform)throw new Error('Missing platform descriptor')
  try{
    Object.defineProperty(process,'platform',{...platform,value:'unsupported'})
    await mkdir(join(root,'scope'))
    await expect(prepare({appRoot:process.cwd(),scopeParent:join(root,'scope'),explicitRoot:null})).rejects.toThrow('Native Voice bootstrap requires Linux x64')
    expect(await readFile(join(root,'scope'),'utf8').then(()=>false,error=>error.code==='EISDIR')).toBe(true)
  }finally{Object.defineProperty(process,'platform',platform);await rm(root,{recursive:true,force:true})}
})

test('an aliased explicit root is refused without following or retiring its external source',async()=>{
  const root=await mkdtemp(join(tmpdir(),'sparra-alias-voice-'))
  try{
    await mkdir(join(root,'source'));await writeFile(join(root,'source','owner.txt'),'external')
    await symlink(join(root,'source'),join(root,'alias'),process.platform==='win32'?'junction':'dir')
    const prepare=await preparation()
    await expect(prepare({appRoot:process.cwd(),explicitRoot:join(root,'alias')})).rejects.toThrow('Voice producer requires its canonical source and pinned virtual environment')
    expect(await readFile(join(root,'source','owner.txt'),'utf8')).toBe('external')
  }finally{await rm(root,{recursive:true,force:true})}
})

test('runner-owned decoded source binds immutable members and retires only its acquired scope',async()=>{
  const module:unknown=await import(modulePath).catch(()=>({}))
  expect(typeof module==='object'&&module!==null&&'createVoiceSourceScope'in module&&typeof module.createVoiceSourceScope==='function').toBe(true)
  if(typeof module!=='object'||module===null||!('createVoiceSourceScope'in module)||typeof module.createVoiceSourceScope!=='function')return
  const parent=await mkdtemp(join(tmpdir(),'sparra-source-parent-')),outside=join(parent,'external')
  try{
    await mkdir(outside);await writeFile(join(outside,'owner.txt'),'external')
    const fixture=join(process.cwd(),'tests/fixtures/voice-source')
    const executable=process.env.SPARRA_VOICE_FIXTURE_PYTHON??(process.platform==='win32'?'C:/Users/louis/Documents/ChatGPT/.worktrees/sparra-voice-pilot/.venv/Scripts/python.exe':undefined)
    if(typeof executable!=='string')throw new Error('Missing qualified Voice fixture interpreter')
    const {members}=await readVoiceSourceFixture(await readFile(join(fixture,'voice-producer-source.tar.gz')),JSON.parse(await readFile(join(fixture,'voice-producer-source.manifest.json'),'utf8')),executable)
    const scope=await module.createVoiceSourceScope(parent,members)
    await scope.assertIdentity()
    await expect(scope.retire()).resolves.toBeUndefined()
    expect(await lstat(scope.directory).then(()=>false,error=>error.code==='ENOENT')).toBe(true)
    expect(await readdir(parent)).toEqual(['external'])
    expect(await readFile(join(outside,'owner.txt'),'utf8')).toBe('external')
    await expect(scope.assertIdentity()).rejects.toThrow('Native Voice preparation failed')
  }finally{await rm(parent,{recursive:true,force:true})}
})

test('runner-owned source detects member replacement before cleanup without following foreign descendants',async()=>{
  const module:unknown=await import(modulePath).catch(()=>({}))
  expect(typeof module==='object'&&module!==null&&'createVoiceSourceScope'in module&&typeof module.createVoiceSourceScope==='function').toBe(true)
  if(typeof module!=='object'||module===null||!('createVoiceSourceScope'in module)||typeof module.createVoiceSourceScope!=='function')return
  const parent=await mkdtemp(join(tmpdir(),'sparra-source-drift-'))
  try{
    const members=new Map([['input.txt',Buffer.from('frozen')]])
    const scope=await module.createVoiceSourceScope(parent,members)
    await chmod(join(scope.root,'input.txt'),0o600)
    await writeFile(join(scope.root,'input.txt'),'changed')
    await expect(scope.assertIdentity()).rejects.toThrow('Native Voice preparation failed')
    await scope.retire()
    expect(await readdir(parent)).toEqual([])
  }finally{await rm(parent,{recursive:true,force:true})}
})

test('partial decoded member rejection retires its owned scope before returning failure',async()=>{
  const {createVoiceSourceScope}=await import('../../scripts/prepare-voice-source.mjs')
  const parent=await mkdtemp(join(tmpdir(),'sparra-partial-voice-'))
  try{
    const scope=await createVoiceSourceScope(parent)
    await expect(scope.install(new Map([['one.txt',Buffer.from('one')],['../outside.txt',Buffer.from('outside')]]))).rejects.toThrow('Native Voice preparation failed')
    expect(await readdir(parent)).toEqual([])
  }finally{await rm(parent,{recursive:true,force:true})}
})

test('changed owned directory fails retirement and preserves the replacement',async()=>{
  const {createVoiceSourceScope}=await import('../../scripts/prepare-voice-source.mjs')
  const parent=await mkdtemp(join(tmpdir(),'sparra-replaced-voice-'))
  try{
    const scope=await createVoiceSourceScope(parent,new Map([['input.txt',Buffer.from('frozen')]]))
    await rename(scope.directory,scope.directory+'-original');await mkdir(scope.directory);await writeFile(join(scope.directory,'foreign.txt'),'foreign')
    await expect(scope.retire()).rejects.toThrow('Native Voice preparation failed')
    expect(await readFile(join(scope.directory,'foreign.txt'),'utf8')).toBe('foreign')
  }finally{await rm(parent,{recursive:true,force:true})}
})

test.each(['missing-member','extra-member','source-link'] as const)('owned source identity refuses %s and retires only its scope',async kind=>{
  const {createVoiceSourceScope}=await import('../../scripts/prepare-voice-source.mjs')
  const parent=await mkdtemp(join(tmpdir(),'sparra-source-shape-'))
  try{
    const outside=join(parent,'outside.txt');await writeFile(outside,'external')
    const scope=await createVoiceSourceScope(parent,new Map([['nested/input.txt',Buffer.from('frozen')]]))
    if(kind==='missing-member')await rm(join(scope.root,'nested/input.txt'))
    else if(kind==='extra-member')await writeFile(join(scope.root,'extra.txt'),'extra')
    else await symlink(parent,join(scope.root,'source-link'),process.platform==='win32'?'junction':'dir')
    await expect(scope.assertIdentity()).rejects.toThrow('Native Voice preparation failed')
    await scope.retire()
    expect(await readdir(parent)).toEqual(['outside.txt'])
    expect(await readFile(outside,'utf8')).toBe('external')
  }finally{await rm(parent,{recursive:true,force:true})}
})
