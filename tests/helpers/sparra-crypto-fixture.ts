import { createCipheriv, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export async function cryptoFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'sparra-crypto-'))
  const path = join(directory, 'keyring.json'), key = randomBytes(32)
  const keyring = {schema_version:1,active_version:1,keys:[{version:1,aes256_key_hex:key.toString('hex')}]}
  await writeFile(path,JSON.stringify(keyring))
  const encrypt = (plaintext: string | Buffer, aad: string) => {
    const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce)
    cipher.setAAD(Buffer.from(aad,'ascii'))
    const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final(),cipher.getAuthTag()])
    return {crypto_version:1,key_version:1,nonce_b64:nonce.toString('base64'),ciphertext_b64:ciphertext.toString('base64')}
  }
  const turnId=randomUUID(),callId=randomUUID()
  const turn={turn_id:turnId,turn_no:1,role:'user',source:'stt_final',...encrypt('Rappelez-moi','turn:'+turnId),started_at:'2026-10-01T10:00:00Z',ended_at:'2026-10-01T10:00:00Z',interrupted:false}
  const inner={schema_version:1,quality:'partial',category:'callback',summary:'Demande de rappel',contact:{name:null,callback_e164:null,preference:null,callback_source:'missing',callback_confirmed:false},next_action:'Rappeler',evidence:[{turn_id:turnId,role:'user'}],request_confirmed:false}
  const result=(value:unknown=inner)=>({schema_version:1,...encrypt(JSON.stringify(value),'result:'+callId)})
  return {directory,path,keyring,encrypt,callId,turnId,turn,inner,result,cleanup:()=>rm(directory,{recursive:true,force:true})}
}

// Actual pinned producer model, encryption and production keyring decoder.
// The result envelope remains a separately proposed Node fixture above.
export async function nativeVoiceTurn(fixture: Awaited<ReturnType<typeof cryptoFixture>>, producer:Readonly<{pythonExecutable:string;sourceRoot:string}>={pythonExecutable:'C:/Users/louis/Documents/ChatGPT/projetV0-voice/.venv/Scripts/python.exe',sourceRoot:'C:/Users/louis/Documents/ChatGPT/.worktrees/sparra-voice-pilot/src'}) {
  const script=String.raw`
import sys, json, base64
from pathlib import Path
sys.path.insert(0, sys.argv[4])
from projetv0_voice.models import TurnUpsertPayloadV1
from projetv0_voice.production_wiring import _decode_keyring_value
keyring = _decode_keyring_value(Path(sys.argv[1]).read_text())
v = keyring.encrypt('Rappelez-moi'.encode(), aad=('turn:'+sys.argv[2]).encode('ascii'))
turn = TurnUpsertPayloadV1(turn_id=sys.argv[2], turn_no=1, role='user', source='stt_final', crypto_version=1, key_version=v.key_version, nonce_b64=base64.b64encode(v.nonce).decode(), ciphertext_b64=base64.b64encode(v.ciphertext).decode(), started_at='2026-10-01T10:00:00Z', ended_at='2026-10-01T10:00:00Z', interrupted=False)
Path(sys.argv[3]).write_text(turn.model_dump_json(), encoding='utf-8')
`
  const output=join(fixture.directory,'native-turn.json')
  const {readFile}=await import('node:fs/promises')
  await promisify(execFile)(producer.pythonExecutable,['-B','-c',script,fixture.path,fixture.turnId,output,producer.sourceRoot],{windowsHide:true,timeout:60000,env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,PYTHONDONTWRITEBYTECODE:'1'}})
  return JSON.parse(await readFile(output,'utf8'))
}
