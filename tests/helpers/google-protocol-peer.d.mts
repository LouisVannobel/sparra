export type GoogleFixtureOptions = {
  scenario?: string; email?: string; name?: string; alg?: string
  claims?: Record<string, unknown>; omitClaims?: string[]; fields?: Record<string, unknown>
}
export function startGoogleProtocolPeer(options?: { ports?: number[]; wrongHost?: boolean; nativeDns?: boolean; family?: 4 | 6; holdTls?: boolean }): Promise<{
  register(url: string, subject?: string, options?: GoogleFixtureOptions): string
  allowPort(port: number): void
  holdHandoff(): void
  releaseHandoff(): void
  onRequestCreated(call: ((request: import('node:http').ClientRequest) => void) | undefined): void
  setMode(mode: string): void
  setDnsMode(mode: string): void
  onPost(call: (() => void) | undefined): void
  evidence(): { tls: number; posts: number; pkce: number; disallowed: number; dnsStarted: number; dnsSettled: number; socketCloses: number; activeSockets: number; pendingAttempts: number; pendingHandoffs: number; nativeDns: boolean; clientSockets: number; clientCloses: number; requests: number; requestCloses: number; activeClientSockets: number; activeRequests: number; emergencyCleanup: boolean; attemptedFamilies: number[]; requestHeaderBytes: number[]; requestSocketAssignments: number }
  close(): Promise<void>
}>
