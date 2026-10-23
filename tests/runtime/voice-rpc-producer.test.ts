import { afterEach, expect, test, vi } from 'vitest'
import { nativeVoice } from '../helpers/sparra-voice-driver'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveVoiceProducer } from '../helpers/sparra-crypto-fixture'

afterEach(()=>vi.unstubAllEnvs())

test('native RPC refuses an invalid explicitly selected producer before dispatch',async()=>{
  vi.stubEnv('SPARRA_VOICE_TEST_ROOT','relative-unqualified-source')
  await expect(nativeVoice({action:'aggregate_size',turns:{}})).rejects.toThrow('Voice producer requires an explicit absolute root')
})

// These trees exercise only the metadata admission boundary. Genuine interpreter,
// venv and imported-module acceptance is exercised by prepareVoiceSource separately.
test.each(['3.13.15','3.13.16','3.13.18','3.14.0'])('producer metadata refuses Python %s rather than widening the exact current pin',async version=>{
  const root=await mkdtemp(join(tmpdir(),'sparra-wrong-python-'))
  try{
    const binary=join(root,'.venv',process.platform==='win32'?'Scripts':'bin')
    await mkdir(binary,{recursive:true});await mkdir(join(root,'src/projetv0_voice'),{recursive:true})
    for(const name of ['__init__.py','models.py','production_wiring.py','crypto.py'])await writeFile(join(root,'src/projetv0_voice',name),'')
    await writeFile(join(binary,process.platform==='win32'?'python.exe':'python'),'metadata fixture, never executed')
    await writeFile(join(root,'.venv/pyvenv.cfg'),'metadata fixture')
    await writeFile(join(root,'.python-version'),version+'\n')
    await writeFile(join(root,'pyproject.toml'),'dependencies = ["cryptography==50.0.0", "pydantic==2.13.4"]\n')
    await writeFile(join(root,'uv.lock'),'[[package]]\nname = "cryptography"\nversion = "50.0.0"\n\n[[package]]\nname = "pydantic"\nversion = "2.13.4"\n')
    await expect(resolveVoiceProducer(root)).rejects.toThrow('Voice producer requires its canonical source and pinned virtual environment')
  }finally{await rm(root,{recursive:true,force:true})}
})
