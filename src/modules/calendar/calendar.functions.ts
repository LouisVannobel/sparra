import { createMiddleware, createServerFn } from '@tanstack/react-start'
import { getRequest, setResponseHeader } from '@tanstack/react-start/server'
import { Schema } from 'effect'
import { requestResources } from '../../platform/resources.server'
import { parseSaveCalendarPolicy } from './policy'
import { CalendarOperationError } from './connection.server'

const calendarStatus={unavailable:503,missing_workspace:404,conflict:409,busy:409,rejected:400} as const
function calendarErrorStatus(error:unknown):number {
  if(error instanceof CalendarOperationError)return calendarStatus[error.code]
  return error instanceof Error&&error.name==='InvalidCalendarPolicy'||Schema.isSchemaError(error)?400:503
}
const errors=createMiddleware({type:'function'}).server(async({next})=>{
  setResponseHeader('cache-control','no-store')
  try{return await next()}catch(error){
    if(error instanceof Response)throw error
    throw new Response('Calendar unavailable',{status:calendarErrorStatus(error)})
  }
})
async function admitted(){const request=getRequest(),resources=requestResources(request);if(!resources.auth)throw new Response('Unauthorized',{status:401});const principal=await resources.auth.requirePrincipal(request);if(!resources.calendar)throw new Response('Calendar unavailable',{status:503});return {request,principal,calendar:resources.calendar}}
const empty=(input:unknown)=>Schema.decodeUnknownSync(Schema.Record(Schema.String,Schema.Never),{onExcessProperty:'error'})(input??{})
export const getCalendar=createServerFn({method:'GET'}).middleware([errors]).validator(empty).handler(async()=>{const {request,principal,calendar}=await admitted();return calendar.read(principal,request.signal)})
export const beginCalendarConnection=createServerFn({method:'POST'}).middleware([errors]).validator((input:unknown)=>Schema.decodeUnknownSync(Schema.Struct({locale:Schema.Literals(['fr','en'])}),{onExcessProperty:'error'})(input)).handler(async({data})=>{const {request,principal,calendar}=await admitted();return calendar.beginConnection(principal,request.signal,data.locale)})
export const saveCalendarPolicy=createServerFn({method:'POST'}).middleware([errors]).validator(parseSaveCalendarPolicy).handler(async({data})=>{const {request,principal,calendar}=await admitted();return calendar.savePolicy(principal,data,request.signal)})
export const disconnectCalendar=createServerFn({method:'POST'}).middleware([errors]).validator(empty).handler(async()=>{const {request,principal,calendar}=await admitted();await calendar.disconnect(principal,request.signal)})
