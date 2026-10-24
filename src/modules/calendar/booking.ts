export type CalendarBookingDto = Readonly<{
  state: 'waiting_evidence' | 'pending' | 'running' | 'confirmed' | 'refused' | 'unknown'
  serviceName: string
  start: string
  end: string
  originalStart?: string
  timezone: string
  providerReference: string | null
  observedState: string | null
}>

export type CalendarBookingOutcome = 'confirmed' | 'cancelled'

export function calendarBookingOutcome(counts: { total: number; confirmed: number; cancelled: number }): CalendarBookingOutcome | null {
  if (counts.total !== 1) return null
  if (counts.cancelled === 1) return 'cancelled'
  return counts.confirmed === 1 ? 'confirmed' : null
}
