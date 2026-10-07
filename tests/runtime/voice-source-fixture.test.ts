import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import { performance } from 'node:perf_hooks'

type VerifierObservation={holdEOF:boolean;child:ChildProcess|null;closed:Promise<void>|null;bytesWritten:number}
const verifier=vi.hoisted(():VerifierObservation=>({holdEOF:false,child:null,closed:null,bytesWritten:0}))
vi.mock('node:child_process',async importOriginal=>{
  const actual=await importOriginal<typeof import('node:child_process')>()
  return {...actual,spawn:(...args:Parameters<typeof actual.spawn>)=>{
    const child=actual.spawn(...args)
    if(verifier.holdEOF){
      verifier.child=child
      verifier.closed=new Promise(resolve=>child.once('close',()=>resolve()))
      const input=child.stdin
      if(!input){child.kill('SIGKILL');throw new Error('Native verifier stdin missing')}
      vi.spyOn(input,'end').mockImplementation((data:unknown)=>{
        if(!Buffer.isBuffer(data))throw new Error('Native verifier input must remain bytes')
        // Bytes are queued to native stdin, not acknowledged by Python.
        input.write(data);verifier.bytesWritten=data.length
        return input
      })
    }
    return child
  }}
})
afterEach(()=>{verifier.holdEOF=false;vi.restoreAllMocks()})

const fixture=join(process.cwd(),'tests/fixtures/voice-source')
const modulePath='../../scripts/voice-source-fixture.mjs'
const pythonExecutable=process.env.SPARRA_VOICE_FIXTURE_PYTHON??(process.platform==='win32'?'C:/Users/louis/Documents/ChatGPT/.worktrees/sparra-voice-pilot/.venv/Scripts/python.exe':undefined)

test.runIf(process.platform==='linux')('native Linux verifier deadline kills and joins real Python with only stdin EOF held',async()=>{
  if(typeof pythonExecutable!=='string')throw new Error('Missing qualified Voice fixture interpreter')
  const {readVoiceSourceFixture}=await import('../../scripts/voice-source-fixture.mjs')
  const archive=readFileSync(join(fixture,'voice-producer-source.tar.gz'))
  const manifestBytes=readFileSync(join(fixture,'voice-producer-source.manifest.json'))
  const manifest=JSON.parse(manifestBytes.toString('utf8'))
  verifier.holdEOF=true
  const nativeKill=vi.spyOn(process,'kill')
  try{
    const started=performance.now()
    await expect(readVoiceSourceFixture(archive,manifest,pythonExecutable)).rejects.toThrow('Invalid native Voice source fixture')
    expect(performance.now()-started).toBeGreaterThanOrEqual(9500)
    const child=verifier.child
    if(!child||child.pid===undefined)throw new Error('Actual verifier child was not observed')
    expect(verifier.bytesWritten).toBeGreaterThan(0);expect(verifier.bytesWritten).toBeLessThanOrEqual(1048576)
    expect(child.signalCode).toBe('SIGKILL');expect(child.exitCode).toBeNull()
    const pid=child.pid
    expect(nativeKill).toHaveBeenCalledWith(-pid,'SIGKILL')
    expect(()=>process.kill(pid,0)).toThrow()
    expect(()=>process.kill(-pid,0)).toThrow()
    expect(readFileSync(join(fixture,'voice-producer-source.tar.gz'))).toEqual(archive)
    expect(readFileSync(join(fixture,'voice-producer-source.manifest.json'))).toEqual(manifestBytes)
  }finally{
    const child=verifier.child
    if(child?.pid!==undefined&&child.exitCode===null&&child.signalCode===null)process.kill(-child.pid,'SIGKILL')
    if(verifier.closed){
      let timer:ReturnType<typeof setTimeout>|undefined
      try{await Promise.race([verifier.closed,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Native verifier cleanup deadline')),2000)})])}
      finally{clearTimeout(timer)}
    }
    verifier.holdEOF=false
  }
},15000)

test('reviewed native Voice source fixture exposes exact authenticated members without executing them',async()=>{
  const source:unknown=await import(modulePath)
  if(typeof source!=='object'||source===null||!('readVoiceSourceFixture' in source)||typeof source.readVoiceSourceFixture!=='function')throw new Error('Missing native Voice fixture reader')
  const archive=readFileSync(join(fixture,'voice-producer-source.tar.gz'))
  const manifest=JSON.parse(readFileSync(join(fixture,'voice-producer-source.manifest.json'),'utf8'))
  const result=await source.readVoiceSourceFixture(archive,manifest,pythonExecutable)
  expect(result.commit).toBe('c141ad06b5b834bb801661b39c16b1e8b92331da')
  expect(result.tree).toBe('ac1eb089e411cd040d8ca1c0a80fb06f0824bb83')
  expect(result.members).toBeInstanceOf(Map)
  expect(result.members.size).toBe(52)
  expect(result.members.has('src/projetv0_voice/recording_archive.py')).toBe(true)
  expect(result.members.has('src/projetv0_voice/audio_contract.py')).toBe(true)
  expect([...result.members.keys()].filter(path=>path.startsWith('tests/'))).toEqual(['tests/integration/sparra_connected_scenario.py'])
  expect(createHash('sha256').update(result.members.get('tests/integration/sparra_connected_scenario.py')).digest('hex')).toBe('63e820a7aee4e680c4c1a217d5deb422088104c7eaece7007083cdb236f81399')
  expect(createHash('sha256').update(result.members.get('src/projetv0_voice/models.py')).digest('hex')).toBe('4c5827d20279ad573f3237e41e547bba32162970111d353d80b9b762ae968ec6')
  expect([...result.members.keys()].sort()).toEqual(manifest.members.map((row:{path:string})=>row.path).sort())
  for(const row of manifest.members){
    const bytes=result.members.get(row.path)
    expect(Buffer.isBuffer(bytes)).toBe(true)
    expect(bytes.length).toBe(row.size)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(row.sha256)
  }
})

test.each(['archive-byte','commit','superseded-commit','tree','member-digest','member-blob','input-roots','extra-member','alias-path','absolute-path','backslash-path'] as const)('native source fixture refuses %s before any environment preparation',async kind=>{
  const source:unknown=await import(modulePath)
  if(typeof source!=='object'||source===null||!('readVoiceSourceFixture' in source)||typeof source.readVoiceSourceFixture!=='function')throw new Error('Missing native Voice fixture reader')
  const archive=readFileSync(join(fixture,'voice-producer-source.tar.gz'))
  const manifest=JSON.parse(readFileSync(join(fixture,'voice-producer-source.manifest.json'),'utf8'))
  if(kind==='archive-byte')archive[archive.length-1]^=1
  else if(kind==='commit')manifest.commit='0'.repeat(40)
  else if(kind==='superseded-commit')manifest.commit='0114bb9eccf4fbbb96ec9042b1d72dc632f6d17d'
  else if(kind==='tree')manifest.tree='0'.repeat(40)
  else if(kind==='member-digest')manifest.members[0].sha256='0'.repeat(64)
  else if(kind==='member-blob')manifest.members[0].git_blob='0'.repeat(40)
  else if(kind==='input-roots')manifest.input_roots=['src']
  else if(kind==='extra-member')manifest.members.push({...manifest.members[0],path:'extra.py'})
  else if(kind==='absolute-path')manifest.members[0].path='/'+manifest.members[0].path
  else if(kind==='backslash-path')manifest.members[0].path='src\\'+manifest.members[0].path
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

test.each(['repository','owned-ref','archive-hash','archive-size','decoded-size','member-size','member-size-type','missing-manifest','duplicate-member'] as const)('native fixture admission refuses inconsistent %s metadata',async kind=>{
  const {readVoiceSourceFixture}=await import('../../scripts/voice-source-fixture.mjs')
  const archive=readFileSync(join(fixture,'voice-producer-source.tar.gz'))
  const manifest=JSON.parse(readFileSync(join(fixture,'voice-producer-source.manifest.json'),'utf8'))
  if(typeof pythonExecutable!=='string')throw new Error('Missing qualified Voice fixture interpreter')
  if(kind==='repository')manifest.repository='foreign/voice'
  else if(kind==='owned-ref')manifest.owned_ref='refs/heads/main'
  else if(kind==='archive-hash')manifest.archive_sha256='0'.repeat(64)
  else if(kind==='archive-size')manifest.archive_size-=1
  else if(kind==='decoded-size')manifest.decoded_source_bytes-=1
  else if(kind==='member-size')manifest.members[0].size=1048577
  else if(kind==='member-size-type')manifest.members[0].size=String(manifest.members[0].size)
  else if(kind==='duplicate-member')manifest.members[1]={...manifest.members[0]}
  const rejected=kind==='missing-manifest'
    // @ts-expect-error -- deliberate absent manifest exercises the JavaScript refusal.
    ?readVoiceSourceFixture(archive,null,pythonExecutable)
    :readVoiceSourceFixture(archive,manifest,pythonExecutable)
  await expect(rejected).rejects.toThrow('Invalid native Voice source fixture')
})
