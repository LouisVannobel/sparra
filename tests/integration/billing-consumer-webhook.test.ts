import { afterAll, afterEach, beforeAll, expect, test } from 'vitest'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import Stripe from 'stripe'
import { chromium, type Browser } from 'playwright'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { startWeb, bounded, unusedLoopbackPort } from '../helpers/web-process'
import { authRpcPath, rpcBody } from '../helpers/auth-rpc'

let stores: Awaited<ReturnType<typeof startDisposableStores>>, browser: Browser
const apps: ReturnType<typeof startWeb>[] = []
const stripe = { STRIPE_API_KEY: 'sk_test_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_fixture', STRIPE_ACCOUNT_ID: 'acct_fixture', STRIPE_ENVIRONMENT: 'sandbox' }
beforeAll(async () => {
  stores = await startDisposableStores(); await stores.migrate()
  await stores.administrator.query('GRANT USAGE ON SCHEMA public TO runtime; GRANT SELECT,INSERT,UPDATE,DELETE ON "user",account,session,verification TO runtime')
  browser = await chromium.launch({ headless: true })
})
afterEach(async () => {
  const failures: unknown[] = []
  for (const app of apps.splice(0)) {
    try {
      if (app.child.exitCode === null && app.child.signalCode === null) await app.shutdown()
      expect(await bounded(app.exit)).toBe(0); await app.cleanup()
    } catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, 'Billing HTTP application retirement failed')
})
afterAll(async () => {
  try { await browser?.close() } finally { await stores?.cleanup() }
  expect(stores.evidence.unrelatedUnchanged).toBe(true)
  expect(stores.evidence.inventoryDelta).toEqual([])
})

async function application(extra: Record<string, string | undefined> = {}, google = false) {
  const port = await unusedLoopbackPort(), origin = 'http://localhost:' + port
  const app = startWeb({ NODE_ENV: 'test', APP_ORIGIN: origin, PORT: String(port), DATABASE_URL: stores.runtimeUrl,
    REDIS_URL: stores.redisUrl, RATE_LIMIT_HMAC_SECRET: stores.hmac, RATE_LIMIT_KEY_ID: 'billing-http', TRUSTED_PROXY_IPS: '127.0.0.1',
    AUTH_SECRET: randomBytes(48).toString('hex'), GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fixture-only',
    REQUEST_TIMEOUT_MS: '3000', SHUTDOWN_TIMEOUT_MS: '1000', ...(google ? { FIXTURE_GOOGLE_PROTOCOL: 'yes' } : {}), ...extra })
  apps.push(app); await bounded(app.ready)
  return { app, origin }
}
type WebhookPayload = { id: string; object: string; api_version: string; created: number; livemode: boolean; type: string;
  data: { object: { id: string; object: string; customer: string; subscription?: string; payment_intent?: null } }; account?: string }
function payload(eventId: string, changes: Partial<WebhookPayload> = {}, customerId = 'cus_fixtureHttp'): WebhookPayload {
  return { id: eventId, object: 'event', api_version: '2026-09-30.endive', created: Math.floor(Date.now() / 1000), livemode: false,
    type: 'checkout.session.completed', data: { object: { id: 'cs_test_fixtureHttp', object: 'checkout.session', customer: customerId,
      subscription: 'sub_fixtureHttp', payment_intent: null } }, ...changes }
}
function signature(raw: string) { return Stripe.webhooks.generateTestHeaderString({ payload: raw, secret: 'whsec_fixture', timestamp: Math.floor(Date.now() / 1000) }) }
async function receiptCount(id: string) {
  return (await stores.administrator.query<{ n: number }>('SELECT count(*)::int AS n FROM billing_event_receipt WHERE event_id=$1', [id])).rows[0].n
}
async function post(origin: string, raw: string, signed = signature(raw)) {
  try { return { kind: 'response' as const, status: (await fetch(origin + '/webhooks/stripe', { method: 'POST',
    headers: { 'stripe-signature': signed, 'content-type': 'application/json' }, body: raw, redirect: 'manual' })).status } }
  catch (error) {
    const cause: unknown = error instanceof Error ? error.cause : undefined
    if (cause && typeof cause === 'object' && 'code' in cause && ['UND_ERR_SOCKET', 'ECONNRESET'].includes(String(cause.code))) return { kind: 'closed' as const }
    throw error
  }
}

test.each(['absent', 'partial'] as const)('native Google session and persisted call Inbox remain usable with %s Stripe configuration', async state => {
  const { app, origin } = await application(state === 'partial' ? { STRIPE_ACCOUNT_ID: 'acct_fixture' } : {}, true)
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-real-ip': '192.0.2.71' } }), page = await context.newPage()
  const subject = randomUUID()
  try {
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
    await page.route('https://accounts.google.com/o/oauth2/v2/auth*', async route => {
      const target = new URL(route.request().url()), code = await app.registerGoogle(target.href, subject, { email: subject + '@example.test' })
      await route.fulfill({ status: 302, headers: { location: origin + '/api/auth/callback/google?code=' + code + '&state=' + target.searchParams.get('state') } })
    })
    await page.goto(origin + '/login?lang=en')
    await page.getByRole('button', { name: 'Continue with Google', exact: true }).click()
    await page.waitForURL(origin + '/account?lang=en')
    const ensured = await context.request.post(origin + await authRpcPath('ensurePersonalWorkspace'), { headers: { origin,
      'content-type': 'application/json', 'x-tsr-serverFn': 'true' }, data: await rpcBody({}) })
    expect(ensured.status()).toBe(200)
    const row = (await stores.administrator.query('SELECT w.id FROM workspace w JOIN "user" u ON u.id=w.owner_user_id WHERE u.email=$1', [subject + '@example.test'])).rows[0]
    expect(row?.id).toEqual(expect.any(String))
    const callId = randomUUID()
    await stores.administrator.query("INSERT INTO sparra_call(id,workspace_id,deployment_id,provider_call_control_id,admitted_at,retention_until,status) VALUES($1,$2,'billing-http',$1::text,clock_timestamp(),clock_timestamp()+interval '30 days','pending')", [callId, row.id])
    expect((await page.goto(origin + '/app?lang=en'))?.status()).toBe(200)
    await page.getByRole('heading', { name: 'Call inbox', exact: true }).waitFor()
    expect((await page.goto(origin + '/app/demandes/' + callId + '?lang=en'))?.status()).toBe(200)
    expect((await stores.administrator.query('SELECT count(*)::int AS n FROM session s JOIN "user" u ON u.id=s.user_id WHERE u.email=$1 AND s.auth_method=\'google\'', [subject + '@example.test'])).rows[0].n).toBe(1)
    expect((await fetch(origin + '/health/ready')).status).toBe(200)
    expect(await post(origin, JSON.stringify(payload('evt_unavailable' + state)))).toEqual({ kind: 'response', status: 503 })
    expect(await receiptCount('evt_unavailable' + state)).toBe(0)
    expect((await app.googleEvidence()).posts).toBe(1)
  } finally { await context.close() }
})

test('signed duplicate and reordered native webhook events each retain one atomic receipt, command and outbox without granting paid access', async () => {
  const { origin } = await application(stripe), userId = randomUUID(), workspaceId = randomUUID(), operationId = randomUUID(), termsId = randomUUID()
  await stores.administrator.query('INSERT INTO "user"(id,name,email,email_verified) VALUES($1,\'Fixture\',$2,true)', [userId, userId + '@example.test'])
  await stores.administrator.query("INSERT INTO workspace(id,kind,lifecycle,owner_user_id) VALUES($1,'personal','active',$2)", [workspaceId, userId])
  await stores.administrator.query("INSERT INTO billing_customer(workspace_id,environment,account_id,stripe_customer_id) VALUES($1,'sandbox','acct_fixture','cus_fixtureHttp')", [workspaceId])
  await stores.administrator.query("INSERT INTO billing_agreed_terms(id,workspace_id,environment,account_id,revision,monthly_price_id,currency,monthly_unit_amount) VALUES($1,$2,'sandbox','acct_fixture',1,'price_fixtureHttp','eur',1500)", [termsId, workspaceId])
  const admittedRequest = { mode: 'subscription', ui_mode: 'hosted_page', customer: 'cus_fixtureHttp', client_reference_id: operationId,
    integration_identifier: 'template_ABCDEFGH', line_items: [{ price: 'price_fixtureHttp', quantity: 1 }], currency: 'eur',
    subscription_data: { billing_mode: { type: 'flexible' } }, success_url: origin + '/billing?session_id={CHECKOUT_SESSION_ID}',
    cancel_url: origin + '/billing?checkout=cancelled' }
  await stores.administrator.query("INSERT INTO billing_operation(id,workspace_id,kind,phase,environment,account_id,api_version,idempotency_key,request_hash,customer_id,agreed_terms_id,monthly_price_id,currency,monthly_unit_amount,integration_identifier,checkout_reference_version) VALUES($1,$2,'CHECKOUT_CREATE','UNKNOWN','sandbox','acct_fixture','2026-09-30.endive',$3,$4,'cus_fixtureHttp',$5,'price_fixtureHttp','eur',1500,'template_ABCDEFGH','operation-v2')",
    [operationId, workspaceId, 'checkout:' + operationId, createHash('sha256').update(JSON.stringify(admittedRequest)).digest('hex'), termsId])
  const completed = JSON.stringify(payload('evt_httpCompleted'))
  const earlier = JSON.stringify(payload('evt_httpSubscription', { type: 'customer.subscription.updated', created: Math.floor(Date.now() / 1000) + 1,
    data: { object: { id: 'sub_fixtureHttp', object: 'subscription', customer: 'cus_fixtureHttp' } } }))
  for (const raw of [earlier, completed, completed, earlier]) expect(await post(origin, raw)).toEqual({ kind: 'response', status: 204 })
  for (const id of ['evt_httpCompleted', 'evt_httpSubscription']) {
    expect(await receiptCount(id)).toBe(1)
    expect((await stores.administrator.query('SELECT count(*)::int AS n FROM billing_event_receipt r JOIN billing_command c ON c.receipt_id=r.id JOIN billing_outbox o ON o.command_id=c.id AND o.workspace_id=c.workspace_id WHERE r.event_id=$1', [id])).rows[0].n).toBe(1)
  }
  expect((await stores.administrator.query('SELECT count(*)::int AS n FROM billing_current_agreement WHERE workspace_id=$1', [workspaceId])).rows[0].n).toBe(0)
})

test.each(['signature', 'version', 'account', 'oversize'] as const)('native webhook rejects %s before any durable receipt', async mutation => {
  const { origin } = await application(stripe), id = 'evt_rejected' + mutation
  const raw = mutation === 'oversize' ? JSON.stringify({ ...payload(id), padding: 'x'.repeat(256 * 1024) })
    : JSON.stringify(payload(id, mutation === 'version' ? { api_version: '2020-08-27' } : mutation === 'account' ? { account: 'acct_foreign' } : {}))
  const result = await post(origin, raw, mutation === 'signature' ? 'invalid' : signature(raw))
  expect(result.kind === 'closed' || result.kind === 'response' && result.status === 503).toBe(true)
  expect(await receiptCount(id)).toBe(0)
  expect((await fetch(origin + '/health/ready')).status).toBe(200)
})

test('aborting a native request body closes its client transport and produces no receipt or paid right', async () => {
  const { origin } = await application(stripe), id = 'evt_bodyAborted', raw = JSON.stringify(payload(id))
  const call = httpRequest(origin + '/webhooks/stripe', { method: 'POST', headers: { 'stripe-signature': signature(raw),
    'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) + 100, expect: '100-continue' } })
  call.on('error', () => {})
  const closed = new Promise<void>(resolve => call.once('close', resolve))
  try {
    await bounded(new Promise<void>(resolve => { call.once('continue', resolve); call.flushHeaders() }))
    call.write(raw.slice(0, 20)); call.destroy()
    await bounded(closed)
    expect(call.closed).toBe(true)
    expect(await receiptCount(id)).toBe(0)
    expect((await fetch(origin + '/health/ready')).status).toBe(200)
  } finally { call.destroy(); await bounded(closed) }
})

test('native server shutdown joins an unfinished webhook body before normal process and store retirement', async () => {
  const { app, origin } = await application(stripe), id = 'evt_bodyDuringShutdown', raw = JSON.stringify(payload(id))
  const call = httpRequest(origin + '/webhooks/stripe', { method: 'POST', headers: { 'stripe-signature': signature(raw),
    'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) + 100, expect: '100-continue' } })
  call.on('error', () => {})
  const closed = new Promise<void>(resolve => call.once('close', resolve))
  try {
    await bounded(new Promise<void>(resolve => { call.once('continue', resolve); call.flushHeaders() }))
    call.write(raw.slice(0, 20))
    await app.shutdown()
    expect(await bounded(app.exit)).toBe(0)
    await bounded(closed)
    expect(call.closed).toBe(true)
    expect(await receiptCount(id)).toBe(0)
  } finally { call.destroy(); await bounded(closed) }
})
