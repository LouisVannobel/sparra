import { afterEach, expect, test, vi } from 'vitest'
import { open, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { cryptoFixture } from '../helpers/sparra-crypto-fixture'
import { readKeyring, decodeMessageContent } from '../../src/modules/sparra/message-crypto.server'
vi.mock('node:fs/promises',async original=>{
  const filesystem=await original<typeof import('node:fs/promises')>()
  return {...filesystem,open:vi.fn(filesystem.open)}
})
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();vi.mocked(open).mockReset()})
test('durable per-call loss is independent from decode failures and marks retained content partial',async()=>{
  const f=await cryptoFixture()
  try{
    vi.stubEnv('SPARRA_AEAD_KEYRING_PATH',f.path)
    const keys=await readKeyring()
    expect(decodeMessageContent(f.callId,{[f.turnId]:f.turn},f.result(),keys,3)).toMatchObject({transcriptAvailability:'partial',transcriptLossCount:3,unavailableTurnCount:0,moreTurns:false,result:f.inner})
    expect(decodeMessageContent(f.callId,{},null,keys,3)).toMatchObject({transcriptAvailability:'unavailable',transcriptLossCount:3,unavailableTurnCount:0})
  }finally{await f.cleanup()}
})
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
test('authenticated ordinal and id order selects 200 turns and excludes evidence from the 201st valid turn',async()=>{
  const f=await cryptoFixture()
  try{
    vi.stubEnv('SPARRA_AEAD_KEYRING_PATH',f.path)
    const keys=await readKeyring(),ids=Array.from({length:201},(_,index)=>'00000000-0000-0000-0000-'+(index+1).toString(16).padStart(12,'0'))
    const turns=Object.fromEntries(ids.map((id,index)=>[id,{...f.turn,turn_id:id,turn_no:index===1?1:index+1,role:index===1?'assistant':'user',source:index===1?'pipecat_assistant':'stt_final',...f.encrypt('Tour '+(index+1),'turn:'+id)}]).reverse())
    const selected={...f.inner,evidence:[{turn_id:ids[0],role:'user'},{turn_id:ids[1],role:'assistant'}]}
    const content=decodeMessageContent(f.callId,turns,f.result(selected),keys)
    expect(content.transcript.map(turn=>turn.id)).toEqual(ids.slice(0,200))
    expect(content.transcript.slice(0,3).map(turn=>({ordinal:turn.ordinal,role:turn.role,text:turn.text}))).toEqual([{ordinal:1,role:'user',text:'Tour 1'},{ordinal:1,role:'assistant',text:'Tour 2'},{ordinal:3,role:'user',text:'Tour 3'}])
    expect(content).toMatchObject({result:selected,transcriptAvailability:'partial',unavailableTurnCount:0,moreTurns:true,transcriptLossCount:0})
    expect(decodeMessageContent(f.callId,turns,f.result({...f.inner,evidence:[{turn_id:ids[200],role:'user'}]}),keys).result).toBeNull()
  }finally{await f.cleanup()}
})

test.each(['ino','dev'] as const)('opened key-file %s mismatch is unavailable and closes its owned descriptor',async field=>{
  const f=await cryptoFixture(),filesystem=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  let file:Awaited<ReturnType<typeof open>>|undefined
  try{
    vi.stubEnv('SPARRA_AEAD_KEYRING_PATH',f.path)
    vi.mocked(open).mockImplementationOnce(async(...args)=>{
      file=await filesystem.open(...args)
      const opened=await file.stat()
      opened[field]++
      vi.spyOn(file,'stat').mockResolvedValueOnce(opened)
      return file
    })
    expect(await readKeyring()).toBeNull()
    if(!file)throw new Error('Key file was not opened')
    expect(file.fd).toBe(-1)
  }finally{await file?.close().catch(()=>{});await f.cleanup()}
})

test.each(['stat','read'] as const)('opened key-file %s failure is unavailable and closes its owned descriptor',async operation=>{
  const f=await cryptoFixture(),filesystem=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  let file:Awaited<ReturnType<typeof open>>|undefined
  try{
    vi.stubEnv('SPARRA_AEAD_KEYRING_PATH',f.path)
    vi.mocked(open).mockImplementationOnce(async(...args)=>{
      file=await filesystem.open(...args)
      vi.spyOn(file,operation).mockRejectedValueOnce(new Error('Owned key file unavailable'))
      return file
    })
    expect(await readKeyring()).toBeNull()
    if(!file)throw new Error('Key file was not opened')
    expect(file.fd).toBe(-1)
  }finally{await file?.close().catch(()=>{});await f.cleanup()}
})

test('missing, relative, oversized, directory, symlink, malformed, invalid UTF8 and duplicate-version key files are unavailable',async()=>{
  const f=await cryptoFixture()
  try{
    const link=join(f.directory,'link');await symlink(f.directory,link,'junction')
    for(const path of ['', 'relative.json',join(f.directory,'missing'),f.directory,link]){vi.stubEnv('SPARRA_AEAD_KEYRING_PATH',path);expect(await readKeyring()).toBeNull()}
    vi.stubEnv('SPARRA_AEAD_KEYRING_PATH',f.path)
    for(const value of ['x'.repeat(16385),'{}',Buffer.from([0xff]),JSON.stringify({...f.keyring,active_version:2}),JSON.stringify({...f.keyring,keys:[...f.keyring.keys,...f.keyring.keys]})]){await writeFile(f.path,value);expect(await readKeyring()).toBeNull()}
  }finally{await f.cleanup()}
})

test.each(['2026-02-31T10:00:00Z','2025-02-29T10:00:00Z','1900-02-29T10:00:00Z','2026-04-31T10:00:00Z','0000-01-01T10:00:00Z','2026-10-01T24:00:00Z','2026-10-01T10:60:00Z','2026-10-01T10:00:60Z','2026-10-01T10:00:00+24:00'])('impossible native turn observation %s is unavailable',async observation=>{
  const f=await cryptoFixture()
  try{vi.stubEnv('SPARRA_AEAD_KEYRING_PATH',f.path)
    const turn={...f.turn,started_at:observation,ended_at:observation}
    expect(decodeMessageContent(f.callId,{[f.turnId]:turn},f.result(),await readKeyring())).toMatchObject({transcript:[],transcriptAvailability:'unavailable',unavailableTurnCount:1,result:null})
  }finally{await f.cleanup()}
})

test('native turn ordering compares microseconds across valid offsets before millisecond DTO normalization',async()=>{
  const f=await cryptoFixture()
  try{vi.stubEnv('SPARRA_AEAD_KEYRING_PATH',f.path);const keys=await readKeyring()
    for(const [started_at,ended_at] of [['2026-10-01T10:00:00.000002Z','2026-10-01T10:00:00.000001Z'],['2026-10-01T11:00:00.000002+01:00','2026-10-01T09:00:00.000001-01:00']]){
      expect(decodeMessageContent(f.callId,{[f.turnId]:{...f.turn,started_at,ended_at}},f.result(),keys)).toMatchObject({transcript:[],unavailableTurnCount:1,result:null})
    }
    for(const [started_at,ended_at,want] of [['2024-02-29T11:00:00.123456+01:00','2024-02-29T09:00:00.123457-01:00','2024-02-29T10:00:00.123Z'],['2000-02-29T10:00:00.1Z','2000-02-29T10:00:00.100001Z','2000-02-29T10:00:00.100Z'],['2026-10-01T10:00:00.000001Z','2026-10-01T10:00:00.000002Z','2026-10-01T10:00:00.000Z']]){
      expect(decodeMessageContent(f.callId,{[f.turnId]:{...f.turn,started_at,ended_at}},f.result(),keys)).toMatchObject({transcript:[{text:'Rappelez-moi',startedAt:want}],transcriptAvailability:'available',unavailableTurnCount:0,result:f.inner})
    }
  }finally{await f.cleanup()}
})

test.each(['schema_version','active_version','version','aes256_key_hex'])('duplicate key-file member %s including escaped names is unavailable',async member=>{
  const f=await cryptoFixture()
  try{vi.stubEnv('SPARRA_AEAD_KEYRING_PATH',f.path)
    const raw=JSON.stringify(f.keyring),needle='"'+member+'":',escaped='"\\u'+member.charCodeAt(0).toString(16).padStart(4,'0')+member.slice(1)+'":'
    for(const repeated of [needle,escaped]){
      // The final member is valid; JSON.parse alone would silently select it.
      await writeFile(f.path,raw.replace(needle,needle+'null,'+repeated))
      expect((await readKeyring())===null).toBe(true)
    }
  }finally{await f.cleanup()}
})

test('valid uniquely escaped key-file names still authenticate native turn text',async()=>{
  const f=await cryptoFixture()
  try{vi.stubEnv('SPARRA_AEAD_KEYRING_PATH',f.path)
    await writeFile(f.path,JSON.stringify(f.keyring).replace(/"(schema_version|active_version|keys|version|aes256_key_hex)":/g,(_,name:string)=>'"\\u'+name.charCodeAt(0).toString(16).padStart(4,'0')+name.slice(1)+'":'))
    expect(decodeMessageContent(f.callId,{[f.turnId]:f.turn},f.result(),await readKeyring())).toMatchObject({transcript:[{text:'Rappelez-moi'}],result:f.inner})
  }finally{await f.cleanup()}
})
