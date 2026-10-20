import { afterEach, expect, test, vi } from 'vitest'
import { Effect } from 'effect'
import { createTransactions } from '../../src/platform/db/transactions.server'
import { createCalendarWorkerResources } from '../../src/platform/calendar-runtime.server'
type Observation = { events: string[]; active: boolean; block: boolean; fail: boolean; release: () => void }
const state = vi.hoisted((): Observation => ({
  events: [],
  active: false,
  block: false,
  fail: false,
  release: () => {},
}))
vi.mock('../../src/platform/db/resources.server', () => ({
  acquireDatabase: (config: { max: number }, login: string) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        state.events.push(login + ':' + config.max)
        return {
          transactions: createTransactions(
            {
              async connect() {
                throw new Error('No SQL in lifecycle fixture')
              },
            },
            { maxStatementTimeoutMs: 1000, maxCleanupTimeoutMs: 1000 },
          ),
          isReady: () => true,
          stop: () => state.events.push('pool-stop'),
        }
      }),
      () =>
        Effect.sync(() => {
          expect(state.active).toBe(false)
          state.events.push('pool-close')
        }),
    ),
}))
vi.mock('../../src/modules/calendar/worker.server', () => ({
  runCalendarOnce: async (_s: unknown, _c: unknown, signal: AbortSignal) => {
    state.events.push('command')
    if (state.fail) throw new Error('Synthetic transport failure')
    state.active = true
    if (state.block)
      await new Promise<void>((resolve) => {
        state.release = resolve
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    state.active = false
    state.events.push('transport-close')
    return false
  },
}))
const env = {
  APP_ORIGIN: 'https://sparra.example',
  SPARRA_GOOGLE_CALENDAR_CLIENT_ID: 'fixture',
  SPARRA_GOOGLE_CALENDAR_CLIENT_SECRET: 'fixture',
  SPARRA_CALENDAR_TOKEN_KEY: Buffer.alloc(32, 8).toString('base64url'),
  SPARRA_CALENDAR_DATABASE_URL: 'postgres://calendar_worker:fixture@localhost/test',
  DB_POOL_MAX: '9',
}
const owned: ReturnType<typeof createCalendarWorkerResources>[] = []
afterEach(async () => {
  state.release()
  for (const r of owned.splice(0)) await r.dispose()
  state.events.length = 0
  state.active = false
  state.block = false
  state.fail = false
})
test('Calendar absent is inert and independent of missing Hatchet configuration', async () => {
  const r = createCalendarWorkerResources({})
  owned.push(r)
  expect(await r.ready()).toMatchObject({ enabled: false })
  expect(state.events).toEqual([])
})
test('one bounded pool and one loop initialize without Hatchet; shutdown joins transport before pool', async () => {
  state.block = true
  const r = createCalendarWorkerResources(env)
  owned.push(r)
  await r.ready()
  await expect.poll(() => state.active).toBe(true)
  await r.dispose()
  expect(state.events).toEqual(['calendar_worker:1', 'command', 'transport-close', 'pool-stop', 'pool-close'])
  expect(r.hasFailed()).toBe(false)
})
test('pump failure remains visible after shutdown', async () => {
  state.fail = true
  const r = createCalendarWorkerResources(env)
  owned.push(r)
  const ready = await r.ready()
  await ready.failure
  expect(r.hasFailed()).toBe(true)
  await r.dispose()
  expect(state.events).toContain('pool-close')
})
