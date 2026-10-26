import { randomUUID } from 'node:crypto'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { Schema, SchemaGetter } from 'effect'
import type { AuthTransactions } from '../../platform/db/transactions.server'
import type { AdmittedPrincipal } from '../auth/session.server'
import { configuration, type ActivityConfigurationDto } from './activity.server'
import { decodeMessageContent, readKeyring, type MessageContent, type MessageResultV1 } from './message-crypto.server'
import { sparraCall, sparraErasure, sparraKnowledgeRevision, type InboxPublicationSnapshot } from './schema.server'
import type { AudioDto } from './audio.server'
import { calendarBookingOutcome, type CalendarBookingDto, type CalendarBookingOutcome } from '../calendar/booking'
import type { RequestFollowUp, RequestFollowUpReceipt } from './follow-up'

const idSchema=Schema.String.check(Schema.isUUID()).pipe(Schema.decode({decode:SchemaGetter.transform(value=>value.toLowerCase()),encode:SchemaGetter.transform(value=>value)}))
const canonicalInstant=Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),Schema.makeFilter(value=>Number.isFinite(Date.parse(value)) && new Date(value).toISOString()===value))
const listInput=Schema.Struct({view:Schema.optional(Schema.Literals(['pending','all'])),cursor:Schema.optional(Schema.Struct({admittedAt:canonicalInstant,id:idSchema}))})
const requestInput=Schema.Struct({requestId:idSchema})
const followUpInput=Schema.Struct({requestId:idSchema,expectedPublicationRevision:Schema.Int.check(Schema.isGreaterThanOrEqualTo(0),Schema.isLessThanOrEqualTo(2147483647)),expectedDecisionToken:idSchema,treated:Schema.Boolean})
class InvalidRequestInput extends Error {constructor(){super('Invalid request input');this.name='InvalidRequestInput'}}
class RequestNotFound extends Error {constructor(){super('Request unavailable');this.name='RequestNotFound'}}
class RequestPublicationConflict extends Error {constructor(){super('La fiche a changé. Actualisez avant de déclarer son traitement.');this.name='RequestPublicationConflict'}}
class RequestPublicationProvisional extends Error {constructor(){super('La collecte est provisoire. Le classement sera disponible après sa clôture.');this.name='RequestPublicationProvisional'}}
export function parseListRequestsInput(input:unknown){try{return Schema.decodeUnknownSync(listInput,{onExcessProperty:'error'})(input===undefined?{}:input)}catch{throw new InvalidRequestInput()}}
export function parseRequestInput(input:unknown){try{return Schema.decodeUnknownSync(requestInput,{onExcessProperty:'error'})(input)}catch{throw new InvalidRequestInput()}}
export function parseUpdateRequestFollowUpInput(input:unknown){try{return Schema.decodeUnknownSync(followUpInput,{onExcessProperty:'error'})(input)}catch{throw new InvalidRequestInput()}}
export type ListRequestsInput=typeof listInput.Type
export type EraseReceipt=Readonly<{requestId:string;state:'queued'|'completed'}>
export type RequestSummaryDto=Readonly<{id:string;admittedAt:string;endedAt:string|null;status:typeof sparraCall.$inferSelect.status;configurationRevision:number|null;treatedAt:string|null;followUp:RequestFollowUp;resultAvailability:'available'|'unavailable';resultQuality:'partial'|'complete'|null;category:MessageResultV1['category']|null;summary:string|null;conversationExcerpt:string|null;contact:MessageResultV1['contact']|null;nextAction:string|null;bookingOutcome?:CalendarBookingOutcome}>
export type RequestDetailDto=RequestSummaryDto & Readonly<{configuration:ActivityConfigurationDto|null;transcript:MessageContent['transcript'];transcriptAvailability:MessageContent['transcriptAvailability'];unavailableTurnCount:number;moreTurns:boolean;transcriptLossCount:number;erasureState:'queued'|'completed'|null;audio?:AudioDto;bookings?:readonly CalendarBookingDto[];evidence:readonly Readonly<{turnId:string;role:'user'|'assistant'}>[];callerPhone:string|null;collectionGaps:NonNullable<InboxPublicationSnapshot['collection']>['gaps'];audioCoverage:'unknown'}>
export type ListRequestsPage=Readonly<{requests:RequestSummaryDto[];nextCursor:{admittedAt:string;id:string}|null}>
function conversationExcerpt(content:MessageContent):string|null {
  const text=content.transcript.find(turn=>turn.role==='user'&&turn.text.trim())?.text.replace(/\s+/gu,' ').trim()
  if(!text)return null
  const characters=[...text]
  return characters.length<=240?text:characters.slice(0,239).join('')+'…'
}
function followUp(row:typeof sparraCall.$inferSelect):RequestFollowUp {
  return {publicationRevision:row.publicationVersion,decisionToken:row.publicationToken,reviewedRevision:row.declaredPublication,declarationActive:row.declarationActive,collectionClosed:row.publicationSnapshot?.collection_closed===true&&row.collectionClosed,firstDeclaredAt:row.treatedAt?.toISOString()??null}
}
const instant=(value:string)=>new Date(value).toISOString()
function outcome(snapshot:InboxPublicationSnapshot|null):CalendarBookingOutcome|null {
  const bookings=snapshot?.bookings??[]
  return calendarBookingOutcome({total:bookings.length,confirmed:bookings.filter(b=>b.state==='confirmed'&&b.event_id&&(b.observed_state===null||b.observed_state==='confirmed')).length,cancelled:bookings.filter(b=>b.state==='confirmed'&&b.event_id&&b.observed_state==='cancelled').length})
}
function summary(row:typeof sparraCall.$inferSelect,content:MessageContent):RequestSummaryDto {
  const result=content.result
  const snapshot=row.publicationSnapshot,bookingOutcome=outcome(snapshot)
  return {id:row.id,admittedAt:snapshot?instant(snapshot.admitted_at):row.admittedAt.toISOString(),endedAt:snapshot?.ended_at?instant(snapshot.ended_at):null,status:snapshot?.status??'pending',configurationRevision:snapshot?.configuration_revision??null,treatedAt:row.treatedAt?.toISOString()??null,followUp:followUp(row),resultAvailability:result?'available':'unavailable',resultQuality:result?.quality??null,category:result?.category??null,summary:result?.summary??null,conversationExcerpt:result?null:conversationExcerpt(content),contact:result?.contact??null,nextAction:result?.next_action??null,...(bookingOutcome?{bookingOutcome}:{})}
}
const hasContent=(row:typeof sparraCall.$inferSelect)=>row.publicationSnapshot!==null&&(row.publicationSnapshot.encrypted_message_result!==null || Object.keys(row.publicationSnapshot.encrypted_turns).length>0)
const decode=(row:typeof sparraCall.$inferSelect,keys:Awaited<ReturnType<typeof readKeyring>>)=>decodeMessageContent(row.id,row.publicationSnapshot?.encrypted_turns??{},row.publicationSnapshot?.encrypted_message_result??null,keys,row.publicationSnapshot?.transcript_loss_count??0)
export function createRequestOperations(owner:AuthTransactions){
  const options=(signal?:AbortSignal)=>({deadlineAtMs:Date.now()+10000,statementTimeoutMs:1000,cleanupTimeoutMs:1000,correlationId:randomUUID(),signal})
  const owned=(workspaceId:string,id:string)=>and(eq(sparraCall.workspaceId,workspaceId),eq(sparraCall.id,id))
  const eligible=()=>and(sql`${sparraCall.retentionUntil} > clock_timestamp()`,isNull(sparraCall.erasureRequestedAt))
  async function list(principal:AdmittedPrincipal,input:unknown,signal?:AbortSignal):Promise<ListRequestsPage>{
    const {cursor,view='pending'}=parseListRequestsInput(input)
    return owner.withPersonalWorkspacePromise(options(signal),principal,false,async lease=>{
      if(!lease)return {requests:[],nextCursor:null}
      const rows=await lease.db.select().from(sparraCall).where(and(eq(sparraCall.workspaceId,lease.workspaceId),eligible(),view==='pending'?sql`(not ${sparraCall.declarationActive} or ${sparraCall.declaredPublication} < ${sparraCall.publicationVersion})`:undefined,cursor?sql`(${sparraCall.admittedAt},${sparraCall.id}) < (${cursor.admittedAt}::timestamptz,${cursor.id}::uuid)`:undefined)).orderBy(desc(sparraCall.admittedAt),desc(sparraCall.id)).limit(51)
      const page=rows.slice(0,50),keys=page.some(hasContent)?await readKeyring():null,last=page.at(-1)
      return {requests:page.map(row=>summary(row,decode(row,keys))),nextCursor:rows.length>50&&last?{admittedAt:last.admittedAt.toISOString(),id:last.id}:null}
    })
  }
  async function detail(principal:AdmittedPrincipal,requestId:string,signal?:AbortSignal):Promise<RequestDetailDto>{
    const {requestId:id}=parseRequestInput({requestId})
    return owner.withPersonalWorkspacePromise(options(signal),principal,false,async lease=>{
      if(!lease)throw new RequestNotFound()
      const [row]=await lease.db.select().from(sparraCall).where(and(owned(lease.workspaceId,id),eligible()))
      if(!row)throw new RequestNotFound()
      const snapshot=row.publicationSnapshot
      const content=decode(row,hasContent(row)?await readKeyring():null)
      // Configuration revisions are immutable. Select only the pin contained in this publication.
      const [pin]=snapshot?.configuration_revision==null?[]:await lease.db.select().from(sparraKnowledgeRevision).where(and(eq(sparraKnowledgeRevision.workspaceId,lease.workspaceId),eq(sparraKnowledgeRevision.revision,snapshot.configuration_revision)))
      const bookings:CalendarBookingDto[]=(snapshot?.bookings??[]).slice(0,20).map(booking=>({
        state:booking.state==='offered'?'unknown':booking.state,serviceName:booking.service_name,start:instant(booking.current_start??booking.window_start),end:booking.current_end?new Date(Date.parse(booking.current_end)-Schema.decodeUnknownSync(Schema.Int)(booking.buffer_minutes)*60000).toISOString():instant(booking.window_end),originalStart:instant(booking.window_start),timezone:Schema.decodeUnknownSync(Schema.String)(booking.timezone),providerReference:booking.state==='confirmed'?booking.event_id:null,observedState:booking.observed_state,
      }))
      const audio:AudioDto|undefined=snapshot?{state:snapshot.audio.state,durationSeconds:snapshot.audio.total_samples===null?null:snapshot.audio.total_samples/8000,expiresAt:row.retentionUntil.toISOString(),partialReason:snapshot.audio.finish_reason,available:['ready','partial'].includes(snapshot.audio.state)&&(snapshot.audio.total_samples??0)>0}:undefined
      return {...summary(row,content),bookings,configuration:pin?configuration(pin):null,transcript:content.transcript,transcriptAvailability:content.transcriptAvailability,unavailableTurnCount:content.unavailableTurnCount,moreTurns:content.moreTurns,transcriptLossCount:content.transcriptLossCount,erasureState:null,audio,evidence:content.result?.evidence.map(item=>({turnId:item.turn_id,role:item.role}))??[],callerPhone:snapshot?.from_e164??null,collectionGaps:snapshot?.collection?.gaps??[],audioCoverage:'unknown'}
    })
  }
  async function updateFollowUp(principal:AdmittedPrincipal,input:unknown,signal?:AbortSignal):Promise<RequestFollowUpReceipt>{
    const data=parseUpdateRequestFollowUpInput(input)
    return owner.withPersonalWorkspacePromise(options(signal),principal,false,async lease=>{
      if(!lease)throw new RequestNotFound()
      const [response]=await lease.db.select({outcome:sql<string>`app_private.update_sparra_follow_up_v1(${lease.workspaceId}::uuid,${data.requestId}::uuid,${data.expectedPublicationRevision}::integer,${data.expectedDecisionToken}::uuid,${data.treated}::boolean)`}).from(sparraCall).where(owned(lease.workspaceId,data.requestId)).limit(1)
      const state=response?.outcome
      if(state==='conflict')throw new RequestPublicationConflict()
      if(state==='provisional')throw new RequestPublicationProvisional()
      if(state!=='applied')throw new RequestNotFound()
      // The SQL command retains the call lock until the native transaction commits.
      const [row]=await lease.db.select().from(sparraCall).where(and(owned(lease.workspaceId,data.requestId),eligible()))
      if(!row)throw new RequestNotFound()
      return {requestId:row.id,followUp:followUp(row)}
    })
  }
  async function erase(principal:AdmittedPrincipal,requestId:string,signal?:AbortSignal):Promise<EraseReceipt>{
    const {requestId:id}=parseRequestInput({requestId})
    return owner.withPersonalWorkspacePromise(options(signal),principal,false,async lease=>{
      if(!lease)throw new RequestNotFound()
      await lease.db.update(sparraCall).set({erasureRequestedAt:sql`clock_timestamp()`}).where(and(owned(lease.workspaceId,id),isNull(sparraCall.erasureRequestedAt))).returning({id:sparraCall.id})
      const [receipt]=await lease.db.select({state:sparraErasure.state}).from(sparraErasure).where(and(eq(sparraErasure.workspaceId,lease.workspaceId),eq(sparraErasure.callId,id)))
      if(!receipt)throw new RequestNotFound()
      return {requestId:id,state:receipt.state}
    })
  }
  async function erasure(principal:AdmittedPrincipal,requestId:string,signal?:AbortSignal):Promise<EraseReceipt>{
    const {requestId:id}=parseRequestInput({requestId})
    return owner.withPersonalWorkspacePromise(options(signal),principal,false,async lease=>{
      if(!lease)throw new RequestNotFound()
      const [receipt]=await lease.db.select({state:sparraErasure.state}).from(sparraErasure).where(and(eq(sparraErasure.workspaceId,lease.workspaceId),eq(sparraErasure.callId,id)))
      if(!receipt)throw new RequestNotFound()
      return {requestId:id,state:receipt.state}
    })
  }
  return {list,detail,updateFollowUp,erase,erasure}
}
