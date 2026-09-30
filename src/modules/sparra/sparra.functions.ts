import { createMiddleware, createServerFn } from '@tanstack/react-start'
import { getRequest, setResponseHeader } from '@tanstack/react-start/server'
import { Schema } from 'effect'
import { requestResources } from '../../platform/resources.server'
import { createActivityOperations, parseSaveActivityInput } from './activity.server'
export type { ActivityConfigurationDto, ActivityState, SaveActivityInput } from './activity.server'

const activityErrors = createMiddleware({ type: 'function' }).server(async ({ next }) => {
  setResponseHeader('cache-control','no-store')
  try { return await next() }
  catch(error) {
    if(error instanceof Response) throw error
    const name = error instanceof Error ? error.name : ''
    throw new Response('Activity unavailable',{status:name==='ActivityRevisionConflict' ? 409 : name==='InvalidActivityInput' || Schema.isSchemaError(error) ? 400 : 500})
  }
})
export const getActivity = createServerFn({method:'GET'}).middleware([activityErrors])
  .validator((input:unknown)=>Schema.decodeUnknownSync(Schema.Record(Schema.String,Schema.Never),{onExcessProperty:'error'})(input === undefined ? {} : input))
  .handler(async()=>{
    const request=getRequest(),resources=requestResources(request)
    if(!resources.auth) throw new Response('Unauthorized',{status:401})
    const principal=await resources.auth.requirePrincipal(request)
    return createActivityOperations(resources.transactions).read(principal,request.signal)
  })
export const saveActivity = createServerFn({method:'POST'}).middleware([activityErrors])
  .validator(parseSaveActivityInput)
  .handler(async({data})=>{
    const request=getRequest(),resources=requestResources(request)
    if(!resources.auth) throw new Response('Unauthorized',{status:401})
    const principal=await resources.auth.requirePrincipal(request)
    const result=await createActivityOperations(resources.transactions).save(principal,data,request.signal)
    if(!result) throw new Response('Activity unavailable',{status:404})
    return result
  })
