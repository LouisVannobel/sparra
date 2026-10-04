import { createServer, type Socket } from 'node:net'
import { listenWire } from './wire-listener'

function int32(value: number) { const bytes = Buffer.alloc(4); bytes.writeInt32BE(value); return bytes }
function int16(value: number) { const bytes = Buffer.alloc(2); bytes.writeInt16BE(value); return bytes }
function message(type: string, ...payload: Buffer[]) {
  const body = Buffer.concat(payload)
  return Buffer.concat([Buffer.from(type), int32(body.length + 4), body])
}
const cstring = (value: string) => Buffer.from(value + '\0')
export type PgWireResult = { fields?: string[]; values?: string[]; command?: string; error?: string; stall?: boolean }

type PgFrame =
  | { kind: 'startup'; code: number; remainder: Buffer }
  | { kind: 'message'; type: string; body: Buffer; remainder: Buffer }

export function parsePgFrame(bytes: Buffer, started: boolean): PgFrame | undefined {
  if (!started) {
    if (bytes.length < 4) return
    const length = bytes.readInt32BE()
    if (bytes.length < length) return
    const code = bytes.readInt32BE(4)
    return { kind: 'startup', code, remainder: bytes.subarray(length) }
  }
  if (bytes.length < 5) return
  const length = bytes.readInt32BE(1)
  if (bytes.length < length + 1) return
  return {
    kind: 'message', type: String.fromCharCode(bytes[0]),
    body: bytes.subarray(5, length + 1), remainder: bytes.subarray(length + 1),
  }
}

// A controlled PostgreSQL wire transport for ownership/startup tests. It does
// not evaluate SQL, enforce constraints, or attest a real database/PgBouncer.
export async function pgWire(result: (sql: string) => PgWireResult = () => ({}), stallHandshakeAfter = Infinity) {
  const sockets = new Set<Socket>()
  const queries: string[] = []
  let connections = 0
  let closedConnections = 0
  const server = createServer(socket => {
    socket.setNoDelay(true)
    const connectionNumber = ++connections
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => { sockets.delete(socket); closedConnections++ })
    let bytes: Buffer = Buffer.alloc(0)
    let started = false
    let parsed = ''
    let status = 'I'
    let stalled = false
    function execute(sql: string) {
      queries.push(sql)
      const answer = result(sql)
      if (answer.stall) { stalled = true; return }
      if (sql.startsWith('BEGIN')) status = 'T'
      if (sql === 'COMMIT' || sql === 'ROLLBACK') status = 'I'
      if (answer.error) {
        status = 'E'
        socket.write(message('E', Buffer.from(`SERROR\0C23505\0M${answer.error}\0\0`)))
        return
      }
      let fields = answer.fields
      let values = answer.values
      if (!fields && sql.includes("current_setting('transaction_isolation')")) { fields = ['isolation']; values = ['read committed'] }
      if (!fields && sql.includes('server_version_num')) {
        fields = ['version', 'superuser', 'bypassrls', 'database_owner', 'table_owner', 'fsync', 'full_page_writes', 'synchronous_commit', 'schema_ready', 'workspace_ready']
        values = ['160015', 'false', 'false', 'false', 'false', 'on', 'on', 'on', 'true', 'true']
      }
      if (fields) {
        socket.write(message('T', int16(fields.length), ...fields.map(name => Buffer.concat([cstring(name), int32(0), int16(0), int32(25), int16(-1), int32(-1), int16(0)]))))
        socket.write(message('D', int16(fields.length), ...fields.map((_, index) => { const value = Buffer.from(values?.[index] ?? ''); return Buffer.concat([int32(value.length), value]) })))
      }
      socket.write(message('C', cstring(answer.command ?? (sql.startsWith('BEGIN') ? 'BEGIN' : sql === 'COMMIT' || sql === 'ROLLBACK' ? sql : 'SELECT 1'))))
    }
    function handleMessage(type: string, body: Buffer) {
      if (type === 'Q') { execute(body.toString().slice(0, -1)); if (!stalled) socket.write(message('Z', Buffer.from(status))) }
      if (type === 'P') { parsed = body.toString().split('\0')[1]; socket.write(message('1')) }
      if (type === 'B') socket.write(message('2'))
      if (type === 'E') execute(parsed)
      if (type === 'S' && !stalled) socket.write(message('Z', Buffer.from(status)))
      if (type === 'X') socket.end()
    }
    socket.on('data', chunk => {
      bytes = Buffer.concat([bytes, typeof chunk === 'string' ? Buffer.from(chunk) : chunk])
      while (bytes.length) {
        const frame = parsePgFrame(bytes, started)
        if (!frame) return
        bytes = frame.remainder
        if (frame.kind === 'startup') {
          if (frame.code === 80877103) { socket.write('N'); continue }
          started = true
          if (connectionNumber > stallHandshakeAfter) continue
          socket.write(Buffer.concat([message('R', int32(0)), message('K', int32(1234), int32(5678)), message('Z', Buffer.from('I'))]))
          continue
        }
        handleMessage(frame.type, frame.body)
      }
    })
  })
  const listener = await listenWire(server, sockets)
  return {
    url: `postgresql://fixture:fixture-only@127.0.0.1:${listener.port}/fixture`, queries, sockets,
    connections: () => connections, closedConnections: () => closedConnections,
    close: listener.close,
  }
}
