export function startCalendarProtocolPeer(): Promise<{
  close(): Promise<void>
  evidence(): { posts: number; tls: number; disallowed: number; activeClientSockets: number; activeSockets: number; activeRequests: number; emergencyCleanup: boolean }
  allowPort(value?: number): void
  requests(): Array<{ host: string; path: string; method: string; body: string }>
  events(): Array<{ id: string; status: string; summary: string; description: string }>
  setMode(value: 'normal' | 'hold-headers' | 'hold-body' | 'lose-insert' | 'hold-insert'): void
  changeEvent(id: string, change: 'cancelled' | 'moved'): void
  register(authorize: string, subject: string): string
}>
