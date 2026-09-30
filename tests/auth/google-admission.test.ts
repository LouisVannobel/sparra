import { inspect } from 'node:util'
import { expect, test } from 'vitest'
import { readAuthConfig } from '../../src/modules/auth/auth.server'

test('unconfigured Google is explicit; partial or malformed credentials fail without exposing secrets', () => {
  expect(readAuthConfig({})).toBeNull()
  expect(() => readAuthConfig({ APP_ORIGIN: 'http://localhost:3000', AUTH_SECRET: 'short-sensitive-marker' })).toThrow('Invalid configuration keys: AUTH_SECRET')
  expect(readAuthConfig({ APP_ORIGIN: 'http://localhost:3000', AUTH_SECRET: 'fixture-auth-secret-long-enough-for-config' })?.google).toBeNull()
  expect(() => readAuthConfig({ APP_ORIGIN: 'http://localhost:3000', AUTH_SECRET: 'fixture-auth-secret-long-enough-for-config', GOOGLE_CLIENT_SECRET: 'partial' })).toThrow('Invalid configuration keys: GOOGLE_CLIENT_ID')
  const config = readAuthConfig({ APP_ORIGIN: 'http://localhost:3000', AUTH_SECRET: 'fixture-auth-secret-long-enough-for-config', GOOGLE_CLIENT_ID: 'fixture-client-id-marker', GOOGLE_CLIENT_SECRET: 'fixture-client-secret-marker' })
  expect(inspect(config)).not.toMatch(/fixture-auth-secret|fixture-client-id-marker|fixture-client-secret-marker/)
})
