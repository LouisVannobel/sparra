import { expect, test, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  runCalendarOnce,
  calendarMidnight,
  type CalendarBookingProvider,
} from '../../src/modules/calendar/worker.server'
import type { CalendarStore, CalendarWork, CalendarFinish } from '../../src/modules/calendar/store.server'
import { calendarFixtureConfig, calendarFixturePolicy } from '../helpers/calendar-fixture'
import { decryptCalendarTokens, encryptCalendarTokens } from '../../src/modules/calendar/token-crypto.server'
import { CalendarProviderError, GOOGLE_CALENDAR_SCOPES, createGoogleCalendarClient } from '../../src/modules/calendar/google.server'
import { startCalendarProtocolPeer } from '../helpers/calendar-protocol-peer.mjs'
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

test.each([false,true])('shutdown during claim settles possible-send=%s before any provider work',async possible=>{
  const f=fixture(possible),shutdown=new AbortController()
  f.store.claim=async()=>{shutdown.abort();return f.q}
  await runCalendarOnce(f.store,calendarFixtureConfig,shutdown.signal,f.provider)
  expect(f.calls).toEqual([])
  expect(f.finishes).toEqual([{state:possible?'unknown':'retry'}])
})

test('shutdown during claim still rejects an unresolved local settlement',async()=>{
  const f=fixture(),shutdown=new AbortController()
  f.store.claim=async()=>{shutdown.abort();return f.q}
  f.store.finish=async()=>{throw new Error('Fixture settlement failure')}
  await expect(runCalendarOnce(f.store,calendarFixtureConfig,shutdown.signal,f.provider)).rejects.toThrow('Calendar settlement unresolved')
  expect(f.calls).toEqual(['read'])
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
test('lost deferred-finish acknowledgement recognizes the durable pending state', async () => {
  const f = fixture()
  f.provider.freeBusy = async () => {
    throw new CalendarProviderError('unavailable')
  }
  f.store.finish = async (_q, result) => {
    expect(result.state).toBe('retry')
    f.q = { ...f.q, state: 'pending' }
    throw new Error('Lost commit')
  }
  await expect(
    runCalendarOnce(f.store, calendarFixtureConfig, new AbortController().signal, f.provider),
  ).resolves.toBe(true)
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

function expire(f:ReturnType<typeof fixture>) {
  f.q={...f.q,tokenEnvelope:encryptCalendarTokens(calendarFixtureConfig,{workspaceId:f.q.workspaceId,connectionId:f.q.connectionId},{accessToken:'expired',refreshToken:'old-refresh',expiresAt:Date.now()-1,grantedScopes:['openid']})}
}
const refreshedScopes=['openid','https://www.googleapis.com/auth/userinfo.email',...GOOGLE_CALENDAR_SCOPES]
test.each([false,true])('expired worker token refresh uses verified subject and %s rotated refresh grant',async rotated=>{
  const f=fixture();expire(f)
  const refreshed={accessToken:'new-access',tokenType:'Bearer' as const,expiresIn:3600,grantedScopes:refreshedScopes,...(rotated?{refreshToken:'new-refresh'}:{})}
  f.provider.refreshTokens=async token=>{expect(token).toBe('old-refresh');f.calls.push('refresh');return refreshed}
  f.provider.userInfo=async token=>{expect(token).toBe('new-access');f.calls.push('identity');return {sub:'subject',email:'owner@example.test',emailVerified:true}}
  f.provider.freeBusy=async token=>{expect(token).toBe('new-access');f.calls.push('freeBusy');return []}
  f.store.finishTokens=async (_q,_work,envelope,lost)=>{expect(lost).toBe(false);expect(envelope).not.toBeNull();f.q={...f.q,tokenEnvelope:envelope};f.calls.push('finishTokens');return true}
  await runCalendarOnce(f.store,calendarFixtureConfig,new AbortController().signal,f.provider)
  const tokens=decryptCalendarTokens(calendarFixtureConfig,{workspaceId:f.q.workspaceId,connectionId:f.q.connectionId},f.q.tokenEnvelope!)
  expect(tokens.refreshToken).toBe(rotated?'new-refresh':'old-refresh')
  expect(f.calls).toEqual(['claim','read','refresh','identity','finishTokens','freeBusy','prepare','POST','close'])
  expect(f.finishes[0]?.state).toBe('confirmed')
})
test.each(['retained','rotated'] as const)('expired worker token uses owned Google TLS refresh with %s grant and one insert',async grant=>{
  const peer=await startCalendarProtocolPeer()
  let client:ReturnType<typeof createGoogleCalendarClient>|undefined
  try {
    peer.setRefreshMode(grant)
    const f=fixture()
    f.q={...f.q,calendarId:'fixture-calendar',googleSubject:'calendar-owner',
      tokenEnvelope:encryptCalendarTokens(calendarFixtureConfig,{workspaceId:f.q.workspaceId,connectionId:f.q.connectionId},{
        accessToken:'expired-access',refreshToken:'fixture-refresh',expiresAt:Date.now()-1,grantedScopes:['openid']})}
    f.store.finishTokens=async (_q,_work,envelope,lost)=>{
      expect(lost).toBe(false)
      expect(envelope).not.toBeNull()
      f.q={...f.q,tokenEnvelope:envelope}
      return true
    }
    client=createGoogleCalendarClient(calendarFixtureConfig,new AbortController().signal,Date.now()+10000)
    await runCalendarOnce(f.store,calendarFixtureConfig,new AbortController().signal,client)
    expect(f.finishes[0]?.state).toBe('confirmed')
    const tokens=decryptCalendarTokens(calendarFixtureConfig,{workspaceId:f.q.workspaceId,connectionId:f.q.connectionId},f.q.tokenEnvelope!)
    expect(tokens.accessToken).toBe('fixture-access')
    expect(tokens.refreshToken).toBe(grant==='rotated'?'fixture-refresh-rotated':'fixture-refresh')
    const requests=peer.requests()
    expect(requests.map(value=>value.path)).toEqual([
      '/token','/v1/userinfo','/calendar/v3/freeBusy','/calendar/v3/calendars/fixture-calendar/events?sendUpdates=none'])
    expect(new URLSearchParams(requests[0]!.body).get('grant_type')).toBe('refresh_token')
    expect(requests.filter(value=>value.method==='POST'&&value.path.includes('/events?'))).toHaveLength(1)
    await expect.poll(()=>peer.evidence()).toMatchObject({activeClientSockets:0,activeSockets:0,activeRequests:0,disallowed:0})
  } finally {await client?.close();await peer.close()}
})
test.each(['missing-grant','foreign-subject','unverified-email'] as const)('worker refresh refuses %s before provider write',async cause=>{
  const f=fixture();expire(f)
  f.provider.refreshTokens=async()=>({accessToken:'new-access',tokenType:'Bearer',expiresIn:3600,grantedScopes:cause==='missing-grant'?['openid','email']:refreshedScopes})
  f.provider.userInfo=async()=>({sub:cause==='foreign-subject'?'foreign':'subject',email:'owner@example.test',emailVerified:cause!=='unverified-email'})
  f.store.finishTokens=async (_q,_work,envelope,lost)=>{expect(envelope).toBeNull();expect(lost).toBe(true);f.calls.push('finishTokens');return true}
  await runCalendarOnce(f.store,calendarFixtureConfig,new AbortController().signal,f.provider)
  expect(f.calls).not.toContain('POST')
  expect(f.calls).toContain('finishTokens')
  expect(f.finishes[0]?.state).toBe('retry')
})
test('worker accepts a refreshed token installed by the owner after its refresh claim',async()=>{
  const f=fixture();expire(f)
  f.store.read=async()=>{f.calls.push('read');f.q={...f.q,tokenEnvelope:encryptCalendarTokens(calendarFixtureConfig,{workspaceId:f.q.workspaceId,connectionId:f.q.connectionId},{accessToken:'owner-access',refreshToken:'owner-refresh',expiresAt:Date.now()+3600000,grantedScopes:refreshedScopes})};return f.q}
  f.store.finishTokens=async (_q,_work,envelope,lost)=>{expect(envelope).toBeNull();expect(lost).toBe(false);f.calls.push('finishTokens');return true}
  f.provider.freeBusy=async token=>{expect(token).toBe('owner-access');f.calls.push('freeBusy');return []}
  await runCalendarOnce(f.store,calendarFixtureConfig,new AbortController().signal,f.provider)
  expect(f.calls).toEqual(['claim','read','finishTokens','freeBusy','prepare','POST','close'])
})
test.each([false,true])('worker refresh lost settlement acknowledgement requires matching envelope=%s',async matches=>{
  const f=fixture();expire(f)
  f.provider.refreshTokens=async()=>({accessToken:'new-access',tokenType:'Bearer',expiresIn:3600,grantedScopes:refreshedScopes})
  f.store.finishTokens=async (_q,_work,envelope)=>{if(envelope&&matches)f.q={...f.q,tokenEnvelope:envelope};throw new Error('Lost token finish acknowledgement')}
  await runCalendarOnce(f.store,calendarFixtureConfig,new AbortController().signal,f.provider)
  expect(f.calls.includes('POST')).toBe(matches)
  expect(f.finishes[0]?.state).toBe(matches?'confirmed':'retry')
})

test.each(['unknown', 'cancelled', 'moved'] as const)(
  'search selects three genuinely free slots after refreshing %s local holds',
  async (observation) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-26T07:00:00Z'))
    try {
      const f = fixture(),
        bookingId = randomUUID(),
        policy = calendarFixturePolicy()
      f.q = {
        ...f.q,
        kind: 'find_slots',
        eventId: null,
        policy: { ...policy, bufferMinutes: 15, noticeMinutes: 0 },
        windowStart: '2026-10-26T08:00:00Z',
        windowEnd: '2026-10-26T11:00:00Z',
        blockers: [
          {
            id: bookingId,
            eventId: 'held',
            calendarId: f.q.calendarId,
            googleSubject: f.q.googleSubject,
            state: observation === 'unknown' ? 'unknown' : 'confirmed',
            start: '2026-10-26T08:00:00Z',
            end: '2026-10-26T09:00:00Z',
            observedState: observation === 'unknown' ? null : 'confirmed',
          },
        ],
      }
      f.provider.getEvent = async () =>
        observation === 'cancelled'
          ? { id: 'held', status: 'cancelled' }
          : {
              id: 'held',
              status: 'confirmed',
              start: { dateTime: '2026-10-26T09:00:00Z' },
              end: { dateTime: '2026-10-26T09:30:00Z' },
            }
      f.store.observe = async () => {
        f.q = {
          ...f.q,
          blockers:
            observation === 'cancelled'
              ? []
              : [{ ...f.q.blockers[0]!, start: '2026-10-26T09:00:00Z', end: '2026-10-26T09:45:00Z' }],
        }
        return true
      }
      await runCalendarOnce(f.store, calendarFixtureConfig, new AbortController().signal, f.provider)
      const result = f.finishes[0]
      expect(result?.state).toBe('offered')
      if (result?.state !== 'offered') throw new Error('Expected offers')
      expect(result.slots.map((slot) => slot.start)).toEqual(
        observation === 'unknown'
          ? ['2026-10-26T09:00:00.000Z', '2026-10-26T09:15:00.000Z', '2026-10-26T09:30:00.000Z']
          : observation === 'cancelled'
            ? ['2026-10-26T08:00:00.000Z', '2026-10-26T08:15:00.000Z', '2026-10-26T08:30:00.000Z']
            : ['2026-10-26T08:00:00.000Z', '2026-10-26T08:15:00.000Z', '2026-10-26T09:45:00.000Z'],
      )
      expect(f.calls).toContain('read')
    } finally {
      vi.useRealTimers()
    }
  },
)

test('shutdown cancellation settles safely but transport closure and unresolved settlement still reject', async () => {
  for (const failure of ['none', 'close', 'settlement']) {
    const f = fixture(),
      controller = new AbortController()
    f.provider.freeBusy = async () => {
      controller.abort()
      throw new CalendarProviderError('unavailable')
    }
    if (failure === 'close')
      f.provider.close = async () => {
        throw new Error('Transport did not close')
      }
    if (failure === 'settlement') {
      f.store.finish = async () => {
        throw new Error('Settlement failed')
      }
      f.store.read = async () => {
        throw new Error('Readback failed')
      }
    }
    const pending = runCalendarOnce(f.store, calendarFixtureConfig, controller.signal, f.provider)
    if (failure === 'none') await expect(pending).resolves.toBe(true)
    else await expect(pending).rejects.toThrow()
    expect(f.calls).not.toContain('POST')
  }
})
