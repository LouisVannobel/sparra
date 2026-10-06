import { Context, Effect, Layer, ManagedRuntime } from 'effect'
import { readDatabaseConfig } from './db/config.server'
import { acquireDatabase } from './db/resources.server'
import { createAuthRateLimiter, readRateLimitConfig } from '../modules/auth/rate-limit.server'
import type { WebResources } from './resources.server'
import { createApplicationAuth, readAuthConfig } from '../modules/auth/auth.server'
import { createPersonalWorkspaces } from '../modules/workspaces/personal.server'
import { createAudioReaderOwner, readAudioIncarnation } from '../modules/sparra/audio-reader.server'

class Resources extends Context.Service<Resources, WebResources>()('app/web/resources') {}

export function createWebResources(env: Readonly<Record<string, string | undefined>>) {
  // Pure validation precedes resource construction and never retains raw causes.
  const database = readDatabaseConfig(env)
  const redis = readRateLimitConfig(env)
  const authConfig = readAuthConfig(env)
  let stopping = false
  let disposal: Promise<void> | undefined
  let readiness: Promise<WebResources> | undefined
  let stopDatabase = () => {}
  let audioReader: ReturnType<typeof createAudioReaderOwner> | undefined
  const layer = Layer.effect(Resources, Effect.gen(function* () {
    const databaseResource = yield* acquireDatabase(database)
    stopDatabase = databaseResource.stop
    if (stopping) stopDatabase()
    const { transactions } = databaseResource
    const limiter = yield* Effect.acquireRelease(
      Effect.sync(() => createAuthRateLimiter(redis)),
      limiter => Effect.promise(() => limiter.close()),
    )
    yield* Effect.tryPromise({ try: () => limiter.connect(), catch: () => new Error('Application stores unavailable') })
    const auth = authConfig ? yield* Effect.acquireRelease(
      Effect.sync(() => createApplicationAuth(transactions, authConfig, limiter)),
      auth => Effect.promise(() => auth.close()),
    ) : null
    const workspaces = createPersonalWorkspaces(transactions)
    audioReader = yield* Effect.acquireRelease(
      Effect.tryPromise({ try: async () => createAudioReaderOwner(transactions, await readAudioIncarnation(env)),
        catch: () => new Error('Audio reader unavailable') }),
      reader => Effect.promise(() => reader.shutdown()),
    )
    return Object.freeze({ transactions, limiter, auth, workspaces, audioReader, isReady: () => !stopping && databaseResource.isReady() && limiter.isReady() })
  }))
  const runtime = ManagedRuntime.make(layer)
  function dispose() {
    stopping = true
    return disposal ??= (async () => {
      await audioReader?.shutdown()
      stopDatabase()
      await runtime.dispose()
    })()
  }
  function ready() {
    return readiness ??= runtime.runPromise(Resources).catch(async () => {
      await dispose()
      throw new Error('Application stores unavailable')
    })
  }
  return { runtime, ready, dispose }
}
