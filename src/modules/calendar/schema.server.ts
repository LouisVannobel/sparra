import { sql } from 'drizzle-orm'
import { boolean, check, integer, jsonb, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { workspace } from '../workspaces/schema.server'
import type { CalendarPolicy } from './policy'

/** One connection generation per native personal Workspace. Never delete this identity. */
export const calendarConnection = pgTable('sparra_calendar_connection', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().unique().references(() => workspace.id, { onDelete: 'restrict' }),
  generation: integer('generation').notNull().default(0),
  status: text('status', { enum: ['disconnected','connecting','connected','reconnect_required','revoking'] }).notNull().default('disconnected'),
  googleSubject: text('google_subject'), accountEmail: text('account_email'), tokenEnvelope: text('token_envelope'),
  stateHash: text('state_hash'), stateSession: text('state_session'), stateSecret: text('state_secret'), stateExpiresAt: timestamp('state_expires_at', { withTimezone:true, precision:3 }),
  workId: uuid('work_id'), workExpiresAt: timestamp('work_expires_at', { withTimezone:true, precision:3 }),
  policyRevision: integer('policy_revision').notNull().default(0), policy: jsonb('policy').$type<CalendarPolicy>(),
  calendarId: text('calendar_id'), calendarSummary: text('calendar_summary'), enabled: boolean('enabled').notNull().default(false),
}, table => [
  uniqueIndex('calendar_active_google_subject').on(table.googleSubject).where(sql`${table.googleSubject} is not null`),
  check('calendar_generation',sql`${table.generation} >= 0 and ${table.policyRevision} >= 0`),
  check('calendar_status',sql`${table.status} in ('disconnected','connecting','connected','reconnect_required','revoking')`),
  check('calendar_active_rules',sql`not ${table.enabled} or (${table.status} = 'connected' and ${table.policy} is not null and ${table.calendarId} is not null and ${table.policyRevision} > 0)`),
  check('calendar_credentials',sql`(${table.status} in ('connected','reconnect_required','revoking')) = (${table.googleSubject} is not null and ${table.tokenEnvelope} is not null and ${table.accountEmail} is not null)`),
  check('calendar_policy_shape',sql`${table.policy} is null or (jsonb_typeof(${table.policy}) = 'object' and ${table.policy}->>'version' = '1')`),
  check('calendar_state_bound',sql`(${table.stateHash} is null and ${table.stateSecret} is null and ${table.stateSession} is null and ${table.stateExpiresAt} is null) or (${table.status} = 'connecting' and ${table.stateHash} ~ '^[a-f0-9]{64}$' and ${table.stateSecret} is not null and ${table.stateSession} is not null and isfinite(${table.stateExpiresAt}))`),
  pgPolicy('calendar_owner', { to:'runtime', for:'all', using:sql`${table.workspaceId}::text = current_setting('app.tenant_id',true)`, withCheck:sql`${table.workspaceId}::text = current_setting('app.tenant_id',true)` }),
]).enableRLS()
export const calendarSchema = { calendarConnection }
