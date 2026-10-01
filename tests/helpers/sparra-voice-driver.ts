import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import type { NativeEncryptedTurn } from '../../src/modules/sparra/message-crypto.server'

type BeginSnapshot={schema_version:1;call_id:string;configuration_revision:number;knowledge:{business_name:string;sector:string;opening_hours:string;services:string;prices:string;faq:string;instructions:string};transfer_destination:string|null;retention_until:string}
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
