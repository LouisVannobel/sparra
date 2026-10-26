import { createMiddleware, createServerFn } from '@tanstack/react-start'
import { getRequest, setResponseHeader } from '@tanstack/react-start/server'
import { Schema } from 'effect'
import { requestResources } from '../../platform/resources.server'
import { createActivityOperations, parseSaveActivityInput } from './activity.server'
export type { ActivityConfigurationDto, ActivityState, SaveActivityInput } from './activity.server'
import { createRequestOperations, parseListRequestsInput, parseRequestInput, parseUpdateRequestFollowUpInput } from './requests.server'
export type { ListRequestsInput, ListRequestsPage, RequestDetailDto, EraseReceipt } from './requests.server'

const failures = {
  activity: { message: 'Activity unavailable', special: 'ActivityRevisionConflict', status: 409, invalid: 'InvalidActivityInput' },
  request: { message: 'Request unavailable', special: 'RequestNotFound', status: 404, invalid: 'InvalidRequestInput' },
} as const
const publicationErrors=new Map([
  ['RequestPublicationConflict','publication-conflict'],
  ['RequestPublicationProvisional','publication-provisional'],
  ['RequestPublicationUnreadable','publication-unreadable'],
])
function sparraFailure(kind:keyof typeof failures,error:unknown):Response {
  if(error instanceof Response)return error
  const failure=failures[kind],name=error instanceof Error?error.name:''
  const publication=kind==='request'?publicationErrors.get(name):undefined
  if(publication)return new Response(error instanceof Error?error.message:'Request unavailable',{status:409,headers:{'x-sparra-request-error':publication}})
  if(kind==='activity'&&name==='ActivityRecordingUnavailable')return new Response('Local audio unavailable',{status:409,headers:{'x-sparra-activity-error':'recording-unavailable'}})
  if(name===failure.special)return new Response(failure.message,{status:failure.status})
  if(name===failure.invalid||Schema.isSchemaError(error))return new Response(failure.message,{status:400})
  return new Response(failure.message,{status:500})
}
function sparraErrors(kind: keyof typeof failures) {
  return createMiddleware({ type: 'function' }).server(async ({ next }) => {
    setResponseHeader('cache-control', 'no-store')
    try { return await next() }
    catch (error) { throw sparraFailure(kind,error) }
  })
}
async function admittedRequest() {
  const request = getRequest(), resources = requestResources(request)
  if (!resources.auth) throw new Response('Unauthorized', { status: 401 })
  const principal = await resources.auth.requirePrincipal(request)
  return { request, resources, principal }
}
const activityErrors = sparraErrors('activity')
export const getActivity = createServerFn({method:'GET'}).middleware([activityErrors])
  .validator((input:unknown)=>Schema.decodeUnknownSync(Schema.Record(Schema.String,Schema.Never),{onExcessProperty:'error'})(input === undefined ? {} : input))
  .handler(async()=>{
    const {request,resources,principal}=await admittedRequest()
    return createActivityOperations(resources.transactions).read(principal,request.signal)
  })
export const saveActivity = createServerFn({method:'POST'}).middleware([activityErrors])
  .validator(parseSaveActivityInput)
  .handler(async({data})=>{
    const {request,resources,principal}=await admittedRequest()
    const result=await createActivityOperations(resources.transactions).save(principal,data,request.signal)
    if(!result) throw new Response('Activity unavailable',{status:404})
    return result
  })

const requestErrors=sparraErrors('request')
export const listRequests=createServerFn({method:'GET'}).middleware([requestErrors]).validator(parseListRequestsInput).handler(async({data})=>{
  const {request,resources,principal}=await admittedRequest()
  return createRequestOperations(resources.transactions).list(principal,data,request.signal)
})
export const getRequestDetail=createServerFn({method:'GET'}).middleware([requestErrors]).validator(parseRequestInput).handler(async({data})=>{
  const {request,resources,principal}=await admittedRequest()
  const detail=await createRequestOperations(resources.transactions).detail(principal,data.requestId,request.signal)
  return {...detail,audio:detail.audio?{...detail.audio,available:detail.audio.available&&resources.audioReader?.isAvailable()===true}:undefined}
})
export const updateRequestFollowUp=createServerFn({method:'POST'}).middleware([requestErrors]).validator(parseUpdateRequestFollowUpInput).handler(async({data})=>{
  const {request,resources,principal}=await admittedRequest()
  return createRequestOperations(resources.transactions).updateFollowUp(principal,data,request.signal)
})
// Existing callers keep their endpoint name during the UI migration, with the
// same strict publication-bound command. ID-only payloads are always rejected.
// Native HTTP consumers: sparra-requests, sparra-browser and sparra-voice-connected integration tests.
// fallow-ignore-next-line unused-export
export const markRequestTreated=createServerFn({method:'POST'}).middleware([requestErrors]).validator(parseUpdateRequestFollowUpInput).handler(async({data})=>{
  const {request,resources,principal}=await admittedRequest()
  return createRequestOperations(resources.transactions).updateFollowUp(principal,data,request.signal)
})
export const eraseRequest=createServerFn({method:'POST'}).middleware([requestErrors]).validator(parseRequestInput).handler(async({data})=>{
  const {request,resources,principal}=await admittedRequest()
  return createRequestOperations(resources.transactions).erase(principal,data.requestId,request.signal)
})
export const getRequestErasure=createServerFn({method:'GET'}).middleware([requestErrors]).validator(parseRequestInput).handler(async({data})=>{
  const {request,resources,principal}=await admittedRequest()
  return createRequestOperations(resources.transactions).erasure(principal,data.requestId,request.signal)
})
