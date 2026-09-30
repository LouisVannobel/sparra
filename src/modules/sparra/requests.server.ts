import { randomUUID } from 'node:crypto'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { Schema, SchemaGetter } from 'effect'
import type { AuthTransactions } from '../../platform/db/transactions.server'
import type { AdmittedPrincipal } from '../auth/session.server'
import { configuration, type ActivityConfigurationDto } from './activity.server'
import { decodeMessageContent, readKeyring, type MessageContent, type MessageResultV1 } from './message-crypto.server'
import { sparraCall, sparraErasure, sparraKnowledgeRevision } from './schema.server'

const idSchema=Schema.String.check(Schema.isUUID()).pipe(Schema.decode({decode:SchemaGetter.transform(value=>value.toLowerCase()),encode:SchemaGetter.transform(value=>value)}))
const canonicalInstant=Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),Schema.makeFilter(value=>Number.isFinite(Date.parse(value)) && new Date(value).toISOString()===value))
const listInput=Schema.Struct({cursor:Schema.optional(Schema.Struct({admittedAt:canonicalInstant,id:idSchema}))})
const requestInput=Schema.Struct({requestId:idSchema})
export class InvalidRequestInput extends Error {constructor(){super('Invalid request input');this.name='InvalidRequestInput'}}
export class RequestNotFound extends Error {constructor(){super('Request unavailable');this.name='RequestNotFound'}}
export function parseListRequestsInput(input:unknown){try{return Schema.decodeUnknownSync(listInput,{onExcessProperty:'error'})(input===undefined?{}:input)}catch{throw new InvalidRequestInput()}}
export function parseRequestInput(input:unknown){try{return Schema.decodeUnknownSync(requestInput,{onExcessProperty:'error'})(input)}catch{throw new InvalidRequestInput()}}
export type ListRequestsInput=typeof listInput.Type
export type EraseReceipt=Readonly<{requestId:string;state:'queued'|'completed'}>
export type RequestSummaryDto=Readonly<{id:string;admittedAt:string;endedAt:string|null;status:typeof sparraCall.$inferSelect.status;configurationRevision:number|null;treatedAt:string|null;resultAvailability:'available'|'unavailable';resultQuality:'partial'|'complete'|null;category:MessageResultV1['category']|null;summary:string|null;contact:MessageResultV1['contact']|null;nextAction:string|null}>
export type RequestDetailDto=RequestSummaryDto & Readonly<{configuration:ActivityConfigurationDto|null;transcript:MessageContent['transcript'];transcriptAvailability:MessageContent['transcriptAvailability'];unavailableTurnCount:number;moreTurns:boolean;erasureState:'queued'|'completed'|null}>
export type ListRequestsPage=Readonly<{requests:RequestSummaryDto[];nextCursor:{admittedAt:string;id:string}|null}>
function summary(row:typeof sparraCall.$inferSelect,content:MessageContent):RequestSummaryDto {
  const result=content.result
  return {id:row.id,admittedAt:row.admittedAt.toISOString(),endedAt:row.endedAt?.toISOString()??null,status:row.status,configurationRevision:row.configurationRevision,treatedAt:row.treatedAt?.toISOString()??null,resultAvailability:result?'available':'unavailable',resultQuality:result?.quality??null,category:result?.category??null,summary:result?.summary??null,contact:result?.contact??null,nextAction:result?.next_action??null}
}
const hasContent=(row:typeof sparraCall.$inferSelect)=>row.encryptedMessageResult!==null || Object.keys(row.encryptedTurns).length>0
export function createRequestOperations(owner:AuthTransactions){
  const options=(signal?:AbortSignal)=>({deadlineAtMs:Date.now()+10000,statementTimeoutMs:1000,cleanupTimeoutMs:1000,correlationId:randomUUID(),signal})
  const owned=(workspaceId:string,id:string)=>and(eq(sparraCall.workspaceId,workspaceId),eq(sparraCall.id,id))
  const eligible=()=>and(sql`${sparraCall.retentionUntil} > clock_timestamp()`,isNull(sparraCall.erasureRequestedAt))
  async function list(principal:AdmittedPrincipal,input:unknown,signal?:AbortSignal):Promise<ListRequestsPage>{
    const {cursor}=parseListRequestsInput(input)
    return owner.withPersonalWorkspacePromise(options(signal),principal,false,async lease=>{
      if(!lease)return {requests:[],nextCursor:null}
      const rows=await lease.db.select().from(sparraCall).where(and(eq(sparraCall.workspaceId,lease.workspaceId),eligible(),cursor?sql`(${sparraCall.admittedAt},${sparraCall.id}) < (${cursor.admittedAt}::timestamptz,${cursor.id}::uuid)`:undefined)).orderBy(desc(sparraCall.admittedAt),desc(sparraCall.id)).limit(51)
      const page=rows.slice(0,50),keys=page.some(hasContent)?await readKeyring():null,last=page.at(-1)
      return {requests:page.map(row=>summary(row,decodeMessageContent(row.id,row.encryptedTurns,row.encryptedMessageResult,keys))),nextCursor:rows.length>50&&last?{admittedAt:last.admittedAt.toISOString(),id:last.id}:null}
    })
  }
  async function detail(principal:AdmittedPrincipal,requestId:string,signal?:AbortSignal):Promise<RequestDetailDto>{
    const {requestId:id}=parseRequestInput({requestId})
    return owner.withPersonalWorkspacePromise(options(signal),principal,false,async lease=>{
      if(!lease)throw new RequestNotFound()
      const [row]=await lease.db.select().from(sparraCall).where(and(owned(lease.workspaceId,id),eligible()))
      if(!row)throw new RequestNotFound()
      const content=decodeMessageContent(row.id,row.encryptedTurns,row.encryptedMessageResult,hasContent(row)?await readKeyring():null)
      const [pin]=row.configurationRevision===null?[]:await lease.db.select().from(sparraKnowledgeRevision).where(and(eq(sparraKnowledgeRevision.workspaceId,lease.workspaceId),eq(sparraKnowledgeRevision.revision,row.configurationRevision)))
      return {...summary(row,content),configuration:pin?configuration(pin):null,transcript:content.transcript,transcriptAvailability:content.transcriptAvailability,unavailableTurnCount:content.unavailableTurnCount,moreTurns:content.moreTurns,erasureState:null}
    })
  }
  async function treat(principal:AdmittedPrincipal,requestId:string,signal?:AbortSignal){
    const {requestId:id}=parseRequestInput({requestId})
    return owner.withPersonalWorkspacePromise(options(signal),principal,false,async lease=>{
      if(!lease)throw new RequestNotFound()
      await lease.db.update(sparraCall).set({treatedAt:sql`clock_timestamp()`}).where(and(owned(lease.workspaceId,id),eligible(),isNull(sparraCall.treatedAt)))
      const [row]=await lease.db.select({treatedAt:sparraCall.treatedAt}).from(sparraCall).where(and(owned(lease.workspaceId,id),eligible()))
      if(!row?.treatedAt)throw new RequestNotFound()
      return {requestId:id,treatedAt:row.treatedAt.toISOString()}
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
  return {list,detail,treat,erase,erasure}
}
