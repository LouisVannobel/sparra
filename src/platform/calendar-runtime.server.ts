import { Context, Effect, Layer, ManagedRuntime } from 'effect'
import { setTimeout as delay } from 'node:timers/promises'
import { readCalendarConfig } from '../modules/calendar/config.server'
import { createCalendarStore } from '../modules/calendar/store.server'
import { runCalendarOnce } from '../modules/calendar/worker.server'
import { readCalendarDatabaseConfig } from './db/config.server'
import { acquireDatabase } from './db/resources.server'
type Ready = { enabled: boolean; failure: Promise<void>; isReady: () => boolean }
class Resources extends Context.Service<Resources, Ready>()('app/calendar/resources') {}
export function createCalendarWorkerResources(env: Readonly<Record<string, string | undefined>>) {
  const controller = new AbortController()
  let stopping = false,
    failed = false,
    disposal: Promise<void> | undefined,
    readiness: Promise<Ready> | undefined,
    resolveFailure!: () => void
  const failure = new Promise<void>((resolve) => {
    resolveFailure = resolve
  })
  const fail = () => {
    failed = true
    resolveFailure()
  }
  const layer = Layer.effect(
    Resources,
    Effect.gen(function* () {
      const config = readCalendarConfig(env)
      if (!config) {
        if (env.SPARRA_CALENDAR_DATABASE_URL) throw new Error('Calendar configuration unavailable')
        return { enabled: false, failure, isReady: () => !stopping }
      }
      const database = yield* acquireDatabase(readCalendarDatabaseConfig(env), 'calendar_worker')
      const store = createCalendarStore(database.transactions)
      let loop: Promise<void> = Promise.resolve()
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          stopping = true
          controller.abort()
          await loop
          database.stop()
        }),
      )
      if (!stopping) {
        loop = (async () => {
          while (!controller.signal.aborted) {
            if (!database.isReady()) throw new Error('Calendar database unavailable')
            const worked = await runCalendarOnce(store, config, controller.signal)
            if (!worked && !controller.signal.aborted)
              await delay(250, undefined, { signal: controller.signal }).catch(() => {})
          }
        })().catch(() => {
          if (!stopping) fail()
        })
      }
      return { enabled: true, failure, isReady: () => !stopping && !failed && database.isReady() }
    }),
  )
  const runtime = ManagedRuntime.make(layer)
  function dispose() {
    if (!disposal) {
      stopping = true
      controller.abort()
      disposal = runtime.dispose().catch(() => {
        fail()
        throw new Error('Calendar worker cleanup unavailable')
      })
    }
    return disposal
  }
  function ready() {
    return (readiness ??= runtime.runPromise(Resources).catch(async () => {
      fail()
      await dispose()
      throw new Error('Calendar worker unavailable')
    }))
  }
  return { ready, dispose, hasFailed: () => failed }
}
