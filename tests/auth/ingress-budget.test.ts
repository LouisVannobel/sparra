import { inspect } from 'node:util'
import { afterEach, expect, test, vi } from 'vitest'
import { createApplicationAuth, readAuthConfig } from '../../src/modules/auth/auth.server'
import { createAuthRateLimiter, readRateLimitConfig } from '../../src/modules/auth/rate-limit.server'
import { createTransactions, type AuthTxOptions } from '../../src/platform/db/transactions.server'

const origin = 'http://localhost:3000'
const activeLimiters: Array<ReturnType<typeof createAuthRateLimiter>> = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(activeLimiters.splice(0).map(limiter => limiter.close()))
})

type Observation = Readonly<{
  options: AuthTxOptions
  remainingMs: number
}>

function signInResult() {
  return {
    url: 'https://accounts.google.com/o/oauth2/v2/auth?fixture=1',
    headers: new Headers(),
  }
}

function authHarness(responder: (observation: Observation, index: number) => unknown | Promise<unknown> = signInResult) {
  let checkouts = 0
  const owner = createTransactions({
    async connect() {
      checkouts++
      throw new Error('The focused carrier fixture must not acquire PostgreSQL')
    },
  }, { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 })
  const observations: Observation[] = []
  const runAuthInvocation = owner.runAuthInvocation
  async function observedInvocation<A>(options: AuthTxOptions, _call: () => Promise<A>): Promise<A> {
    return runAuthInvocation(options, async () => {
      const inherited = owner.invocationOptions()
      const observation = { options: inherited, remainingMs: inherited.deadlineAtMs - Date.now() }
      observations.push(observation)
      return (await responder(observation, observations.length - 1)) as A
    })
  }
  const invocation = vi.spyOn(owner, 'runAuthInvocation').mockImplementation(observedInvocation)
  const limiter = createAuthRateLimiter(readRateLimitConfig({
    REDIS_URL: 'redis://:fixture@127.0.0.1:1',
    RATE_LIMIT_HMAC_SECRET: 'fixture-secret-at-least-thirty-two-characters',
    RATE_LIMIT_KEY_ID: 'ingress-budget',
    TRUSTED_PROXY_IPS: '127.0.0.1',
    NODE_ENV: 'test',
  }))
  activeLimiters.push(limiter)
  const consume = vi.spyOn(limiter, 'consumeAuthAttempt').mockResolvedValue(undefined)
  const auth = createApplicationAuth(owner, readAuthConfig({
    APP_ORIGIN: origin,
    NODE_ENV: 'test',
    AUTH_SECRET: 'fixture-auth-secret-at-least-thirty-two-characters',
    GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'fixture-only',
  })!, limiter)
  return { auth, consume, invocation, observations, checkouts: () => checkouts }
}

function ingressRequest(
  deadlineAtMs: number,
  descriptor: PropertyDescriptor | null = { value: deadlineAtMs },
  signal?: AbortSignal,
  extraHeaders: HeadersInit = {},
) {
  const request = Object.assign(new Request(origin + '/_serverFn/fixture', {
    method: 'POST', signal,
    headers: { origin, 'x-real-ip': '192.0.2.1', ...Object.fromEntries(new Headers(extraHeaders)) },
  }), { runtime: { node: { req: { socket: { remoteAddress: '127.0.0.1' } } } } })
  if (descriptor) Object.defineProperty(request, 'appAuthDeadlineAtMs', descriptor)
  return request
}

test('begin Google sign-in keeps the ingress deadline after limiter delay', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
  const fixture = authHarness()
  fixture.consume.mockImplementation(async () => { clock.mockReturnValue(2500) })
  const request = ingressRequest(7000)

  const result = await fixture.auth.beginGoogleSignIn(request)

  expect(result.url).toContain('accounts.google.com')
  expect(fixture.observations).toHaveLength(1)
  expect(fixture.observations[0]).toMatchObject({ remainingMs: 4500 })
  expect(fixture.observations[0].options.deadlineAtMs).toBe(7000)
  expect(fixture.observations[0].options.signal).toBe(request.signal)
  expect(fixture.checkouts()).toBe(0)
})

test('expiry during the limiter wait admits no auth invocation or database checkout', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
  const fixture = authHarness()
  fixture.consume.mockImplementation(async () => { clock.mockReturnValue(1101) })
  const request = ingressRequest(1100)

  const error = await fixture.auth.beginGoogleSignIn(request).catch(error => error)

  expect(error).toMatchObject({ name: 'Error', message: 'Application auth deadline unavailable' })
  expect(request.signal.aborted).toBe(false)
  expect(fixture.invocation).not.toHaveBeenCalled()
  expect(fixture.observations).toEqual([])
  expect(fixture.checkouts()).toBe(0)
})

test('logout reuses one deadline for principal read and successful sign-out', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
  const principal = { userId: 'user-1', sessionId: 'session-1', name: 'Fixture', email: 'fixture@example.test' }
  const signedOut = { headers: new Headers({ 'set-cookie': 'fixture=; Max-Age=0' }) }
  const fixture = authHarness((_observation, index) => {
    if (index === 0) { clock.mockReturnValue(2000); return principal }
    return signedOut
  })
  const request = ingressRequest(7000)

  expect(await fixture.auth.logout(request)).toBe(signedOut)
  expect(fixture.observations.map(value => value.options.deadlineAtMs)).toEqual([7000, 7000])
  expect(fixture.observations.map(value => value.options.signal)).toEqual([request.signal, request.signal])
  expect(fixture.checkouts()).toBe(0)
})

test('logout cannot start sign-out after the request deadline expires during principal read', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
  const principal = { userId: 'user-1', sessionId: 'session-1', name: 'Fixture', email: 'fixture@example.test' }
  const fixture = authHarness((_observation, index) => {
    if (index === 0) { clock.mockReturnValue(1501); return principal }
    return { headers: new Headers() }
  })
  const request = ingressRequest(1500)

  const error = await fixture.auth.logout(request).catch(error => error)

  expect(error).toMatchObject({ name: 'Error', message: 'Application auth deadline unavailable' })
  expect(request.signal.aborted).toBe(false)
  expect(fixture.observations.map(value => value.options.deadlineAtMs)).toEqual([1500])
  expect(fixture.checkouts()).toBe(0)
})

test('overlapping requests keep independent deadlines in the actual invocation owner', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1000)
  let entered = 0
  let release = () => {}
  const bothEntered = new Promise<void>(resolve => { release = resolve })
  const fixture = authHarness(async () => {
    entered++
    if (entered === 2) release()
    await bothEntered
    return signInResult()
  })
  const first = ingressRequest(7000)
  const second = ingressRequest(8000)

  await Promise.all([fixture.auth.beginGoogleSignIn(first), fixture.auth.beginGoogleSignIn(second)])

  expect(fixture.observations.map(value => value.options.deadlineAtMs).sort()).toEqual([7000, 8000])
  expect(new Set(fixture.observations.map(value => value.options.signal))).toEqual(new Set([first.signal, second.signal]))
  expect(fixture.checkouts()).toBe(0)
})

test.each([
  ['missing', () => ingressRequest(9000, null)],
  ['header-only', () => ingressRequest(9000, null, undefined, { 'x-app-auth-deadline': 'private-header-marker' })],
  ['nonfinite', () => ingressRequest(Number.NaN)],
  ['fractional', () => ingressRequest(9000.5)],
  ['nonpositive', () => ingressRequest(0)],
  ['expired', () => ingressRequest(1000)],
  ['enumerable', () => ingressRequest(9000, { value: 9000, enumerable: true })],
  ['writable', () => ingressRequest(9000, { value: 9000, writable: true })],
  ['configurable', () => ingressRequest(9000, { value: 9000, configurable: true })],
  ['accessor', () => ingressRequest(9000, { get() { throw new Error('private-accessor-marker') } })],
  ['inherited', () => {
    const request = ingressRequest(9000, null)
    const parent = Object.create(Object.getPrototypeOf(request))
    Object.defineProperty(parent, 'appAuthDeadlineAtMs', { value: 9000 })
    Object.setPrototypeOf(request, parent)
    return request
  }],
] as const)('%s auth deadline carrier fails closed before the limiter', async (_name, makeRequest) => {
  vi.spyOn(Date, 'now').mockReturnValue(1000)
  const fixture = authHarness()

  const error = await fixture.auth.beginGoogleSignIn(makeRequest()).catch(error => error)

  expect(error).toMatchObject({ name: 'Error', message: 'Application auth deadline unavailable' })
  expect(inspect(error, { depth: 10 })).not.toMatch(/private-header-marker|private-accessor-marker/)
  expect(fixture.consume).not.toHaveBeenCalled()
  expect(fixture.invocation).not.toHaveBeenCalled()
  expect(fixture.observations).toEqual([])
  expect(fixture.checkouts()).toBe(0)
})

test('an already-aborted request remains rejected by the invocation owner', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1000)
  const fixture = authHarness()
  const request = ingressRequest(9000, undefined, AbortSignal.abort())

  const error = await fixture.auth.beginGoogleSignIn(request).catch(error => error)

  expect(error).toMatchObject({ name: 'PgTransactionError' })
  expect(fixture.consume).toHaveBeenCalledTimes(1)
  expect(fixture.observations).toEqual([])
  expect(fixture.checkouts()).toBe(0)
})
