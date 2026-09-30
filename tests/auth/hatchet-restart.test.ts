import { expect, test, vi } from 'vitest'
import { recoveryMeasurementDeadline, restartActionObserver, statementBudget, superviseRestartWorker } from '../helpers/hatchet-restart'
import { createHatchetAdministrator } from '../fixtures/db/disposable-stores'
import { proveHatchetStatementDeadline } from '../fixtures/db/hatchet-restart-observation'

test('normal Hatchet administrator does not send a diagnostic statement timeout at startup', () => {
  const client = createHatchetAdministrator('postgresql://synthetic:synthetic@127.0.0.1:1/auth')
  // Shipped pg8.23.0 serializes startup parameters through this method. No
  // connection is made, and the capability check avoids an unchecked cast.
  if (!('getStartupConf' in client) || typeof client.getStartupConf !== 'function') throw new Error('Pinned pg startup API missing')
  expect(client.getStartupConf()).not.toHaveProperty('statement_timeout')
})

test('entering native deadline calibration first initializes only that diagnostic session', async () => {
  const client = createHatchetAdministrator('postgresql://synthetic:synthetic@127.0.0.1:1/auth')
  const stopBeforeIO = new Error('test stops at the first session instruction')
  const query = vi.spyOn(client, 'query').mockImplementation(() => { throw stopBeforeIO })
  try {
    await expect(proveHatchetStatementDeadline(client)).rejects.toBe(stopBeforeIO)
    expect(query).toHaveBeenCalledExactlyOnceWith('SET statement_timeout = 1000')
  } finally { query.mockRestore() }
})

test('unexpected start settlement refuses the next diagnostic admission even after readiness', async () => {
  const worker = superviseRestartWorker('original', Promise.resolve(), () => 12)
  await worker.settled
  expect(worker.observation).toEqual({ generation: 'original', state: 'resolved', stopRequested: false, settledAt: 12 })
  expect(() => worker.check()).toThrow('Unexpected worker start settlement')
})

test('requested stop permits supervised settlement but retains its outcome and time', async () => {
  let resolveStart = () => {}
  const worker = superviseRestartWorker('replacement', new Promise<void>(resolve => { resolveStart = resolve }), () => 30)
  worker.requestStop(); resolveStart(); await worker.settled
  expect(() => worker.check()).not.toThrow()
  expect(worker.observation).toEqual({ generation: 'replacement', state: 'resolved', stopRequested: true, settledAt: 30 })
})

test('receipt observer accepts the exact scoped marker before admission returns and discards other text', () => {
  const observer = restartActionObserver(() => 8)
  observer.ownWorker('owned')
  observer.accept('Worker/unowned', 'Task run starting... \t auth-email-delivery/00000000-0000-4000-8000-000000000031 ')
  observer.accept('Worker/synthetic-owned', 'arbitrary ignored text')
  observer.accept('Worker/synthetic-owned', 'Task run completed \t auth-email-delivery/00000000-0000-4000-8000-000000000031 ')
  observer.accept('Worker/synthetic-owned', 'Task run starting... \t auth-email-delivery/00000000-0000-4000-8000-000000000031 ')
  observer.accept('Worker/synthetic-owned', 'Task run starting... \t auth-email-delivery/00000000-0000-4000-8000-000000000031 ')
  expect(observer.receipts).toEqual([{ generation: 'owned', runId: '00000000-0000-4000-8000-000000000031', at: 8, count: 2 }])
})

test('recovery observation requires a measured stale condition and honors both frozen caps', () => {
  expect(recoveryMeasurementDeadline(1000, 200_000, 40_000, 140_000)).toBeUndefined()
  expect(recoveryMeasurementDeadline(1000, 200_000, 40_000, 140_000, 110_000)).toBe(131_000)
  expect(recoveryMeasurementDeadline(1000, 90_000, 40_000, 140_000, 110_000)).toBe(90_000)
  expect(recoveryMeasurementDeadline(1000, 200_000, 40_000, 140_000, undefined, 145_000)).toBe(60_000)
  expect(recoveryMeasurementDeadline(1000, 200_000, 40_000, 140_000, undefined, 120_000)).toBeUndefined()
})

test('SQL statement timeout never becomes zero/unlimited and never exceeds remaining budget', () => {
  expect(statementBudget(2000, 500)).toBe(1000)
  expect(statementBudget(700, 500)).toBe(200)
  expect(() => statementBudget(500, 500)).toThrow('SQL observation deadline')
})
