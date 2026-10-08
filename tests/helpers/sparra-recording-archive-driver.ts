import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveVoiceProducer } from './sparra-crypto-fixture'
import { retireFixtureDirectory } from './credential-init-retirement'

export type RecordingReceipt = Readonly<{recording_id:string;ciphertext_sha256:string;encrypted_bytes:number;key_version:number;retention_until:string}>
export type ReceiptOperation = Readonly<{
  schema_version:1;operation_id:string;deployment_id:string;call_id:string;occurred_at:string;kind:'recording.upsert'
  payload:Readonly<{recording_id:string;status:'saved'|'purged';telnyx_recording_id:string;channels:'dual';format:'wav';started_at:string;ended_at:string;retention_until:string;archive_receipt:RecordingReceipt}>
}>
export type NativeRecordingSnapshot = Readonly<{schema_version:1;call_id:string;configuration_revision:number;recording_enabled:boolean;knowledge:Readonly<{business_name:string;sector:string;opening_hours:string;services:string;prices:string;faq:string;instructions:string}>;transfer_destination:string|null;retention_until:string}>
export type NativeRecordingRouting = Readonly<{schema_version:1;direction:'incoming';connection_id:string;to_e164:string;from_e164:null;telnyx_call_control_id:string;telnyx_call_leg_id:string;telnyx_call_session_id:string;admitted_at:string}>
export type ArchivedFixture = Readonly<{callId:string;recordingId:string;operations:readonly string[];receiptBytes:string;operation:ReceiptOperation;ciphertextBytes:number;ciphertextSha256:string;ledgerState:string}>
type PrepareInput=Readonly<{url:string;deployment:string;routing:NativeRecordingRouting;snapshot:NativeRecordingSnapshot}>
type ArchiveFacts=Readonly<{call_id:string;recording_id:string;receipt_operation:string;operations:readonly string[];ciphertext_bytes:number;ciphertext_sha256:string;ledger_state:string}>
type RelayFacts=Readonly<{relay:Readonly<{status:string;processed:number;acked:number;retried:number;discarded:number}>;ledger_state:string}>
type ArchiveWitness=Readonly<{ledger_state:string;outbox_head_kind:string|null;outbox_head_operation_id:string|null;recording_outbox_rows:number}>
type DriverValue=ArchiveFacts|RelayFacts|ArchiveWitness|Readonly<{ack:true}>|Readonly<{files_removed:true;ack:true}>|Readonly<{retired:true}>
type DriverReply=Readonly<{ready?:true;ok?:DriverValue;error?:string}>
type DriverRequest=Readonly<{action:'prepare'}>&PrepareInput|Readonly<{action:'relay'|'witness';call_id:string}>|Readonly<{action:'ingest';call_id:string;operation:string;lost_commit:boolean}>|Readonly<{action:'erase';call_id:string;token:string}>|Readonly<{action:'close'}>
const invalid=()=>new Error('Native recording archive fixture contract')

function decodeArchive(value:DriverValue):ArchivedFixture {
  if(!('receipt_operation' in value)||typeof value.call_id!=='string'||typeof value.recording_id!=='string'||typeof value.receipt_operation!=='string'
    ||!Array.isArray(value.operations)||!value.operations.every((entry:unknown)=>typeof entry==='string')||typeof value.ciphertext_bytes!=='number'
    ||typeof value.ciphertext_sha256!=='string'||typeof value.ledger_state!=='string')throw invalid()
  try{
    const operation:ReceiptOperation=JSON.parse(value.receipt_operation)
    if(operation.call_id!==value.call_id||operation.payload.recording_id!==value.recording_id||operation.payload.archive_receipt.ciphertext_sha256!==value.ciphertext_sha256
      ||operation.payload.archive_receipt.encrypted_bytes!==value.ciphertext_bytes)throw invalid()
    return {callId:value.call_id,recordingId:value.recording_id,operations:value.operations,receiptBytes:value.receipt_operation,
      operation,ciphertextBytes:value.ciphertext_bytes,ciphertextSha256:value.ciphertext_sha256,ledgerState:value.ledger_state}
  }catch{throw invalid()}
}

/** A persistent fixture avoids repeated cold graph imports; selected producer stays owned by the caller. */
export async function startRecordingArchiveFixture() {
  const root=process.env.SPARRA_VOICE_TEST_ROOT,home=process.env.SPARRA_VOICE_TEST_HOME
  if(!root||!home)throw new Error('Recording receipt requires the prepared actual Voice source scope')
  const producer=await resolveVoiceProducer(root)
  const prefix='sparra-recording-native-',directory=await mkdtemp(join(tmpdir(),prefix))
  const child=spawn(producer.pythonExecutable,['-I','-B',resolve('tests/helpers/sparra-recording-archive-driver.py'),producer.sourceRoot,directory],{
    windowsHide:true,stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,
      PYTHONDONTWRITEBYTECODE:'1',HOME:home,APPDATA:home},
  })
  let buffer='',terminal=false,failed=false
  const queued:DriverReply[]=[]
  const pending:Array<{resolve:(value:DriverReply)=>void;reject:(error:Error)=>void}>=[]
  const exited=new Promise<void>(accept=>child.once('close',()=>{terminal=true;accept()}))
  function fail(){failed=true;for(const waiter of pending.splice(0))waiter.reject(invalid())}
  child.stdout.on('data',data=>{
    if(terminal||failed)return
    buffer+=data.toString()
    if(buffer.length>1048576){child.kill();fail();return}
    for(let newline=buffer.indexOf('\n');newline>=0;newline=buffer.indexOf('\n')){
      const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1)
      try{
        const reply:DriverReply=JSON.parse(line)
        if(typeof reply!=='object'||reply===null||Array.isArray(reply))throw invalid()
        const waiter=pending.shift();if(waiter)waiter.resolve(reply);else queued.push(reply)
      }catch{child.kill();fail();return}
    }
  })
  child.stderr.resume() // Provider URLs, private keys and dependency notices are never evidence output.
  child.stdin.on('error',fail)
  child.once('error',fail)
  child.once('close',fail)
  function read():Promise<DriverReply> {
    if(terminal||failed)return Promise.reject(invalid())
    const ready=queued.shift();if(ready)return Promise.resolve(ready)
    return new Promise((accept,reject)=>{
      const waiter={resolve:(value:DriverReply)=>{clearTimeout(timer);accept(value)},reject:(error:Error)=>{clearTimeout(timer);reject(error)}}
      const timer=setTimeout(()=>{const index=pending.indexOf(waiter);if(index>=0)pending.splice(index,1);child.kill();failed=true;reject(new Error('Native recording archive fixture30s deadline'))},30000)
      pending.push(waiter)
    })
  }
  async function command(request:DriverRequest):Promise<DriverValue> {
    if(terminal||failed)throw invalid()
    child.stdin.write(JSON.stringify(request)+'\n')
    const reply=await read()
    if(terminal||failed)throw invalid()
    if(typeof reply.error==='string')throw new Error('Native recording archive fixture: '+reply.error)
    if(reply.ok===undefined||typeof reply.ok!=='object'||reply.ok===null||Array.isArray(reply.ok))throw invalid()
    return reply.ok
  }
  async function awaitExit(milliseconds:number){
    let timer:ReturnType<typeof setTimeout>|undefined
    try{return await Promise.race([exited.then(()=>true),new Promise<false>(accept=>{timer=setTimeout(()=>accept(false),milliseconds)})])}
    finally{clearTimeout(timer)}
  }
  async function cleanup(){
    let retired=false
    try{
      if(!terminal&&!failed){const reply=await command({action:'close'});retired='retired' in reply&&reply.retired===true}
    }finally{
      child.stdin.end()
      if(!await awaitExit(3000)){child.kill();await awaitExit(3000)}
      if(!terminal)throw new Error('Native recording archive consumer retirement unknown: '+directory)
      await retireFixtureDirectory(directory,prefix,true)
    }
    if(!retired||child.exitCode!==0)throw new Error('Native recording archive cleanup failed')
  }
  try{if((await read()).ready!==true||terminal||failed)throw invalid()}
  catch(error){try{await cleanup()}catch{}throw error}
  return {
    async prepare(input:PrepareInput){
      return decodeArchive(await command({action:'prepare',...input}))
    },
    async relay(callId:string){
      const reply=await command({action:'relay',call_id:callId})
      if(!('relay' in reply)||typeof reply.relay!=='object'||reply.relay===null||typeof reply.relay.status!=='string'||typeof reply.relay.processed!=='number'
        ||typeof reply.relay.acked!=='number'||typeof reply.ledger_state!=='string')throw invalid()
      return {status:reply.relay.status,processed:reply.relay.processed,acked:reply.relay.acked,ledgerState:reply.ledger_state}
    },
    async ingest(callId:string,operation:string,lostCommit=false){
      return command({action:'ingest',call_id:callId,operation,lost_commit:lostCommit})
    },
    async witness(callId:string):Promise<ArchiveWitness>{
      const reply=await command({action:'witness',call_id:callId})
      if(!('outbox_head_kind' in reply)||typeof reply.ledger_state!=='string'||typeof reply.recording_outbox_rows!=='number')throw invalid()
      return reply
    },
    async erase(callId:string,token:string){return command({action:'erase',call_id:callId,token})},
    cleanup,
  }
}
