import { sql } from 'drizzle-orm'
import { boolean, check, foreignKey, index, integer, jsonb, pgPolicy, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { mode: 'date', precision: 3, withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  recovering: boolean('recovering').notNull().default(false),
  recoveryGeneration: integer('recovery_generation').notNull().default(0),
  holdUntil: timestamp('hold_until', { mode: 'date', precision: 3, withTimezone: true }),
}, table => [
  check('user_recovery_generation_nonnegative', sql`${table.recoveryGeneration} >= 0`),
])

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at', { mode: 'date', precision: 3, withTimezone: true }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { mode: 'date', precision: 3, withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  authState: text('auth_state').notNull(),
  authMethod: text('auth_method').notNull(),
  authenticatedAt: timestamp('authenticated_at', { mode: 'date', precision: 3, withTimezone: true }).notNull(),
  providerIdentity: jsonb('provider_identity'),
  recoveryGeneration: integer('recovery_generation').notNull(),
  lastActivityAt: timestamp('last_activity_at', { mode: 'date', precision: 3, withTimezone: true }).notNull(),
}, table => [
  index('session_user_id_idx').on(table.userId),
  check('session_auth_state_allowed', sql`${table.authState} in ('ACTIVE', 'MFA_PENDING', 'RECOVERY_RESTRICTED')`),
  check('session_auth_method_allowed', sql`${table.authMethod} in ('google', 'magic-link', 'passkey', 'totp', 'recovery')`),
  check('session_recovery_generation_nonnegative', sql`${table.recoveryGeneration} >= 0`),
])

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { mode: 'date', precision: 3, withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { mode: 'date', precision: 3, withTimezone: true }),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { mode: 'date', precision: 3, withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, table => [
  index('account_user_id_idx').on(table.userId),
  unique('account_provider_account_id_unique').on(table.providerId, table.accountId),
  check('account_provider_google', sql`${table.providerId} = 'google'`),
  check('account_password_disabled', sql`${table.password} is null`),
])

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { mode: 'date', precision: 3, withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { mode: 'date', precision: 3, withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, table => [
  index('verification_identifier_idx').on(table.identifier),
])

export const passkey = pgTable('passkey', {
  id: text('id').primaryKey(),
  name: text('name'),
  publicKey: text('public_key').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  credentialID: text('credential_id').notNull().unique(),
  counter: integer('counter').notNull(),
  deviceType: text('device_type').notNull(),
  backedUp: boolean('backed_up').notNull(),
  transports: text('transports'),
  createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true }),
  aaguid: text('aaguid'),
}, table => [index('passkey_user_id_idx').on(table.userId)])

const authScope = sql`current_setting('app.tenant_id', true) = '00000000-0000-0000-0000-000000000000'`
const emailTime = (name: string) => timestamp(name, { mode: 'date', precision: 3, withTimezone: true })

export const authSessionRevocation = pgTable('auth_session_revocation', {
  id: uuid('id').primaryKey(),
  actorUserId: text('actor_user_id').notNull(),
  authorizingSessionId: text('authorizing_session_id').notNull(),
  targetSessionId: text('target_session_id').notNull(),
  workspaceId: uuid('workspace_id').notNull(),
  correlationId: uuid('correlation_id').notNull(),
  occurredAt: emailTime('occurred_at').notNull(),
}, () => [pgPolicy('auth_session_revocation_insert', { for: 'insert', withCheck: authScope })]).enableRLS()

export const additionalPasskeyIntent = pgTable('additional_passkey_intent', {
  id: uuid('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  sessionId: text('session_id').notNull().references(() => session.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').notNull(),
  recoveryGeneration: integer('recovery_generation').notNull(),
  phase: text('phase', { enum: ['CHALLENGE', 'AUTHORIZED', 'CONSUMED'] }).notNull(),
  expiresAt: emailTime('expires_at').notNull(),
  authenticationChallenge: text('authentication_challenge'),
  authorizingKeyId: text('authorizing_key_id'),
  authorizingCredentialId: text('authorizing_credential_id'),
  authorizingPublicKey: text('authorizing_public_key'),
  registrationVerificationIdentifier: text('registration_verification_identifier'),
}, table => [
  index('additional_passkey_intent_expired_idx').on(table.userId, table.expiresAt, table.id),
  check('additional_passkey_intent_generation', sql`${table.recoveryGeneration} >= 0`),
  check('additional_passkey_intent_phase', sql`(
    ${table.phase} = 'CHALLENGE' and ${table.authenticationChallenge} is not null
    and ${table.authorizingKeyId} is null and ${table.authorizingCredentialId} is null
    and ${table.authorizingPublicKey} is null and ${table.registrationVerificationIdentifier} is null
  ) or (
    ${table.phase} in ('AUTHORIZED','CONSUMED') and ${table.authenticationChallenge} is null
    and ${table.authorizingKeyId} is not null and ${table.authorizingCredentialId} is not null
    and ${table.authorizingPublicKey} is not null and ${table.registrationVerificationIdentifier} is not null
  )`),
  pgPolicy('additional_passkey_intent_scope', { for: 'all', using: authScope, withCheck: authScope }),
]).enableRLS()

export const firstGooglePasskeyIntent = pgTable('first_google_passkey_intent', {
  id: uuid('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  sessionId: text('session_id').notNull().references(() => session.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').notNull(),
  recoveryGeneration: integer('recovery_generation').notNull(),
  accountId: text('account_id').notNull(),
  subject: text('subject').notNull(),
  createdAt: emailTime('created_at').notNull(),
  expiresAt: emailTime('expires_at').notNull(),
  phase: text('phase', { enum: ['PENDING_GOOGLE', 'EXCHANGING', 'AUTHORIZED', 'CONSUMED', 'INVALIDATED'] }).notNull(),
  reason: text('reason', { enum: ['unavailable', 'proof_unavailable', 'proof_stale', 'cancelled', 'superseded'] }),
  authenticatedAt: emailTime('authenticated_at'),
  registrationVerificationIdentifier: text('registration_verification_identifier'),
  passkeyId: text('passkey_id'),
}, table => [
  index('first_google_passkey_intent_retention_idx').on(table.userId, table.createdAt, table.id),
  check('first_google_passkey_intent_generation', sql`${table.recoveryGeneration} >= 0`),
  check('first_google_passkey_intent_expiry', sql`${table.expiresAt} > ${table.createdAt} and ${table.expiresAt} <= ${table.createdAt} + interval '5 minutes'`),
  check('first_google_passkey_intent_phase', sql`${table.phase} in ('PENDING_GOOGLE','EXCHANGING','AUTHORIZED','CONSUMED','INVALIDATED')`),
  check('first_google_passkey_intent_authority', sql`${table.phase} not in ('AUTHORIZED','CONSUMED') or ${table.authenticatedAt} is not null`),
  check('first_google_passkey_intent_reason', sql`(${table.phase} = 'INVALIDATED' and ${table.reason} is not null and ${table.reason} in ('unavailable','proof_unavailable','proof_stale','cancelled','superseded')) or (${table.phase} <> 'INVALIDATED' and ${table.reason} is null)`),
  pgPolicy('first_google_passkey_intent_scope', { for: 'all', using: authScope, withCheck: authScope }),
]).enableRLS()

export const googleAccountIntent = pgTable('google_account_intent', {
  id: uuid('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  sessionId: text('session_id').notNull().references(() => session.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').notNull(),
  recoveryGeneration: integer('recovery_generation').notNull(),
  action: text('action', { enum: ['LINK', 'UNLINK'] }).notNull(),
  locale: text('locale', { enum: ['fr', 'en'] }).notNull(),
  targetAccountId: text('target_account_id'),
  targetSubject: text('target_subject'),
  createdAt: emailTime('created_at').notNull(),
  expiresAt: emailTime('expires_at').notNull(),
  phase: text('phase', { enum: ['CHALLENGE', 'AUTHORIZED', 'EXCHANGING', 'CONSUMED', 'INVALIDATED'] }).notNull(),
  reason: text('reason', { enum: ['unavailable', 'expired', 'cancelled'] }),
  authenticationChallenge: text('authentication_challenge'),
  authorizingKeyId: text('authorizing_key_id'),
  authorizingCredentialId: text('authorizing_credential_id'),
  authorizingPublicKey: text('authorizing_public_key'),
  oauthState: text('oauth_state'),
  nativeAccountId: text('native_account_id'),
  providerSubject: text('provider_subject'),
  outcome: text('outcome', { enum: ['linked', 'unlinked'] }),
}, table => [
  index('google_account_intent_retention_idx').on(table.userId, table.createdAt, table.id),
  check('google_account_intent_generation', sql`${table.recoveryGeneration} >= 0`),
  check('google_account_intent_locale', sql`${table.locale} in ('fr','en')`),
  check('google_account_intent_expiry', sql`${table.expiresAt} > ${table.createdAt} and ${table.expiresAt} <= ${table.createdAt} + interval '5 minutes'`),
  check('google_account_intent_target', sql`(${table.action} = 'LINK' and ${table.targetAccountId} is null and ${table.targetSubject} is null) or (${table.action} = 'UNLINK' and ${table.targetAccountId} is not null and ${table.targetSubject} is not null)`),
  check('google_account_intent_phase', sql`${table.phase} in ('CHALLENGE','AUTHORIZED','EXCHANGING','CONSUMED','INVALIDATED') and (${table.action} = 'LINK' or ${table.phase} not in ('AUTHORIZED','EXCHANGING'))`),
  check('google_account_intent_proof', sql`(
    ${table.phase} = 'CHALLENGE' and ${table.authenticationChallenge} is not null and ${table.authorizingKeyId} is null and ${table.authorizingCredentialId} is null and ${table.authorizingPublicKey} is null and ${table.oauthState} is null
  ) or (
    ${table.phase} in ('AUTHORIZED','EXCHANGING') and ${table.authenticationChallenge} is null and ${table.authorizingKeyId} is not null and ${table.authorizingCredentialId} is not null and ${table.authorizingPublicKey} is not null and ${table.oauthState} is not null
  ) or (
    ${table.phase} in ('CONSUMED','INVALIDATED') and ${table.authenticationChallenge} is null and ${table.authorizingKeyId} is null and ${table.authorizingCredentialId} is null and ${table.authorizingPublicKey} is null and ${table.oauthState} is null
  )`),
  check('google_account_intent_receipt', sql`(${table.phase} = 'CONSUMED' and ${table.nativeAccountId} is not null and ${table.providerSubject} is not null and ${table.outcome} is not null and ((${table.action} = 'LINK' and ${table.outcome} = 'linked') or (${table.action} = 'UNLINK' and ${table.outcome} = 'unlinked'))) or (${table.phase} <> 'CONSUMED' and ${table.nativeAccountId} is null and ${table.providerSubject} is null and ${table.outcome} is null)`),
  check('google_account_intent_reason', sql`(${table.phase} = 'INVALIDATED' and ${table.reason} is not null and ${table.reason} in ('unavailable','expired','cancelled')) or (${table.phase} <> 'INVALIDATED' and ${table.reason} is null)`),
  pgPolicy('google_account_intent_scope', { for: 'all', using: authScope, withCheck: authScope }),
]).enableRLS()

export const recoveryCodeBatch = pgTable('recovery_code_batch', {
  userId: text('user_id').primaryKey().references(() => user.id, { onDelete: 'cascade' }),
  batchId: uuid('batch_id').notNull().unique(),
  formatVersion: integer('format_version').notNull(),
  recoveryGeneration: integer('recovery_generation').notNull(),
  issuedAt: emailTime('issued_at').notNull(),
}, table => [
  unique('recovery_code_batch_owner_unique').on(table.userId, table.batchId),
  check('recovery_code_batch_format_v1', sql`${table.formatVersion} = 1`),
  check('recovery_code_batch_generation_nonnegative', sql`${table.recoveryGeneration} >= 0`),
  pgPolicy('recovery_code_batch_scope', { for: 'all', using: authScope, withCheck: authScope }),
]).enableRLS()

export const recoveryCode = pgTable('recovery_code', {
  id: uuid('id').primaryKey(),
  userId: text('user_id').notNull(),
  batchId: uuid('batch_id').notNull(),
  digest: text('digest').notNull().unique(),
  spentAt: emailTime('spent_at'),
}, table => [
  foreignKey({ columns: [table.userId, table.batchId], foreignColumns: [recoveryCodeBatch.userId, recoveryCodeBatch.batchId], name: 'recovery_code_current_batch_fk' })
    .onDelete('no action').onUpdate('no action'),
  check('recovery_code_digest_hex', sql`${table.digest} ~ '^[0-9a-f]{64}$'`),
  pgPolicy('recovery_code_scope', { for: 'all', using: authScope, withCheck: authScope }),
]).enableRLS()

export const recoveryAttempt = pgTable('recovery_attempt', {
  id: uuid('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  recoveryGeneration: integer('recovery_generation').notNull(),
  batchId: uuid('batch_id').notNull(),
  codeId: uuid('code_id').notNull(),
  googleAccountId: text('google_account_id').notNull(),
  issuer: text('issuer').notNull(),
  subject: text('subject').notNull(),
  oauthState: text('oauth_state').notNull().unique(),
  createdAt: emailTime('created_at').notNull(),
  expiresAt: emailTime('expires_at').notNull(),
  phase: text('phase', { enum: ['PENDING_GOOGLE', 'EXCHANGING', 'PROVED'] }).notNull(),
}, table => [
  index('recovery_attempt_cleanup_idx').on(table.userId, table.expiresAt, table.id),
  check('recovery_attempt_generation_nonnegative', sql`${table.recoveryGeneration} >= 0`),
  check('recovery_attempt_issuer_google', sql`${table.issuer} = 'https://accounts.google.com'`),
  check('recovery_attempt_subject_nonempty', sql`length(${table.subject}) > 0`),
  check('recovery_attempt_state_nonempty', sql`length(${table.oauthState}) > 0`),
  check('recovery_attempt_deadline', sql`${table.expiresAt} > ${table.createdAt} and ${table.expiresAt} <= ${table.createdAt} + interval '5 minutes'`),
  check('recovery_attempt_phase', sql`${table.phase} in ('PENDING_GOOGLE','EXCHANGING','PROVED')`),
  pgPolicy('recovery_attempt_scope', { for: 'all', using: authScope, withCheck: authScope }),
]).enableRLS()

export const recoveryCodeRotationFact = pgTable('recovery_code_rotation_fact', {
  id: uuid('id').primaryKey(),
  actorUserId: text('actor_user_id').notNull(),
  generation: integer('generation').notNull(),
  authorizingSessionId: text('authorizing_session_id').notNull(),
  authorizingPasskeyId: text('authorizing_passkey_id').notNull(),
  challengeId: uuid('challenge_id').notNull(),
  priorBatchId: uuid('prior_batch_id'),
  newBatchId: uuid('new_batch_id').notNull(),
  codeCount: integer('code_count').notNull(),
  occurredAt: emailTime('occurred_at').notNull(),
  correlationId: uuid('correlation_id').notNull(),
}, table => [
  check('recovery_code_rotation_fact_generation', sql`${table.generation} >= 0`),
  check('recovery_code_rotation_fact_eight', sql`${table.codeCount} = 8`),
  pgPolicy('recovery_code_rotation_fact_insert', { for: 'insert', withCheck: authScope }),
]).enableRLS()

export const authEmailRequest = pgTable('auth_email_request', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull(),
  purpose: text('purpose', { enum: ['magic-link'] }).notNull(),
  generation: integer('generation').notNull(),
  state: text('state', { enum: ['active', 'consumed', 'terminal'] }).notNull(),
  userId: text('user_id').references(() => user.id, { onDelete: 'restrict' }),
}, table => [
  unique('auth_email_request_email_purpose_unique').on(table.email, table.purpose),
  check('auth_email_request_generation_positive', sql`${table.generation} > 0`),
  check('auth_email_request_purpose', sql`${table.purpose} = 'magic-link'`),
  check('auth_email_request_normalized', sql`${table.email} = lower(btrim(${table.email}))`),
  check('auth_email_request_state', sql`${table.state} in ('active','consumed','terminal')`),
  pgPolicy('auth_email_request_scope', { for: 'all', using: authScope, withCheck: authScope }),
]).enableRLS()

export const authEmailCommand = pgTable('auth_email_command', {
  id: uuid('id').primaryKey(),
  requestId: uuid('request_id').notNull().references(() => authEmailRequest.id, { onDelete: 'restrict' }),
  generation: integer('generation').notNull(),
  purpose: text('purpose', { enum: ['magic-link'] }).notNull(),
  recipient: text('recipient').notNull(),
  locale: text('locale', { enum: ['fr', 'en'] }).notNull(),
  createdAt: emailTime('created_at').notNull().defaultNow(),
  expiresAt: emailTime('expires_at').notNull(),
  userId: text('user_id').references(() => user.id, { onDelete: 'restrict' }),
  recoveryGeneration: integer('recovery_generation'),
}, table => [
  unique('auth_email_command_request_generation_unique').on(table.requestId, table.generation),
  check('auth_email_command_generation_positive', sql`${table.generation} > 0`),
  check('auth_email_command_purpose', sql`${table.purpose} = 'magic-link'`),
  check('auth_email_command_locale', sql`${table.locale} in ('fr','en')`),
  check('auth_email_command_expiry', sql`${table.expiresAt} > ${table.createdAt} and ${table.expiresAt} <= ${table.createdAt} + interval '10 minutes'`),
  check('auth_email_command_user_binding', sql`(${table.userId} is null and ${table.recoveryGeneration} is null) or (${table.userId} is not null and ${table.recoveryGeneration} is not null and ${table.recoveryGeneration} >= 0)`),
  pgPolicy('auth_email_command_scope', { for: 'all', using: authScope, withCheck: authScope }),
]).enableRLS()

export const emailDelivery = pgTable('email_delivery', {
  id: uuid('id').primaryKey(),
  commandId: uuid('command_id').notNull().unique().references(() => authEmailCommand.id, { onDelete: 'restrict' }),
  state: text('state', { enum: ['active', 'consumed', 'terminal', 'superseded', 'expired'] }).notNull(),
  verifierHash: text('verifier_hash'),
  keyId: text('key_id').notNull(),
  ciphertext: text('ciphertext'),
  nonce: text('nonce'),
  tag: text('tag'),
  snapshotFormat: text('snapshot_format'),
  snapshotHash: text('snapshot_hash'),
  replayWindowSeconds: integer('replay_window_seconds'),
  providerState: text('provider_state', { enum: ['unattempted', 'attempting', 'effect_unknown', 'plunk_queued', 'held'] }).notNull().default('unattempted'),
  providerFence: integer('provider_fence').notNull().default(0),
  providerLeaseUntil: emailTime('provider_lease_until'),
  firstAttemptAt: emailTime('first_attempt_at'),
  replayNotAfter: emailTime('replay_not_after'),
  queuedEvidence: text('queued_evidence', { enum: ['response_200', 'duplicate_409'] }),
  plunkEmailId: uuid('plunk_email_id'),
}, table => [
  uniqueIndex('email_delivery_verifier_unique').on(table.verifierHash).where(sql`${table.verifierHash} IS NOT NULL`),
  check('email_delivery_verifier_canonical', sql`${table.verifierHash} IS NULL OR ${table.verifierHash} ~ '^[0-9a-f]{64}$'`),
  index('email_delivery_material_candidates_idx').on(table.commandId).where(sql`${table.ciphertext} IS NOT NULL OR ${table.verifierHash} IS NOT NULL`),
  check('email_delivery_snapshot', sql`(${table.snapshotFormat} is null and ${table.snapshotHash} is null and ${table.replayWindowSeconds} is null) or (${table.snapshotFormat} = 'auth-plunk-v1' and ${table.snapshotHash} ~ '^[0-9a-f]{64}$' and (${table.replayWindowSeconds} is null or ${table.replayWindowSeconds} between 1 and 600))`),
  check('email_delivery_provider_state', sql`${table.providerState} in ('unattempted','attempting','effect_unknown','plunk_queued','held') and ${table.providerFence} >= 0`),
  check('email_delivery_state', sql`${table.state} in ('active','consumed','terminal','superseded','expired')`),
  check('email_delivery_envelope', sql`(${table.ciphertext} is null and ${table.nonce} is null and ${table.tag} is null) or (${table.ciphertext} is not null and ${table.nonce} is not null and ${table.tag} is not null and ${table.nonce} ~ '^[0-9a-f]{24}$' and ${table.tag} ~ '^[0-9a-f]{32}$')`),
  pgPolicy('email_delivery_scope', { for: 'all', using: authScope, withCheck: authScope }),
]).enableRLS()

export const authEmailOutbox = pgTable('auth_email_outbox', {
  id: uuid('id').primaryKey(),
  deliveryId: uuid('delivery_id').notNull().unique().references(() => emailDelivery.id, { onDelete: 'restrict' }),
  admissionState: text('admission_state', { enum: ['pending', 'admitting', 'admitted', 'admission_unknown'] }).notNull().default('pending'),
  admissionFence: integer('admission_fence').notNull().default(0),
  admissionLeaseUntil: emailTime('admission_lease_until'),
  runId: uuid('run_id'),
}, table => [
  index('auth_email_outbox_admission_candidates_idx').on(table.id).where(sql`${table.admissionState} = 'pending' OR ${table.admissionState} = 'admitting'`),
  check('auth_email_outbox_admission', sql`${table.admissionState} in ('pending','admitting','admitted','admission_unknown') and ${table.admissionFence} >= 0`),
  pgPolicy('auth_email_outbox_scope', { for: 'all', using: authScope, withCheck: authScope }),
]).enableRLS()

export const authSchema = { user, session, account, verification, passkey, additionalPasskeyIntent, firstGooglePasskeyIntent, recoveryCodeBatch,
  recoveryCode, recoveryAttempt, recoveryCodeRotationFact, authEmailRequest, authEmailCommand, emailDelivery, authEmailOutbox }
