import { createHash, randomUUID } from 'node:crypto'
import { and, eq, gt, sql } from 'drizzle-orm'
import { Schema } from 'effect'
import type { AuthTransactions } from '../../platform/db/transactions.server'
import type { PersonalWorkspaceLease } from '../../platform/db/auth-pg-lease.server'
import type { AdmittedPrincipal } from '../auth/session.server'
import { parseSaveActivityInput, saveActivityInLease, type SaveActivityInput } from './activity.server'
import { sparraKnowledgeCapture, sparraKnowledgeConfirmation } from './schema.server'
import { captureWebsite, type WebsiteCapture } from './website-capture.server'

export type KnowledgeDecision = Readonly<{action:'use';passageId:string;target:'openingHours'|'services'|'prices'|'faq'} | {action:'ignore';passageId:string}>
export type KnowledgeProvenance = Readonly<{confirmed:true;source:WebsiteCapture | null;decisions:readonly KnowledgeDecision[]}>
export type KnowledgeImportInput = Readonly<{url:string}>
export type KnowledgeImportDto = Readonly<{captureId:string;source:WebsiteCapture}>
export type ActivityConfirmationKey = Readonly<{draftId:string;draftVersion:number}>
export type ConfirmActivityInput = ActivityConfirmationKey & Readonly<{activity:SaveActivityInput & Required<Pick<SaveActivityInput,'transferDestination'|'recordingEnabled'|'recordingPolicy'|'recordingContactPhone'>>;captureId?:string;decisions:readonly KnowledgeDecision[];confirmed:true}>
export type ActivityConfirmationDto = Readonly<{status:'confirmed';revision:number;savedAt:string}>
export type ActivityConfirmationLookup = ActivityConfirmationDto | Readonly<{status:'unverifiable'}>
class KnowledgeError extends Error {
  constructor(name:string) {super(name);this.name=name}
}
const invalid = () => new KnowledgeError('InvalidKnowledgeInput')
const uuid=Schema.String.check(Schema.isUUID())
const identity={draftId:uuid,draftVersion:Schema.Int.check(Schema.isGreaterThanOrEqualTo(1),Schema.isLessThanOrEqualTo(2147483647))}
const passageId=Schema.String.check(Schema.isPattern(/^p[1-9][0-9]{0,4}$/))
const decisions=Schema.Array(Schema.Union([
  Schema.Struct({action:Schema.Literal('use'),passageId,target:Schema.Literals(['openingHours','services','prices','faq'])}),
  Schema.Struct({action:Schema.Literal('ignore'),passageId}),
])).check(Schema.isMaxLength(200))
const confirmation=Schema.Struct({...identity,activity:Schema.Unknown,captureId:Schema.optionalKey(uuid),decisions,confirmed:Schema.Literal(true)})
const completeSettings=Schema.Struct({transferDestination:Schema.NullOr(Schema.String),recordingEnabled:Schema.Boolean,recordingPolicy:Schema.Literals(['off','local_30d']),recordingContactPhone:Schema.NullOr(Schema.String)})
export function parseKnowledgeImportInput(input:unknown):KnowledgeImportInput {
  try {return Schema.decodeUnknownSync(Schema.Struct({url:Schema.String.check(Schema.isMinLength(1),Schema.isMaxLength(2048))}),{onExcessProperty:'error'})(input)} catch {throw invalid()}
}
export function parseActivityConfirmationKey(input:unknown):ActivityConfirmationKey {
  try {return Schema.decodeUnknownSync(Schema.Struct(identity),{onExcessProperty:'error'})(input)} catch {throw invalid()}
}
export function parseConfirmActivityInput(input:unknown) {
  try {
    const value=Schema.decodeUnknownSync(confirmation,{onExcessProperty:'error'})(input)
    Schema.decodeUnknownSync(completeSettings)(value.activity)
    const activity=parseSaveActivityInput(value.activity)
    if(value.decisions.length && !value.captureId) throw invalid()
    if(new Set(value.decisions.map(decision=>decision.passageId)).size!==value.decisions.length) throw invalid()
    // Canonical property order, normalized text and explicit settings define the
    // exact submitted intent. Nothing here depends on a surviving capture row.
    return {draftId:value.draftId.toLowerCase(),draftVersion:value.draftVersion,activity:{expectedRevision:activity.expectedRevision,businessName:activity.businessName,sector:activity.sector,knowledge:{openingHours:activity.knowledge.openingHours,services:activity.knowledge.services,prices:activity.knowledge.prices,faq:activity.knowledge.faq,instructions:activity.knowledge.instructions},transferDestination:activity.transferDestination,recordingEnabled:activity.recordingEnabled,recordingPolicy:activity.recordingPolicy!,recordingContactPhone:activity.recordingContactPhone!},...(value.captureId?{captureId:value.captureId.toLowerCase()}:{}),decisions:value.decisions.map(decision=>decision.action==='use'?{action:decision.action,passageId:decision.passageId,target:decision.target}:{action:decision.action,passageId:decision.passageId}),confirmed:true as const}
  } catch {throw invalid()}
}
const options=(signal?:AbortSignal,deadlineAtMs=Date.now()+10000)=>({deadlineAtMs,statementTimeoutMs:1000,cleanupTimeoutMs:1000,correlationId:randomUUID(),signal})
async function cleanup(lease:PersonalWorkspaceLease) {
  await lease.db.select({done:sql`public.sparra_knowledge_cleanup_v1()`}).from(sql`(select 1) AS knowledge_cleanup`)
}
const receipt=(row:typeof sparraKnowledgeConfirmation.$inferSelect):ActivityConfirmationDto=>({status:'confirmed',revision:row.revision,savedAt:row.savedAt.toISOString()})
export function createKnowledgeConfirmationOperations(owner:AuthTransactions) {
  async function importPage(principal:AdmittedPrincipal,input:unknown,requestOrigin:string,signal?:AbortSignal):Promise<KnowledgeImportDto> {
    const {url}=parseKnowledgeImportInput(input),captureId=randomUUID(),deadlineAtMs=Date.now()+30000
    const combined=AbortSignal.any([AbortSignal.timeout(30000),...(signal?[signal]:[])])
    const workspaceId=await owner.withPersonalWorkspacePromise(options(combined,deadlineAtMs),principal,false,async lease=>{
      if(!lease) throw new KnowledgeError('KnowledgeWorkspaceUnavailable')
      await cleanup(lease)
      const [current]=await lease.db.select().from(sparraKnowledgeCapture).where(eq(sparraKnowledgeCapture.workspaceId,lease.workspaceId))
      if(current && !current.source) throw new KnowledgeError('KnowledgeImportBusy')
      await lease.db.insert(sparraKnowledgeCapture).values({workspaceId:lease.workspaceId,captureId,source:null,expiresAt:new Date(deadlineAtMs)})
        .onConflictDoUpdate({target:sparraKnowledgeCapture.workspaceId,set:{captureId,source:null,expiresAt:new Date(deadlineAtMs)}})
      return lease.workspaceId
    })
    // Network work happens after COMMIT, outside every Workspace transaction.
    const source=await captureWebsite(url,{signal:combined,blockedHosts:[new URL(requestOrigin).hostname]})
    combined.throwIfAborted()
    await owner.withPersonalWorkspacePromise(options(combined,deadlineAtMs),principal,false,async lease=>{
      if(!lease || lease.workspaceId!==workspaceId) throw new KnowledgeError('KnowledgeWorkspaceUnavailable')
      combined.throwIfAborted()
      const [stored]=await lease.db.update(sparraKnowledgeCapture).set({source,expiresAt:sql`clock_timestamp()+interval '3600 seconds'`})
        .where(and(eq(sparraKnowledgeCapture.workspaceId,workspaceId),eq(sparraKnowledgeCapture.captureId,captureId),gt(sparraKnowledgeCapture.expiresAt,sql`clock_timestamp()`),sql`${sparraKnowledgeCapture.source} is null`)).returning({id:sparraKnowledgeCapture.captureId})
      if(!stored) throw new KnowledgeError('KnowledgeCaptureUnavailable')
    })
    return {captureId,source}
  }
  async function confirm(principal:AdmittedPrincipal,input:unknown,signal?:AbortSignal):Promise<ActivityConfirmationDto> {
    const value=parseConfirmActivityInput(input),inputHash=createHash('sha256').update(JSON.stringify(value)).digest('hex')
    return owner.withPersonalWorkspacePromise(options(signal),principal,false,async lease=>{
      if(!lease) throw new KnowledgeError('KnowledgeWorkspaceUnavailable')
      const [existing]=await lease.db.select({receipt:sparraKnowledgeConfirmation,valid:sql<boolean>`${sparraKnowledgeConfirmation.expiresAt}>clock_timestamp()`}).from(sparraKnowledgeConfirmation).where(and(eq(sparraKnowledgeConfirmation.workspaceId,lease.workspaceId),eq(sparraKnowledgeConfirmation.draftId,value.draftId),eq(sparraKnowledgeConfirmation.draftVersion,value.draftVersion)))
      if(existing) {
        if(!existing.valid) throw new KnowledgeError('KnowledgeConfirmationUnverifiable')
        if(existing.receipt.inputHash!==inputHash) throw new KnowledgeError('KnowledgeConfirmationConflict')
        return receipt(existing.receipt)
      }
      await cleanup(lease)
      let source:WebsiteCapture|null=null
      if(value.captureId) {
        const [capture]=await lease.db.select().from(sparraKnowledgeCapture).where(and(eq(sparraKnowledgeCapture.workspaceId,lease.workspaceId),eq(sparraKnowledgeCapture.captureId,value.captureId),gt(sparraKnowledgeCapture.expiresAt,sql`clock_timestamp()`)))
        if(!capture?.source) throw new KnowledgeError('KnowledgeCaptureUnavailable')
        source=capture.source
        if(value.decisions.some(decision=>!source?.passages.some(passage=>passage.id===decision.passageId))) throw invalid()
      }
      const saved=await saveActivityInLease(lease,value.activity)
      // Preserve cited originals; the edited activity remains the owner's text.
      const provenance:KnowledgeProvenance={confirmed:true,source:source?{...source,passages:source.passages.filter(passage=>value.decisions.some(decision=>decision.passageId===passage.id))}:null,decisions:value.decisions}
      const [stored]=await lease.db.insert(sparraKnowledgeConfirmation).values({workspaceId:lease.workspaceId,draftId:value.draftId,draftVersion:value.draftVersion,revision:saved.revision,inputHash,provenance,savedAt:new Date(saved.savedAt),expiresAt:new Date(new Date(saved.savedAt).getTime()+7*86400000)}).returning()
      if(!stored) throw new KnowledgeError('KnowledgeConfirmationUnavailable')
      return receipt(stored)
    })
  }
  async function lookup(principal:AdmittedPrincipal,input:ActivityConfirmationKey,signal?:AbortSignal):Promise<ActivityConfirmationLookup> {
    const key=parseActivityConfirmationKey({draftId:input.draftId,draftVersion:input.draftVersion})
    return owner.withPersonalWorkspacePromise(options(signal),principal,false,async lease=>{
      if(!lease) return {status:'unverifiable'}
      await cleanup(lease)
      const [existing]=await lease.db.select().from(sparraKnowledgeConfirmation).where(and(eq(sparraKnowledgeConfirmation.workspaceId,lease.workspaceId),eq(sparraKnowledgeConfirmation.draftId,key.draftId),eq(sparraKnowledgeConfirmation.draftVersion,key.draftVersion),gt(sparraKnowledgeConfirmation.expiresAt,sql`clock_timestamp()`)))
      return existing?receipt(existing):{status:'unverifiable'}
    })
  }
  return {importPage,confirm,lookup}
}
