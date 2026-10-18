import { Effect } from 'effect'
import { afterEach, expect, test, vi } from 'vitest'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { createWebResources } from '../../src/platform/runtime.server'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'

type NativeObservation = { databaseStopped: boolean; databaseReleased: boolean; authClosed: boolean; limiterClosed: boolean; onDatabaseStop?: () => void }
const native = vi.hoisted((): NativeObservation => ({ databaseStopped: false, databaseReleased: false, authClosed: false, limiterClosed: false }))
vi.mock('../../src/platform/db/resources.server', () => ({ acquireDatabase: () => Effect.acquireRelease(
  Effect.sync(() => ({ transactions: createTransactions({ async connect() { throw new Error('No SQL in composition fixture') } },
    { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 }), stop: () => { native.onDatabaseStop?.(); native.databaseStopped = true }, isReady: () => !native.databaseStopped })),
  () => Effect.sync(() => { native.databaseReleased = true }),
) }))
vi.mock('../../src/modules/auth/rate-limit.server', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/modules/auth/rate-limit.server')>()
  return { ...actual, createAuthRateLimiter: () => ({ async connect() {}, async close() { native.limiterClosed = true }, isReady: () => !native.limiterClosed }) }
})
vi.mock('../../src/modules/auth/auth.server', () => ({ readAuthConfig: () => ({}), createApplicationAuth: () => ({
  async requirePrincipal() { return { userId: 'fixture-user', sessionId: 'fixture-session' } }, async close() { native.authClosed = true },
}) }))

const owners: ReturnType<typeof createWebResources>[] = []
const env = { NODE_ENV: 'test', APP_ORIGIN: 'https://sparra.example', DATABASE_URL: 'postgres://fixture:synthetic@127.0.0.1/fixture',
  REDIS_URL: 'redis://:synthetic@127.0.0.1', RATE_LIMIT_HMAC_SECRET: 'synthetic-secret-at-least-thirty-two-characters',
  RATE_LIMIT_KEY_ID: 'fixture', TRUSTED_PROXY_IPS: '127.0.0.1' }

afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.dispose()
  native.databaseStopped = false; native.databaseReleased = false; native.authClosed = false; native.limiterClosed = false
  native.onDatabaseStop = undefined
  vi.restoreAllMocks()
})

test.each([
  {},
  { STRIPE_ACCOUNT_ID: 'acct_fixture' },
  { STRIPE_API_KEY: 'sk_test_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_fixture', STRIPE_ACCOUNT_ID: 'acct_fixture', STRIPE_ENVIRONMENT: 'live' },
])('absent or rejected Stripe configuration leaves Web ready and only billing unavailable (%j)', async stripe => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('No provider I/O in startup fixture') })
  const owner = createWebResources({ ...env, ...stripe }); owners.push(owner)
  const resources = await owner.ready()
  expect(resources.isReady()).toBe(true)
  expect(resources.auth).not.toBeNull()
  expect(resources.workspaces).toBeDefined()
  expect(resources.audioReader).toBeDefined()
  expect(resources.billing).toBeDefined()
  const request = new Request('https://sparra.example/webhooks/stripe', { method: 'POST' })
  Object.defineProperty(request, 'appAuthDeadlineAtMs', { value: Date.now() + 10000 })
  expect((await resources.billing?.receiveBillingWebhook(request))?.status).toBe(503)
  expect(fetch).not.toHaveBeenCalled()
  await owner.dispose()
  expect(native.databaseReleased && native.authClosed && native.limiterClosed).toBe(true)
})

test('complete Stripe configuration composes billing without a startup account or catalog request', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('No provider I/O in startup fixture') })
  const owner = createWebResources({ ...env, STRIPE_API_KEY: 'sk_test_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_fixture',
    STRIPE_ACCOUNT_ID: 'acct_fixture', STRIPE_ENVIRONMENT: 'sandbox' }); owners.push(owner)
  const resources = await owner.ready()
  expect(resources.isReady()).toBe(true)
  expect(resources.billing).toBeDefined()
  expect(fetch).not.toHaveBeenCalled()
})

test('Web disposal observes native webhook request and socket closure before stopping the dependent database owner', async () => {
  const owner = createWebResources({ ...env, STRIPE_API_KEY: 'sk_test_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_fixture',
    STRIPE_ACCOUNT_ID: 'acct_fixture', STRIPE_ENVIRONMENT: 'sandbox' }); owners.push(owner)
  const resources = await owner.ready(), socket = new Socket(), incoming = new IncomingMessage(socket)
  incoming.method = 'POST'
  const outgoing = new ServerResponse(incoming); outgoing.assignSocket(socket)
  const request = new Request('https://sparra.example/webhooks/stripe', { method: 'POST', headers: { 'stripe-signature': 'fixture-pending-body' } })
  Object.assign(request, { runtime: { name: 'node', node: { req: incoming, res: outgoing } } })
  Object.defineProperty(request, 'appAuthDeadlineAtMs', { value: Date.now() + 10000 })
  let closedBeforeDatabaseStop = false
  native.onDatabaseStop = () => { closedBeforeDatabaseStop = incoming.closed && socket.closed }
  const pending = resources.billing!.receiveBillingWebhook(request)
  try {
    await expect.poll(() => incoming.listenerCount('readable') > 0).toBe(true)
    await owner.dispose()
    expect(closedBeforeDatabaseStop).toBe(true)
    expect(native.databaseReleased).toBe(true)
    expect((await pending).status).toBe(503)
  } finally { incoming.destroy(); socket.destroy(); await pending }
})
