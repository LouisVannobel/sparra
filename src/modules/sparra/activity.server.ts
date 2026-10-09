import { randomUUID } from 'node:crypto'
import { desc, eq, sql } from 'drizzle-orm'
import { Schema, SchemaGetter } from 'effect'
import type { AuthTransactions } from '../../platform/db/transactions.server'
import type { AdmittedPrincipal } from '../auth/session.server'
import type { WorkspaceDto } from '../workspaces/personal.server'
import { workspace } from '../workspaces/schema.server'
import { sparraKnowledgeRevision } from './schema.server'

const scalar = Schema.String.check(Schema.isPattern(/^[^\ud800-\udfff]*$/u))
const name = scalar.check(Schema.isPattern(/^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]*$/)).pipe(
  Schema.decode({ decode: SchemaGetter.transform(value => value.trim()), encode: SchemaGetter.transform(value => value) }),
).check(Schema.isMinLength(1), Schema.isMaxLength(80))
const section = (limit: number) => scalar.check(Schema.isPattern(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]*$/)).pipe(
  Schema.decode({ decode: SchemaGetter.transform(value => value.replace(/\r\n/g,'\n')), encode: SchemaGetter.transform(value => value) }),
).check(Schema.isMaxLength(limit))
const saveInput = Schema.Struct({
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(2147483646)),
  businessName: name, sector: Schema.Literals(['garage','controle-technique']),
  knowledge: Schema.Struct({ openingHours: section(1000), services: section(2000), prices: section(1500), faq: section(3000), instructions: section(2000) }),
  transferDestination: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isPattern(/^\+[1-9][0-9]{1,14}$/)))),
  recordingEnabled: Schema.optionalKey(Schema.Boolean),
  recordingPolicy: Schema.optionalKey(Schema.Literals(['off','local_30d'])),
  recordingContactPhone: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isPattern(/^\+[1-9][0-9]{1,14}(?![\s\S])/)))),
})
export class InvalidActivityInput extends Error {
  constructor() { super('Invalid activity input'); this.name = 'InvalidActivityInput' }
}
class ActivityRevisionConflict extends Error {
  constructor() { super('Activity revision conflict'); this.name = 'ActivityRevisionConflict' }
}
class ActivityRecordingUnavailable extends Error {
  constructor() { super('Local audio unavailable'); this.name = 'ActivityRecordingUnavailable' }
}
export type SaveActivityInput = Readonly<{
  expectedRevision: number; businessName: string; sector: 'garage' | 'controle-technique'
  knowledge: Readonly<{ openingHours: string; services: string; prices: string; faq: string; instructions: string }>
  transferDestination?: string | null
  recordingEnabled?: boolean
  recordingPolicy?: 'off' | 'local_30d'
  recordingContactPhone?: string | null
}>
export type ActivityConfigurationDto = Readonly<Omit<SaveActivityInput,'expectedRevision' | 'transferDestination' | 'recordingPolicy' | 'recordingContactPhone'> & { workspaceId: string; revision: number; savedAt: string; transferDestination: string | null; recordingPolicy: 'off' | 'local_30d'; recordingContactPhone: string | null }>
export type ActivityState = Readonly<{ workspace: WorkspaceDto | null; configuration: ActivityConfigurationDto | null; localAudioAvailable: boolean }>
export function parseSaveActivityInput(input: unknown) {
  try {
    const value = Schema.decodeUnknownSync(saveInput,{ onExcessProperty: 'error' })(input)
    if(value.recordingPolicy !== undefined && value.recordingEnabled === true) throw new InvalidActivityInput()
    return { ...value, transferDestination: value.transferDestination ?? null, recordingEnabled: value.recordingEnabled ?? false, ...(Object.hasOwn(value,'recordingContactPhone') ? {recordingContactPhone:value.recordingContactPhone ?? null} : {}) }
  } catch { throw new InvalidActivityInput() }
}
export function configuration(row: typeof sparraKnowledgeRevision.$inferSelect): ActivityConfigurationDto {
  return { workspaceId:row.workspaceId,revision:row.revision,savedAt:row.savedAt.toISOString(),businessName:row.businessName,sector:row.sector,knowledge:{openingHours:row.openingHours,services:row.services,prices:row.prices,faq:row.faq,instructions:row.instructions},transferDestination:row.transferDestination,recordingEnabled:row.recordingEnabled,recordingPolicy:row.recordingPolicy,recordingContactPhone:row.recordingContactPhone }
}
export function createActivityOperations(owner: AuthTransactions) {
  const options = (signal?: AbortSignal) => ({ deadlineAtMs: Date.now()+10000,statementTimeoutMs:1000,cleanupTimeoutMs:1000,correlationId:randomUUID(),signal })
  async function read(principal: AdmittedPrincipal,signal?: AbortSignal): Promise<ActivityState> {
    return owner.withPersonalWorkspacePromise(options(signal),principal,false,async lease=>{
      if(!lease) return {workspace:null,configuration:null,localAudioAvailable:false}
      const [current] = await lease.db.select({id:workspace.id,displayName:workspace.displayName}).from(workspace).where(eq(workspace.id,lease.workspaceId))
      if(!current) return {workspace:null,configuration:null,localAudioAvailable:false}
      const [row] = await lease.db.select().from(sparraKnowledgeRevision).where(eq(sparraKnowledgeRevision.workspaceId,lease.workspaceId)).orderBy(desc(sparraKnowledgeRevision.revision)).limit(1)
      const [capability]=await lease.db.select({available:sql<boolean>`public.sparra_local_audio_available_v1()`}).from(sql`(select 1) AS local_audio_call`)
      return {workspace:current,configuration:row ? configuration(row) : null,localAudioAvailable:capability?.available===true}
    })
  }
  async function save(principal: AdmittedPrincipal,input: unknown,signal?: AbortSignal): Promise<ActivityConfigurationDto | null> {
    const value=parseSaveActivityInput(input)
    return owner.withPersonalWorkspacePromise(options(signal),principal,false,async lease=>{
      if(!lease) return null
      // The native personal lease already holds the active Workspace FOR UPDATE.
      const [latest]=await lease.db.select({revision:sparraKnowledgeRevision.revision,recordingPolicy:sparraKnowledgeRevision.recordingPolicy,recordingContactPhone:sparraKnowledgeRevision.recordingContactPhone}).from(sparraKnowledgeRevision).where(eq(sparraKnowledgeRevision.workspaceId,lease.workspaceId)).orderBy(desc(sparraKnowledgeRevision.revision)).limit(1)
      if((latest?.revision ?? 0)!==value.expectedRevision) throw new ActivityRevisionConflict()
      if(value.recordingPolicy === undefined && latest?.recordingPolicy === 'local_30d') throw new ActivityRecordingUnavailable()
      if(value.recordingPolicy === 'local_30d') {
        const [capability]=await lease.db.select({available:sql<boolean>`public.sparra_local_audio_available_v1()`}).from(sql`(select 1) AS local_audio_call`)
        if(capability?.available !== true) throw new ActivityRecordingUnavailable()
      }
      const [saved]=await lease.db.insert(sparraKnowledgeRevision).values({workspaceId:lease.workspaceId,revision:value.expectedRevision+1,businessName:value.businessName,sector:value.sector,...value.knowledge,transferDestination:value.transferDestination,recordingEnabled:value.recordingPolicy === undefined ? value.recordingEnabled : false,recordingPolicy:value.recordingPolicy ?? 'off',recordingContactPhone:Object.hasOwn(value,'recordingContactPhone') ? value.recordingContactPhone ?? null : latest?.recordingContactPhone ?? null}).returning()
      if(!saved) throw new Error('Activity unavailable')
      return configuration(saved)
    })
  }
  return {read,save}
}
