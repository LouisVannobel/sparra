import { Server, createServer } from 'node:net'
import { expect, test, vi } from 'vitest'
import { unusedLoopbackPortPair } from '../helpers/web-process'

test('reserves both distinct loopback ports before releasing either reservation and returns reusable ports', async () => {
  const reservations: Server[] = [], atClose: boolean[][] = []
  const emit = Server.prototype.emit, close = Server.prototype.close
  // SAFETY: observe and forward native lifecycle events; all TCP binds and
  // closes remain real. No allocator result or chosen port is substituted.
  vi.spyOn(Server.prototype, 'emit').mockImplementation(function (this: Server, event, ...args) {
    if (event === 'listening') reservations.push(this)
    return emit.call(this, event, ...args)
  })
  vi.spyOn(Server.prototype, 'close').mockImplementation(function (this: Server, callback) {
    atClose.push(reservations.map(server => server.listening))
    return close.call(this, callback)
  })
  let ports: readonly [number, number]
  let returnedClosed = false
  try { ports = await unusedLoopbackPortPair(); returnedClosed = reservations.every(server => !server.listening) }
  finally {
    vi.restoreAllMocks()
    for (const server of reservations) if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
  expect(atClose[0]).toEqual([true, true])
  expect(ports[0]).not.toBe(ports[1])
  expect(returnedClosed).toBe(true)
  const rebound = [createServer(), createServer()]
  try {
    await Promise.all(rebound.map((server, index) => new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(ports[index], '127.0.0.1', resolve)
    })))
    expect(rebound.every(server => server.listening)).toBe(true)
  } finally {
    await Promise.all(rebound.filter(server => server.listening).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))))
  }
})
