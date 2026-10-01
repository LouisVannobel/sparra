import { createDecipheriv } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { Schema } from 'effect'

const positive = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const uuid = Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/))
const text = (max:number) => Schema.String.check(Schema.isMaxLength(max),Schema.isPattern(/^[^\ud800-\udfff]*$/u),Schema.isPattern(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]*$/))
// Native datetime observations have Gregorian calendar validity and microsecond
// ordering, even though the browser DTO deliberately normalizes to milliseconds.
function instantMicros(value:string):bigint|null {
  const parts=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value)
  if(!parts)return null
  const year=Number(parts[1]),month=Number(parts[2]),day=Number(parts[3]),hour=Number(parts[4]),minute=Number(parts[5]),second=Number(parts[6])
  const days=[31,year%4===0&&(year%100!==0||year%400===0)?29:28,31,30,31,30,31,31,30,31,30,31]
  if(year<1||month<1||month>12||day<1||day>days[month-1]||hour>23||minute>59||second>59||Number(parts[9]??0)>23||Number(parts[10]??0)>59)return null
  const milliseconds=Date.parse(value)
  if(!Number.isFinite(milliseconds)||milliseconds<Date.parse('0001-01-01T00:00:00Z')||milliseconds>Date.parse('9999-12-31T23:59:59.999Z'))return null
  return BigInt(milliseconds)*1000n+BigInt((parts[7]??'').padEnd(6,'0').slice(3))
}
const instant = Schema.String.check(Schema.makeFilter(value=>instantMicros(value)!==null))
const encrypted = {crypto_version:Schema.Literal(1),key_version:positive,nonce_b64:Schema.String.check(Schema.isMaxLength(172)),ciphertext_b64:Schema.String.check(Schema.isMaxLength(87384))}
const turnSchema = Schema.Struct({turn_id:uuid,turn_no:positive,role:Schema.Literals(['user','assistant']),source:Schema.Literals(['stt_final','pipecat_assistant']),...encrypted,started_at:instant,ended_at:instant,interrupted:Schema.Boolean})
const envelopeSchema = Schema.Struct({schema_version:Schema.Literal(1),...encrypted})
export type NativeEncryptedTurn = typeof turnSchema.Type
export type EncryptedMessageResult = typeof envelopeSchema.Type
const keyringSchema = Schema.Struct({schema_version:Schema.Literal(1),active_version:positive,keys:Schema.Array(Schema.Struct({version:positive,aes256_key_hex:Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))})).check(Schema.isMinLength(1))})
const resultSchema = Schema.Struct({
  schema_version:Schema.Literal(1),quality:Schema.Literal('partial'),category:Schema.Literals(['callback','information','appointment_to_confirm','declared_urgent']),summary:text(3000),
  contact:Schema.Struct({name:Schema.NullOr(text(120)),callback_e164:Schema.NullOr(Schema.String.check(Schema.isPattern(/^\+[1-9][0-9]{1,14}$/))),preference:Schema.NullOr(text(300)),callback_source:Schema.Literals(['caller','provider','missing']),callback_confirmed:Schema.Literal(false)}),
  next_action:text(500),evidence:Schema.Array(Schema.Struct({turn_id:uuid,role:Schema.Literals(['user','assistant'])})).check(Schema.isMaxLength(64)),request_confirmed:Schema.Literal(false),
})
export type MessageResultV1 = typeof resultSchema.Type
type Keyring = ReadonlyMap<number,Buffer>
export type TranscriptTurn = Readonly<{id:string;ordinal:number;role:'user'|'assistant';text:string;interrupted:boolean;startedAt:string}>
export type MessageContent = Readonly<{result:MessageResultV1|null;transcript:TranscriptTurn[];transcriptAvailability:'available'|'unavailable'|'partial';unavailableTurnCount:number;moreTurns:boolean;transcriptLossCount:number}>
const strict = {onExcessProperty:'error'} as const

/** JSON.parse validates syntax first; this bounded token scan only checks member
 * uniqueness, including decoded escapes, at every object depth in the key file. */
function rejectDuplicateMembers(raw:string):void {
  const objects:(Set<string>|null)[]=[]
  for(const token of raw.matchAll(/"(?:\\.|[^"\\])*"|[{}[\]]/g)){
    const value=token[0]
    if(value==='{')objects.push(new Set())
    else if(value==='[')objects.push(null)
    else if(value==='}'||value===']')objects.pop()
    else if(/^\s*:/.test(raw.slice(token.index+value.length))){
      const members=objects.at(-1),name:string=JSON.parse(value)
      if(!members||members.has(name))throw new Error('Unavailable')
      members.add(name)
    }
  }
}

/** No default key, discovery or empty replacement. Invalid configuration is bounded unavailability. */
export async function readKeyring(): Promise<Keyring|null> {
  let file:Awaited<ReturnType<typeof open>>|undefined
  try {
    const path=process.env.SPARRA_AEAD_KEYRING_PATH
    if(!path || !isAbsolute(path))return null
    const before=await lstat(path)
    if(!before.isFile() || before.isSymbolicLink() || before.size>16384 || resolve(await realpath(path))!==resolve(path))return null
    file=await open(path,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened=await file.stat()
    if(!opened.isFile() || opened.size>16384 || opened.ino!==before.ino || opened.dev!==before.dev)return null
    const buffer=Buffer.alloc(16385)
    let length=0
    while(length<buffer.length){const {bytesRead}=await file.read(buffer,length,buffer.length-length,null);if(!bytesRead)break;length+=bytesRead}
    if(length>16384)return null
    const raw=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,length)),parsed:unknown=JSON.parse(raw)
    rejectDuplicateMembers(raw)
    const value=Schema.decodeUnknownSync(keyringSchema,strict)(parsed)
    const keys=new Map<number,Buffer>()
    for(const key of value.keys){if(keys.has(key.version))return null;keys.set(key.version,Buffer.from(key.aes256_key_hex,'hex'))}
    return keys.has(value.active_version)?keys:null
  }catch{return null}finally{await file?.close().catch(()=>{})}
}
function decrypt(value:typeof envelopeSchema.Type|typeof turnSchema.Type,aad:string,keys:Keyring):string {
  const key=keys.get(value.key_version),nonce=Buffer.from(value.nonce_b64,'base64'),ciphertext=Buffer.from(value.ciphertext_b64,'base64')
  if(!key || nonce.length!==12 || nonce.toString('base64')!==value.nonce_b64 || ciphertext.length<16 || ciphertext.length>65536 || ciphertext.toString('base64')!==value.ciphertext_b64)throw new Error('Unavailable')
  const decipher=createDecipheriv('aes-256-gcm',key,nonce)
  decipher.setAAD(Buffer.from(aad,'ascii'));decipher.setAuthTag(ciphertext.subarray(-16))
  // Never decode or expose the unauthenticated update buffer before final verifies the tag.
  const plaintext=Buffer.concat([decipher.update(ciphertext.subarray(0,-16)),decipher.final()])
  return new TextDecoder('utf-8',{fatal:true}).decode(plaintext)
}
export function decodeMessageContent(callId:string,storedTurns:unknown,storedResult:unknown,keys:Keyring|null,transcriptLossCount=0):MessageContent {
  const transcript:TranscriptTurn[]=[],authenticated=new Map<string,'user'|'assistant'>()
  let unavailableTurnCount=0,moreTurns=false,result:MessageResultV1|null=null
  try{
    if(Buffer.byteLength(JSON.stringify(storedTurns),'utf8')>524288)throw new Error('Unavailable')
    const map=Schema.decodeUnknownSync(Schema.Record(Schema.String,Schema.Unknown))(storedTurns)
    const entries=Object.entries(map).map(([id,value])=>{try{return {id,turn:Schema.decodeUnknownSync(turnSchema,strict)(value)}}catch{return {id,turn:null}}}).sort((a,b)=>(a.turn?.turn_no??Infinity)-(b.turn?.turn_no??Infinity)||a.id.localeCompare(b.id))
    moreTurns=entries.length>200
    for(const {id,turn} of entries.slice(0,200)){
      try{
        if(!turn || !keys || id!==turn.turn_id || turn.source!==(turn.role==='user'?'stt_final':'pipecat_assistant'))throw new Error('Unavailable')
        const started=instantMicros(turn.started_at),ended=instantMicros(turn.ended_at)
        if(started===null||ended===null||ended<started)throw new Error('Unavailable')
        const decoded=Schema.decodeUnknownSync(text(65536))(decrypt(turn,'turn:'+id,keys))
        transcript.push({id,ordinal:turn.turn_no,role:turn.role,text:decoded,interrupted:turn.interrupted,startedAt:new Date(turn.started_at).toISOString()});authenticated.set(id,turn.role)
      }catch{unavailableTurnCount++}
    }
  }catch{unavailableTurnCount=1}
  try{
    if(!keys || storedResult===null || Buffer.byteLength(JSON.stringify(storedResult),'utf8')>16384)throw new Error('Unavailable')
    const envelope=Schema.decodeUnknownSync(envelopeSchema,strict)(storedResult),plain=decrypt(envelope,'result:'+callId,keys)
    if(Buffer.byteLength(plain,'utf8')>8192)throw new Error('Unavailable')
    const value=Schema.decodeUnknownSync(resultSchema,strict)(JSON.parse(plain)),ids=new Set<string>()
    for(const evidence of value.evidence){if(ids.has(evidence.turn_id)||authenticated.get(evidence.turn_id)!==evidence.role)throw new Error('Unavailable');ids.add(evidence.turn_id)}
    if((value.contact.callback_e164===null)!==(value.contact.callback_source==='missing'))throw new Error('Unavailable')
    result=value
  }catch{result=null}
  return {result,transcript,unavailableTurnCount,moreTurns,transcriptLossCount,transcriptAvailability:transcript.length===0?'unavailable':unavailableTurnCount||moreTurns||transcriptLossCount>0?'partial':'available'}
}
