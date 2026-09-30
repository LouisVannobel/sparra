import { createServer, type Socket } from 'node:net'

// Controlled RESP transport, not a Redis implementation or live-store proof.
export async function redisWire(reply: (command: string[], socket: Socket) => void, stallHandshake: boolean | 'reconnect' = false) {
  const sockets = new Set<Socket>()
  const commands: string[][] = []
  let connections = 0
  const server = createServer(socket => {
    const connectionNumber = ++connections
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    let bytes = Buffer.alloc(0)
    socket.on('data', chunk => {
      bytes = Buffer.concat([bytes, typeof chunk === 'string' ? Buffer.from(chunk) : chunk])
      while (bytes.length) {
        let cursor = bytes.indexOf('\r\n')
        if (cursor < 0) return
        const count = Number(bytes.subarray(1, cursor).toString())
        cursor += 2
        const command: string[] = []
        for (let index = 0; index < count; index++) {
          const end = bytes.indexOf('\r\n', cursor)
          if (end < 0) return
          const length = Number(bytes.subarray(cursor + 1, end).toString())
          if (bytes.length < end + 2 + length + 2) return
          command.push(bytes.subarray(end + 2, end + 2 + length).toString())
          cursor = end + 2 + length + 2
        }
        bytes = bytes.subarray(cursor)
        commands.push(command)
        if (command[0] === 'EVAL') reply(command, socket)
        else if (stallHandshake !== true && !(stallHandshake === 'reconnect' && connectionNumber > 1)) socket.write('+OK\r\n')
      }
    })
  })
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  return {
    url: `redis://:fixture-only@127.0.0.1:${address.port}`,
    commands, sockets,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(done => server.close(() => done()))
    },
  }
}

export function tuple(...values: number[]) {
  return `*${values.length}\r\n${values.map(value => `:${value}\r\n`).join('')}`
}
