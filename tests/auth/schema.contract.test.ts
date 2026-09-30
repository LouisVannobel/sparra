import { getAuthTables, getSchema, parseSessionOutput, parseUserOutput } from 'better-auth/db'
import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core'
import { expect, test, vi } from 'vitest'
import { SQL } from 'drizzle-orm'
import { authSchemaOptions } from '../../src/modules/auth/schema-options.server'
import { account, authSchema, session, user, verification, passkey, additionalPasskeyIntent, firstGooglePasskeyIntent,
  recoveryCodeBatch, recoveryCode, recoveryAttempt, recoveryCodeRotationFact, authEmailRequest, authEmailCommand, emailDelivery, authEmailOutbox } from '../../src/modules/auth/schema.server'

function requiredColumn(config: ReturnType<typeof getTableConfig>, name: string) {
  const column = config.columns.find(candidate => candidate.name === name)
  if (!column) throw new Error(`Missing Drizzle column: ${name}`)
  return column
}

function checkQueries(config: ReturnType<typeof getTableConfig>) {
  const dialect = new PgDialect()
  return Object.fromEntries(config.checks.map(candidate => [candidate.name, dialect.sqlToQuery(candidate.value).sql]))
}

function indexColumnNames(indexConfig: ReturnType<typeof getTableConfig>['indexes'][number]['config']) {
  return indexConfig.columns.map(column => {
    if (!('name' in column) || typeof column.name !== 'string') throw new Error('Expected a concrete indexed column')
    return column.name
  })
}

test('supplies the exact private field contract to Better Auth without permissive session defaults', () => {
  const tables = getAuthTables(authSchemaOptions)

  expect(tables.user.fields.recovering).toEqual({
    type: 'boolean', required: true, defaultValue: false, input: false, returned: false,
  })
  expect(tables.user.fields.recoveryGeneration).toEqual({
    type: 'number', required: true, defaultValue: 0, input: false, returned: false,
  })
  expect(tables.user.fields.holdUntil).toEqual({
    type: 'date', required: false, input: false, returned: false,
  })
  expect(tables.session.fields.authState).toEqual({
    type: ['ACTIVE', 'MFA_PENDING', 'RECOVERY_RESTRICTED'], required: true, input: false, returned: false,
  })
  expect(tables.session.fields.authMethod).toEqual({
    type: ['google', 'magic-link', 'passkey', 'totp', 'recovery'], required: true, input: false, returned: false,
  })
  expect(tables.session.fields.authenticatedAt).toEqual({
    type: 'date', required: true, input: false, returned: false,
  })
  expect(tables.session.fields.providerIdentity).toEqual({
    type: 'json', required: false, input: false, returned: false,
  })
  expect(tables.session.fields.recoveryGeneration).toEqual({
    type: 'number', required: true, input: false, returned: false,
  })
  expect(tables.session.fields.lastActivityAt).toEqual({
    type: 'date', required: true, input: false, returned: false,
  })

  for (const field of ['authState', 'authMethod', 'authenticatedAt', 'providerIdentity', 'recoveryGeneration', 'lastActivityAt']) {
    expect(tables.session.fields[field]?.defaultValue, `session.${field}`).toBeUndefined()
  }
})

test('retains the complete Better Auth 1.7.4 base models and native index metadata', () => {
  const tables = getAuthTables(authSchemaOptions)
  const resolvedSchema = getSchema(authSchemaOptions)

  expect(Object.keys(tables.user.fields).sort()).toEqual([
    'createdAt', 'email', 'emailVerified', 'holdUntil', 'image', 'name', 'recovering', 'recoveryGeneration', 'updatedAt',
  ])
  expect(Object.keys(tables.session.fields).sort()).toEqual([
    'authMethod', 'authState', 'authenticatedAt', 'createdAt', 'expiresAt', 'ipAddress', 'lastActivityAt',
    'providerIdentity', 'recoveryGeneration', 'token', 'updatedAt', 'userAgent', 'userId',
  ])
  expect(Object.keys(tables.account.fields).sort()).toEqual([
    'accessToken', 'accessTokenExpiresAt', 'accountId', 'createdAt', 'idToken', 'password', 'providerId',
    'refreshToken', 'refreshTokenExpiresAt', 'scope', 'updatedAt', 'userId',
  ])
  expect(Object.keys(tables.verification.fields).sort()).toEqual([
    'createdAt', 'expiresAt', 'identifier', 'updatedAt', 'value',
  ])
  expect(tables.user.fields.email).toMatchObject({ required: true, unique: true })
  expect(tables.user.fields.emailVerified).toMatchObject({ required: true, defaultValue: false, input: false })
  expect(tables.session.fields.token).toMatchObject({ required: true, unique: true })
  expect(tables.session.fields.userId).toMatchObject({
    required: true, index: true, references: { model: 'user', field: 'id', onDelete: 'cascade' },
  })
  expect(tables.account.fields.issuer).toBeUndefined()
  expect(tables.account.fields.providerId).toMatchObject({ required: true, type: 'string' })
  expect(tables.account.fields.accountId).toMatchObject({ required: true, type: 'string' })
  expect(tables.account.fields.userId).toMatchObject({
    required: true, index: true, references: { model: 'user', field: 'id', onDelete: 'cascade' },
  })
  expect(tables.verification.fields.identifier).toMatchObject({ required: true, index: true })
  expect(resolvedSchema.account.indexes).toEqual([])
})

test('uses the real Better Auth output parsers to remove every private additional field', () => {
  const createdAt = new Date('2026-09-10T01:02:03.004Z')
  const updatedAt = new Date('2026-09-10T02:03:04.005Z')
  const expiresAt = new Date('2026-09-11T01:02:03.004Z')
  const userFixture = {
    id: 'user_fixture',
    name: 'Storage Fixture',
    email: 'fixture@example.test',
    emailVerified: true,
    image: 'https://example.test/avatar.png',
    createdAt,
    updatedAt,
    recovering: true,
    recoveryGeneration: 41,
    holdUntil: new Date('2026-09-12T01:02:03.004Z'),
  }
  const sessionFixture = {
    id: 'session_fixture',
    userId: 'user_fixture',
    token: 'fixture-token-not-an-accepted-session',
    expiresAt,
    createdAt,
    updatedAt,
    ipAddress: '192.0.2.10',
    userAgent: 'complete-fixture',
    authState: 'RECOVERY_RESTRICTED',
    authMethod: 'recovery',
    authenticatedAt: new Date('2026-09-10T00:02:03.004Z'),
    providerIdentity: { issuer: 'fixture-issuer', subject: 'fixture-subject' },
    recoveryGeneration: 41,
    lastActivityAt: new Date('2026-09-10T02:02:03.004Z'),
  }

  expect(parseUserOutput(authSchemaOptions, userFixture)).toEqual({
    id: 'user_fixture',
    name: 'Storage Fixture',
    email: 'fixture@example.test',
    emailVerified: true,
    image: 'https://example.test/avatar.png',
    createdAt,
    updatedAt,
  })
  expect(parseSessionOutput(authSchemaOptions, sessionFixture)).toEqual({
    id: 'session_fixture',
    userId: 'user_fixture',
    token: 'fixture-token-not-an-accepted-session',
    expiresAt,
    createdAt,
    updatedAt,
    ipAddress: '192.0.2.10',
    userAgent: 'complete-fixture',
  })
})

test('exports Better Auth and concrete auth-owned tables with required keys and PostgreSQL column names', () => {
  expect(authSchema).toEqual({ user, session, account, verification, passkey, additionalPasskeyIntent, firstGooglePasskeyIntent,
    recoveryCodeBatch, recoveryCode, recoveryAttempt, recoveryCodeRotationFact, authEmailRequest, authEmailCommand, emailDelivery, authEmailOutbox })

  const userConfig = getTableConfig(user)
  const sessionConfig = getTableConfig(session)
  const accountConfig = getTableConfig(account)
  const verificationConfig = getTableConfig(verification)
  expect([userConfig.name, sessionConfig.name, accountConfig.name, verificationConfig.name]).toEqual([
    'user', 'session', 'account', 'verification',
  ])

  expect(user.id.name).toBe('id')
  expect(user.emailVerified.name).toBe('email_verified')
  expect(user.recoveryGeneration.name).toBe('recovery_generation')
  expect(user.holdUntil.name).toBe('hold_until')
  expect(session.userId.name).toBe('user_id')
  expect(session.authState.name).toBe('auth_state')
  expect(session.authMethod.name).toBe('auth_method')
  expect(session.authenticatedAt.name).toBe('authenticated_at')
  expect(session.providerIdentity.name).toBe('provider_identity')
  expect(session.recoveryGeneration.name).toBe('recovery_generation')
  expect(session.lastActivityAt.name).toBe('last_activity_at')
  expect(account.accountId.name).toBe('account_id')
  expect(account.providerId.name).toBe('provider_id')
  expect(verification.expiresAt.name).toBe('expires_at')

  for (const [config, id] of [[userConfig, user.id], [sessionConfig, session.id], [accountConfig, account.id], [verificationConfig, verification.id]] as const) {
    expect(requiredColumn(config, 'id')).toBe(id)
    expect(id.primary).toBe(true)
    expect(id.notNull).toBe(true)
  }
})

test('maps every date as millisecond timestamptz with Date values and real timestamp defaults', () => {
  const timestampColumns = [
    user.createdAt, user.updatedAt, user.holdUntil,
    session.expiresAt, session.createdAt, session.updatedAt, session.authenticatedAt, session.lastActivityAt,
    account.accessTokenExpiresAt, account.refreshTokenExpiresAt, account.createdAt, account.updatedAt,
    verification.expiresAt, verification.createdAt, verification.updatedAt,
  ]
  for (const column of timestampColumns) {
    expect(column.dataType, column.name).toBe('date')
    expect(column.getSQLType(), column.name).toBe('timestamp (3) with time zone')
  }

  for (const column of [user.createdAt, user.updatedAt, session.createdAt, session.updatedAt, account.createdAt, account.updatedAt, verification.createdAt, verification.updatedAt]) {
    expect(column.hasDefault, column.name).toBe(true)
    expect(column.default).toBeInstanceOf(SQL)
    if (!(column.default instanceof SQL)) throw new Error('Expected SQL timestamp default')
    expect(new PgDialect().sqlToQuery(column.default).sql).toBe('now()')
  }
  for (const column of [user.updatedAt, session.updatedAt, account.updatedAt, verification.updatedAt]) {
    expect(column.onUpdateFn, column.name).toBeTypeOf('function')
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-09-10T00:00:00Z'))
      expect(column.onUpdateFn?.()).toEqual(new Date('2026-09-10T00:00:00Z'))
      vi.setSystemTime(new Date('2026-09-10T01:00:00Z'))
      expect(column.onUpdateFn?.()).toEqual(new Date('2026-09-10T01:00:00Z'))
    } finally { vi.useRealTimers() }
  }
})

test('encodes requiredness, safe defaults and nonnegative and enum constraints in Drizzle metadata', () => {
  const userConfig = getTableConfig(user)
  const sessionConfig = getTableConfig(session)

  expect(requiredColumn(userConfig, 'recovering')).toMatchObject({ notNull: true, hasDefault: true, default: false })
  expect(requiredColumn(userConfig, 'recovery_generation')).toMatchObject({ notNull: true, hasDefault: true, default: 0 })
  expect(requiredColumn(userConfig, 'hold_until')).toMatchObject({ notNull: false, hasDefault: false })
  expect(checkQueries(userConfig)).toEqual({
    user_recovery_generation_nonnegative: '"user"."recovery_generation" >= 0',
  })

  for (const name of ['auth_state', 'auth_method', 'authenticated_at', 'recovery_generation', 'last_activity_at']) {
    expect(requiredColumn(sessionConfig, name), name).toMatchObject({ notNull: true, hasDefault: false })
  }
  expect(requiredColumn(sessionConfig, 'provider_identity')).toMatchObject({ notNull: false, hasDefault: false })
  expect(requiredColumn(sessionConfig, 'provider_identity').getSQLType()).toBe('jsonb')
  expect(checkQueries(sessionConfig)).toEqual({
    session_auth_state_allowed: '"session"."auth_state" in (\'ACTIVE\', \'MFA_PENDING\', \'RECOVERY_RESTRICTED\')',
    session_auth_method_allowed: '"session"."auth_method" in (\'google\', \'magic-link\', \'passkey\', \'totp\', \'recovery\')',
    session_recovery_generation_nonnegative: '"session"."recovery_generation" >= 0',
  })
})

test('declares the required foreign keys, indexes, composite identity and disabled password storage', () => {
  const sessionConfig = getTableConfig(session)
  const accountConfig = getTableConfig(account)
  const verificationConfig = getTableConfig(verification)

  expect(sessionConfig.indexes).toHaveLength(1)
  expect(sessionConfig.indexes[0].config).toMatchObject({ name: 'session_user_id_idx', unique: false })
  expect(indexColumnNames(sessionConfig.indexes[0].config)).toEqual(['user_id'])
  expect(accountConfig.indexes).toHaveLength(1)
  expect(accountConfig.indexes[0].config).toMatchObject({ name: 'account_user_id_idx', unique: false })
  expect(indexColumnNames(accountConfig.indexes[0].config)).toEqual(['user_id'])
  expect(verificationConfig.indexes).toHaveLength(1)
  expect(verificationConfig.indexes[0].config).toMatchObject({ name: 'verification_identifier_idx', unique: false })
  expect(indexColumnNames(verificationConfig.indexes[0].config)).toEqual(['identifier'])

  for (const config of [sessionConfig, accountConfig]) {
    expect(config.foreignKeys).toHaveLength(1)
    const reference = config.foreignKeys[0].reference()
    expect(reference.foreignTable).toBe(user)
    expect(reference.columns.map(column => column.name)).toEqual(['user_id'])
    expect(reference.foreignColumns.map(column => column.name)).toEqual(['id'])
    expect(config.foreignKeys[0].onDelete).toBe('cascade')
  }

  expect(accountConfig.columns.some(column => column.name === 'issuer')).toBe(false)
  expect(accountConfig.uniqueConstraints.map(candidate => ({
    name: candidate.getName(),
    columns: candidate.columns.map(column => column.name),
  }))).toEqual([{ name: 'account_provider_account_id_unique', columns: ['provider_id', 'account_id'] }])
  expect(requiredColumn(accountConfig, 'password')).toMatchObject({ notNull: false, hasDefault: false })
  expect(checkQueries(accountConfig)).toEqual({
    account_password_disabled: '"account"."password" is null',
    account_provider_google: '"account"."provider_id" = \'google\'',
  })
})

test('base required columns and unique email/token remain enforced independently of Better Auth metadata', () => {
  for (const column of [user.name, user.email, user.emailVerified, user.createdAt, user.updatedAt, session.token, session.userId, session.expiresAt, session.createdAt, session.updatedAt, account.accountId, account.providerId, account.userId, account.createdAt, account.updatedAt, verification.identifier, verification.value, verification.expiresAt, verification.createdAt, verification.updatedAt]) expect(column.notNull).toBe(true)
  expect(user.email.isUnique).toBe(true)
  expect(session.token.isUnique).toBe(true)
})

test('auth mail identity is UUID-based with RLS and unique command/delivery/outbox, without tenant or required User', () => {
  for (const table of [authEmailRequest, authEmailCommand, emailDelivery, authEmailOutbox]) {
    const config = getTableConfig(table)
    expect(config.enableRLS).toBe(true)
    expect(config.columns.some(column => column.name === 'tenant_id')).toBe(false)
    expect(table.id.getSQLType()).toBe('uuid')
    expect(config.policies).toHaveLength(1)
  }
  expect(authEmailRequest.userId.notNull).toBe(false)
  expect(authEmailCommand.userId.notNull).toBe(false)
  expect(getTableConfig(authEmailCommand).uniqueConstraints[0].columns.map(column => column.name)).toEqual(['request_id', 'generation'])
  expect(emailDelivery.commandId.isUnique).toBe(true)
  expect(authEmailOutbox.deliveryId.isUnique).toBe(true)
  expect(Object.keys(authEmailOutbox).filter(key => ['recipient', 'token', 'ciphertext'].includes(key))).toEqual([])
})
