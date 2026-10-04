import { createMiddleware, createServerFn } from '@tanstack/react-start'
import { getRequest, setResponseHeader } from '@tanstack/react-start/server'
import { Schema } from 'effect'
import { requestResources } from '../../platform/resources.server'
import { createActivityOperations, parseSaveActivityInput } from './activity.server'
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

const requestErrors=sparraErrors('request')
export const listRequests=createServerFn({method:'GET'}).middleware([requestErrors]).validator(parseListRequestsInput).handler(async({data})=>{
  const {request,resources,principal}=await admittedRequest()
  return createRequestOperations(resources.transactions).list(principal,data,request.signal)
})
export const getRequestDetail=createServerFn({method:'GET'}).middleware([requestErrors]).validator(parseRequestInput).handler(async({data})=>{
  const {request,resources,principal}=await admittedRequest()
  return createRequestOperations(resources.transactions).detail(principal,data.requestId,request.signal)
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
