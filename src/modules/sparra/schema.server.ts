import { sql, type SQLWrapper } from 'drizzle-orm'
import { check, foreignKey, index, integer, jsonb, pgPolicy, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { workspace } from '../workspaces/schema.server'
import type { NativeEncryptedTurn, EncryptedMessageResult } from './message-crypto.server'

// PostgreSQL stores Unicode scalars; add supplementary scalars once to match
// the public input's UTF16 string.length limit.
const utf16Length = (column: SQLWrapper) => sql`length(${column}) + length(regexp_replace(${column}, U&'[\\0001-\\FFFF]', '', 'g'))`
export const sparraKnowledgeRevision = pgTable('sparra_knowledge_revision', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspace.id, { onDelete: 'restrict' }),
  revision: integer('revision').notNull(),
  businessName: text('business_name').notNull(),
  sector: text('sector', { enum: ['garage', 'controle-technique'] }).notNull(),
  openingHours: text('opening_hours').notNull(), services: text('services').notNull(), prices: text('prices').notNull(), faq: text('faq').notNull(), instructions: text('instructions').notNull(),
  transferDestination: text('transfer_destination'),
  savedAt: timestamp('saved_at', { withTimezone: true, precision: 3 }).notNull().default(sql`clock_timestamp()`),
}, table => [
  primaryKey({ columns: [table.workspaceId, table.revision] }),
  check('sparra_revision_positive', sql`${table.revision} > 0`),
  check('sparra_revision_nonzero_workspace', sql`${table.workspaceId} <> '00000000-0000-0000-0000-000000000000'::uuid`),
  check('sparra_revision_business_name', sql`${utf16Length(table.businessName)} between 1 and 80 and ${table.businessName} = btrim(${table.businessName}) and ${table.businessName} !~ U&'[\\0001-\\001F\\007F-\\009F\\2028\\2029]'`),
  check('sparra_revision_sector', sql`${table.sector} in ('garage','controle-technique')`),
  ...([['opening_hours',table.openingHours,1000],['services',table.services,2000],['prices',table.prices,1500],['faq',table.faq,3000],['instructions',table.instructions,2000]] as const).map(([name,column,limit]) => check('sparra_revision_'+name, sql`${utf16Length(column)} <= ${sql.raw(String(limit))} and ${column} !~ U&'[\\0001-\\0008\\000B\\000C\\000E-\\001F\\007F-\\009F]'`)),
  check('sparra_revision_transfer', sql`${table.transferDestination} is null or ${table.transferDestination} ~ '^\\+[1-9][0-9]{1,14}$'`),
  check('sparra_revision_saved_at', sql`isfinite(${table.savedAt})`),
  pgPolicy('sparra_revision_voice_read',{to:'sparra_voice_definer',for:'select',using:sql`workspace_id = voice_private.bound_workspace()`}),
  pgPolicy('sparra_revision_voice_delete',{to:'sparra_voice_definer',for:'delete',using:sql`workspace_id = voice_private.bound_workspace()`}),
  pgPolicy('sparra_revision_read', { to: 'runtime', for: 'select', using: sql`${table.workspaceId}::text = current_setting('app.tenant_id',true) and current_setting('app.tenant_id',true) <> '00000000-0000-0000-0000-000000000000' and exists (select 1 from public.workspace where workspace.id = ${table.workspaceId} and workspace.lifecycle = 'active')` }),
  pgPolicy('sparra_revision_insert', { to: 'runtime', for: 'insert', withCheck: sql`${table.workspaceId}::text = current_setting('app.tenant_id',true) and current_setting('app.tenant_id',true) <> '00000000-0000-0000-0000-000000000000' and exists (select 1 from public.workspace where workspace.id = ${table.workspaceId} and workspace.lifecycle = 'active')` }),
]).enableRLS()

const scoped = (column:SQLWrapper) => sql`${column}::text = current_setting('app.tenant_id',true) and current_setting('app.tenant_id',true) <> '00000000-0000-0000-0000-000000000000'`
const active = (column:SQLWrapper) => sql`${scoped(column)} and exists (select 1 from public.workspace where workspace.id = ${column} and workspace.lifecycle = 'active')`
export const sparraCall = pgTable('sparra_call', {
  id:uuid('id').primaryKey(),workspaceId:uuid('workspace_id').notNull().references(()=>workspace.id,{onDelete:'restrict'}),
  configurationRevision:integer('configuration_revision'),deploymentId:text('deployment_id').notNull(),providerCallControlId:text('provider_call_control_id').notNull(),providerCallLegId:text('provider_call_leg_id'),providerCallSessionId:text('provider_call_session_id'),
  admittedAt:timestamp('admitted_at',{withTimezone:true,precision:3}).notNull(),retentionUntil:timestamp('retention_until',{withTimezone:true,precision:3}).notNull(),endedAt:timestamp('ended_at',{withTimezone:true,precision:3}),
  connectionId:text('connection_id'),toE164:text('to_e164'),fromE164:text('from_e164'),startedAt:timestamp('started_at',{withTimezone:true,precision:3}),endReason:text('end_reason'),endReasonRank:integer('end_reason_rank'),endReasonOccurredAt:timestamp('end_reason_occurred_at',{withTimezone:true,precision:6}),endReasonOperationId:uuid('end_reason_operation_id'),transcriptLossCount:integer('transcript_loss_count').notNull().default(0),
  status:text('status',{enum:['pending','active','closing','closed','failed']}).notNull().default('pending'),
  disclosureState:text('disclosure_state',{enum:['pending','completed','failed']}).notNull().default('pending'),disclosureStartedAt:timestamp('disclosure_started_at',{withTimezone:true,precision:3}),disclosureCompletedAt:timestamp('disclosure_completed_at',{withTimezone:true,precision:3}),disclosureFailedAt:timestamp('disclosure_failed_at',{withTimezone:true,precision:3}),inputGateOpenedAt:timestamp('input_gate_opened_at',{withTimezone:true,precision:3}),
  encryptedTurns:jsonb('encrypted_turns').$type<Record<string,NativeEncryptedTurn>>().notNull().default(sql`'{}'::jsonb`),encryptedMessageResult:jsonb('encrypted_message_result').$type<EncryptedMessageResult>(),
  treatedAt:timestamp('treated_at',{withTimezone:true,precision:3}),erasureRequestedAt:timestamp('erasure_requested_at',{withTimezone:true,precision:3}),
},table=>[
  unique('sparra_call_provider_identity').on(table.deploymentId,table.providerCallControlId),
  foreignKey({name:'sparra_call_configuration_pin',columns:[table.workspaceId,table.configurationRevision],foreignColumns:[sparraKnowledgeRevision.workspaceId,sparraKnowledgeRevision.revision]}).onDelete('restrict'),
  index('sparra_call_inbox').on(table.workspaceId,table.admittedAt.desc(),table.id.desc()),
  check('sparra_call_nonzero_workspace',sql`${table.workspaceId} <> '00000000-0000-0000-0000-000000000000'::uuid`),
  check('sparra_call_identity',sql`length(${table.deploymentId}) between 1 and 256 and length(${table.providerCallControlId}) between 1 and 1024`),
  check('sparra_call_retention',sql`isfinite(${table.admittedAt}) and isfinite(${table.retentionUntil}) and ${table.retentionUntil} = ${table.admittedAt} + interval '2592000 seconds'`),
  check('sparra_call_loss',sql`${table.transcriptLossCount} >= 0`),
  pgPolicy('sparra_call_voice',{to:'sparra_voice_definer',for:'all',using:sql`workspace_id = voice_private.bound_workspace() and deployment_id = voice_private.bound_deployment()`,withCheck:sql`workspace_id = voice_private.bound_workspace() and deployment_id = voice_private.bound_deployment()`}),
  check('sparra_call_status',sql`${table.status} in ('pending','active','closing','closed','failed')`),
  check('sparra_call_disclosure',sql`${table.disclosureState} in ('pending','completed','failed')`),
  check('sparra_call_turns',sql`jsonb_typeof(${table.encryptedTurns}) = 'object' and octet_length(${table.encryptedTurns}::text) <= 524288`),
  check('sparra_call_result',sql`${table.encryptedMessageResult} is null or (jsonb_typeof(${table.encryptedMessageResult}) = 'object' and octet_length(${table.encryptedMessageResult}::text) <= 16384)`),
  ...([table.endedAt,table.disclosureStartedAt,table.disclosureCompletedAt,table.disclosureFailedAt,table.inputGateOpenedAt,table.treatedAt,table.erasureRequestedAt] as const).map(column=>check('sparra_call_finite_'+column.name,sql`${column} is null or isfinite(${column})`)),
  pgPolicy('sparra_call_read',{to:'runtime',for:'select',using:active(table.workspaceId)}),
  pgPolicy('sparra_call_update',{to:'runtime',for:'update',using:active(table.workspaceId),withCheck:active(table.workspaceId)}),
  // The triggering runtime UPDATE holds the active Workspace lock. The definer
  // is deliberately not admitted by Workspace RLS; OLD fixes its product scope.
  pgPolicy('sparra_call_erase_read',{to:'workspace_owner',for:'select',using:scoped(table.workspaceId)}),
  pgPolicy('sparra_call_erase_delete',{to:'workspace_owner',for:'delete',using:scoped(table.workspaceId)}),
]).enableRLS()
export const sparraErasure = pgTable('sparra_erasure',{
  workspaceId:uuid('workspace_id').notNull(),callId:uuid('call_id').notNull(),deploymentId:text('deployment_id').notNull(),providerCallControlId:text('provider_call_control_id').notNull(),
  requestedAt:timestamp('requested_at',{withTimezone:true,precision:3}).notNull(),originalRetentionUntil:timestamp('original_retention_until',{withTimezone:true,precision:3}).notNull(),fenceUntil:timestamp('fence_until',{withTimezone:true,precision:3}).notNull(),
  localCleanupCompletedAt:timestamp('local_cleanup_completed_at',{withTimezone:true,precision:3}),localAckOccurredAt:timestamp('local_ack_occurred_at',{withTimezone:true,precision:6}),
  state:text('state',{enum:['queued','completed']}).notNull().default('queued'),leaseToken:uuid('lease_token'),leaseUntil:timestamp('lease_until',{withTimezone:true,precision:3}),completedAt:timestamp('completed_at',{withTimezone:true,precision:3}),
},table=>[
  primaryKey({columns:[table.workspaceId,table.callId]}),unique('sparra_erasure_provider_identity').on(table.deploymentId,table.providerCallControlId),
  check('sparra_erasure_nonzero_workspace',sql`${table.workspaceId} <> '00000000-0000-0000-0000-000000000000'::uuid`),
  check('sparra_erasure_fence',sql`isfinite(${table.requestedAt}) and isfinite(${table.originalRetentionUntil}) and isfinite(${table.fenceUntil}) and ${table.fenceUntil} = ${table.originalRetentionUntil} + interval '900 seconds'`),
  check('sparra_erasure_state',sql`(${table.state} = 'queued' and ${table.completedAt} is null) or (${table.state} = 'completed' and ${table.completedAt} is not null and isfinite(${table.completedAt}))`),
  check('sparra_erasure_lease',sql`(${table.leaseToken} is null and ${table.leaseUntil} is null) or (${table.leaseToken} is not null and ${table.leaseUntil} is not null and isfinite(${table.leaseUntil}))`),
  pgPolicy('sparra_erasure_voice',{to:'sparra_voice_definer',for:'all',using:sql`workspace_id = voice_private.bound_workspace() and deployment_id = voice_private.bound_deployment()`,withCheck:sql`workspace_id = voice_private.bound_workspace() and deployment_id = voice_private.bound_deployment()`}),
  pgPolicy('sparra_erasure_read',{to:'runtime',for:'select',using:active(table.workspaceId)}),
  pgPolicy('sparra_erasure_insert',{to:'workspace_owner',for:'insert',withCheck:scoped(table.workspaceId)}),
]).enableRLS()
