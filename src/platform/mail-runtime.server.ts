import { Context, Effect, Layer, ManagedRuntime, Predicate, Redacted, Schema } from 'effect'
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

const label = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/))
export function readMailWorkerConfig(env: Readonly<Record<string, string | undefined>>) {
  try {
    const envelope = readAuthEmailEnvelope(env)
    const projectId = Schema.decodeUnknownSync(label)(env.AUTH_MAIL_PROJECT_ID), credentialId = Schema.decodeUnknownSync(label)(env.AUTH_MAIL_CREDENTIAL_ID)
    const apiOrigin = readWebConfig({ NODE_ENV: 'production', APP_ORIGIN: env.AUTH_MAIL_API_ORIGIN }).origin
    const secret = Redacted.make(Schema.decodeUnknownSync(Schema.String.check(Schema.isPattern(/^sk_[A-Za-z0-9_-]{1,256}$/)))(env.AUTH_MAIL_PLUNK_SECRET))
    const token = Schema.decodeUnknownSync(Schema.NonEmptyString)(env.HATCHET_CLIENT_TOKEN)
    const host_port = Schema.decodeUnknownSync(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9.-]+:[0-9]{1,5}$/)))(env.HATCHET_CLIENT_HOST_PORT)
    const api_url = readWebConfig({ NODE_ENV: env.NODE_ENV, APP_ORIGIN: env.HATCHET_CLIENT_API_URL }).origin
    const tls_strategy = Schema.decodeUnknownSync(Schema.Literals(['tls', 'none']))(env.HATCHET_CLIENT_TLS_STRATEGY ?? 'tls')
    if (tls_strategy === 'none' && (env.NODE_ENV !== 'test' || !/^(127\.0\.0\.1|localhost):/.test(host_port))) throw new Error()
    return { envelope, binding: { apiOrigin, projectId, credentialId, secret },
      hatchet: { token, host_port, api_url, tls_config: { tls_strategy } },
      relay: readDatabaseConfig({ ...env, DATABASE_URL: env.AUTH_MAIL_RELAY_DATABASE_URL }),
      worker: readDatabaseConfig({ ...env, DATABASE_URL: env.AUTH_MAIL_WORKER_DATABASE_URL }) }
  } catch { throw new Error('Auth mail worker configuration rejected') }
}
type MailResources = { failure: Promise<void>; isReady(): boolean }
class Resources extends Context.Service<Resources, MailResources>()('app/auth-mail/resources') {}

export type MailStopEvent = 'native-stop-completed' | 'native-stop-failed' | 'native-start-completed' | 'native-start-resolved' | 'native-start-cancelled' | 'native-start-failed' | 'handlers-stopped' | 'relay-stopped'
export function createMailWorkerResources(env: Readonly<Record<string, string | undefined>>, emptyConfigPath: string, observeStop: (event: MailStopEvent) => void = () => {}) {
  const config = readMailWorkerConfig(env)
  let stopping = false, disposal: Promise<void> | undefined, readiness: Promise<MailResources> | undefined
  const owner = new AbortController()
  let nativeFailed = false
  const layer = Layer.effect(Resources, Effect.gen(function* () {
    const relayDb = yield* acquireDatabase(config.relay, 'auth_mail_relay')
    const workerDb = yield* acquireDatabase(config.worker, 'auth_mail_worker')
    const relayStore = createMailStore(relayDb.transactions), workerStore = createMailStore(workerDb.transactions)
    const transport = yield* Effect.acquireRelease(Effect.sync(() => createPlunkTransport(config.binding)), value => Effect.promise(() => value.close()))
    const handler = createAuthMailHandler(workerStore, config.envelope, transport)
    const client = createAuthMailHatchet(config.hatchet, emptyConfigPath, owner.signal)
    const task = createAuthMailTask(client, handler)
    yield* Effect.tryPromise({ try: async () => {
      if ((await client.tenant.get()).version !== 'V1' || await client.dispatcher.getVersion() !== 'v0.101.27') throw new Error()
    }, catch: () => new Error('Auth mail engine contract rejected') })
    let failed!: () => void
    const failure = new Promise<void>(resolve => { failed = resolve })
    const relayController = new AbortController()
    let loop: Promise<void> = Promise.resolve()
    const native = yield* Effect.acquireRelease(Effect.tryPromise({ try: async () => {
      const worker = await client.worker('auth-email-worker', { workflows: [task], slots: 1, handleKill: false })
      const started = worker.start().then(() => {
        if (!stopping) { nativeFailed = true; failed() }
        return 'native-start-resolved' as const
      }, error => {
        if (owner.signal.aborted && Predicate.isObject(error) && 'name' in error && error.name === 'AbortError') return 'native-start-cancelled' as const
        nativeFailed = true; failed()
        return 'native-start-failed' as const
      })
      return { worker, started }
    }, catch: () => new Error('Auth mail worker unavailable') }), value => Effect.promise(async () => {
      stopping = true; owner.abort(); relayController.abort()
      // Native stop is not a handler drain receipt. Join both the native work
      // and every owned handler/transport before either login pool is disposed.
      await Promise.allSettled([
        value.worker.stop().then(() => observeStop('native-stop-completed'), () => { nativeFailed = true; observeStop('native-stop-failed') }),
        handler.stop().then(() => observeStop('handlers-stopped')),
        loop.then(() => observeStop('relay-stopped')),
        value.started.then(outcome => { observeStop(outcome); observeStop('native-start-completed') }),
      ])
      relayDb.stop(); workerDb.stop()
    }))
    yield* Effect.tryPromise({ try: () => Promise.race([
      native.worker.waitUntilReady(20000), failure.then(() => { throw new Error() }),
    ]), catch: () => new Error('Auth mail worker unavailable') })
    loop = (async () => {
      while (!relayController.signal.aborted) {
        if (!relayDb.isReady() || !workerDb.isReady()) { failed(); return }
        await relayAuthMailOnce(relayStore, task, relayController.signal)
        if (!relayController.signal.aborted) await workerStore.purge()
        await delay(1000, undefined, { signal: relayController.signal }).catch(() => {})
      }
    })().catch(() => { if (!stopping) failed() })
    return { failure, isReady: () => !stopping && relayDb.isReady() && workerDb.isReady() }
  }))
  const runtime = ManagedRuntime.make(layer)
  function dispose() { stopping = true; owner.abort(); return disposal ??= runtime.dispose() }
  function ready() { return readiness ??= runtime.runPromise(Resources).catch(async () => { await dispose(); throw new Error('Auth mail worker unavailable') }) }
  return { ready, dispose, hasFailed: () => nativeFailed }
}
