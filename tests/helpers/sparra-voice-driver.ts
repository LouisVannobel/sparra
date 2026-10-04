import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import type { NativeEncryptedTurn } from '../../src/modules/sparra/message-crypto.server'

type BeginSnapshot={schema_version:1;call_id:string;configuration_revision:number;recording_enabled:boolean;knowledge:{business_name:string;sector:string;opening_hours:string;services:string;prices:string;faq:string;instructions:string};transfer_destination:string|null;retention_until:string}
type CallLease={schema_version:1;call_id:string;lease_token:string;deployment_id:string;original_retention_until:string;lease_expires_at:string}
type RecordingLease={schema_version:1;recording_id:string;lease_token:string;telnyx_recording_id:string;purge_attempt:number;lease_expires_at:string}
type BeginRequest={url:string;deployment:string;call_id:string;routing:object}
type FixtureRequests={identity:{url:string};begin:BeginRequest;begin_unknown_commit:BeginRequest;ingest:{url:string;operation:object};lease_call:{url:string};lease_recording:{url:string};ack_call:{url:string;id:string;token:string;at:string};ack_recording:{url:string;id:string;token:string;at:string;outcome:string};aggregate_size:{turns:object};turn:{keyring_path:string;turn_id:string;at:string}}
type FixtureResults={identity:{login:string;role:string};begin:BeginSnapshot;begin_unknown_commit:BeginSnapshot;ingest:{ack:true};lease_call:CallLease[];lease_recording:RecordingLease[];ack_call:{ack:true};ack_recording:{ack:true};aggregate_size:{bytes:number};turn:NativeEncryptedTurn}
type FixtureReply<T>={ok:T;error?:never}|{error:string;ok?:never}
export function nativeValue<T>(reply:FixtureReply<T>):T {
  if(reply.error!==undefined)throw new Error('Native Voice fixture: '+reply.error)
  return reply.ok
}
const voice='C:/Users/louis/Documents/ChatGPT/.worktrees/sparra-voice-pilot'
// These are fixture transport shapes. Actual Python Pydantic models and the
// native sink validate requests; integration assertions verify exact responses.
export function nativeVoice<A extends keyof FixtureRequests>(request:{action:A}&FixtureRequests[A]):Promise<FixtureReply<FixtureResults[A]>> {
  return new Promise((accept,reject)=>{
    const child=spawn(voice+'/.venv/Scripts/python.exe',['-B',resolve('tests/helpers/sparra-voice-driver.py')],{windowsHide:true,env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,PYTHONPATH:voice+'/src',PYTHONDONTWRITEBYTECODE:'1'}})
    const timeout=setTimeout(()=>{child.kill();reject(new Error('Native Voice fixture deadline'))},15000)
    let output=''
    child.stdout.on('data',data=>{output+=data;if(output.length>1048576){child.kill();reject(new Error('Native Voice fixture output bound'))}})
    child.stderr.resume()
    child.on('error',()=>{clearTimeout(timeout);reject(new Error('Native Voice fixture startup'))})
    child.on('close',code=>{clearTimeout(timeout);try{if(code!==0)throw new Error();accept(JSON.parse(output))}catch{reject(new Error('Native Voice fixture failed'))}})
    child.stdin.end(JSON.stringify(request))
  })
}

/** Test-only persistent transport; Python owns the native graph and validates facts. */
export function startConnectedVoice(input:{url:string;keyring_path:string;evidence_path:string;state_path:string;resume_call_id?:string;recovery_case?:string}) {
  const child=spawn(voice+'/.venv/Scripts/python.exe',['-B',resolve('tests/helpers/sparra-voice-driver.py')],{windowsHide:true,env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,PYTHONPATH:voice+'/src',PYTHONDONTWRITEBYTECODE:'1'}})
  type QueuedTurnWitness=Readonly<{call_id:string;operation_id:string;operation_sha256:string;ciphertext_sha256:string;finalizer_operation_sha256:string;removed_before_ack:boolean}>
  type Reply={ready?:boolean;call_id?:string;call_ids?:string[];revision?:number;loss?:number;retained?:number;map_bytes?:number;compact_bytes?:number;candidate_bytes?:number;stable?:boolean;cleaned?:boolean;recording_ack?:boolean;no_hangup?:boolean;ack_before_scrub?:boolean;queue_witness?:QueuedTurnWitness;checks?:string[];error?:string;where?:string}
  const replies:Reply[]=[]
  const waiters:Array<{resolve:(value:Reply)=>void;reject:(error:Error)=>void}>=[]
  let text='',closed=false
  const fail=(label:string)=>{closed=true;for(const waiter of waiters.splice(0))waiter.reject(new Error(label))}
  child.stdout.on('data',bytes=>{
    text+=bytes.toString()
    if(text.length>2097152){child.kill();fail('Connected Voice output bound');return}
    for(let newline=text.indexOf('\n');newline>=0;newline=text.indexOf('\n')){
      const line=text.slice(0,newline);text=text.slice(newline+1)
      try{const value:Reply=JSON.parse(line);const waiter=waiters.shift();if(waiter)waiter.resolve(value);else replies.push(value)}catch{child.kill();fail('Connected Voice invalid fixture output')}
    }
  })
  child.stderr.resume() // Native dependency notices are not provider payload artifacts.
  child.on('error',()=>fail('Connected Voice startup failed'))
  child.on('close',()=>fail('Connected Voice closed'))
  function read():Promise<Reply>{
    const buffered=replies.shift();if(buffered)return Promise.resolve(buffered)
    if(closed)return Promise.reject(new Error('Connected Voice closed'))
    return new Promise((resolve,reject)=>{
      const waiter={resolve:(value:Reply)=>{clearTimeout(timer);resolve(value)},reject:(error:Error)=>{clearTimeout(timer);reject(error)}}
      const timer=setTimeout(()=>{const at=waiters.indexOf(waiter);if(at>=0)waiters.splice(at,1);child.kill();reject(new Error('Connected Voice phase deadline'))},90000)
      waiters.push(waiter)
    })
  }
  async function checked(){const reply=await read();if(reply.error)throw new Error('Connected Voice '+reply.error+' at '+reply.where);return reply}
  child.stdin.write(JSON.stringify({action:'connected',...input})+'\n')
  async function exited(){await new Promise<void>(resolve=>{if(child.exitCode!==null||child.signalCode!==null)resolve();else child.once('close',()=>resolve())});return {code:child.exitCode,signal:child.signalCode}}
  return {ready:checked(),async command(action:string){child.stdin.write(JSON.stringify({action})+'\n');return checked()},async crash(){child.kill('SIGKILL');return exited()},async cleanup(){if(!closed){child.stdin.end();child.kill()}await exited()}}
}
