import { afterEach, expect, test, vi } from 'vitest'
import { stat, symlink, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { cryptoFixture, nativeVoiceTurn, resolveVoiceProducer } from '../helpers/sparra-crypto-fixture'
import { readKeyring, decodeMessageContent } from '../../src/modules/sparra/message-crypto.server'

afterEach(()=>vi.unstubAllEnvs())

test.each(['relative','missing','incomplete','aliased'] as const)('native consumer refuses %s producer root before creating an encrypted turn',async kind=>{
  const f=await cryptoFixture()
  try{
    let root=kind==='relative'?'relative-voice-root':kind==='missing'?join(f.directory,'missing-root'):f.directory
    if(kind==='aliased'){
      root=join(f.directory,'aliased-root')
      await symlink(process.env.SPARRA_VOICE_TEST_ROOT??'C:/Users/louis/Documents/ChatGPT/.worktrees/sparra-voice-pilot',root,process.platform==='win32'?'junction':'dir')
    }
    vi.stubEnv('SPARRA_VOICE_TEST_ROOT',root)
    const refused=await nativeVoiceTurn(f).then(()=>false,()=>true)
    expect(refused).toBe(true)
    expect(await stat(join(f.directory,'native-turn.json')).then(()=>true,()=>false)).toBe(false)
  }finally{await f.cleanup()}
})

test('native consumer refuses an explicit foreign executable before creating an encrypted turn',async()=>{
  const f=await cryptoFixture()
  try{
    const sourceRoot=join(process.env.SPARRA_VOICE_TEST_ROOT??'C:/Users/louis/Documents/ChatGPT/.worktrees/sparra-voice-pilot','src')
    const pythonExecutable=process.platform==='win32'?'C:/Users/louis/Documents/ChatGPT/projetV0-voice/.venv/Scripts/python.exe':'/usr/bin/python3'
    const refused=await nativeVoiceTurn(f,{pythonExecutable,sourceRoot}).then(()=>false,()=>true)
    expect(refused).toBe(true)
    expect(await stat(join(f.directory,'native-turn.json')).then(()=>true,()=>false)).toBe(false)
  }finally{await f.cleanup()}
})

test.runIf(process.platform==='win32')('Windows case-only root and explicit descriptor consume the canonical native producer',async()=>{
  const root=await realpath(process.env.SPARRA_VOICE_TEST_ROOT??'C:/Users/louis/Documents/ChatGPT/.worktrees/sparra-voice-pilot')
  const caseRoot=root.toLowerCase()
  expect(caseRoot===root).toBe(false)
  vi.stubEnv('SPARRA_VOICE_TEST_ROOT',caseRoot)
  const producer=await resolveVoiceProducer()
  expect(producer).toEqual({pythonExecutable:await realpath(join(root,'.venv/Scripts/python.exe')),sourceRoot:await realpath(join(root,'src'))})
  const f=await cryptoFixture()
  try{
    vi.stubEnv('SPARRA_AEAD_KEYRING_PATH',f.path)
    const turn=await nativeVoiceTurn(f,{pythonExecutable:producer.pythonExecutable.toLowerCase(),sourceRoot:producer.sourceRoot.toLowerCase()})
    expect(decodeMessageContent(f.callId,{[f.turnId]:turn},f.result(),await readKeyring())).toMatchObject({transcript:[{text:'Rappelez-moi',startedAt:'2026-10-01T10:00:00.000Z'}],transcriptAvailability:'available',unavailableTurnCount:0,result:f.inner})
  }finally{await f.cleanup()}
},65000)

test('actual native serialized Voice text and proposed result decode through configured key file',async()=>{
  const producer=await resolveVoiceProducer()
  const f=await cryptoFixture()
  try {vi.stubEnv('SPARRA_AEAD_KEYRING_PATH',f.path)
    const turn=await nativeVoiceTurn(f,producer),decoded=decodeMessageContent(f.callId,{[f.turnId]:turn},f.result(),await readKeyring())
    expect(decoded.transcript).toEqual([{id:f.turnId,ordinal:1,role:'user',text:'Rappelez-moi',interrupted:false,startedAt:'2026-10-01T10:00:00.000Z'}])
    expect(decoded).toMatchObject({transcriptAvailability:'available',unavailableTurnCount:0,moreTurns:false,result:f.inner})
    // Consume the pinned native model's UTC/fractional serialization too, without
    // altering the shared fixture or importing producer code into the application.
    const fractional=await nativeVoiceTurn({...f,turn:{...f.turn,started_at:'2024-02-29T11:00:00.123456+01:00',ended_at:'2024-02-29T09:00:00.123457-01:00'}},producer)
    expect(fractional.started_at).toBe('2024-02-29T10:00:00.123456Z');expect(fractional.ended_at).toBe('2024-02-29T10:00:00.123457Z')
    expect(decodeMessageContent(f.callId,{[f.turnId]:fractional},f.result(),await readKeyring())).toMatchObject({transcript:[{text:'Rappelez-moi',startedAt:'2024-02-29T10:00:00.123Z'}],transcriptAvailability:'available',unavailableTurnCount:0,result:f.inner})
  }finally{await f.cleanup()}
},65000)
