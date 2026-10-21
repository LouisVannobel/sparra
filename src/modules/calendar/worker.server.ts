import type { CalendarStore, CalendarWork, CalendarFinish } from './store.server'
import type { CalendarConfig } from './config.server'
import {
  createGoogleCalendarClient,
  CalendarProviderError,
  hasRequiredCalendarGrants,
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
async function refreshCalendarGrant(store:CalendarStore,config:CalendarConfig,command:CalendarWork,provider:CalendarBookingProvider,workId:string,tokens:ReturnType<typeof decryptCalendarTokens>):Promise<string> {
  const result=await provider.refreshTokens(tokens.refreshToken)
  if(!result.expiresIn||!hasRequiredCalendarGrants(result.grantedScopes))throw new CalendarProviderError('unauthorized')
  const identity=await provider.userInfo(result.accessToken)
  if(identity.sub!==command.googleSubject||!identity.emailVerified)throw new CalendarProviderError('unauthorized')
  const envelope=encryptCalendarTokens(config,{workspaceId:command.workspaceId,connectionId:command.connectionId},{
    accessToken:result.accessToken,refreshToken:result.refreshToken??tokens.refreshToken,
    expiresAt:Date.now()+result.expiresIn*1000,grantedScopes:result.grantedScopes,
  })
  let settled=false
  try {settled=await store.finishTokens(command,workId,envelope,false)}
  catch {settled=(await store.read(command))?.tokenEnvelope===envelope}
  if(!settled)throw new CalendarProviderError('unavailable')
  return result.accessToken
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
    return await refreshCalendarGrant(store,config,command,provider,workId,tokens)
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
async function observedCalendarEvent(command:CalendarWork,provider:CalendarBookingProvider,token:string,event:GoogleEvent) {
  if(event.status==='cancelled')return {eventId:event.id,status:'cancelled' as const}
  if('dateTime' in event.start&&'dateTime' in event.end)
    return {eventId:event.id,status:event.status,start:event.start.dateTime,end:event.end.dateTime}
  if('date' in event.start&&'date' in event.end) {
    const calendar=(await provider.listCalendars(token)).find(value=>value.id===command.calendarId)
    if(!calendar)throw new CalendarProviderError('unavailable')
    return {eventId:event.id,status:event.status,start:calendarMidnight(event.start.date,calendar.timeZone),end:calendarMidnight(event.end.date,calendar.timeZone)}
  }
  throw new CalendarProviderError('rejected')
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
    const observation=await observedCalendarEvent(command,provider,token,event)
    if(observation.status==='cancelled') {
      await store.observe(command,blocker.id,observation)
      continue
    }
    if (!(await store.observe(command, blocker.id, observation)))
      throw new CalendarProviderError('unavailable')
  }
}

async function queryCalendarAvailability(store:CalendarStore,command:CalendarWork,provider:CalendarBookingProvider,token:string) {
  const policy=command.policy
  if(!policy)throw new CalendarProviderError('rejected')
  await reconcileConfirmedHolds(store,command,provider,token)
  const buffer=policy.bufferMinutes*60000
  const busy=await provider.freeBusy(token,{
    calendarId:command.calendarId,
    timeMin:new Date(Date.parse(command.windowStart)-buffer).toISOString(),
    timeMax:new Date(Date.parse(command.windowEnd)+buffer).toISOString(),
  })
  return {policy,buffer,busy}
}

async function offeredCalendarSlots(store:CalendarStore,command:CalendarWork,policy:NonNullable<CalendarWork['policy']>,busy:Awaited<ReturnType<CalendarBookingProvider['freeBusy']>>) {
  // A fresh read follows freeBusy; observations and admissions may have changed holds.
  const current=await store.read(command)
  if(!current||current.fence!==command.fence||current.state!=='running')throw new CalendarProviderError('unavailable')
  return findCalendarSlots(policy,{serviceId:command.serviceId,windowStart:command.windowStart,windowEnd:command.windowEnd,now:Date.now(),busy,
    holds:current.blockers.map(hold=>({start:hold.start,end:hold.end}))})
}

function overlapsCalendarBooking(command:CalendarWork,busy:Awaited<ReturnType<CalendarBookingProvider['freeBusy']>>,buffer:number) {
  return busy.some(value=>Date.parse(command.windowStart)<Date.parse(value.end)+buffer&&Date.parse(command.windowEnd)+buffer>Date.parse(value.start))
}

async function prepareCalendarBooking(store:CalendarStore,command:CalendarWork):Promise<boolean> {
  try {return await store.prepare(command)}
  catch {
    const read=await store.read(command)
    return read?.fence===command.fence&&read.possibleSendFence===command.fence&&read.state==='unknown'
  }
}
function canDispatchPreparedBooking(command:CalendarWork,signal:AbortSignal):boolean {
  return !signal.aborted&&Date.now()<Date.parse(command.firstSendDeadline)&&Date.now()<Date.parse(command.leaseUntil??'')
}
function failedCalendarWork(possible:boolean,command:CalendarWork):CalendarFinish {
  if(possible)return {state:'unknown'}
  return {state:Date.now()>=Date.parse(command.firstSendDeadline)?'refused':'retry'}
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
    const {policy,buffer,busy}=await queryCalendarAvailability(store,command,provider,token)
    if (command.kind === 'find_slots') {
      await finish({state:'offered',slots:await offeredCalendarSlots(store,command,policy,busy)})
      return true
    }
    if (overlapsCalendarBooking(command,busy,buffer)) {
      await finish({ state: 'refused' })
      return true
    }
    const prepared=await prepareCalendarBooking(store,command)
    if (!prepared) {
      await finish({ state: 'refused' })
      return true
    }
    possible = true
    // Only this in-process attempt may send; a replacement claim can only GET.
    if(!canDispatchPreparedBooking(command,signal))throw new CalendarProviderError('unknown')
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
    await finish(failedCalendarWork(possible,command))
  } finally {
    await provider.close()
  }
  return true
}
