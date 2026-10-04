import { sql } from 'drizzle-orm'
import { bigint, boolean, check, customType, integer, pgPolicy, pgSchema, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { workspace } from '../workspaces/schema.server'

// Consumed by Drizzle migration generation. Procedural source is the forward
// native migration, matching the existing authentication/Workspace convention.
const privateSchema=pgSchema('voice_private')
const name=customType<{data:string}>({dataType:()=> 'name'})
const oid=customType<{data:number}>({dataType:()=> 'oid'})
const date=(column:string)=>timestamp(column,{withTimezone:true,precision:3})
const scope=sql`workspace_id = voice_private.bound_workspace() and deployment_id = voice_private.bound_deployment()`
export const voiceDeploymentBinding=privateSchema.table('deployment_binding',{
  serviceLogin:name('service_login').primaryKey(),serviceRoleOid:oid('service_role_oid').notNull().unique(),
  deploymentId:text('deployment_id').notNull().unique(),workspaceId:uuid('workspace_id').notNull().references(()=>workspace.id,{onDelete:'restrict'}),
  connectionId:text('connection_id').notNull(),toE164:text('to_e164').notNull(),admissionEnabled:boolean('admission_enabled').notNull().default(false),audioEnabled:boolean('audio_enabled').notNull().default(false),
},t=>[
  check('voice_binding_deployment',sql`length(${t.deploymentId}) between 1 and 256 and ${t.deploymentId} !~ '[[:cntrl:]]'`),
  check('voice_binding_connection',sql`octet_length(${t.connectionId}) between 1 and 256 and ${t.connectionId} !~ '[[:cntrl:]]'`),
  check('voice_binding_did',sql`${t.toE164} ~ '^\\+[1-9][0-9]{1,14}$'`),
  pgPolicy('voice_binding_read',{to:'sparra_voice_definer',for:'select',using:sql`${t.serviceLogin} = session_user and ${t.serviceRoleOid} = (select oid from pg_catalog.pg_roles where rolname = session_user)`}),
]).enableRLS()
export const voiceOperationReceipt=privateSchema.table('operation_receipt',{
  deploymentId:text('deployment_id').notNull(),operationId:uuid('operation_id').notNull(),workspaceId:uuid('workspace_id').notNull(),callId:uuid('call_id').notNull(),payloadSha256:text('payload_sha256').notNull(),occurredAt:date('occurred_at').notNull(),originalRetentionUntil:date('original_retention_until').notNull(),
},t=>[primaryKey({columns:[t.deploymentId,t.operationId]}),check('voice_receipt_digest',sql`${t.payloadSha256} ~ '^[0-9a-f]{64}$'`),pgPolicy('voice_receipt_scope',{to:'sparra_voice_definer',for:'all',using:scope,withCheck:scope})]).enableRLS()
export const voiceRecordingPurge=privateSchema.table('recording_purge',{
  recordingId:uuid('recording_id').primaryKey(),workspaceId:uuid('workspace_id').notNull(),deploymentId:text('deployment_id').notNull(),callId:uuid('call_id').notNull(),providerRecordingId:text('provider_recording_id').notNull(),originalRetentionUntil:date('original_retention_until').notNull(),
  purgeAttempt:integer('purge_attempt').notNull().default(0),leaseToken:uuid('lease_token'),leaseUntil:date('lease_until'),retryAt:date('retry_at').notNull().default(sql`clock_timestamp()`),
  outcome:text('outcome'),ackToken:uuid('ack_token'),ackOccurredAt:timestamp('ack_occurred_at',{withTimezone:true,precision:6}),
  archiveCiphertextSha256:text('archive_ciphertext_sha256'),archiveEncryptedBytes:integer('archive_encrypted_bytes'),archiveKeyVersion:bigint('archive_key_version',{mode:'number'}),
},t=>[
  unique('voice_recording_provider').on(t.deploymentId,t.providerRecordingId),check('voice_recording_id',sql`length(${t.providerRecordingId}) between 1 and 256 and ${t.providerRecordingId} ~ '^[A-Za-z0-9._~-]+$' and ${t.providerRecordingId} not in ('.','..')`),
  check('voice_recording_attempt',sql`${t.purgeAttempt} between 0 and 1000000`),check('voice_recording_outcome',sql`${t.outcome} is null or ${t.outcome} in ('deleted','not_found','retry','failed')`),
  check('voice_recording_archive_receipt',sql`(${t.archiveCiphertextSha256} is null and ${t.archiveEncryptedBytes} is null and ${t.archiveKeyVersion} is null) or (${t.archiveCiphertextSha256} is not null and ${t.archiveCiphertextSha256} ~ '^[0-9a-f]{64}$' and ${t.archiveEncryptedBytes} is not null and ${t.archiveEncryptedBytes} between 17 and 33554448 and ${t.archiveKeyVersion} is not null and ${t.archiveKeyVersion} between 1 and 9007199254740991)`),
  pgPolicy('voice_recording_scope',{to:'sparra_voice_definer',for:'all',using:scope,withCheck:scope}),
]).enableRLS()
