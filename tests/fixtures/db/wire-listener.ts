import type { Server, Socket } from 'node:net'

export async function listenWire(server: Server, sockets: Set<Socket>) {
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  return {
    port: address.port,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(done => server.close(() => done()))
    },
  }
}
