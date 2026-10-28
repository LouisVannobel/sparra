import { Pool } from 'pg'
import { expect, test, vi } from 'vitest'
import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { addOAuthServerContext, createAuthEndpoint } from 'better-auth/api'
import { generateState, type OAuthProvider } from 'better-auth/oauth2'
import { googleAdmission } from '../../src/modules/auth/admission.server'
import { firstGooglePurpose } from '../../src/modules/auth/first-google-passkey.server'
import { googleAccountPurpose } from '../../src/modules/auth/google-account.server'
import { recoveryGooglePurpose } from '../../src/modules/auth/recovery.server'
import { createTransactions } from '../../src/platform/db/transactions.server'

test('ordinary Google exchange refuses the three foreign native purposes before delegating', async () => {
  const pool = new Pool({ connectionString: 'postgresql://fixture:fixture@127.0.0.1:1/fixture' })
  const owner = createTransactions(pool, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
  const tokens = { accessToken: 'fixture-access-token' }
  const input = { code: 'fixture-code', redirectURI: 'http://localhost:3000/api/auth/callback/google' }
  try {
    for (const purpose of [firstGooglePurpose, googleAccountPurpose, recoveryGooglePurpose, undefined]) {
      const exchange = vi.fn(async (_input: Parameters<OAuthProvider['validateAuthorizationCode']>[0]) => tokens)
      const admission = googleAdmission(owner, provider => ({ ...provider, validateAuthorizationCode: exchange }))
      const auth = betterAuth({
        baseURL: 'http://localhost:3000', secret: 'fixture-auth-secret-long-enough-for-config', database: memoryAdapter({}),
        socialProviders: { google: { clientId: 'fixture.apps.googleusercontent.com', clientSecret: 'fixture-only' } },
        plugins: [{ id: 'purpose-consumer-fixture', endpoints: { checkPurpose: createAuthEndpoint('/fixture/purpose', { method: 'POST' }, async ctx => {
          if (purpose !== undefined) await addOAuthServerContext({ purpose })
          await generateState(ctx)
          const callback = { ...ctx, path: '/callback/:id', params: { id: 'google' }, request: undefined, returnHeaders: false as const }
          const result = await admission.hooks.before[0].handler(callback)
          const provider = result.context.context.socialProviders.find(candidate => candidate.id === 'google')!
          if (purpose === undefined) expect(await provider.validateAuthorizationCode(input)).toBe(tokens)
          else await expect(provider.validateAuthorizationCode(input)).rejects.toMatchObject({ status: 'UNAUTHORIZED' })
          return { checked: true }
        }) } }],
      })
      expect(await auth.api.checkPurpose()).toEqual({ checked: true })
      if (purpose === undefined) expect(exchange).toHaveBeenCalledExactlyOnceWith(input)
      else expect(exchange).not.toHaveBeenCalled()
    }
    expect(pool.totalCount).toBe(0)
  } finally { await pool.end() }
})
