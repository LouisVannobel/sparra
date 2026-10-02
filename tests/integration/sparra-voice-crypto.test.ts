import { afterEach, expect, test, vi } from 'vitest'
import { stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cryptoFixture, nativeVoiceTurn } from '../helpers/sparra-crypto-fixture'
import { readKeyring, decodeMessageContent } from '../../src/modules/sparra/message-crypto.server'

afterEach(()=>vi.unstubAllEnvs())

test('actual native serialized Voice text and proposed result decode through configured key file',async()=>{
  const root=process.env.SPARRA_VOICE_TEST_ROOT??'C:/Users/louis/Documents/ChatGPT/.worktrees/sparra-voice-pilot'
  if(!isAbsolute(root))throw new Error('Fresh Voice integration requires an absolute real producer root')
  const producer={pythonExecutable:join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),sourceRoot:join(root,'src')}
  // Refuse missing source rather than letting Python resolve an installed fallback package.
  for(const path of [producer.pythonExecutable,join(root,'.venv/pyvenv.cfg'),join(producer.sourceRoot,'projetv0_voice/__init__.py')]){
    if(!(await stat(path)).isFile())throw new Error('Fresh Voice integration requires its real source and virtual environment')
  }
  const f=await cryptoFixture()
  try {vi.stubEnv('SPARRA_AEAD_KEYRING_PATH',f.path)
    const turn=await nativeVoiceTurn(f,producer),decoded=decodeMessageContent(f.callId,{[f.turnId]:turn},f.result(),await readKeyring())
    expect(decoded.transcript).toEqual([{id:f.turnId,ordinal:1,role:'user',text:'Rappelez-moi',interrupted:false,startedAt:'2026-10-01T10:00:00.000Z'}])
    expect(decoded).toMatchObject({transcriptAvailability:'available',unavailableTurnCount:0,moreTurns:false,result:f.inner})
    // Consume the pinned native model's UTC/fractional serialization too, without
    // altering the shared fixture or importing producer code into the application.
    const script=String.raw`
import sys, json
from pathlib import Path
sys.path.insert(0, sys.argv[2])
from projetv0_voice.models import TurnUpsertPayloadV1
turn = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
turn.update(started_at='2024-02-29T11:00:00.123456+01:00', ended_at='2024-02-29T09:00:00.123457-01:00')
print(TurnUpsertPayloadV1.model_validate(turn).model_dump_json())
`
    const {stdout}=await promisify(execFile)(producer.pythonExecutable,['-B','-c',script,join(f.directory,'native-turn.json'),producer.sourceRoot],{windowsHide:true,timeout:60000,env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,PYTHONDONTWRITEBYTECODE:'1'}})
    const fractional=JSON.parse(stdout)
    expect(fractional.started_at).toBe('2024-02-29T10:00:00.123456Z');expect(fractional.ended_at).toBe('2024-02-29T10:00:00.123457Z')
    expect(decodeMessageContent(f.callId,{[f.turnId]:fractional},f.result(),await readKeyring())).toMatchObject({transcript:[{text:'Rappelez-moi',startedAt:'2024-02-29T10:00:00.123Z'}],transcriptAvailability:'available',unavailableTurnCount:0,result:f.inner})
  }finally{await f.cleanup()}
},65000)
