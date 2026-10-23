import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { nativeVoice } from '../helpers/sparra-voice-driver'

type ChildTransportBoundary={environment:NodeJS.ProcessEnv|undefined;args:readonly string[]}
const boundary=vi.hoisted(():ChildTransportBoundary=>({environment:undefined,args:[]}))
vi.mock('node:child_process',async importOriginal=>{
  const actual=await importOriginal<typeof import('node:child_process')>()
  const {EventEmitter}=await import('node:events'),{PassThrough}=await import('node:stream')
  return {...actual,spawn:(_executable:string,args:readonly string[],options:{env:NodeJS.ProcessEnv})=>{
    boundary.environment=options.env;boundary.args=args
    const child=new EventEmitter(),stdout=new PassThrough(),stderr=new PassThrough()
    return Object.assign(child,{stdout,stderr,kill:()=>true,stdin:{end:()=>{
      queueMicrotask(()=>{stdout.end(JSON.stringify({ok:{bytes:2}}));child.emit('close',0)})
    }}})
  }}
})
afterEach(()=>{vi.unstubAllEnvs();boundary.environment=undefined;boundary.args=[]})

// This double records the real transport's spawn boundary. It proves environment
// forwarding only, never Python/SQL/native identity or product acceptance.
test('one-shot Voice transport forwards its owned HOME and APPDATA at the child boundary',async()=>{
  const root=process.env.SPARRA_VOICE_TEST_ROOT
  if(!root)throw new Error('Transport regression requires the explicit canonical producer root')
  const owned=await realpath(await mkdtemp(join(tmpdir(),'sparra-voice-home-transport-')))
  try{
    vi.stubEnv('SPARRA_VOICE_TEST_HOME',owned)
    expect(await nativeVoice({action:'aggregate_size',turns:{}})).toEqual({ok:{bytes:2}})
    expect(boundary.environment).toMatchObject({HOME:owned,APPDATA:owned,PYTHONDONTWRITEBYTECODE:'1'})
    expect(boundary.args.slice(0,2)).toEqual(['-I','-B'])
  }finally{
    if(dirname(owned)!==await realpath(tmpdir())||!basename(owned).startsWith('sparra-voice-home-transport-'))throw new Error('Refusing foreign transport fixture cleanup')
    await rm(owned,{recursive:true})
  }
})
