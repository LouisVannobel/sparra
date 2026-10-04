import { once } from 'node:events'
import { createConnection } from 'node:net'
import { Client } from 'pg'
import { expect, test } from 'vitest'

async function parser() {
  const module = await import('../../fixtures/db/pg-wire')
  expect('parsePgFrame' in module, 'PostgreSQL single-frame parser export').toBe(true)
  if (!('parsePgFrame' in module) || typeof module.parsePgFrame !== 'function') throw new Error('Missing PostgreSQL single-frame parser')
  return module.parsePgFrame
}

test('PostgreSQL framing reads one startup packet and leaves the following packet intact', async () => {
  const parsePgFrame = await parser()
  const first = parsePgFrame(Buffer.from('0000000804d2162f0000000800030000', 'hex'), false)

  expect(first).toEqual({
    kind: 'startup', code: 80877103, remainder: Buffer.from('0000000800030000', 'hex'),
  })
  if (!first) throw new Error('Expected complete SSL request')
  expect(parsePgFrame(first.remainder, false)).toEqual({
    kind: 'startup', code: 196608, remainder: Buffer.alloc(0),
  })
})

test('PostgreSQL framing preserves the UTF-8 body and the next typed message', async () => {
  const parsePgFrame = await parser()
  const first = parsePgFrame(Buffer.from('510000001453454c4543542027c3a9f09f949127005300000004', 'hex'), true)

  expect(first).toEqual({
    kind: 'message', type: 'Q', body: Buffer.from("SELECT 'é🔑'\0"), remainder: Buffer.from('5300000004', 'hex'),
  })
  if (!first) throw new Error('Expected complete query message')
  expect(parsePgFrame(first.remainder, true)).toEqual({
    kind: 'message', type: 'S', body: Buffer.alloc(0), remainder: Buffer.alloc(0),
  })
})

test('PostgreSQL framing waits at every incomplete startup and typed byte boundary', async () => {
  const parsePgFrame = await parser()
  for (const [frame, started] of [
    [Buffer.from('0000000800030000', 'hex'), false],
    [Buffer.from('510000001453454c4543542027c3a9f09f94912700', 'hex'), true],
  ] as const) {
    for (let end = 0; end < frame.length; end++) {
      const partial = frame.subarray(0, end)
      const original = Buffer.from(partial)
      expect(parsePgFrame(partial, started), `incomplete prefix of ${end} bytes`).toBeUndefined()
      expect(partial).toEqual(original)
    }
  }
})

test('PostgreSQL framing retains an incomplete following message until its next fragment', async () => {
  const parsePgFrame = await parser()
  const first = parsePgFrame(Buffer.from('5300000004510000000b53454c', 'hex'), true)

  expect(first).toEqual({
    kind: 'message', type: 'S', body: Buffer.alloc(0), remainder: Buffer.from('510000000b53454c', 'hex'),
  })
  if (!first) throw new Error('Expected complete sync message')
  expect(parsePgFrame(first.remainder, true)).toBeUndefined()
  expect(parsePgFrame(Buffer.concat([first.remainder, Buffer.from('ECT\0')]), true)).toEqual({
    kind: 'message', type: 'Q', body: Buffer.from('SELECT\0'), remainder: Buffer.alloc(0),
  })
})

test('PostgreSQL framing preserves signed lengths and the existing short startup RangeError', async () => {
  const parsePgFrame = await parser()

  expect(() => parsePgFrame(Buffer.from('00000004', 'hex'), false)).toThrow(RangeError)
  expect(parsePgFrame(Buffer.from('51ffffffff', 'hex'), true)).toEqual({
    kind: 'message', type: 'Q', body: Buffer.alloc(0), remainder: Buffer.from('51ffffffff', 'hex'),
  })
})

test('PostgreSQL wire consumes fragmented SSL and coalesced startup and query packets', async () => {
  const { pgWire } = await import('../../fixtures/db/pg-wire')
  const wire = await pgWire()
  const target = new URL(wire.url)
  const socket = createConnection({ host: '127.0.0.1', port: Number(target.port) })
  let response = Buffer.alloc(0)
  socket.on('data', chunk => { response = Buffer.concat([response, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]) })
  try {
    await once(socket, 'connect')
    socket.write(Buffer.from('000000', 'hex'))
    socket.write(Buffer.from('0804d2162f', 'hex'))
    await expect.poll(() => response.toString()).toBe('N')
    socket.write(Buffer.from('0000000800030000510000000b53454c', 'hex'))
    await expect.poll(() => response.length).toBe(29)
    expect(wire.queries).toEqual([])
    socket.write(Buffer.from('454354005300000004', 'hex'))
    await expect.poll(() => wire.queries).toEqual(['SELECT'])
    await expect.poll(() => response.toString('hex')).toBe(
      '4e5200000008000000004b0000000c000004d20000162e5a0000000549' +
      '430000000d53454c4543542031005a00000005495a0000000549',
    )
    const disconnected = once(socket, 'close')
    socket.write(Buffer.from('5800000004', 'hex'))
    await disconnected
    await expect.poll(wire.closedConnections).toBe(1)
    expect(wire.connections()).toBe(1)
    expect(wire.sockets.size).toBe(0)
  } finally {
    socket.destroy()
    await wire.close()
  }
})

test('PostgreSQL wire keeps native pg simple and prepared results and transaction states', async () => {
  const { pgWire } = await import('../../fixtures/db/pg-wire')
  const wire = await pgWire(sql => sql === 'bad' ? { error: 'fixture query rejected' }
    : sql.startsWith('SELECT') ? { fields: ['value'], values: ['é🔑'] } : {})
  const client = new Client({ connectionString: wire.url, connectionTimeoutMillis: 500, query_timeout: 500 })
  try {
    await client.connect()
    expect((await client.query('SELECT café')).rows).toEqual([{ value: 'é🔑' }])
    expect((await client.query({ name: 'frame-consumer', text: 'SELECT prepared' })).rows).toEqual([{ value: 'é🔑' }])
    expect(client.getTransactionStatus()).toBe('I')
    await client.query('BEGIN')
    expect(client.getTransactionStatus()).toBe('T')
    await expect(client.query('bad')).rejects.toMatchObject({ code: '23505', message: 'fixture query rejected' })
    expect(client.getTransactionStatus()).toBe('E')
    await client.query('ROLLBACK')
    expect(client.getTransactionStatus()).toBe('I')
    expect(wire.queries).toEqual(['SELECT café', 'SELECT prepared', 'BEGIN', 'bad', 'ROLLBACK'])
  } finally {
    await client.end()
    await wire.close()
  }
})

test('PostgreSQL wire preserves coalesced opcode order and suppresses ready responses after a stall', async () => {
  const { pgWire } = await import('../../fixtures/db/pg-wire')
  const wire = await pgWire(sql => sql === 'stall' ? { stall: true } : {})
  const target = new URL(wire.url)
  const socket = createConnection({ host: '127.0.0.1', port: Number(target.port) })
  let response = Buffer.alloc(0)
  socket.on('data', chunk => { response = Buffer.concat([response, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]) })
  try {
    await once(socket, 'connect')
    const disconnected = once(socket, 'close')
    socket.write(Buffer.from(
      '0000000800030000' +
      '510000000a424547494e00' +
      '50000000170053454c454354207072657061726564000000' +
      '420000000c0000000000000000' +
      '45000000090000000000' +
      '5300000004' +
      '510000000a7374616c6c00' +
      '5300000004' +
      '510000000d524f4c4c4241434b00' +
      '5800000004', 'hex',
    ))
    await disconnected
    expect(response.toString('hex')).toBe(
      '5200000008000000004b0000000c000004d20000162e5a0000000549' +
      '430000000a424547494e005a0000000554' +
      '31000000043200000004' +
      '430000000d53454c4543542031005a0000000554' +
      '430000000d524f4c4c4241434b00',
    )
    expect(wire.queries).toEqual(['BEGIN', 'SELECT prepared', 'stall', 'ROLLBACK'])
    await expect.poll(wire.closedConnections).toBe(1)
    expect(wire.sockets.size).toBe(0)
  } finally {
    socket.destroy()
    await wire.close()
  }
})
