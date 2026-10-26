import { createMiddleware, createServerFn } from '@tanstack/react-start'
import { getRequest, setResponseHeader } from '@tanstack/react-start/server'
import { Schema } from 'effect'
import { requestResources } from '../../platform/resources.server'
import { createActivityOperations, parseSaveActivityInput } from './activity.server'
import { createKnowledgeConfirmationOperations, parseActivityConfirmationKey, parseConfirmActivityInput, parseKnowledgeImportInput } from './knowledge-confirmation.server'
export type { ActivityConfirmationDto, ActivityConfirmationKey, ActivityConfirmationLookup, ConfirmActivityInput, KnowledgeDecision, KnowledgeImportDto, KnowledgeImportInput } from './knowledge-confirmation.server'
export type { WebsiteCapture } from './website-capture.server'
export type { ActivityConfigurationDto, ActivityState, SaveActivityInput } from './activity.server'
import { createRequestOperations, parseListRequestsInput, parseRequestInput } from './requests.server'
export type { ListRequestsInput, ListRequestsPage, RequestDetailDto, EraseReceipt } from './requests.server'

const failures = {
  activity: { message: 'Activity unavailable', special: 'ActivityRevisionConflict', status: 409, invalid: 'InvalidActivityInput' },
  request: { message: 'Request unavailable', special: 'RequestNotFound', status: 404, invalid: 'InvalidRequestInput' },
} as const
function sparraErrors(kind: keyof typeof failures) {
  const failure = failures[kind]
  return createMiddleware({ type: 'function' }).server(async ({ next }) => {
    setResponseHeader('cache-control', 'no-store')
    try { return await next() }
    catch (error) {
      if (error instanceof Response) throw error
      const name = error instanceof Error ? error.name : ''
      if(kind === 'activity' && name === 'ActivityRecordingUnavailable') throw new Response('Local audio unavailable',{status:409,headers:{'x-sparra-activity-error':'recording-unavailable'}})
      if(kind === 'activity' && (name.startsWith('Knowledge') || name === 'InvalidKnowledgeInput' || name === 'WebsiteCaptureError')) {
        const status = name === 'InvalidKnowledgeInput' || name === 'WebsiteCaptureError' ? 400 : name === 'KnowledgeWorkspaceUnavailable' ? 404 : 409
        throw new Response('Knowledge operation unavailable',{status,headers:{'x-sparra-knowledge-error':name}})
      }
      const status = name === failure.special ? failure.status : name === failure.invalid || Schema.isSchemaError(error) ? 400 : 500
      throw new Response(failure.message, { status })
    }
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

export const importKnowledgePage = createServerFn({method:'POST'}).middleware([activityErrors]).validator(parseKnowledgeImportInput).handler(async({data})=>{
  const {request,resources,principal}=await admittedRequest()
  return createKnowledgeConfirmationOperations(resources.transactions).importPage(principal,data,new URL(request.url).origin,request.signal)
})
export const confirmActivity = createServerFn({method:'POST'}).middleware([activityErrors]).validator(parseConfirmActivityInput).handler(async({data})=>{
  const {request,resources,principal}=await admittedRequest()
  return createKnowledgeConfirmationOperations(resources.transactions).confirm(principal,data,request.signal)
})
export const getActivityConfirmation = createServerFn({method:'GET'}).middleware([activityErrors]).validator(parseActivityConfirmationKey).handler(async({data})=>{
  const {request,resources,principal}=await admittedRequest()
  return createKnowledgeConfirmationOperations(resources.transactions).lookup(principal,data,request.signal)
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
export const markRequestTreated=createServerFn({method:'POST'}).middleware([requestErrors]).validator(parseRequestInput).handler(async({data})=>{
  const {request,resources,principal}=await admittedRequest()
  return createRequestOperations(resources.transactions).treat(principal,data.requestId,request.signal)
})
export const eraseRequest=createServerFn({method:'POST'}).middleware([requestErrors]).validator(parseRequestInput).handler(async({data})=>{
  const {request,resources,principal}=await admittedRequest()
  return createRequestOperations(resources.transactions).erase(principal,data.requestId,request.signal)
})
export const getRequestErasure=createServerFn({method:'GET'}).middleware([requestErrors]).validator(parseRequestInput).handler(async({data})=>{
  const {request,resources,principal}=await admittedRequest()
  return createRequestOperations(resources.transactions).erasure(principal,data.requestId,request.signal)
})
