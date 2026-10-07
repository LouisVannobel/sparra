// Actual registered source mapper; next/header boundaries are controlled.
// This unit does not qualify HTTP, authentication, R1 or a server invocation.
import { beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { createMiddleware, createStart, executeMiddleware, type FunctionMiddleware, type ServerFnMiddlewareResult } from '@tanstack/react-start'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Schema } from 'effect'
import { InvalidActivityInput } from '../../src/modules/sparra/activity.server'
import { parseRequestInput } from '../../src/modules/sparra/requests.server'

type NativeMapper=Parameters<FunctionMiddleware<{}>['server']>[0]
type RegisteredMiddleware=Parameters<typeof executeMiddleware>[0][number]
type MappingObservation={mappers:RegisteredMiddleware[];capturing:boolean;header:ReturnType<typeof vi.fn>}
const observed=vi.hoisted(():MappingObservation=>({mappers:[],capturing:true,header:vi.fn()}))
let withNativeStart:(execute:()=>Promise<ServerFnMiddlewareResult>)=>Promise<ServerFnMiddlewareResult>
vi.mock('@tanstack/react-start',async importOriginal=>{
  const actual=await importOriginal<typeof import('@tanstack/react-start')>()
  return {...actual,createMiddleware:(options:{type:'function'})=>{
    const native=actual.createMiddleware(options)
    return {...native,server:(callback:NativeMapper)=>{
      const registered=native.server(callback)
      if(observed.capturing)observed.mappers.push(registered)
      return registered
    }}
  }}
})
vi.mock('@tanstack/react-start/server',async importOriginal=>{
  const actual=await importOriginal<typeof import('@tanstack/react-start/server')>()
  return {...actual,setResponseHeader:observed.header}
})
beforeAll(async()=>{
  await import('../../src/modules/sparra/sparra.functions')
  expect(observed.mappers).toHaveLength(2)
  observed.capturing=false
  const require=createRequire(import.meta.url)
  const startPackage=require.resolve('@tanstack/react-start/package.json')
  const corePackage=createRequire(startPackage).resolve('@tanstack/start-client-core/package.json')
  const storagePackage=createRequire(corePackage).resolve('@tanstack/start-storage-context/package.json')
  const storage:unknown=await import(pathToFileURL(join(dirname(storagePackage),'dist/esm/index.js')).href)
  if(typeof storage!=='object'||storage===null||!('runWithStartContext' in storage)
    ||typeof storage.runWithStartContext!=='function')throw new Error('Public native Start context runner unavailable')
  const runWithStartContext=storage.runWithStartContext
  const startOptions=await createStart(()=>({})).getOptions()
  withNativeStart=async execute=>{
    let result:ServerFnMiddlewareResult|undefined
    await runWithStartContext({request:new Request('http://mapping-unit.invalid/'),startOptions,
      getRouter:()=>{throw new Error('Mapping unit unexpectedly requested a router')},
      contextAfterGlobalMiddlewares:{},executedRequestMiddlewares:new Set(),handlerType:'serverFn'},
    async()=>{result=await execute()})
    if(result===undefined)throw new Error('Native Start context did not execute its mapping callback')
    return result
  }
})
beforeEach(()=>observed.header.mockClear())

function mapping(kind:'activity'|'request',failure?:unknown){
  const value=observed.mappers[kind==='activity'?0:1]
  if(!value)throw new Error('Native error mapper was not registered')
  const terminal=createMiddleware({type:'function'}).server(async({next})=>{
    if(failure!==undefined)throw failure
    return next({context:{unitResult:true}})
  })
  return withNativeStart(()=>executeMiddleware([value,terminal],'server',{
    method:'GET',data:undefined,context:{},headers:new Headers(),signal:new AbortController().signal,
    serverFnMeta:{id:'sparra-error-mapping-unit'},
  }))
}
function namedFailure(name:string){const value=new Error('private-unit-marker');value.name=name;return value}
function schemaFailure(){try{Schema.decodeUnknownSync(Schema.String)(1)}catch(error){return error}throw new Error('Schema fixture unexpectedly passed')}
function requestInputFailure(){try{parseRequestInput({})}catch(error){return error}throw new Error('Request fixture unexpectedly passed')}

test.each(['activity','request'] as const)('registered %s mapper returns next and preserves a thrown Response',async kind=>{
  expect((await mapping(kind)).context).toEqual({unitResult:true})
  const refusal=new Response('private-unit-marker',{status:401})
  expect((await mapping(kind,refusal)).error).toBe(refusal)
  expect(observed.header.mock.calls).toEqual([['cache-control','no-store'],['cache-control','no-store']])
})

test.each([
  ['activity',()=>new InvalidActivityInput(),400,'Activity unavailable'],
  ['activity',()=>namedFailure('ActivityRevisionConflict'),409,'Activity unavailable'],
  ['activity',()=>namedFailure('ActivityRecordingUnavailable'),409,'Local audio unavailable'],
  ['request',requestInputFailure,400,'Request unavailable'],
  ['request',()=>namedFailure('RequestNotFound'),404,'Request unavailable'],
  ['activity',schemaFailure,400,'Activity unavailable'],
  ['request',schemaFailure,400,'Request unavailable'],
  ['activity',()=>new Error('private-unit-marker'),500,'Activity unavailable'],
  ['request',()=>new Error('private-unit-marker'),500,'Request unavailable'],
  ['request',()=>({private:'private-unit-marker'}),500,'Request unavailable'],
] as const)('registered %s mapper safely maps row %#',async(kind,failure,status,message)=>{
  const rejection=(await mapping(kind,failure())).error
  expect(rejection).toBeInstanceOf(Response)
  if(!(rejection instanceof Response))throw new Error('Native mapper did not return its bounded refusal')
  expect(rejection.status).toBe(status)
  expect(await rejection.text()).toBe(message)
  expect(observed.header).toHaveBeenCalledExactlyOnceWith('cache-control','no-store')
})
