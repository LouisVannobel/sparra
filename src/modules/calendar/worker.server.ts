import type { CalendarStore, CalendarWork, CalendarFinish } from './store.server'
import type { CalendarConfig } from './config.server'
import {
  createGoogleCalendarClient,
  CalendarProviderError,
  GOOGLE_CALENDAR_SCOPES,
  type GoogleEvent,
} from './google.server'
import { decryptCalendarTokens, encryptCalendarTokens } from './token-crypto.server'
import { findCalendarSlots } from './availability.server'
export type CalendarBookingProvider = Pick<
  ReturnType<typeof createGoogleCalendarClient>,
  'freeBusy' | 'insertEvent' | 'getEvent' | 'refreshTokens' | 'userInfo' | 'listCalendars' | 'close'
>
function verifiedCreation(command: CalendarWork, event: GoogleEvent) {
  if (
    event.id !== command.eventId ||
    event.status !== 'confirmed' ||
    !('dateTime' in event.start) ||
    !('dateTime' in event.end) ||
    Date.parse(event.start.dateTime) !== Date.parse(command.windowStart) ||
    Date.parse(event.end.dateTime) !== Date.parse(command.windowEnd) ||
    event.extendedProperties?.private.sparraOperationId !== command.id
  )
    throw new CalendarProviderError('unknown')
  return {
    state: 'confirmed' as const,
    eventId: event.id,
    operationId: command.id,
    start: command.windowStart,
    end: command.windowEnd,
  }
}
/** All-day edits use the observed destination calendar zone. */
export function calendarMidnight(date: string, timeZone: string): string {
  const format = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }),
    matches: number[] = []
  const center = Date.parse(date + 'T00:00:00Z')
  for (let t = center - 86400000; t <= center + 86400000; t += 60000) {
    const p = Object.fromEntries(format.formatToParts(t).map((p) => [p.type, p.value]))
    if (`${p.year}-${p.month}-${p.day}` === date && p.hour === '00' && p.minute === '00') matches.push(t)
  }
  if (matches.length !== 1) throw new CalendarProviderError('rejected')
  return new Date(matches[0]!).toISOString()
}
async function calendarAccessToken(
  store: CalendarStore,
  config: CalendarConfig,
  command: CalendarWork,
  provider: CalendarBookingProvider,
) {
  if (!command.tokenEnvelope) throw new CalendarProviderError('unauthorized')
  const binding = { workspaceId: command.workspaceId, connectionId: command.connectionId }
  let tokens = decryptCalendarTokens(config, binding, command.tokenEnvelope)
  if (tokens.expiresAt > Date.now() + 60000) return tokens.accessToken
  const workId = await store.claimTokens(command)
  if (!workId) throw new CalendarProviderError('unavailable')
  try {
    const current = await store.read(command)
    if (!current?.tokenEnvelope) throw new CalendarProviderError('unauthorized')
    tokens = decryptCalendarTokens(config, binding, current.tokenEnvelope)
    if (tokens.expiresAt > Date.now() + 60000) {
      if (!(await store.finishTokens(command, workId, null, false)))
        throw new CalendarProviderError('unavailable')
      return tokens.accessToken
    }
    const result = await provider.refreshTokens(tokens.refreshToken)
    if (
      !result.expiresIn ||
      !result.grantedScopes.includes('openid') ||
      !result.grantedScopes.some(
        (value) => value === 'email' || value === 'https://www.googleapis.com/auth/userinfo.email',
      ) ||
      !GOOGLE_CALENDAR_SCOPES.every((value) => result.grantedScopes.includes(value))
    )
      throw new CalendarProviderError('unauthorized')
    const identity = await provider.userInfo(result.accessToken)
    if (identity.sub !== command.googleSubject || !identity.emailVerified)
      throw new CalendarProviderError('unauthorized')
    const envelope = encryptCalendarTokens(config, binding, {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken ?? tokens.refreshToken,
      expiresAt: Date.now() + result.expiresIn * 1000,
      grantedScopes: result.grantedScopes,
    })
    let settled = false
    try {
      settled = await store.finishTokens(command, workId, envelope, false)
    } catch {
      settled = (await store.read(command))?.tokenEnvelope === envelope
    }
    if (!settled) throw new CalendarProviderError('unavailable')
    return result.accessToken
  } catch (error) {
    await store
      .finishTokens(
        command,
        workId,
        null,
        error instanceof CalendarProviderError && error.code === 'unauthorized',
      )
      .catch(() => {})
    throw error
  }
}
async function reconcileConfirmedHolds(
  store: CalendarStore,
  command: CalendarWork,
  provider: CalendarBookingProvider,
  token: string,
) {
  for (const blocker of command.blockers) {
    if (
      blocker.state !== 'confirmed' ||
      blocker.googleSubject !== command.googleSubject ||
      blocker.calendarId !== command.calendarId
    )
      continue
    const event = await provider.getEvent(token, {
      calendarId: blocker.calendarId,
      eventId: blocker.eventId,
    })
    if (event.status === 'cancelled') {
      await store.observe(command, blocker.id, { eventId: event.id, status: 'cancelled' })
      continue
    }
    let start: string, end: string
    if ('dateTime' in event.start && 'dateTime' in event.end) {
      start = event.start.dateTime
      end = event.end.dateTime
    } else if ('date' in event.start && 'date' in event.end) {
      const calendar = (await provider.listCalendars(token)).find((value) => value.id === command.calendarId)
      if (!calendar) throw new CalendarProviderError('unavailable')
      start = calendarMidnight(event.start.date, calendar.timeZone)
      end = calendarMidnight(event.end.date, calendar.timeZone)
    } else throw new CalendarProviderError('rejected')
    if (!(await store.observe(command, blocker.id, { eventId: event.id, status: event.status, start, end })))
      throw new CalendarProviderError('unavailable')
  }
}

export async function runCalendarOnce(
  store: CalendarStore,
  config: CalendarConfig,
  signal: AbortSignal,
  suppliedProvider?: CalendarBookingProvider,
): Promise<boolean> {
  if (signal.aborted) return false
  // Join the bounded local claim on shutdown; cancelling it can turn an idle
  // rollback into an ambiguous transaction error. No provider work starts here.
  const claimed = await store.claim()
  if (!claimed) return false
  const command: CalendarWork = claimed
  let possible = command.possibleSendFence !== null
  async function finish(result: CalendarFinish) {
    try {
      if (!(await store.finish(command, result))) throw new Error('Calendar settlement refused')
    } catch {
      const read = await store.read(command)
      const expectedState = result.state === 'retry' ? 'pending' : result.state
      if (read?.fence !== command.fence || read.state !== expectedState)
        throw new Error('Calendar settlement unresolved')
    }
  }
  if (signal.aborted) {
    await finish({ state: possible ? 'unknown' : 'retry' })
    return true
  }
  const provider =
    suppliedProvider ??
    createGoogleCalendarClient(
      config,
      signal,
      Math.min(Date.now() + 30000, Date.parse(command.leaseUntil ?? '')),
    )
  try {
    if (!possible && (Date.now() >= Date.parse(command.firstSendDeadline) || !command.callId)) {
      await finish({ state: 'refused' })
      return true
    }
    const token = await calendarAccessToken(store, config, command, provider)
    if (possible) {
      await finish(
        verifiedCreation(
          command,
          await provider.getEvent(token, { calendarId: command.calendarId, eventId: command.eventId! }),
        ),
      )
      return true
    }
    const policy = command.policy
    if (!policy) throw new CalendarProviderError('rejected')
    await reconcileConfirmedHolds(store, command, provider, token)
    const buffer = policy.bufferMinutes * 60000
    const busy = await provider.freeBusy(token, {
      calendarId: command.calendarId,
      timeMin: new Date(Date.parse(command.windowStart) - buffer).toISOString(),
      timeMax: new Date(Date.parse(command.windowEnd) + buffer).toISOString(),
    })
    if (command.kind === 'find_slots') {
      // Observations and concurrent admissions may have changed the holds while
      // Google was queried. SQL still excludes any later race under its lock.
      const current = await store.read(command)
      if (!current || current.fence !== command.fence || current.state !== 'running') {
        throw new CalendarProviderError('unavailable')
      }
      await finish({
        state: 'offered',
        slots: findCalendarSlots(policy, {
          serviceId: command.serviceId,
          windowStart: command.windowStart,
          windowEnd: command.windowEnd,
          now: Date.now(),
          busy,
          holds: current.blockers.map((hold) => ({ start: hold.start, end: hold.end })),
        }),
      })
      return true
    }
    if (
      busy.some(
        (value) =>
          Date.parse(command.windowStart) < Date.parse(value.end) + buffer &&
          Date.parse(command.windowEnd) + buffer > Date.parse(value.start),
      )
    ) {
      await finish({ state: 'refused' })
      return true
    }
    let prepared = false
    try {
      prepared = await store.prepare(command)
    } catch {
      const read = await store.read(command)
      prepared =
        read?.fence === command.fence && read.possibleSendFence === command.fence && read.state === 'unknown'
    }
    if (!prepared) {
      await finish({ state: 'refused' })
      return true
    }
    possible = true
    // Only this in-process attempt may send; a replacement claim can only GET.
    if (
      signal.aborted ||
      Date.now() >= Date.parse(command.firstSendDeadline) ||
      Date.now() >= Date.parse(command.leaseUntil ?? '')
    )
      throw new CalendarProviderError('unknown')
    const event = await provider.insertEvent(token, {
      calendarId: command.calendarId,
      event: {
        id: command.eventId!,
        summary: command.serviceName,
        description: config.origin + '/app/demandes/' + command.callId,
        start: { dateTime: command.windowStart, timeZone: policy.timeZone },
        end: { dateTime: command.windowEnd, timeZone: policy.timeZone },
        extendedProperties: { private: { sparraOperationId: command.id } },
      },
    })
    await finish(verifiedCreation(command, event))
  } catch {
    const expired = Date.now() >= Date.parse(command.firstSendDeadline)
    const state = possible ? 'unknown' : expired ? 'refused' : 'retry'
    await finish({ state })
  } finally {
    await provider.close()
  }
  return true
}
