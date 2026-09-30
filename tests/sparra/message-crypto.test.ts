import { afterEach, expect, test, vi } from 'vitest'
import { writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { cryptoFixture, nativeVoiceTurn } from '../helpers/sparra-crypto-fixture'
import { readKeyring, decodeMessageContent } from '../../src/modules/sparra/message-crypto.server'
afterEach(()=>vi.unstubAllEnvs())
test('actual native serialized Voice text and proposed result decode through configured key file',async()=>{
  const f=await cryptoFixture()
  try {vi.stubEnv('SPARRA_AEAD_KEYRING_PATH',f.path)
    const turn=await nativeVoiceTurn(f),decoded=decodeMessageContent(f.callId,{[f.turnId]:turn},f.result(),await readKeyring())
    expect(decoded.transcript).toEqual([{id:f.turnId,ordinal:1,role:'user',text:'Rappelez-moi',interrupted:false,startedAt:'2026-10-01T10:00:00.000Z'}])
    expect(decoded).toMatchObject({transcriptAvailability:'available',unavailableTurnCount:0,moreTurns:false,result:f.inner})
  }finally{await f.cleanup()}
},65000)
test('keyless, wrong AAD, bad tag, unknown version and authenticated invalid UTF8 never expose text',async()=>{
  const f=await cryptoFixture()
  try{vi.stubEnv('SPARRA_AEAD_KEYRING_PATH',f.path);const keys=await readKeyring()
    for(const turn of [{...f.turn,key_version:2},{...f.turn,crypto_version:2},{...f.turn,nonce_b64:Buffer.alloc(11).toString('base64')},{...f.turn,...f.encrypt('secret','turn:'+randomUUID())},{...f.turn,ciphertext_b64:Buffer.alloc(20).toString('base64')},{...f.turn,...f.encrypt(Buffer.from([0xff]),'turn:'+f.turnId)},{...f.turn,plaintext:'fallback'}]){
      expect(decodeMessageContent(f.callId,{[f.turnId]:turn},f.result(),keys)).toMatchObject({transcript:[],transcriptAvailability:'unavailable',unavailableTurnCount:1,result:null})
    }
    expect(decodeMessageContent(f.callId,{[f.turnId]:f.turn},f.result(),null).transcript).toEqual([])
    for(const result of [{...f.result(),key_version:2},{...f.result(),crypto_version:2},{schema_version:1,...f.encrypt(JSON.stringify(f.inner),'result:'+randomUUID())},{schema_version:1,...f.encrypt(Buffer.from([0xff]),'result:'+f.callId)},{schema_version:1,...f.encrypt('broken-json','result:'+f.callId)}])expect(decodeMessageContent(f.callId,{[f.turnId]:f.turn},result,keys)).toMatchObject({result:null,transcriptAvailability:'available'})
  }finally{await f.cleanup()}
})
test('strict authenticated result, evidence, pilot quality and independent mixed transcript outcomes',async()=>{
  const f=await cryptoFixture()
  try{vi.stubEnv('SPARRA_AEAD_KEYRING_PATH',f.path);const keys=await readKeyring(),turns={[f.turnId]:f.turn}
    for(const inner of [{...f.inner,extra:true},{...f.inner,quality:'complete'},{...f.inner,request_confirmed:true},{...f.inner,summary:'\ud800'},{...f.inner,summary:'x'.repeat(3001)},{...f.inner,evidence:[{turn_id:randomUUID(),role:'user'}]},{...f.inner,evidence:[{turn_id:f.turnId,role:'assistant'}]},{...f.inner,contact:{...f.inner.contact,callback_source:'provider'}},{...f.inner,evidence:[...f.inner.evidence,...f.inner.evidence]}]) expect(decodeMessageContent(f.callId,turns,f.result(inner),keys).result).toBeNull()
    const mixed=decodeMessageContent(f.callId,{...turns,[randomUUID()]:{}},f.result(),keys)
    expect(mixed).toMatchObject({result:f.inner,transcriptAvailability:'partial',unavailableTurnCount:1})
    expect(decodeMessageContent(f.callId,{},null,keys)).toMatchObject({result:null,transcript:[],transcriptAvailability:'unavailable'})
    expect(decodeMessageContent(f.callId,Object.fromEntries(Array.from({length:201},()=>[randomUUID(),{}])),null,keys)).toMatchObject({moreTurns:true,unavailableTurnCount:200})
  }finally{await f.cleanup()}
})
test('missing, relative, oversized, directory, symlink, malformed and duplicate-version key files are unavailable',async()=>{
  const f=await cryptoFixture()
  try{
    const link=join(f.directory,'link');await symlink(f.directory,link,'junction')
    for(const path of ['', 'relative.json',join(f.directory,'missing'),f.directory,link]){vi.stubEnv('SPARRA_AEAD_KEYRING_PATH',path);expect(await readKeyring()).toBeNull()}
    vi.stubEnv('SPARRA_AEAD_KEYRING_PATH',f.path)
    for(const value of ['x'.repeat(16385),'{}',JSON.stringify({...f.keyring,active_version:2}),JSON.stringify({...f.keyring,keys:[...f.keyring.keys,...f.keyring.keys]})]){await writeFile(f.path,value);expect(await readKeyring()).toBeNull()}
  }finally{await f.cleanup()}
})
