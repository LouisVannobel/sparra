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
