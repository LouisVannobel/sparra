import { once } from 'node:events'
import { createConnection, createServer, type Socket } from 'node:net'
import { expect, test } from 'vitest'

test('wire listener binds a reachable loopback port and closes its tracked connections', async () => {
  const { listenWire } = await import('../../fixtures/db/wire-listener')
  const sockets = new Set<Socket>()
  const clients: Socket[] = []
  const server = createServer(socket => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
  })
  const listener = await listenWire(server, sockets)
  try {
    expect(server.address()).toMatchObject({ address: '127.0.0.1', family: 'IPv4', port: listener.port })
    expect(listener.port).toBeGreaterThan(0)
    expect(listener.port).toBeLessThanOrEqual(65535)
    for (let index = 0; index < 2; index++) {
      const accepted = once(server, 'connection')
      const client = createConnection({ host: '127.0.0.1', port: listener.port })
      clients.push(client)
      await Promise.all([accepted, once(client, 'connect')])
    }
    expect(sockets.size).toBe(2)
    const tracked = [...sockets]
    const disconnected = clients.map(client => once(client, 'close'))
    const serverDisconnected = tracked.map(socket => once(socket, 'close'))
    const closing = listener.close()
    expect(tracked.every(socket => socket.destroyed)).toBe(true)
    await closing
    await Promise.all([...disconnected, ...serverDisconnected])
    expect(server.listening).toBe(false)
    expect(sockets.size).toBe(0)
    await expect(listener.close()).resolves.toBeUndefined()
    const refused = createConnection({ host: '127.0.0.1', port: listener.port })
    clients.push(refused)
    const [error] = await once(refused, 'error')
    expect(error).toHaveProperty('code', 'ECONNREFUSED')
  } finally {
    for (const client of clients) client.destroy()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(done => server.close(() => done()))
  }
})
