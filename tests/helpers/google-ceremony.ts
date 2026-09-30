import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import type { createApplicationAuth } from '../../src/modules/auth/auth.server'
import type { AuthTransactions } from '../../src/platform/db/transactions.server'
import type { startGoogleProtocolPeer } from './google-protocol-peer.mjs'

// Same controlled token protocol as google-auth.test.ts: BA owns callback,
// adapter admission, session issuance, cookies and the validated private reader.
export function googleCeremony(auth: ReturnType<typeof createApplicationAuth>, owner: AuthTransactions, peer: Awaited<ReturnType<typeof startGoogleProtocolPeer>>) {
  const origin = 'http://localhost:3000'
  let ip = 1
  const cookies = (headers: Headers) => headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const request = (path: string, method: string, cookie = '') => {
    const incoming = Object.assign(new Request(origin+path, {
      method, headers: { origin, cookie, 'x-real-ip': `192.0.2.${ip++}` },
    }), { runtime: { node: { req: { socket: { remoteAddress: '127.0.0.1' } } } } })
    Object.defineProperty(incoming, 'appAuthDeadlineAtMs', { value: Date.now() + 10_000 })
    return incoming
  }
  return async () => {
    const subject = randomUUID(), start = await auth.beginGoogleSignIn(request('/_serverFn/fixture', 'POST'))
    const url = new URL(start.url)
    owner.assertNoActiveAuthTransaction()
    const code = peer.register(start.url, subject, { name: 'Workspace protocol fixture' })
    const response = await auth.callback(request(`/api/auth/callback/google?code=${code}&state=${url.searchParams.get('state')}`, 'GET', cookies(start.headers)))
    expect(response.status).toBe(302)
    const cookie = cookies(response.headers), accountRequest = request('/account', 'GET', cookie)
    const principal = await auth.requirePrincipal(accountRequest)
    return { principal, cookie, headers: accountRequest.headers }
  }
}
