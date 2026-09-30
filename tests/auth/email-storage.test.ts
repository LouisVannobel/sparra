import { expect, test } from 'vitest'
import { normalizeAuthEmail, validateEmailAuthorization } from '../../src/modules/auth/auth-email-store.server'
import { authSchemaOptions } from '../../src/modules/auth/schema-options.server'

test('normalizes authorized recipient identity and caps every link at ten minutes', () => {
  expect(normalizeAuthEmail(' Fixture@Example.Test ')).toBe('fixture@example.test')
  expect(validateEmailAuthorization({ email: 'fixture@example.test', purpose: 'magic-link', locale: 'fr', expectedGeneration: 0, lifetimeSeconds: 600 }).lifetimeSeconds).toBe(600)
  for (const lifetimeSeconds of [0, -1, 601, 1.5]) {
    expect(() => validateEmailAuthorization({ email: 'fixture@example.test', purpose: 'magic-link', locale: 'fr', expectedGeneration: 0, lifetimeSeconds })).toThrow('Auth email request rejected')
  }
})

test('Better Auth automatic signup email is off and affected verification lifetime is capped', () => {
  expect(authSchemaOptions).toMatchObject({ emailVerification: { sendOnSignUp: false, expiresIn: 600 } })
})

test('rejects arbitrary purpose, malformed email, locale and incomplete user generation binding', () => {
  const valid = { email: 'fixture@example.test', purpose: 'magic-link', locale: 'en', expectedGeneration: 0, lifetimeSeconds: 600 }
  for (const changes of [{ email: '' }, { email: 'bad' }, { purpose: 'welcome' }, { locale: 'xx' }, { expectedGeneration: -1 }, { userId: 'user' }, { recoveryGeneration: 0 }]) {
    expect(() => validateEmailAuthorization({ ...valid, ...changes })).toThrow('Auth email request rejected')
  }
})
