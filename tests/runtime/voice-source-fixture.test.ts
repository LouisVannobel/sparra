import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

const fixture=join(process.cwd(),'tests/fixtures/voice-source')
const modulePath='../../scripts/voice-source-fixture.mjs'
const pythonExecutable=process.env.SPARRA_VOICE_FIXTURE_PYTHON??(process.platform==='win32'?'C:/Users/louis/Documents/ChatGPT/.worktrees/sparra-voice-pilot/.venv/Scripts/python.exe':undefined)

test('reviewed native Voice source fixture exposes exact authenticated members without executing them',async()=>{
  const source:unknown=await import(modulePath)
  if(typeof source!=='object'||source===null||!('readVoiceSourceFixture' in source)||typeof source.readVoiceSourceFixture!=='function')throw new Error('Missing native Voice fixture reader')
  const archive=readFileSync(join(fixture,'voice-producer-source.tar.gz'))
  const manifest=JSON.parse(readFileSync(join(fixture,'voice-producer-source.manifest.json'),'utf8'))
  const result=await source.readVoiceSourceFixture(archive,manifest,pythonExecutable)
  expect(result.commit).toBe('9b79ddd69095e7d8c6995e0a88a4e78a16c166c3')
  expect(result.tree).toBe('e52035d2a8a68dfa9ae0c23a1266d830f286e07d')
  expect(result.members).toBeInstanceOf(Map)
  expect([...result.members.keys()].sort()).toEqual(manifest.members.map((row:{path:string})=>row.path).sort())
  for(const row of manifest.members){
    const bytes=result.members.get(row.path)
    expect(Buffer.isBuffer(bytes)).toBe(true)
    expect(bytes.length).toBe(row.size)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(row.sha256)
  }
})

test.each(['archive-byte','commit','tree','member-digest','member-blob','input-roots','extra-member','alias-path'] as const)('native source fixture refuses %s before any environment preparation',async kind=>{
  const source:unknown=await import(modulePath)
  if(typeof source!=='object'||source===null||!('readVoiceSourceFixture' in source)||typeof source.readVoiceSourceFixture!=='function')throw new Error('Missing native Voice fixture reader')
  const archive=readFileSync(join(fixture,'voice-producer-source.tar.gz'))
  const manifest=JSON.parse(readFileSync(join(fixture,'voice-producer-source.manifest.json'),'utf8'))
  if(kind==='archive-byte')archive[archive.length-1]^=1
  else if(kind==='commit')manifest.commit='0'.repeat(40)
  else if(kind==='tree')manifest.tree='0'.repeat(40)
  else if(kind==='member-digest')manifest.members[0].sha256='0'.repeat(64)
  else if(kind==='member-blob')manifest.members[0].git_blob='0'.repeat(40)
  else if(kind==='input-roots')manifest.input_roots=['src']
  else if(kind==='extra-member')manifest.members.push({...manifest.members[0],path:'extra.py'})
  else manifest.members[0].path='src/../'+manifest.members[0].path
  await expect(source.readVoiceSourceFixture(archive,manifest,pythonExecutable)).rejects.toThrow('Invalid native Voice source fixture')
})

test.each([undefined,'python3','relative/python','/tmp/../python'])('native fixture reader requires an explicit canonical interpreter: %s',async executable=>{
  const {readVoiceSourceFixture}=await import('../../scripts/voice-source-fixture.mjs')
  const archive=readFileSync(join(fixture,'voice-producer-source.tar.gz'))
  const manifest=JSON.parse(readFileSync(join(fixture,'voice-producer-source.manifest.json'),'utf8'))
  // @ts-expect-error -- deliberate missing interpreter exercises the JavaScript refusal.
  const refused=await readVoiceSourceFixture(archive,manifest,executable).then(()=>false,error=>error.message==='Invalid native Voice source fixture')
  expect(refused).toBe(true)
})

test.each(['repository','owned-ref','archive-size','decoded-size','member-size','missing-manifest','duplicate-member'] as const)('native fixture admission refuses inconsistent %s metadata',async kind=>{
  const {readVoiceSourceFixture}=await import('../../scripts/voice-source-fixture.mjs')
  const archive=readFileSync(join(fixture,'voice-producer-source.tar.gz'))
  const manifest=JSON.parse(readFileSync(join(fixture,'voice-producer-source.manifest.json'),'utf8'))
  if(typeof pythonExecutable!=='string')throw new Error('Missing qualified Voice fixture interpreter')
  if(kind==='repository')manifest.repository='foreign/voice'
  else if(kind==='owned-ref')manifest.owned_ref='refs/heads/main'
  else if(kind==='archive-size')manifest.archive_size-=1
  else if(kind==='decoded-size')manifest.decoded_source_bytes-=1
  else if(kind==='member-size')manifest.members[0].size=1048577
  else if(kind==='duplicate-member')manifest.members[1]={...manifest.members[0]}
  const rejected=kind==='missing-manifest'
    // @ts-expect-error -- deliberate absent manifest exercises the JavaScript refusal.
    ?readVoiceSourceFixture(archive,null,pythonExecutable)
    :readVoiceSourceFixture(archive,manifest,pythonExecutable)
  await expect(rejected).rejects.toThrow('Invalid native Voice source fixture')
})
