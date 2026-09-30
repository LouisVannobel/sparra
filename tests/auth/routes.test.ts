import { betterAuth } from 'better-auth'
import { createAuthEndpoint } from 'better-auth/api'
import { passkey } from '@better-auth/passkey'
import { expect, test } from 'vitest'
import { assertEndpointClassification, isPublicAuthRequest } from '../../src/modules/auth/http-boundary.server'

test('only canonical GET Google callback can reach the auth handler', () => {
  expect(isPublicAuthRequest(new Request('http://localhost:3000/api/auth/callback/google?code=a&state=b'), 'http://localhost:3000')).toBe(true)
  for (const path of ['/api/auth/organization', '/api/auth/organization/foo', '/api/auth/%6frganization', '/api/auth/%252forganization', '/api/auth//callback/google', '/api/auth/callback/google/', '/api/auth/callback%2fgoogle', '/api/auth/callback%5cgoogle', '/api/auth/get-session', '/api/auth/sign-in/social', '/api/auth/link-social', '/api/auth/revoke-sessions', '/api/auth/callback/google%00']) {
    for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) expect(isPublicAuthRequest(new Request('http://localhost:3000' + path, { method }), 'http://localhost:3000')).toBe(false)
  }
  expect(isPublicAuthRequest(new Request('http://localhost:3000/api/auth/callback/google', { method: 'POST' }), 'http://localhost:3000')).toBe(false)
  expect(isPublicAuthRequest(new Request('https://other.example/api/auth/callback/google'), 'http://localhost:3000')).toBe(false)
  for (const path of ['/api/auth/organization/../callback/google', '/api/auth/./callback/google', '/api/auth/%2e/callback/google', '/api/auth/%252e/callback/google', '/api/auth/organization/%2e%2e/callback/google', '/api/auth/\\callback/google', '/api/auth/callback/google\t']) {
    expect(isPublicAuthRequest({ url: 'http://localhost:3000' + path, method: 'GET' }, 'http://localhost:3000')).toBe(false)
  }
})
test('all real BA 1.7.1 endpoint metadata is classified; additions or changed methods fail closed', () => {
  const auth = betterAuth({ baseURL: 'http://localhost:3000', secret: 'fixture-secret-at-least-thirty-two-characters', logger: { disabled: true } })
  expect(() => assertEndpointClassification(auth.api)).not.toThrow()
  expect(() => assertEndpointClassification({ ...auth.api, unexpected: { path: '/unexpected', options: { method: 'GET' } } })).toThrow()
  expect(() => assertEndpointClassification({ ...auth.api, callbackOAuth: { path: '/callback/:id', options: { method: ['GET', 'POST', 'DELETE'] } } })).toThrow()
})
test('magic classification requires explicit native server-only POST metadata', () => {
  const endpoint = createAuthEndpoint('/application/magic/consume', { method: 'POST', metadata: { SERVER_ONLY: true } }, async () => ({ fixture: true }))
  const auth = betterAuth({ baseURL: 'https://app.example.test', secret: 'fixture-secret-at-least-thirty-two-characters', logger: { disabled: true },
    plugins: [{ id: 'metadata-fixture', endpoints: { consumeApplicationMagic: endpoint } }] })
  expect(() => assertEndpointClassification(auth.api, true)).not.toThrow()
  expect(() => assertEndpointClassification({ ...auth.api, consumeApplicationMagic: { ...endpoint, options: { method: 'POST' } } }, true)).toThrow('Unclassified auth endpoint')
  expect(isPublicAuthRequest(new Request('https://app.example.test/api/auth/application/magic/consume', { method: 'POST' }), 'https://app.example.test')).toBe(false)
})
test('native passkey metadata is classified but no passkey HTTP endpoint is public', () => {
  const auth = betterAuth({ baseURL: 'https://app.example.test', secret: 'fixture-secret-at-least-thirty-two-characters', logger: { disabled: true }, plugins: [passkey()] })
  expect(() => assertEndpointClassification(auth.api, false, true)).not.toThrow()
  expect(() => assertEndpointClassification(auth.api)).toThrow()
  for (const path of ['/passkey/generate-register-options', '/passkey/verify-registration', '/passkey/generate-authenticate-options',
    '/passkey/verify-authentication', '/passkey/list-user-passkeys', '/passkey/delete-passkey', '/passkey/update-passkey']) {
    for (const method of ['GET', 'POST']) expect(isPublicAuthRequest(new Request('https://app.example.test/api/auth' + path, { method }), 'https://app.example.test')).toBe(false)
  }
})
