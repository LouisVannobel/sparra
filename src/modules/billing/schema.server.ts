import { sql } from 'drizzle-orm'
import { bigint, check, foreignKey, index, jsonb, pgPolicy, pgTable, text, timestamp, unique, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core'
import { workspace } from '../workspaces/schema.server'

const tenant = (workspaceId: AnyPgColumn) => sql`${workspaceId}::text = current_setting('app.tenant_id', true)`

export const billingAgreedTerms = pgTable('billing_agreed_terms', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspace.id, { onDelete: 'restrict' }),
  environment: text('environment', { enum: ['sandbox', 'live'] }).notNull(),
  accountId: text('account_id').notNull(),
  revision: bigint('revision', { mode: 'number' }).notNull(),
  monthlyPriceId: text('monthly_price_id').notNull(),
  currency: text('currency').notNull(),
  monthlyUnitAmount: bigint('monthly_unit_amount', { mode: 'number' }).notNull(),
}, table => [
  unique('billing_terms_revision').on(table.workspaceId, table.environment, table.accountId, table.revision),
  unique('billing_terms_scope').on(table.id, table.workspaceId, table.environment, table.accountId),
  check('billing_terms_environment', sql`${table.environment} in ('sandbox','live')`),
  check('billing_terms_account', sql`${table.accountId} ~ '^acct_[A-Za-z0-9]+$'`),
  check('billing_terms_revision_positive', sql`${table.revision} between 1 and 9007199254740991`),
  check('billing_terms_price', sql`${table.monthlyPriceId} ~ '^price_[A-Za-z0-9]+$'`),
  check('billing_terms_currency', sql`${table.currency} ~ '^[a-z]{3}$'`),
  check('billing_terms_amount', sql`${table.monthlyUnitAmount} between 1 and 9007199254740991`),
  pgPolicy('billing_terms_runtime_read', { to: 'runtime', for: 'select', using: tenant(table.workspaceId) }),
  pgPolicy('billing_terms_workspace_definer_read', { to: 'workspace_bootstrap', for: 'select', using: tenant(table.workspaceId) }),
  pgPolicy('billing_terms_billing_definer_read', { to: 'billing_definer', for: 'select', using: sql`true` }),
]).enableRLS()

export const billingCustomer = pgTable('billing_customer', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspace.id, { onDelete: 'restrict' }),
  environment: text('environment', { enum: ['sandbox', 'live'] }).notNull(),
  accountId: text('account_id').notNull(),
  stripeCustomerId: text('stripe_customer_id').notNull(),
  knownSubscriptionId: text('known_subscription_id'),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().default(sql`clock_timestamp()`),
}, table => [
  unique('billing_customer_scope_unique').on(table.workspaceId, table.environment, table.accountId),
  unique('billing_customer_provider_unique').on(table.environment, table.accountId, table.stripeCustomerId),
  unique('billing_customer_checkout_ref').on(table.workspaceId, table.environment, table.accountId, table.stripeCustomerId),
  uniqueIndex('billing_customer_subscription_scope').on(table.environment, table.accountId, table.knownSubscriptionId).where(sql`${table.knownSubscriptionId} is not null`),
  check('billing_customer_environment', sql`${table.environment} in ('sandbox','live')`),
  check('billing_customer_provider_id', sql`${table.stripeCustomerId} ~ '^cus_[A-Za-z0-9]+$'`),
  check('billing_customer_subscription_id', sql`${table.knownSubscriptionId} is null or ${table.knownSubscriptionId} ~ '^sub_[A-Za-z0-9]+$'`),
  pgPolicy('billing_customer_runtime_read', { to: 'runtime', for: 'select', using: tenant(table.workspaceId) }),
  pgPolicy('billing_customer_definer', { to: 'workspace_bootstrap', for: 'all', using: tenant(table.workspaceId), withCheck: tenant(table.workspaceId) }),
]).enableRLS()

export const billingOperation = pgTable('billing_operation', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspace.id, { onDelete: 'restrict' }),
  kind: text('kind', { enum: ['CUSTOMER_CREATE', 'CHECKOUT_CREATE', 'CANCEL_AT_PERIOD_END'] }).notNull(),
  phase: text('phase', { enum: ['ADMITTED', 'DISPATCHING', 'SUCCEEDED', 'UNKNOWN'] }).notNull().default('ADMITTED'),
  environment: text('environment', { enum: ['sandbox', 'live'] }).notNull(),
  accountId: text('account_id').notNull(),
  apiVersion: text('api_version').notNull(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  requestHash: text('request_hash').notNull(),
  customerId: text('customer_id'),
  agreedTermsId: uuid('agreed_terms_id'),
  monthlyPriceId: text('monthly_price_id'),
  onboardingPriceId: text('onboarding_price_id'),
  currency: text('currency'),
  monthlyUnitAmount: bigint('monthly_unit_amount', { mode: 'number' }),
  onboardingUnitAmount: bigint('onboarding_unit_amount', { mode: 'number' }),
  integrationIdentifier: text('integration_identifier'),
  checkoutReferenceVersion: text('checkout_reference_version', { enum: ['legacy-v1', 'operation-v2'] }).notNull().default('legacy-v1'),
  stripeObjectId: text('stripe_object_id'),
  checkoutUrl: text('checkout_url'),
  checkoutExpiresAt: bigint('checkout_expires_at', { mode: 'number' }),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().default(sql`clock_timestamp()`),
  updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().default(sql`clock_timestamp()`),
}, table => [
  unique('billing_operation_one_slot').on(table.workspaceId, table.environment, table.accountId, table.kind),
  unique('billing_operation_workspace_ref').on(table.id, table.workspaceId),
  unique('billing_operation_graph_ref').on(table.id, table.workspaceId, table.environment, table.accountId, table.customerId),
  foreignKey({ name: 'billing_operation_terms_scope', columns: [table.agreedTermsId, table.workspaceId, table.environment, table.accountId],
    foreignColumns: [billingAgreedTerms.id, billingAgreedTerms.workspaceId, billingAgreedTerms.environment, billingAgreedTerms.accountId] }),
  check('billing_operation_terms_shape', sql`(${table.kind}='CHECKOUT_CREATE') = (${table.agreedTermsId} is not null)
    and ${table.onboardingPriceId} is null and ${table.onboardingUnitAmount} is null`),
  foreignKey({ name: 'billing_operation_customer_same_scope',
    columns: [table.workspaceId, table.environment, table.accountId, table.customerId],
    foreignColumns: [billingCustomer.workspaceId, billingCustomer.environment, billingCustomer.accountId, billingCustomer.stripeCustomerId] }),
  check('billing_operation_kind', sql`${table.kind} in ('CUSTOMER_CREATE','CHECKOUT_CREATE','CANCEL_AT_PERIOD_END')`),
  check('billing_operation_phase', sql`${table.phase} in ('ADMITTED','DISPATCHING','SUCCEEDED','UNKNOWN')`),
  check('billing_reference_version', sql`${table.checkoutReferenceVersion} in ('legacy-v1','operation-v2')`),
  check('billing_operation_environment', sql`${table.environment} in ('sandbox','live')`),
  check('billing_operation_api', sql`${table.apiVersion} = '2026-09-30.endive'`),
  check('billing_operation_key', sql`length(${table.idempotencyKey}) between 1 and 255 and ${table.idempotencyKey} ~ '^[A-Za-z0-9:_-]+$'`),
  check('billing_operation_hash', sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`),
  check('billing_operation_shape', sql`(
    ${table.kind}='CUSTOMER_CREATE' and ${table.customerId} is null and ${table.monthlyPriceId} is null
      and ${table.onboardingPriceId} is null and ${table.currency} is null and ${table.monthlyUnitAmount} is null
      and ${table.onboardingUnitAmount} is null and ${table.integrationIdentifier} is null
    or ${table.kind}='CHECKOUT_CREATE' and ${table.customerId} ~ '^cus_[A-Za-z0-9]+$'
      and ${table.monthlyPriceId} ~ '^price_[A-Za-z0-9]+$' and ${table.currency} ~ '^[a-z]{3}$'
      and ${table.monthlyUnitAmount} > 0 and (${table.onboardingPriceId} is null and ${table.onboardingUnitAmount} is null
        or ${table.onboardingPriceId} ~ '^price_[A-Za-z0-9]+$' and ${table.onboardingUnitAmount} > 0)
      and ${table.integrationIdentifier} ~ '^[A-Za-z][A-Za-z0-9_-]*_[A-Za-z]{8}$'
    or ${table.kind}='CANCEL_AT_PERIOD_END' and ${table.customerId} ~ '^cus_[A-Za-z0-9]+$'
      and ${table.monthlyPriceId} is null and ${table.onboardingPriceId} is null and ${table.currency} is null
      and ${table.monthlyUnitAmount} is null and ${table.onboardingUnitAmount} is null and ${table.integrationIdentifier} is null
  ) is true`),
  check('billing_operation_result', sql`(
    ${table.phase}='SUCCEEDED' and ${table.stripeObjectId} is not null
      and (${table.kind}='CUSTOMER_CREATE' and ${table.stripeObjectId} ~ '^cus_[A-Za-z0-9]+$' and ${table.checkoutUrl} is null and ${table.checkoutExpiresAt} is null
        or ${table.kind}='CHECKOUT_CREATE' and ${table.stripeObjectId} ~ '^cs_(test|live)_[A-Za-z0-9]+$'
          and ${table.checkoutUrl} is not null and ${table.checkoutExpiresAt} > 0
        or ${table.kind}='CANCEL_AT_PERIOD_END' and ${table.stripeObjectId} ~ '^sub_[A-Za-z0-9]+$'
          and ${table.checkoutUrl} is null and ${table.checkoutExpiresAt} is null)
    or ${table.phase}<>'SUCCEEDED' and ${table.stripeObjectId} is null and ${table.checkoutUrl} is null and ${table.checkoutExpiresAt} is null
  ) is true`),
  pgPolicy('billing_operation_runtime_read', { to: 'runtime', for: 'select', using: tenant(table.workspaceId) }),
  pgPolicy('billing_operation_definer', { to: 'workspace_bootstrap', for: 'all', using: tenant(table.workspaceId), withCheck: tenant(table.workspaceId) }),
]).enableRLS()

export const billingOperationOutcome = pgTable('billing_operation_outcome', {
  id: uuid('id').primaryKey().defaultRandom(),
  operationId: uuid('operation_id').notNull(),
  workspaceId: uuid('workspace_id').notNull(),
  outcome: text('outcome', { enum: ['DISPATCHING', 'SUCCEEDED', 'UNKNOWN'] }).notNull(),
  stripeObjectId: text('stripe_object_id'),
  occurredAt: timestamp('occurred_at', { withTimezone: true, precision: 3 }).notNull().default(sql`clock_timestamp()`),
}, table => [
  foreignKey({ name: 'billing_outcome_operation_same_workspace', columns: [table.operationId, table.workspaceId],
    foreignColumns: [billingOperation.id, billingOperation.workspaceId] }).onDelete('restrict'),
  unique('billing_outcome_one_phase').on(table.operationId, table.outcome),
  check('billing_outcome_kind', sql`${table.outcome} in ('DISPATCHING','SUCCEEDED','UNKNOWN')`),
  check('billing_outcome_object', sql`(${table.outcome}='SUCCEEDED' and ${table.stripeObjectId} is not null) or (${table.outcome}<>'SUCCEEDED' and ${table.stripeObjectId} is null)`),
  pgPolicy('billing_outcome_runtime_read', { to: 'runtime', for: 'select', using: tenant(table.workspaceId) }),
  pgPolicy('billing_outcome_definer', { to: 'workspace_bootstrap', for: 'all', using: tenant(table.workspaceId), withCheck: tenant(table.workspaceId) }),
]).enableRLS()

export const billingEventReceipt = pgTable('billing_event_receipt', {
  id: uuid('id').primaryKey().defaultRandom(), environment: text('environment').notNull(), accountId: text('account_id').notNull(),
  eventId: text('event_id').notNull(), projection: jsonb('projection').notNull(), projectionHash: text('projection_hash').notNull(),
  chargeId: text('charge_id'), riskId: text('risk_id'), receivedAt: timestamp('received_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, table => [unique('billing_receipt_identity').on(table.environment, table.accountId, table.eventId),
  index('billing_receipt_charge').on(table.environment, table.accountId, table.chargeId),
  check('billing_receipt_scope', sql`${table.environment} in ('sandbox','live') and ${table.accountId} ~ '^acct_[A-Za-z0-9]+$'`),
  check('billing_receipt_hash', sql`${table.projectionHash} ~ '^[0-9a-f]{64}$'`),
]).enableRLS()

export const billingReceiptAssignment = pgTable('billing_receipt_assignment', {
  receiptId: uuid('receipt_id').primaryKey().references(() => billingEventReceipt.id, { onDelete: 'restrict' }),
  workspaceId: uuid('workspace_id').notNull().references(() => workspace.id, { onDelete: 'restrict' }),
  assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, table => [unique('billing_assignment_pair').on(table.receiptId, table.workspaceId), index('billing_assignment_workspace').on(table.workspaceId)]).enableRLS()

export const billingCommand = pgTable('billing_command', {
  id: uuid('id').primaryKey().defaultRandom(), receiptId: uuid('receipt_id').notNull().unique(), workspaceId: uuid('workspace_id').notNull(),
  operationId: uuid('operation_id').notNull(), fence: bigint('fence', { mode: 'number' }).notNull().default(0),
  leaseUntil: timestamp('lease_until', { withTimezone: true }), manifestRevision: bigint('manifest_revision', { mode: 'number' }).notNull().default(0),
  targetProgress: jsonb('target_progress').notNull().default(sql`'[]'::jsonb`), identities: jsonb('identities').notNull().default(sql`'{}'::jsonb`),
  completedAt: timestamp('completed_at', { withTimezone: true }), createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, table => [
  unique('billing_command_pair').on(table.id, table.workspaceId),
  foreignKey({ name: 'billing_command_assignment_pair', columns: [table.receiptId, table.workspaceId], foreignColumns: [billingReceiptAssignment.receiptId, billingReceiptAssignment.workspaceId] }),
  foreignKey({ name: 'billing_command_operation_pair', columns: [table.operationId, table.workspaceId], foreignColumns: [billingOperation.id, billingOperation.workspaceId] }),
  index('billing_command_operation').on(table.operationId, table.workspaceId), index('billing_command_pending').on(table.completedAt, table.createdAt),
  index('billing_command_identity_lookup').using('gin', table.identities),
  check('billing_command_progress_bound', sql`jsonb_typeof(${table.targetProgress})='array' and jsonb_array_length(${table.targetProgress})<=500 and jsonb_typeof(${table.identities})='object'`),
  check('billing_command_fences', sql`${table.fence}>=0 and ${table.manifestRevision}>=0`),
]).enableRLS()

export const billingOutbox = pgTable('billing_outbox', {
  id: uuid('id').primaryKey().defaultRandom(), commandId: uuid('command_id').notNull().unique(), workspaceId: uuid('workspace_id').notNull(),
  admissionState: text('admission_state', { enum: ['ready', 'dispatching', 'unknown', 'admitted', 'retired'] }).notNull().default('ready'),
  admissionFence: bigint('admission_fence', { mode: 'number' }).notNull().default(0), admissionLeaseUntil: timestamp('admission_lease_until', { withTimezone: true }),
  runId: uuid('run_id'), terminalDisposition: text('terminal_disposition', { enum: ['completed', 'failed', 'cancelled'] }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, table => [foreignKey({ name: 'billing_outbox_command_pair', columns: [table.commandId, table.workspaceId], foreignColumns: [billingCommand.id, billingCommand.workspaceId] }),
  index('billing_outbox_admission').on(table.admissionState, table.admissionLeaseUntil, table.createdAt),
  uniqueIndex('billing_one_native_run').on(sql`(true)`).where(sql`${table.admissionState} in ('dispatching','unknown','admitted')`),
  check('billing_outbox_state', sql`${table.admissionState} in ('ready','dispatching','unknown','admitted','retired')`),
  check('billing_outbox_terminal', sql`(${table.admissionState}='retired')=(${table.terminalDisposition} is not null) and (${table.admissionState}<>'retired' or ${table.runId} is not null)`),
]).enableRLS()

export const billingChargeBinding = pgTable('billing_charge_binding', {
  id: uuid('id').primaryKey().defaultRandom(), workspaceId: uuid('workspace_id').notNull(), operationId: uuid('operation_id').notNull(),
  environment: text('environment').notNull(), accountId: text('account_id').notNull(), customerId: text('customer_id').notNull(),
  subscriptionId: text('subscription_id').notNull(), chargeId: text('charge_id').notNull(), paymentIntentId: text('payment_intent_id').notNull(), invoiceId: text('invoice_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, table => [unique('billing_binding_edge').on(table.environment, table.accountId, table.chargeId, table.paymentIntentId, table.invoiceId),
  foreignKey({ name: 'billing_binding_operation_pair', columns: [table.operationId, table.workspaceId], foreignColumns: [billingOperation.id, billingOperation.workspaceId] }),
  foreignKey({ name: 'billing_binding_operation_scope', columns: [table.operationId, table.workspaceId, table.environment, table.accountId, table.customerId],
    foreignColumns: [billingOperation.id, billingOperation.workspaceId, billingOperation.environment, billingOperation.accountId, billingOperation.customerId] }),
  index('billing_binding_invoice').on(table.environment, table.accountId, table.invoiceId),
  index('billing_binding_pi').on(table.environment, table.accountId, table.paymentIntentId),
  index('billing_binding_operation').on(table.operationId, table.workspaceId),
]).enableRLS()

export const billingRiskObservation = pgTable('billing_risk_observation', {
  id: uuid('id').primaryKey().defaultRandom(), workspaceId: uuid('workspace_id').notNull().references(() => workspace.id, { onDelete: 'restrict' }),
  environment: text('environment').notNull(), accountId: text('account_id').notNull(), chargeId: text('charge_id').notNull(),
  facts: jsonb('facts').notNull(), factsHash: text('facts_hash').notNull(),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, table => [unique('billing_risk_fact_identity').on(table.environment, table.accountId, table.chargeId, table.factsHash),
  index('billing_risk_workspace').on(table.workspaceId),
]).enableRLS()

export const billingAgreement = pgTable('billing_agreement', {
  id: uuid('id').primaryKey().defaultRandom(), workspaceId: uuid('workspace_id').notNull(), operationId: uuid('operation_id').notNull(),
  environment: text('environment').notNull(), accountId: text('account_id').notNull(), subscriptionId: text('subscription_id').notNull(),
  invoiceId: text('invoice_id').notNull(), periodStart: bigint('period_start', { mode: 'number' }).notNull(), periodEnd: bigint('period_end', { mode: 'number' }).notNull(),
  proof: jsonb('proof').notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, table => [unique('billing_agreement_period').on(table.environment, table.accountId, table.subscriptionId, table.periodStart, table.periodEnd),
  unique('billing_agreement_invoice').on(table.environment, table.accountId, table.invoiceId), unique('billing_agreement_pair').on(table.id, table.workspaceId),
  foreignKey({ name: 'billing_agreement_operation_pair', columns: [table.operationId, table.workspaceId], foreignColumns: [billingOperation.id, billingOperation.workspaceId] }),
  check('billing_agreement_period_order', sql`${table.periodStart}>0 and ${table.periodEnd}>${table.periodStart}`),
  index('billing_agreement_workspace').on(table.workspaceId),
  pgPolicy('billing_agreement_runtime_read', { to: 'runtime', for: 'select', using: tenant(table.workspaceId) }),
]).enableRLS()

export const billingCurrentAgreement = pgTable('billing_current_agreement', {
  workspaceId: uuid('workspace_id').primaryKey().references(() => workspace.id, { onDelete: 'restrict' }),
  agreementId: uuid('agreement_id').notNull(), version: bigint('version', { mode: 'number' }).notNull(),
  heldAt: timestamp('held_at', { withTimezone: true }),
}, table => [foreignKey({ name: 'billing_current_same_workspace', columns: [table.agreementId, table.workspaceId], foreignColumns: [billingAgreement.id, billingAgreement.workspaceId] }),
  check('billing_current_version', sql`${table.version}>0`),
  pgPolicy('billing_current_runtime_read', { to: 'runtime', for: 'select', using: tenant(table.workspaceId) }),
]).enableRLS()

export const billingSchema = { billingCustomer, billingOperation, billingOperationOutcome, billingEventReceipt, billingReceiptAssignment,
  billingCommand, billingOutbox, billingChargeBinding, billingRiskObservation, billingAgreement, billingCurrentAgreement }
