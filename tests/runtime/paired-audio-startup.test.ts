import { expect, test } from 'vitest'
import { preparePairedAudioFixture, startPairedAudioFixture } from '../helpers/paired-audio-startup'

function gate() {
  let release!: () => void
  const ready = new Promise<void>(resolve => { release = resolve })
  return { ready, release }
}

test.each(['voice', 'web'] as const)('preparations overlap and %s readiness alone cannot complete the fixture', async firstReady => {
  const voice = gate(), web = gate(), entered: string[] = []
  let ready = false
  const preparation = preparePairedAudioFixture(
    async () => { entered.push('voice'); await voice.ready },
    async () => { entered.push('web'); await web.ready },
  )
  const observed = preparation.then(() => { ready = true })
  try {
    await Promise.resolve()
    expect(entered).toEqual(['voice', 'web'])
    const first = firstReady === 'voice' ? voice : web, second = firstReady === 'voice' ? web : voice
    first.release()
    await Promise.resolve()
    expect(ready).toBe(false)
    second.release()
    await observed
    expect(ready).toBe(true)
  } finally {
    voice.release(); web.release(); await observed
  }
})

test.each(['voice', 'web'] as const)('%s startup rejection cannot let cleanup retire stores before the sibling startup joins', async failed => {
  const sibling = gate(), events: string[] = [], failure = new Error(failed + ' readiness failed')
  let outcome: unknown, cleaned = false
  const pending = async () => { events.push('sibling-start'); await sibling.ready; events.push('sibling-joined') }
  const reject = async () => { events.push('failed-start'); throw failure }
  const preparation = preparePairedAudioFixture(failed === 'voice' ? reject : pending, failed === 'web' ? reject : pending)
  // This is the same join required by afterEach on a failed/timed-out hook:
  // the owner can retire stores only once pending preparation has settled.
  const cleanup = (async () => {
    try { await preparation } catch (error) { outcome = error }
    events.push('stores-retired'); cleaned = true
  })()
  try {
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(events).toContain('sibling-start')
    expect(cleaned).toBe(false)
    sibling.release()
    await cleanup
    expect(outcome).toBeInstanceOf(AggregateError)
    if (!(outcome instanceof AggregateError)) throw new Error('Missing paired startup failure')
    expect(outcome.errors).toEqual([failure])
    expect(events.indexOf('sibling-joined')).toBeLessThan(events.indexOf('stores-retired'))
  } finally { sibling.release(); await cleanup }
})

test('synchronous and asynchronous startup failures are both observed after both preparations have run', async () => {
  const failures = [new Error('Voice spawn failed'), new Error('Web readiness failed')], entered: string[] = []
  const preparation = preparePairedAudioFixture(
    () => { entered.push('voice'); throw failures[0] },
    async () => { entered.push('web'); throw failures[1] },
  )
  let outcome: unknown
  try { await preparation } catch (error) { outcome = error }
  expect(entered).toEqual(['voice', 'web'])
  expect(outcome).toBeInstanceOf(AggregateError)
  if (!(outcome instanceof AggregateError)) throw new Error('Missing paired startup failures')
  expect(outcome.errors).toEqual(failures)
})

test('cleanup joins an earlier prerequisite failure and retires only the current hook owners', async () => {
  const events: string[] = [], prerequisite = gate(), failure = new Error('native auth setup failed')
  const previous = startPairedAudioFixture(async owners => {
    owners.stores = async () => { events.push('previous-stores-retired') }
  })
  await previous.ready; await previous.cleanup()
  const current = startPairedAudioFixture(async owners => {
    owners.stores = async () => { events.push('current-stores-retired') }
    events.push('prerequisite-pending')
    await prerequisite.ready
    events.push('prerequisite-failed')
    throw failure
  })
  const rejected = expect(current.ready).rejects.toBe(failure)
  await Promise.resolve()
  const cleanup = current.cleanup()
  try {
    await Promise.resolve(); await Promise.resolve()
    expect(events).toEqual(['previous-stores-retired', 'prerequisite-pending'])
    prerequisite.release()
    await rejected; await cleanup
    expect(events).toEqual(['previous-stores-retired', 'prerequisite-pending', 'prerequisite-failed', 'current-stores-retired'])
  } finally { prerequisite.release(); await rejected; await cleanup }
})

test('owned cleanup retains phase order and observes every retirement failure', async () => {
  const events: string[] = [], failures = [new Error('Voice closure failed'), new Error('crypto retirement failed')]
  const fixture = startPairedAudioFixture(async owners => {
    owners.voice = async () => { events.push('voice'); throw failures[0] }
    owners.web = async () => { events.push('web') }
    owners.issuer = async () => { events.push('issuer') }
    owners.crypto = async () => { events.push('crypto'); throw failures[1] }
    owners.stores = async () => { events.push('stores') }
  })
  await fixture.ready
  let outcome: unknown
  try { await fixture.cleanup() } catch (error) { outcome = error }
  expect(events).toEqual(['voice', 'web', 'issuer', 'crypto', 'stores'])
  expect(outcome).toBeInstanceOf(AggregateError)
  if (!(outcome instanceof AggregateError)) throw new Error('Missing paired cleanup failures')
  expect(outcome.errors).toEqual(failures)
})
