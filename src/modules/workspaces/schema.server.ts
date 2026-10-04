import { sql } from 'drizzle-orm'
import { check, pgPolicy, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { user } from '../auth/schema.server'

export const workspace = pgTable('workspace', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind', { enum: ['personal'] }).notNull().default('personal'),
  lifecycle: text('lifecycle', { enum: ['provisioning', 'active', 'deleting'] }).notNull().default('active'),
  ownerUserId: text('owner_user_id').notNull().unique().references(() => user.id, { onDelete: 'restrict' }),
  authOrganizationId: text('auth_organization_id'),
  displayName: text('display_name').notNull().default('Workspace'),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
}, table => [
  check('workspace_personal', sql`${table.kind} = 'personal' and ${table.authOrganizationId} is null`),
  check('workspace_lifecycle', sql`${table.lifecycle} in ('provisioning','active','deleting')`),
  check('workspace_nonzero_id', sql`${table.id} <> '00000000-0000-0000-0000-000000000000'::uuid`),
  check('workspace_display_name', sql`length(${table.displayName}) between 1 and 80 and length(btrim(${table.displayName})) > 0 and ${table.displayName} !~ '[[:cntrl:]]' and position(chr(8232) in ${table.displayName}) = 0 and position(chr(8233) in ${table.displayName}) = 0`),
  pgPolicy('workspace_voice_read',{to:'sparra_voice_definer',for:'select',using:sql`id = voice_private.bound_workspace()`}),
  pgPolicy('workspace_voice_lock',{to:'sparra_voice_definer',for:'update',using:sql`id = voice_private.bound_workspace()`,withCheck:sql`id = voice_private.bound_workspace()`}),
  pgPolicy('workspace_tenant', { to: 'runtime', for: 'all', using: sql`${table.id}::text = current_setting('app.tenant_id', true) and ${table.lifecycle} = 'active'`, withCheck: sql`${table.id}::text = current_setting('app.tenant_id', true) and ${table.lifecycle} = 'active'` }),
  pgPolicy('workspace_bootstrap', { to: 'workspace_bootstrap', for: 'all', using: sql`current_setting('app.tenant_id', true) = '00000000-0000-0000-0000-000000000000'`, withCheck: sql`current_setting('app.tenant_id', true) = '00000000-0000-0000-0000-000000000000'` }),
]).enableRLS()

// Copied identifiers deliberately have no parent FK. These append-only facts
// survive account closure. Retention requires an explicit module-owned decision.
export const workspaceAudit = pgTable('workspace_audit', {
  id: uuid('id').primaryKey().defaultRandom(),
  action: text('action', { enum: ['personal-created', 'display-name-changed'] }).notNull(),
  actorUserId: text('actor_user_id').notNull(),
  workspaceId: uuid('workspace_id').notNull(),
  correlationId: uuid('correlation_id').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true, precision: 3 }).notNull().default(sql`clock_timestamp()`),
}, table => [
  check('workspace_audit_action', sql`${table.action} in ('personal-created','display-name-changed')`),
  pgPolicy('workspace_audit_tenant_insert', { to: 'runtime', for: 'insert', withCheck: sql`${table.workspaceId}::text = current_setting('app.tenant_id', true) and ${table.action} = 'display-name-changed'` }),
  pgPolicy('workspace_audit_bootstrap_insert', { to: 'workspace_bootstrap', for: 'insert', withCheck: sql`current_setting('app.tenant_id', true) = '00000000-0000-0000-0000-000000000000' and ${table.action} = 'personal-created'` }),
]).enableRLS()
export const workspaceSchema = { workspace, workspaceAudit }
