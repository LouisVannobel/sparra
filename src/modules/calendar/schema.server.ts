import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { workspace } from '../workspaces/schema.server'
import type { CalendarPolicy } from './policy'

/** One connection generation per native personal Workspace. Never delete this identity. */
export const calendarConnection = pgTable(
  'sparra_calendar_connection',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .unique()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    generation: integer('generation').notNull().default(0),
    status: text('status', {
      enum: ['disconnected', 'connecting', 'connected', 'reconnect_required', 'revoking'],
    })
      .notNull()
      .default('disconnected'),
    googleSubject: text('google_subject'),
    accountEmail: text('account_email'),
    tokenEnvelope: text('token_envelope'),
    stateHash: text('state_hash'),
    stateSession: text('state_session'),
    stateSecret: text('state_secret'),
    stateExpiresAt: timestamp('state_expires_at', { withTimezone: true, precision: 3 }),
    workId: uuid('work_id'),
    workExpiresAt: timestamp('work_expires_at', { withTimezone: true, precision: 3 }),
    policyRevision: integer('policy_revision').notNull().default(0),
    policy: jsonb('policy').$type<CalendarPolicy>(),
    calendarId: text('calendar_id'),
    calendarSummary: text('calendar_summary'),
    enabled: boolean('enabled').notNull().default(false),
  },
  (table) => [
    uniqueIndex('calendar_active_google_subject')
      .on(table.googleSubject)
      .where(sql`${table.googleSubject} is not null`),
    check('calendar_generation', sql`${table.generation} >= 0 and ${table.policyRevision} >= 0`),
    check(
      'calendar_status',
      sql`${table.status} in ('disconnected','connecting','connected','reconnect_required','revoking')`,
    ),
    check(
      'calendar_active_rules',
      sql`not ${table.enabled} or (${table.status} = 'connected' and ${table.policy} is not null and ${table.calendarId} is not null and ${table.policyRevision} > 0)`,
    ),
    check(
      'calendar_credentials',
      sql`(${table.status} in ('connected','reconnect_required','revoking')) = (${table.googleSubject} is not null and ${table.tokenEnvelope} is not null and ${table.accountEmail} is not null)`,
    ),
    check(
      'calendar_policy_shape',
      sql`${table.policy} is null or (jsonb_typeof(${table.policy}) = 'object' and ${table.policy}->>'version' = '1')`,
    ),
    check(
      'calendar_state_bound',
      sql`(${table.stateHash} is null and ${table.stateSecret} is null and ${table.stateSession} is null and ${table.stateExpiresAt} is null) or (${table.status} = 'connecting' and ${table.stateHash} ~ '^[a-f0-9]{64}$' and ${table.stateSecret} is not null and ${table.stateSession} is not null and isfinite(${table.stateExpiresAt}))`,
    ),
    pgPolicy('calendar_owner', {
      to: 'runtime',
      for: 'all',
      using: sql`${table.workspaceId}::text = current_setting('app.tenant_id',true)`,
      withCheck: sql`${table.workspaceId}::text = current_setting('app.tenant_id',true)`,
    }),
    pgPolicy('calendar_connection_voice', {
      to: 'sparra_voice_definer', for: 'select', using: sql`workspace_id = voice_private.bound_workspace()`,
    }),
    pgPolicy('calendar_connection_worker', {
      to: 'calendar_definer', for: 'all', using: sql`true`, withCheck: sql`true`,
    }),
  ],
).enableRLS()
const instant = (name: string) => timestamp(name, { withTimezone: true, precision: 3 })
export const calendarCommand = pgTable(
  'sparra_calendar_command',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    callId: uuid('call_id'),
    deploymentId: text('deployment_id'),
    kind: text('kind').notNull(),
    request: jsonb('request'),
    digest: text('digest').notNull(),
    connectionId: uuid('connection_id').notNull(),
    generation: integer('generation').notNull(),
    policyRevision: integer('policy_revision').notNull(),
    googleSubject: text('google_subject').notNull(),
    calendarId: text('calendar_id').notNull(),
    policy: jsonb('policy').$type<CalendarPolicy>(),
    serviceId: text('service_id').notNull(),
    serviceName: text('service_name').notNull(),
    windowStart: instant('window_start').notNull(),
    windowEnd: instant('window_end').notNull(),
    offerId: uuid('offer_id'),
    state: text('state').notNull().default('pending'),
    fence: bigint('fence', { mode: 'number' }).notNull().default(0),
    leaseUntil: instant('lease_until'),
    retryAt: instant('retry_at').notNull().defaultNow(),
    createdAt: instant('created_at').notNull().defaultNow(),
    firstSendDeadline: instant('first_send_deadline').notNull(),
    possibleSendFence: bigint('possible_send_fence', { mode: 'number' }),
    eventId: text('event_id'),
    currentStart: instant('current_start'),
    currentEnd: instant('current_end'),
    observedState: text('observed_state'),
    observedAt: instant('observed_at'),
    result: jsonb('result'),
  },
  (table) => [
    check('calendar_command_kind', sql`${table.kind} in ('find_slots','book_appointment')`),
    check(
      'calendar_command_state',
      sql`${table.state} in ('waiting_evidence','pending','running','offered','confirmed','refused','unknown')`,
    ),
    check(
      'calendar_command_bounds',
      sql`isfinite(${table.windowStart}) and isfinite(${table.windowEnd}) and ${table.windowStart}<${table.windowEnd} and ${table.fence}>=0`,
    ),
    index('calendar_command_ready').on(table.retryAt),
    pgPolicy('calendar_publication_owner', {to:'workspace_owner',for:'select',using:sql`${table.workspaceId}::text=current_setting('app.tenant_id',true)`}),
    pgPolicy('calendar_command_owner', {
      to: 'runtime',
      for: 'select',
      using: sql`${table.workspaceId}::text=current_setting('app.tenant_id',true)`,
    }),
    pgPolicy('calendar_command_voice', {
      to: 'sparra_voice_definer',
      for: 'all',
      using: sql`${table.workspaceId}=voice_private.bound_workspace() and ${table.deploymentId}=voice_private.bound_deployment()`,
      withCheck: sql`${table.workspaceId}=voice_private.bound_workspace() and ${table.deploymentId}=voice_private.bound_deployment()`,
    }),
    pgPolicy('calendar_command_worker', {
      to: 'calendar_definer',
      for: 'all',
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
).enableRLS()
export const calendarOffer = pgTable(
  'sparra_calendar_offer',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    commandId: uuid('command_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    callId: uuid('call_id').notNull(),
    deploymentId: text('deployment_id').notNull(),
    start: instant('start').notNull(),
    end: instant('end').notNull(),
    expiresAt: instant('expires_at').notNull(),
  },
  (table) => [
    check(
      'calendar_offer_bounds',
      sql`isfinite(${table.start}) and isfinite(${table.end}) and ${table.start}<${table.end} and isfinite(${table.expiresAt})`,
    ),
    pgPolicy('calendar_offer_voice', {
      to: 'sparra_voice_definer',
      for: 'select',
      using: sql`${table.workspaceId}=voice_private.bound_workspace() and ${table.deploymentId}=voice_private.bound_deployment()`,
    }),
    pgPolicy('calendar_offer_worker', {
      to: 'calendar_definer',
      for: 'all',
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
).enableRLS()
export const calendarSchema = { calendarConnection, calendarCommand, calendarOffer }
