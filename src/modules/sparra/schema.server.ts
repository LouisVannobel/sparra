import { sql, type SQLWrapper } from 'drizzle-orm'
import { check, integer, pgPolicy, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { workspace } from '../workspaces/schema.server'

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
  pgPolicy('sparra_revision_read', { to: 'runtime', for: 'select', using: sql`${table.workspaceId}::text = current_setting('app.tenant_id',true) and current_setting('app.tenant_id',true) <> '00000000-0000-0000-0000-000000000000'` }),
  pgPolicy('sparra_revision_insert', { to: 'runtime', for: 'insert', withCheck: sql`${table.workspaceId}::text = current_setting('app.tenant_id',true) and current_setting('app.tenant_id',true) <> '00000000-0000-0000-0000-000000000000'` }),
]).enableRLS()
