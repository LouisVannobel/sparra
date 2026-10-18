import { Context, Effect, Exit, Layer, ManagedRuntime, Predicate, Redacted, Schema, Scope } from 'effect'
import { setTimeout as delay } from 'node:timers/promises'
import { readDatabaseConfig } from './db/config.server'
import { acquireDatabase } from './db/resources.server'
import { createMailStore } from '../modules/auth/mail-store.server'
import { readAuthEmailEnvelope } from '../modules/auth/auth-email-envelope.server'
import { createPlunkTransport } from '../modules/auth/plunk.server'
import { createAuthMailHandler } from '../modules/auth/mail-worker.server'
import { createAuthMailHatchet, createAuthMailTask } from '../modules/auth/mail-hatchet.server'
import { relayAuthMailOnce } from '../modules/auth/mail-relay.server'
import { readWebConfig } from './config.server'
import { readStripeConfig } from '../modules/billing/stripe-config.server'
import { createBillingStore } from '../modules/billing/store.server'
import { createBillingHandler } from '../modules/billing/worker.server'
import { createBillingTask, stopBillingRelay } from '../modules/billing/billing-hatchet.server'
import { relayBillingOnce } from '../modules/billing/billing-relay.server'

const label = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/))
const mailKeys = ['AUTH_MAIL_KEY_ID', 'AUTH_MAIL_KEYS_JSON', 'AUTH_MAIL_PROJECT_ID', 'AUTH_MAIL_CREDENTIAL_ID',
  'AUTH_MAIL_API_ORIGIN', 'AUTH_MAIL_PLUNK_SECRET', 'AUTH_MAIL_RELAY_DATABASE_URL', 'AUTH_MAIL_WORKER_DATABASE_URL'] as const
const billingKeys = ['STRIPE_API_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_ACCOUNT_ID', 'STRIPE_ENVIRONMENT',
  'BILLING_RELAY_DATABASE_URL', 'BILLING_WORKER_DATABASE_URL'] as const

export function readMailWorkerConfig(env: Readonly<Record<string, string | undefined>>) {
  try {
    const rejectedCapabilities: Array<'mail' | 'billing'> = []
    const mail = (() => {
      if (mailKeys.every(key => env[key] === undefined)) return null
      try {
        const envelope = readAuthEmailEnvelope(env)
        const projectId = Schema.decodeUnknownSync(label)(env.AUTH_MAIL_PROJECT_ID), credentialId = Schema.decodeUnknownSync(label)(env.AUTH_MAIL_CREDENTIAL_ID)
        const apiOrigin = readWebConfig({ NODE_ENV: 'production', APP_ORIGIN: env.AUTH_MAIL_API_ORIGIN }).origin
        const secret = Redacted.make(Schema.decodeUnknownSync(Schema.String.check(Schema.isPattern(/^sk_[A-Za-z0-9_-]{1,256}$/)))(env.AUTH_MAIL_PLUNK_SECRET))
        return { envelope, binding: { apiOrigin, projectId, credentialId, secret },
          relay: readDatabaseConfig({ ...env, DATABASE_URL: env.AUTH_MAIL_RELAY_DATABASE_URL }),
          worker: readDatabaseConfig({ ...env, DATABASE_URL: env.AUTH_MAIL_WORKER_DATABASE_URL }) }
      } catch { rejectedCapabilities.push('mail'); return null }
    })()
    const billing = (() => {
      if (billingKeys.every(key => env[key] === undefined)) return null
      try {
        const stripe = readStripeConfig(env)
        if (!stripe) throw new Error()
        return { stripe,
          relay: readDatabaseConfig({ ...env, DATABASE_URL: env.BILLING_RELAY_DATABASE_URL }),
          worker: readDatabaseConfig({ ...env, DATABASE_URL: env.BILLING_WORKER_DATABASE_URL }) }
      } catch { rejectedCapabilities.push('billing'); return null }
    })()
    if (!mail && !billing || mail && billing && mail.relay.max < 2) throw new Error()
    const token = Schema.decodeUnknownSync(Schema.NonEmptyString)(env.HATCHET_CLIENT_TOKEN)
    const host_port = Schema.decodeUnknownSync(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9.-]+:[0-9]{1,5}$/)))(env.HATCHET_CLIENT_HOST_PORT)
    const api_url = readWebConfig({ NODE_ENV: env.NODE_ENV, APP_ORIGIN: env.HATCHET_CLIENT_API_URL }).origin
    const tls_strategy = Schema.decodeUnknownSync(Schema.Literals(['tls', 'none']))(env.HATCHET_CLIENT_TLS_STRATEGY ?? 'tls')
    if (tls_strategy === 'none' && (env.NODE_ENV !== 'test' || !/^(127\.0\.0\.1|localhost):/.test(host_port))) throw new Error()
    return { hatchet: { token, host_port, api_url, tls_config: { tls_strategy } }, rejectedCapabilities,
      mail: mail ? { ...mail, relay: { ...mail.relay, max: 1 }, worker: { ...mail.worker, max: 1 } } : null,
      billing: billing ? { ...billing, relay: { ...billing.relay, max: 1 }, worker: { ...billing.worker, max: 1 } } : null }
  } catch { throw new Error('Application worker configuration rejected') }
}

type MailResources = { failure: Promise<void>; isReady(): boolean }
class Resources extends Context.Service<Resources, MailResources>()('app/auth-mail/resources') {}

export type MailStopEvent = 'native-stop-completed' | 'native-stop-failed' | 'native-start-completed' | 'native-start-resolved' | 'native-start-cancelled' | 'native-start-failed' | 'handlers-stopped' | 'billing-handler-stopped' | 'relay-stopped' | 'mail-config-rejected' | 'billing-config-rejected'
export function createMailWorkerResources(env: Readonly<Record<string, string | undefined>>, emptyConfigPath: string, observeStop: (event: MailStopEvent) => void = () => {}) {
  const config = readMailWorkerConfig(env)
  for (const capability of config.rejectedCapabilities) observeStop(`${capability}-config-rejected`)
  let stopping = false, disposal: Promise<void> | undefined, readiness: Promise<MailResources> | undefined
  const startupOwner = new AbortController(), owner = new AbortController(), relayController = new AbortController()
  let nativeFailed = false, billingTransportUnproven = false
  let billingTask: ReturnType<typeof createBillingTask> | null = null
  let relayStop: Promise<void> | undefined, cleanupDeadlineAtMs: number | undefined
  let cleanupFailure: { cause: unknown } | undefined
  let failed!: () => void
  const failure = new Promise<void>(resolve => { failed = resolve })
  function fail() { nativeFailed = true; failed() }
  function beginRelayStop() {
    cleanupDeadlineAtMs ??= Date.now() + 15000
    return relayStop ??= billingTask ? stopBillingRelay(billingTask, cleanupDeadlineAtMs) : Promise.resolve()
  }
  const layer = Layer.effect(Resources, Effect.gen(function* () {
    // A failed SDK/handler join must not unwind the pools under unresolved work.
    const databaseScope = yield* Scope.make()
    const databases: { stop(): void; isReady(): boolean }[] = []
    let client: ReturnType<typeof createAuthMailHatchet> | undefined
    let worker: Awaited<ReturnType<ReturnType<typeof createAuthMailHatchet>['worker']>> | undefined
    let handler: ReturnType<typeof createAuthMailHandler> | undefined
    let billingHandler: ReturnType<typeof createBillingHandler> | undefined
    let transport: ReturnType<typeof createPlunkTransport> | undefined
    let acquisition: Promise<void> = Promise.resolve(), loop: Promise<void> = Promise.resolve()
    let loopFailure: { cause: unknown } | undefined
    let started: Promise<'native-start-resolved' | 'native-start-cancelled' | 'native-start-failed'> | undefined
    let readyWait: Promise<void> | undefined, joining: Promise<void> | undefined
    function join() {
      if (joining) return joining
      stopping = true
      const billingStopped = beginRelayStop()
      joining = (async () => {
        const results = await Promise.allSettled([
          billingStopped,
          Promise.resolve().then(() => client?.dispose()),
          Promise.resolve().then(() => handler?.stop()).then(() => { if (handler) observeStop('handlers-stopped') }),
          Promise.resolve().then(() => billingHandler?.stop()).then(() => { if (billingHandler) observeStop('billing-handler-stopped') }),
          loop.then(() => { if (loopFailure) throw loopFailure.cause; observeStop('relay-stopped') }),
          (async () => {
            await acquisition.catch(() => {})
            const stopped = worker?.stop().then(() => observeStop('native-stop-completed'), error => {
              fail(); observeStop('native-stop-failed'); throw error
            })
            const nativeResults = await Promise.allSettled([
              stopped,
              started?.then(outcome => { observeStop(outcome); observeStop('native-start-completed') }),
              readyWait?.catch(() => {}),
            ])
            const errors = nativeResults.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
            if (errors.length) throw new AggregateError(errors, 'Application worker native cleanup failed')
          })(),
        ])
        const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
        try { await transport?.close() } catch (error) { errors.push(error) }
        if (billingTransportUnproven) errors.push(new Error('Billing relay REST transport closure unproven'))
        if (errors.length) { fail(); throw new AggregateError(errors, 'Application worker cleanup unsafe') }
        for (const database of databases) database.stop()
        await Effect.runPromise(Scope.close(databaseScope, Exit.void))
      })().catch(cause => { cleanupFailure = { cause }; fail(); throw cause })
      startupOwner.abort(); owner.abort(); relayController.abort()
      return joining
    }
    yield* Effect.addFinalizer(() => Effect.promise(join))
    const check = () => { if (stopping || owner.signal.aborted) throw new Error('Application worker stopped') }
    const relayDb = config.mail ? yield* acquireDatabase(config.mail.relay, 'auth_mail_relay').pipe(Scope.provide(databaseScope)) : null
    if (relayDb) databases.push(relayDb)
    const workerDb = config.mail ? yield* acquireDatabase(config.mail.worker, 'auth_mail_worker').pipe(Scope.provide(databaseScope)) : null
    if (workerDb) databases.push(workerDb)
    const billingRelayDb = config.billing ? yield* acquireDatabase(config.billing.relay, 'billing_relay').pipe(Scope.provide(databaseScope)) : null
    if (billingRelayDb) databases.push(billingRelayDb)
    const billingWorkerDb = config.billing ? yield* acquireDatabase(config.billing.worker, 'billing_worker').pipe(Scope.provide(databaseScope)) : null
    if (billingWorkerDb) databases.push(billingWorkerDb)
    check()
    const relayStore = relayDb ? createMailStore(relayDb.transactions) : null
    const workerStore = workerDb ? createMailStore(workerDb.transactions) : null
    const billingRelayStore = billingRelayDb ? createBillingStore(billingRelayDb.transactions) : null
    if (config.mail && workerStore) {
      transport = createPlunkTransport(config.mail.binding)
      handler = createAuthMailHandler(workerStore, config.mail.envelope, transport)
    }
    if (config.billing && billingWorkerDb) billingHandler = createBillingHandler(config.billing.stripe, createBillingStore(billingWorkerDb.transactions))
    const deadlineAt = Date.now() + 15000
    client = createAuthMailHatchet(config.hatchet, emptyConfigPath, {
      startup: { signal: startupOwner.signal, deadlineAt }, lifetimeSignal: owner.signal, cleanupTimeoutMs: 15000,
    })
    const ownedClient = client
    const task = handler ? createAuthMailTask(client, handler) : null
    billingTask = billingHandler ? createBillingTask(client, billingHandler) : null
    const workflows = [...(task ? [task] : []), ...(billingTask ? [billingTask] : [])]
    if (workflows.length === 0) throw new Error('Application worker has no configured task')
    acquisition = (async () => {
      check()
      const info = await ownedClient.getStartupInfo()
      check()
      if (info.tenantVersion !== 'V1' || info.engineVersion !== 'v0.101.27') throw new Error('Application worker engine contract rejected')
      worker = await ownedClient.worker('auth-email-worker', { workflows, slots: 1, handleKill: false })
      check()
      started = worker.start().then(() => {
        if (!stopping) fail()
        return 'native-start-resolved' as const
      }, error => {
        if (owner.signal.aborted && Predicate.isObject(error) && 'name' in error && error.name === 'AbortError') return 'native-start-cancelled' as const
        fail()
        return 'native-start-failed' as const
      })
    })().catch(error => { if (!stopping) fail(); throw error })
    yield* Effect.tryPromise({ try: () => acquisition, catch: cause => new Error('Auth mail worker unavailable', { cause }) })
    yield* Effect.tryPromise({ try: async () => {
      check()
      if (!worker || Date.now() >= deadlineAt) throw new Error('Auth mail worker unavailable')
      readyWait = worker.waitUntilReady(deadlineAt - Date.now())
      await Promise.race([readyWait, failure.then(() => { throw new Error('Auth mail worker unavailable') })])
      check()
    }, catch: cause => new Error('Auth mail worker unavailable', { cause }) })
    loop = (async () => {
      while (!relayController.signal.aborted) {
        if (!databases.every(database => database.isReady())) { fail(); return }
        if (relayStore && task) await relayAuthMailOnce(relayStore, task, relayController.signal)
        if (!relayController.signal.aborted && billingRelayStore && billingTask) await relayBillingOnce(billingRelayStore, billingTask,
          relayController.signal, () => {
            billingTransportUnproven = true; stopping = true; fail()
            // Close admission now; the memoized rejection is still joined by
            // disposal after the current relay's SQL finalization has settled.
            void beginRelayStop().catch(() => {})
            startupOwner.abort(); owner.abort(); relayController.abort()
          })
        if (!relayController.signal.aborted && workerStore) await workerStore.purge()
        await delay(1000, undefined, { signal: relayController.signal }).catch(() => {})
      }
    })().catch(error => { loopFailure = { cause: error }; fail() })
    return { failure, isReady: () => !stopping && databases.every(database => database.isReady()) }
  }))
  const runtime = ManagedRuntime.make(layer)
  function dispose() {
    if (disposal) return disposal
    stopping = true
    beginRelayStop()
    let resolve!: () => void, reject!: (cause: unknown) => void
    disposal = new Promise<void>((done, failed) => { resolve = done; reject = failed })
    startupOwner.abort(); owner.abort(); relayController.abort()
    void runtime.dispose().then(() => { if (cleanupFailure) throw cleanupFailure.cause }).then(resolve, reject)
    return disposal
  }
  function ready() { return readiness ??= runtime.runPromise(Resources).catch(async cause => { await dispose(); throw new Error('Auth mail worker unavailable', { cause }) }) }
  return { ready, dispose, hasFailed: () => nativeFailed }
}
