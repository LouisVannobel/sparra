import { createServer, type Socket } from 'node:net'
import { listenWire } from './wire-listener'

type RedisCommand = { status: 'pending' } | { status: 'complete'; command: string[]; remainder: Buffer }

export function parseRedisCommand(bytes: Buffer): RedisCommand {
  let cursor = bytes.indexOf('\r\n')
  if (cursor < 0) return { status: 'pending' }
  const count = Number(bytes.subarray(1, cursor).toString())
  cursor += 2
  const command: string[] = []
  for (let index = 0; index < count; index++) {
    const end = bytes.indexOf('\r\n', cursor)
    if (end < 0) return { status: 'pending' }
    const length = Number(bytes.subarray(cursor + 1, end).toString())
    if (bytes.length < end + 2 + length + 2) return { status: 'pending' }
    command.push(bytes.subarray(end + 2, end + 2 + length).toString())
    cursor = end + 2 + length + 2
  }
  return { status: 'complete', command, remainder: bytes.subarray(cursor) }
}

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
    let bytes: Buffer = Buffer.alloc(0)
    socket.on('data', chunk => {
      bytes = Buffer.concat([bytes, typeof chunk === 'string' ? Buffer.from(chunk) : chunk])
      while (bytes.length) {
        const parsed = parseRedisCommand(bytes)
        if (parsed.status === 'pending') return
        const command = parsed.command
        bytes = parsed.remainder
        commands.push(command)
        if (command[0] === 'EVAL') reply(command, socket)
        else if (stallHandshake !== true && !(stallHandshake === 'reconnect' && connectionNumber > 1)) socket.write('+OK\r\n')
      }
    })
  })
  const listener = await listenWire(server, sockets)
  return {
    url: `redis://:fixture-only@127.0.0.1:${listener.port}`,
    commands, sockets,
    close: listener.close,
  }
}

export function tuple(...values: number[]) {
  return `*${values.length}\r\n${values.map(value => `:${value}\r\n`).join('')}`
}
