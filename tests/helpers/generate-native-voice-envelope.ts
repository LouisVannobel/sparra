import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { cryptoFixture, nativeVoiceTurn } from './sparra-crypto-fixture.ts'
const root='C:/Users/louis/Documents/ChatGPT/.worktrees/sparra-voice-pilot'
const fixture=await cryptoFixture()
try {
  const turn=await nativeVoiceTurn(fixture)
  const sourceHashes:Record<string,string>={}
  for(const name of ['src/projetv0_voice/models.py','src/projetv0_voice/production_wiring.py','src/projetv0_voice/crypto.py'])sourceHashes[name]=createHash('sha256').update(await readFile(root+'/'+name)).digest('hex')
  const value={schema_version:1,synthetic_public_key:true,producer_commit:execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),producer_source_sha256:sourceHashes,
    plaintext:'Rappelez-moi',call_id:fixture.callId,turn_id:fixture.turnId,turn,keyring:fixture.keyring}
  await mkdir('tests/fixtures/sparra',{recursive:true})
  await writeFile('tests/fixtures/sparra/native-voice-envelope.json',JSON.stringify(value,null,2)+'\n')
} finally { await fixture.cleanup() }
