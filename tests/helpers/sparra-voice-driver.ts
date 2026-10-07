import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
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
export function startConnectedVoice(input:{url:string;keyring_path:string;evidence_path:string;state_path:string;resume_call_id?:string;recovery_case?:string;audio_candidate?:true;workspace_id?:string},producer?:Readonly<{pythonExecutable:string;sourceRoot:string}>) {
  const phaseEpoch=performance.now()
  const audioCommands=new Set(['audio-admit','audio-finish','audio-hold-ack','audio-erasure-held','audio-release-ack','stop'])
  const child=spawn(producer?.pythonExecutable??voice+'/.venv/Scripts/python.exe',[...(producer?['-I']:[]),'-B',resolve('tests/helpers/sparra-voice-driver.py')],{windowsHide:true,cwd:producer?dirname(producer.sourceRoot):undefined,env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,PYTHONPATH:voice+'/src',PYTHONDONTWRITEBYTECODE:'1',...(producer?{HOME:process.env.SPARRA_VOICE_TEST_HOME,APPDATA:process.env.SPARRA_VOICE_TEST_HOME,NLTK_DATA:process.env.SPARRA_VOICE_NLTK_DATA}:{})}})
  type QueuedTurnWitness=Readonly<{call_id:string;operation_id:string;operation_sha256:string;ciphertext_sha256:string;finalizer_operation_sha256:string;removed_before_ack:boolean}>
  type Reply={ready?:boolean;stopped?:boolean;call_id?:string;call_ids?:string[];revision?:number;loss?:number;retained?:number;map_bytes?:number;compact_bytes?:number;candidate_bytes?:number;stable?:boolean;cleaned?:boolean;recording_ack?:boolean;no_hangup?:boolean;ack_before_scrub?:boolean;queue_witness?:QueuedTurnWitness;checks?:string[];recording_id?:string;retention_until?:string;total_samples?:number;pcm_sha256?:string;writer_cleaned?:boolean;ack_held?:boolean;cleanup_commit_held?:boolean;cleanup_command?:'erase'|'audio_erase_complete';candidate?:boolean;error?:string;where?:string}
  const replies:Reply[]=[]
  const phases=new Set(['driver-input','driver-models','scenario-imported','candidate-setup','settings-valid','profile-valid',
    'keyring-valid','graph-build','graph-built','lifespan-start','network-start','scenario-ready','writer_startup_failed',
    'writer_quick_check_failed','qualification_status_failed','operation_sink_open_failed','stale_recovery_failed',
    'runtime_publication_failed','runtime_begin_drain_failed','other_safe_failure','metrics-build','metrics-built',
    'sink-build','sink-built','control-build','control-built','inference-factories-build','inference-factories-built',
    'audio-admit-entered','audio-admit-completed','audio-finish-entered','audio-finish-completed',
    'webhook-initiated-send','webhook-initiated-accepted','registry-admitted','webhook-answered-accepted',
    'stream-command-wait','stream-command-seen','media-connected','disclosure-mark-echoed','session-constructed',
    'controller-choice-ready','dtmf-one-send','dtmf-one-sent','input-gate-active',
    'asgi-webhook-entered','asgi-webhook-retired','registry-resolve-entered','registry-resolve-returned',
    'registry-resolve-rejected','begin-rpc-entered','begin-rpc-returned','begin-rpc-failed',
    'audio-hangup-accepted','audio-media-close-start','audio-media-close-completed','audio-capture-stopped',
    'audio-capture-state-off','audio-capture-state-recording','audio-capture-state-partial','audio-capture-state-stopped',
    'audio-capture-event-pending','audio-capture-event-joined','audio-capture-receipt-pending','audio-capture-receipt-joined',
    'native-close-entered','native-close-media-start','native-close-media-joined','native-close-server-start',
    'native-close-server-joined','native-close-runtime-start','native-close-runtime-joined',
    'native-close-http-start','native-close-http-joined','native-close-completed',
    'audio-erase-lease-acquired','audio-erase-lease-failed','audio-erase-stop-start','audio-erase-stop-completed',
    'audio-erase-stop-failed','audio-erase-writer-start','audio-erase-writer-completed','audio-erase-writer-failed',
    'audio-ack-callback-entered','audio-ack-held-entered',
    'audio-terminal-absent','audio-terminal-pending','audio-terminal-acked'])
  const waiters:Array<{resolve:(value:Reply)=>void;reject:(error:Error)=>void}>=[]
  let text='',closed=false,nativeCloseCompleted=false,ackInvariantRefusal:Error|undefined
  const fail=(label:string)=>{closed=true;for(const waiter of waiters.splice(0))waiter.reject(new Error(label))}
  child.stdout.on('data',bytes=>{
    text+=bytes.toString()
    if(text.length>2097152){child.kill();fail('Connected Voice output bound');return}
    for(let newline=text.indexOf('\n');newline>=0;newline=text.indexOf('\n')){
      const line=text.slice(0,newline);text=text.slice(newline+1)
      try{
        const value:Reply&{phase?:string;peak_rss_kib?:number;elapsed_ms?:number;admission_guard?:Record<string,boolean>;audio_terminal_guard?:Record<string,boolean>;audio_ack_refusal?:{condition:string;error_class:string};server_join_guard?:{connections:number;tasks:number;owner_present:boolean;owner_closed:boolean;owner_task_done:boolean;owner_phase:string;stacks:Array<{done:boolean;frames:Array<{file:string;function:string;line:number}>}>;connection_states:Array<{protocol:string;closing:boolean;write_buffer_bytes:number;tls:boolean}>}}=JSON.parse(line)
        if(value.server_join_guard!==undefined){
          const guard=value.server_join_guard
          const phases=new Set(['absent','gated','constructing','preactivated','finishing','done','other'])
          if(!input.audio_candidate||Object.keys(guard).length!==8||!Number.isSafeInteger(guard.connections)||guard.connections<0||guard.connections>65535||!Number.isSafeInteger(guard.tasks)||guard.tasks<0||guard.tasks>65535||typeof guard.owner_present!=='boolean'||typeof guard.owner_closed!=='boolean'||typeof guard.owner_task_done!=='boolean'||!phases.has(guard.owner_phase)||!Array.isArray(guard.stacks)||guard.stacks.length>8||!Array.isArray(guard.connection_states)||guard.connection_states.length>8)throw new Error('Invalid diagnostic')
          const protocols=new Set(['H11Protocol','HttpToolsProtocol','WebSocketProtocol','WebSocketsSansIOProtocol','WSProtocol','other'])
          for(const connection of guard.connection_states){if(!protocols.has(connection.protocol)||typeof connection.closing!=='boolean'||typeof connection.tls!=='boolean'||!Number.isSafeInteger(connection.write_buffer_bytes)||connection.write_buffer_bytes<0)throw new Error('Invalid diagnostic')}
          for(const stack of guard.stacks){
            if(typeof stack.done!=='boolean'||!Array.isArray(stack.frames)||stack.frames.length>16)throw new Error('Invalid diagnostic')
            for(const frame of stack.frames){if(typeof frame.file!=='string'||frame.file!=='native-code'&&!/^[a-z_]+(?:\.py)?$/.test(frame.file)||frame.file.length>128||typeof frame.function!=='string'||frame.function!=='native-code'&&!/^[A-Za-z_][A-Za-z0-9_]*$/.test(frame.function)||frame.function.length>128||!Number.isSafeInteger(frame.line)||frame.line<0)throw new Error('Invalid diagnostic')}
          }
          console.log('PAIRED_SERVER_JOIN_GUARD '+JSON.stringify(guard));continue
        }
        if(value.audio_terminal_guard!==undefined){
          const names=['outbox_empty','terminal_present','terminal_bounded','terminal_known_acked','terminal_cipher_present','terminal_metadata_only','terminal_identity_exact','retention_original_30d']
          if(!input.audio_candidate||Object.keys(value.audio_terminal_guard).length!==names.length||names.some(name=>typeof value.audio_terminal_guard?.[name]!=='boolean'))throw new Error('Invalid diagnostic')
          console.log('PAIRED_AUDIO_TERMINAL_GUARD '+JSON.stringify(value.audio_terminal_guard));continue
        }
        if(value.audio_ack_refusal!==undefined){
          const conditions=new Set(['native_memory_scrub_before_ack','native_begin_holder_scrub_before_ack','native_owner_scrub_before_ack','native_bridge_cache_scrub_before_ack','native_bridge_facts_scrub_before_ack','native_content_removed_before_ack','native_capture_owned_before_ack','native_capture_terminal_before_ack','native_capture_event_joined_before_ack','native_capture_receipts_joined_before_ack','native_cleanup_commit_joined_before_ack','native_audio_ciphertext_removed_before_ack','native_audio_content_removed_known_metadata_before_ack','native_audio_terminal_observation_bound','native_ack_failure'])
          const classes=new Set(['AssertionError','RuntimeError','PersistenceError','CommandSerializationError','OperationSinkContractError','OperationSinkPermanentError','TimeoutError','OtherException'])
          if(!input.audio_candidate||Object.keys(value.audio_ack_refusal).length!==2||!conditions.has(value.audio_ack_refusal.condition)||!classes.has(value.audio_ack_refusal.error_class))throw new Error('Invalid diagnostic')
          ackInvariantRefusal??=new Error('Connected Voice ACK invariant refused: '+value.audio_ack_refusal.condition)
          console.log('PAIRED_AUDIO_ACK_REFUSAL '+JSON.stringify(value.audio_ack_refusal));continue
        }
        if(value.admission_guard!==undefined){const names=['same_call_id','generation_present','same_admitted_created','retention_30d'];if(!input.audio_candidate||Object.keys(value.admission_guard).length!==names.length||names.some(name=>typeof value.admission_guard?.[name]!=='boolean'))throw new Error('Invalid diagnostic');console.log('PAIRED_ADMISSION_GUARD '+JSON.stringify(value.admission_guard));continue}
        if(value.phase!==undefined){if(!input.audio_candidate||!phases.has(value.phase)||value.peak_rss_kib!==undefined&&(!Number.isSafeInteger(value.peak_rss_kib)||value.peak_rss_kib<0)||value.elapsed_ms!==undefined&&(!Number.isSafeInteger(value.elapsed_ms)||value.elapsed_ms<0))throw new Error('Invalid diagnostic');if(value.phase==='native-close-completed')nativeCloseCompleted=true;console.log('PAIRED_VOICE_PHASE '+value.phase+' elapsed_ms='+Math.round(performance.now()-phaseEpoch)+(value.peak_rss_kib===undefined?'':' peak_rss_kib='+value.peak_rss_kib)+(value.elapsed_ms===undefined?'':' python_elapsed_ms='+value.elapsed_ms));continue}
        const waiter=waiters.shift();if(waiter)waiter.resolve(value);else replies.push(value)
      }catch{child.kill();fail('Connected Voice invalid fixture output')}
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
      const timer=setTimeout(()=>{const at=waiters.indexOf(waiter);if(at>=0)waiters.splice(at,1);child.kill();reject(new Error('Connected Voice phase deadline'))},input.audio_candidate?10000:90000)
      waiters.push(waiter)
    })
  }
  async function checked(){const reply=await read();if(ackInvariantRefusal)throw ackInvariantRefusal;if(reply.error)throw new Error('Connected Voice '+reply.error+' at '+reply.where);return reply}
  child.stdin.write(JSON.stringify({action:'connected',...input,...(producer?{source_root:producer.sourceRoot}:{})})+'\n')
  async function exited(){await new Promise<void>(resolve=>{if(child.exitCode!==null||child.signalCode!==null)resolve();else child.once('close',()=>resolve())});return {code:child.exitCode,signal:child.signalCode}}
  return {ready:checked(),nativeCloseCompleted:()=>nativeCloseCompleted,async command(action:string){if(input.audio_candidate&&audioCommands.has(action))console.log('PAIRED_VOICE_COMMAND '+action+' sent elapsed_ms='+Math.round(performance.now()-phaseEpoch));child.stdin.write(JSON.stringify({action})+'\n');const reply=await checked();if(input.audio_candidate&&audioCommands.has(action))console.log('PAIRED_VOICE_COMMAND '+action+' delivered elapsed_ms='+Math.round(performance.now()-phaseEpoch));return reply},async stop(fixtureCloseFailure=false){
    child.stdin.write(JSON.stringify({action:'stop',...(fixtureCloseFailure?{fixture_close_failure:true}:{})})+'\n')
    let failure:unknown
    try{const reply=await checked();if(!reply.stopped)throw new Error('Connected Voice stop missing')}
    catch(error){failure=error}finally{child.stdin.end()}
    const ended=await exited()
    if(failure!==undefined)throw failure
    if(ackInvariantRefusal)throw ackInvariantRefusal
    if(ended.code!==0||ended.signal!==null||replies.some(reply=>reply.error!==undefined))throw new Error('Connected Voice final closure failed')
    return ended
  },async crash(){child.kill('SIGKILL');return exited()},async cleanup(){if(!closed){child.stdin.end();if(!input.audio_candidate)child.kill()}return exited()}}
}
