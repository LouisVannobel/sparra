import { expect, test } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  runCalendarOnce,
  calendarMidnight,
  type CalendarBookingProvider,
} from '../../src/modules/calendar/worker.server'
import type { CalendarStore, CalendarWork, CalendarFinish } from '../../src/modules/calendar/store.server'
import { calendarFixtureConfig, calendarFixturePolicy } from '../helpers/calendar-fixture'
import { encryptCalendarTokens } from '../../src/modules/calendar/token-crypto.server'
import { CalendarProviderError } from '../../src/modules/calendar/google.server'
function fixture(possible = false) {
  const id = randomUUID(),
    workspaceId = randomUUID(),
    connectionId = randomUUID(),
    eventId = 'sparra' + id.replaceAll('-', ''),
    now = Date.now()
  let q: CalendarWork = {
    id,
    workspaceId,
    connectionId,
    callId: randomUUID(),
    kind: 'book_appointment',
    generation: 1,
    policyRevision: 1,
    googleSubject: 'subject',
    calendarId: 'calendar',
    policy: calendarFixturePolicy(),
    serviceId: 'oil-change',
    serviceName: 'Vidange',
    windowStart: new Date(now + 86400000).toISOString(),
    windowEnd: new Date(now + 88200000).toISOString(),
    state: possible ? 'unknown' : 'running',
    fence: 2,
    leaseUntil: new Date(now + 30000).toISOString(),
    firstSendDeadline: new Date(now + 30000).toISOString(),
    possibleSendFence: possible ? 1 : null,
    eventId,
    createdAt: new Date(now).toISOString(),
    result: null,
    tokenEnvelope: null,
    blockers: [],
  }
  q = {
    ...q,
    tokenEnvelope: encryptCalendarTokens(
      calendarFixtureConfig,
      { workspaceId, connectionId },
      { accessToken: 'access', refreshToken: 'refresh', expiresAt: now + 3600000, grantedScopes: ['openid'] },
    ),
  }
  const calls: string[] = [],
    finishes: CalendarFinish[] = []
  const store: CalendarStore = {
    async claim() {
      calls.push('claim')
      return q
    },
    async read() {
      calls.push('read')
      return q
    },
    async prepare() {
      calls.push('prepare')
      q = { ...q, possibleSendFence: q.fence, state: 'unknown' }
      return true
    },
    async finish(_q, result) {
      finishes.push(result)
      q = { ...q, state: result.state === 'confirmed' ? 'confirmed' : q.state }
      return true
    },
    async observe() {
      return true
    },
    async claimTokens() {
      return randomUUID()
    },
    async finishTokens() {
      return true
    },
  }
  const event = () => ({
    id: eventId,
    status: 'confirmed' as const,
    start: { dateTime: q.windowStart },
    end: { dateTime: q.windowEnd },
    extendedProperties: { private: { sparraOperationId: id } },
  })
  const provider: CalendarBookingProvider = {
    async listCalendars() {
      return []
    },
    async freeBusy() {
      calls.push('freeBusy')
      return []
    },
    async insertEvent(_token, input) {
      calls.push('POST')
      expect(input.event.description).toBe(calendarFixtureConfig.origin + '/app/demandes/' + q.callId)
      expect(JSON.stringify(input)).not.toMatch(/contact|transcript|attendees/)
      return event()
    },
    async getEvent() {
      calls.push('GET')
      return event()
    },
    async refreshTokens() {
      throw new Error('Unexpected refresh')
    },
    async userInfo() {
      return { sub: 'subject', email: 'fixture@example.test', emailVerified: true }
    },
    async close() {
      calls.push('close')
    },
  }
  return {
    calls,
    finishes,
    store,
    provider,
    get q() {
      return q
    },
    set q(value: CalendarWork) {
      q = value
    },
  }
}
test('freeBusy precedes final fenced send transition and stable POST then verified finish', async () => {
  const f = fixture()
  await runCalendarOnce(f.store, calendarFixtureConfig, new AbortController().signal, f.provider)
  expect(f.calls).toEqual(['claim', 'freeBusy', 'prepare', 'POST', 'close'])
  expect(f.finishes).toMatchObject([{ state: 'confirmed', eventId: f.q.eventId }])
})
test('possible-send crash recovers only by GET with the same target and never POST', async () => {
  const f = fixture(true)
  await runCalendarOnce(f.store, calendarFixtureConfig, new AbortController().signal, f.provider)
  expect(f.calls).toEqual(['claim', 'GET', 'close'])
  expect(f.finishes[0]?.state).toBe('confirmed')
})
test('unknown GET 404 preserves unresolved interval and never authorizes a fresh POST', async () => {
  const f = fixture(true)
  f.provider.getEvent = async () => {
    f.calls.push('GET')
    throw new CalendarProviderError('not_found')
  }
  await runCalendarOnce(f.store, calendarFixtureConfig, new AbortController().signal, f.provider)
  expect(f.calls).not.toContain('POST')
  expect(f.finishes[0]?.state).toBe('unknown')
})
test('lost prepare acknowledgement is read back before sending; replaced fence never sends', async () => {
  for (const replaced of [false, true]) {
    const f = fixture()
    const prepare = f.store.prepare
    f.store.prepare = async (q) => {
      await prepare(q)
      if (replaced) f.q = { ...f.q, fence: 3 }
      throw new Error('Lost commit')
    }
    await runCalendarOnce(f.store, calendarFixtureConfig, new AbortController().signal, f.provider)
    expect(f.calls.includes('POST')).toBe(!replaced)
    expect(f.calls).toContain('read')
  }
})
test('lost finish acknowledgement reads committed result without another POST', async () => {
  const f = fixture()
  const finish = f.store.finish
  f.store.finish = async (q, r) => {
    await finish(q, r)
    throw new Error('Lost commit')
  }
  await runCalendarOnce(f.store, calendarFixtureConfig, new AbortController().signal, f.provider)
  expect(f.calls.filter((x) => x === 'POST')).toHaveLength(1)
  expect(f.calls).toContain('read')
})
test('lost deferred-finish acknowledgement recognizes the durable pending state',async()=>{
 const f=fixture()
 f.provider.freeBusy=async()=>{throw new CalendarProviderError('unavailable')}
 f.store.finish=async(_q,result)=>{expect(result.state).toBe('retry');f.q={...f.q,state:'pending'};throw new Error('Lost commit')}
 await expect(runCalendarOnce(f.store,calendarFixtureConfig,new AbortController().signal,f.provider)).resolves.toBe(true)
 expect(f.calls).not.toContain('POST')
})
test('disconnect or expired first-send deadline prevents a write after freeBusy', async () => {
  const f = fixture()
  f.store.prepare = async () => false
  await runCalendarOnce(f.store, calendarFixtureConfig, new AbortController().signal, f.provider)
  expect(f.calls).not.toContain('POST')
  expect(f.finishes[0]?.state).toBe('refused')
})
test('freeBusy failure cannot be interpreted as an empty agenda and insertion conflict remains unknown', async () => {
  for (const failure of ['busy', 'insert']) {
    const f = fixture()
    if (failure === 'busy')
      f.provider.freeBusy = async () => {
        throw new CalendarProviderError('rejected')
      }
    else
      f.provider.insertEvent = async () => {
        throw new CalendarProviderError('conflict')
      }
    await runCalendarOnce(f.store, calendarFixtureConfig, new AbortController().signal, f.provider)
    expect(f.finishes[0]?.state).toBe(failure === 'busy' ? 'retry' : 'unknown')
    expect(f.calls).not.toContain('GET')
  }
})
test('a retrieved event with foreign correlation or changed interval cannot establish original confirmation', async () => {
  for (const mismatch of ['correlation', 'time']) {
    const f = fixture(true)
    f.provider.getEvent = async () => ({
      id: f.q.eventId!,
      status: 'confirmed',
      start: {
        dateTime:
          mismatch === 'time' ? new Date(Date.parse(f.q.windowStart) + 60000).toISOString() : f.q.windowStart,
      },
      end: { dateTime: f.q.windowEnd },
      extendedProperties: {
        private: { sparraOperationId: mismatch === 'correlation' ? randomUUID() : f.q.id },
      },
    })
    await runCalendarOnce(f.store, calendarFixtureConfig, new AbortController().signal, f.provider)
    expect(f.finishes[0]?.state).toBe('unknown')
  }
})
test('known moved/all-day/cancelled events are observed before freeBusy and the new local exclusion', async () => {
  for (const status of ['moved', 'all-day', 'cancelled']) {
    const f = fixture(),
      bookingId = randomUUID()
    f.q = {
      ...f.q,
      blockers: [
        {
          id: bookingId,
          eventId: 'known-event',
          calendarId: f.q.calendarId,
          googleSubject: f.q.googleSubject,
          state: 'confirmed',
          start: f.q.windowStart,
          end: f.q.windowEnd,
          observedState: 'confirmed',
        },
      ],
    }
    f.provider.getEvent = async () => {
      f.calls.push('GET')
      return status === 'cancelled'
        ? { id: 'known-event', status: 'cancelled' }
        : status === 'all-day'
          ? {
              id: 'known-event',
              status: 'confirmed',
              start: { date: '2026-10-25' },
              end: { date: '2026-10-26' },
            }
          : {
              id: 'known-event',
              status: 'confirmed',
              start: { dateTime: new Date(Date.parse(f.q.windowStart) + 86400000).toISOString() },
              end: { dateTime: new Date(Date.parse(f.q.windowEnd) + 86400000).toISOString() },
            }
    }
    f.provider.listCalendars = async () => [
      { id: f.q.calendarId, summary: 'Agenda', timeZone: 'Europe/Paris', accessRole: 'writer' },
    ]
    f.store.observe = async (_q, id, result) => {
      expect(id).toBe(bookingId)
      if (status === 'all-day')
        expect(result).toMatchObject({ start: '2026-10-24T22:00:00.000Z', end: '2026-10-25T23:00:00.000Z' })
      f.calls.push('observe')
      return true
    }
    await runCalendarOnce(f.store, calendarFixtureConfig, new AbortController().signal, f.provider)
    expect(f.calls.slice(0, 4)).toEqual(['claim', 'GET', 'observe', 'freeBusy'])
  }
  expect(calendarMidnight('2026-10-25', 'Europe/Paris')).toBe('2026-10-24T22:00:00.000Z')
})
test('an existing refresh owner prevents a second token exchange or any provider write', async () => {
  const f = fixture()
  f.q = {
    ...f.q,
    tokenEnvelope: encryptCalendarTokens(
      calendarFixtureConfig,
      { workspaceId: f.q.workspaceId, connectionId: f.q.connectionId },
      {
        accessToken: 'expired',
        refreshToken: 'refresh',
        expiresAt: Date.now() - 1,
        grantedScopes: ['openid'],
      },
    ),
  }
  f.store.claimTokens = async () => null
  await runCalendarOnce(f.store, calendarFixtureConfig, new AbortController().signal, f.provider)
  expect(f.finishes[0]?.state).toBe('retry')
  expect(f.calls).toEqual(['claim', 'close'])
})
