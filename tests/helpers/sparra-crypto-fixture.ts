import { createCipheriv, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, rm, stat, realpath, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
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

type VoiceProducer=Readonly<{pythonExecutable:string;sourceRoot:string}>

function absoluteProducerPath(path:string){
  return isAbsolute(path)&&!path.split(/[\\/]/).some(part=>part==='.'||part==='..')
}

function sameProducerPath(actual:string,requested:string){
  return process.platform==='win32'?actual.toLowerCase()===requested.toLowerCase():actual===requested
}

async function canonicalVoiceProducerPaths(requestedRoot:string){
  const producerRoot=await realpath(requestedRoot)
  if(!sameProducerPath(producerRoot,requestedRoot))throw new Error('Voice producer path refused')
  const sourceRoot=join(producerRoot,'src'),venv=join(producerRoot,'.venv')
  const pythonExecutable=join(venv,process.platform==='win32'?'Scripts/python.exe':'bin/python')
  for(const directory of [producerRoot,sourceRoot,venv,dirname(pythonExecutable)]){
    if(!(await stat(directory)).isDirectory()||!sameProducerPath(await realpath(directory),directory))throw new Error('Voice producer path refused')
  }
  for(const path of [join(venv,'pyvenv.cfg'),join(producerRoot,'.python-version'),join(producerRoot,'pyproject.toml'),join(producerRoot,'uv.lock'),...['__init__.py','models.py','production_wiring.py','crypto.py'].map(name=>join(sourceRoot,'projetv0_voice',name))]){
    const file=await stat(path)
    if(!file.isFile()||file.size>1048576||!sameProducerPath(await realpath(path),path))throw new Error('Voice producer path refused')
  }
  // Linux venv interpreters normally link to their base Python; sys.prefix below
  // proves the selected venv instead of refusing that legitimate symlink.
  if(!(await stat(pythonExecutable)).isFile()||(process.platform==='win32'&&!sameProducerPath(await realpath(pythonExecutable),pythonExecutable)))throw new Error('Voice producer executable refused')
  return {producerRoot,sourceRoot,pythonExecutable}
}

async function assertVoiceProducerPins(producerRoot:string){
  const [python,project,lock]=await Promise.all([readFile(join(producerRoot,'.python-version'),'utf8'),readFile(join(producerRoot,'pyproject.toml'),'utf8'),readFile(join(producerRoot,'uv.lock'),'utf8')])
  if(python.trim()!=='3.13.15'||!project.includes('"cryptography==50.0.0"')||!project.includes('"pydantic==2.13.4"')||!/\[\[package\]\]\r?\nname = "cryptography"\r?\nversion = "50\.0\.0"\r?\n/.test(lock)||!/\[\[package\]\]\r?\nname = "pydantic"\r?\nversion = "2\.13\.4"\r?\n/.test(lock))throw new Error('Voice producer pins refused')
}

export async function resolveVoiceProducer(root?:string):Promise<VoiceProducer>{
  root??=process.env.SPARRA_VOICE_TEST_ROOT??(process.platform==='win32'?'C:/Users/louis/Documents/ChatGPT/.worktrees/sparra-voice-pilot':undefined)
  if(root===undefined||!absoluteProducerPath(root))throw new Error('Voice producer requires an explicit absolute root')
  try{
    const {producerRoot,sourceRoot,pythonExecutable}=await canonicalVoiceProducerPaths(resolve(root))
    await assertVoiceProducerPins(producerRoot)
    return {pythonExecutable:process.platform==='win32'?await realpath(pythonExecutable):pythonExecutable,sourceRoot:await realpath(sourceRoot)}
  }catch{
    throw new Error('Voice producer requires its canonical source and pinned virtual environment')
  }
}

// Actual pinned producer model, encryption and production keyring decoder.
// The result envelope remains a separately proposed Node fixture above.
export async function nativeVoiceTurn(fixture: Awaited<ReturnType<typeof cryptoFixture>>, producer?:VoiceProducer) {
  const selected=producer?await resolveVoiceProducer(dirname(producer.sourceRoot)):await resolveVoiceProducer()
  if(producer&&(!absoluteProducerPath(producer.sourceRoot)||!absoluteProducerPath(producer.pythonExecutable)||!sameProducerPath(resolve(producer.sourceRoot),selected.sourceRoot)||!sameProducerPath(resolve(producer.pythonExecutable),selected.pythonExecutable)))throw new Error('Voice producer descriptor refused')
  const nltkData=process.env.SPARRA_VOICE_NLTK_DATA,home=process.env.SPARRA_VOICE_TEST_HOME
  if(typeof nltkData!=='string'||typeof home!=='string'||!absoluteProducerPath(nltkData)||!absoluteProducerPath(home))throw new Error('Voice tokenizer prerequisite refused')
  const script=String.raw`
import sys, base64, inspect
from pathlib import Path
source = Path(sys.argv[4])
venv = source.parent / '.venv'
assert source.resolve() == source and venv.resolve() == venv
assert sys.version_info[:3] == (3, 13, 15)
assert Path(sys.prefix).resolve() == venv and sys.prefix != sys.base_prefix
import cryptography, pydantic
assert cryptography.__version__ == '50.0.0' and pydantic.__version__ == '2.13.4'
assert Path(cryptography.__file__).resolve().is_relative_to(venv)
assert Path(pydantic.__file__).resolve().is_relative_to(venv)
import nltk, os
nltk.data.path[:]=[os.environ['NLTK_DATA']]
nltk.data.find('tokenizers/punkt_tab')
sys.path.insert(0, str(source))
from projetv0_voice import models, production_wiring, crypto
for module, name in [(models, 'models.py'), (production_wiring, 'production_wiring.py'), (crypto, 'crypto.py')]:
    assert Path(module.__file__).resolve() == source / 'projetv0_voice' / name
TurnUpsertPayloadV1 = models.TurnUpsertPayloadV1
_decode_keyring_value = production_wiring._decode_keyring_value
assert Path(inspect.getsourcefile(TurnUpsertPayloadV1)).resolve() == source / 'projetv0_voice/models.py'
assert Path(inspect.getsourcefile(_decode_keyring_value)).resolve() == source / 'projetv0_voice/production_wiring.py'
assert Path(inspect.getsourcefile(crypto.CryptoKeyring.encrypt)).resolve() == source / 'projetv0_voice/crypto.py'
assert production_wiring.CryptoKeyring is crypto.CryptoKeyring
keyring = _decode_keyring_value(Path(sys.argv[1]).read_text())
v = keyring.encrypt('Rappelez-moi'.encode(), aad=('turn:'+sys.argv[2]).encode('ascii'))
turn = TurnUpsertPayloadV1(turn_id=sys.argv[2], turn_no=1, role='user', source='stt_final', crypto_version=1, key_version=v.key_version, nonce_b64=base64.b64encode(v.nonce).decode(), ciphertext_b64=base64.b64encode(v.ciphertext).decode(), started_at=sys.argv[5], ended_at=sys.argv[6], interrupted=False)
Path(sys.argv[3]).write_text(turn.model_dump_json(), encoding='utf-8')
`
  const output=join(fixture.directory,'native-turn.json')
  try{
    await promisify(execFile)(selected.pythonExecutable,['-I','-B','-c',script,fixture.path,fixture.turnId,output,selected.sourceRoot,fixture.turn.started_at,fixture.turn.ended_at],{cwd:dirname(selected.sourceRoot),windowsHide:true,timeout:60000,env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,PYTHONDONTWRITEBYTECODE:'1',HOME:home,APPDATA:home,NLTK_DATA:nltkData}})
  }catch{
    throw new Error('Voice producer runtime refused')
  }
  return JSON.parse(await readFile(output,'utf8'))
}
