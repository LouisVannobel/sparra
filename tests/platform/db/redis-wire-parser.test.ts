import { expect, test } from 'vitest'

test('Redis parser reads one command and leaves the next RESP frame intact', async () => {
  const { parseRedisCommand } = await import('../../fixtures/db/redis-wire')
  const result = parseRedisCommand(Buffer.from('*2\r\n$4\r\nEVAL\r\n$6\r\né🔑\r\n*1\r\n$4\r\nPING\r\n'))

  expect(result).toEqual({
    status: 'complete',
    command: ['EVAL', 'é🔑'],
    remainder: Buffer.from('*1\r\n$4\r\nPING\r\n'),
  })
  if (result.status !== 'complete') throw new Error('Expected complete EVAL command')
  expect(parseRedisCommand(result.remainder)).toEqual({
    status: 'complete', command: ['PING'], remainder: Buffer.alloc(0),
  })
})

test('Redis parser waits at every incomplete byte boundary of a UTF-8 command', async () => {
  const { parseRedisCommand } = await import('../../fixtures/db/redis-wire')
  const frame = Buffer.from('*3\r\n$3\r\nSET\r\n$5\r\ncafé\r\n$2\r\nok\r\n')

  for (let end = 0; end < frame.length; end++) {
    const partial = frame.subarray(0, end)
    const original = Buffer.from(partial)
    expect(parseRedisCommand(partial), `incomplete prefix of ${end} bytes`).toEqual({ status: 'pending' })
    expect(partial).toEqual(original)
  }
  expect(parseRedisCommand(frame)).toEqual({
    status: 'complete', command: ['SET', 'café', 'ok'], remainder: Buffer.alloc(0),
  })
})

test('Redis parser preserves a partial next command until the following chunk completes it', async () => {
  const { parseRedisCommand } = await import('../../fixtures/db/redis-wire')
  const first = parseRedisCommand(Buffer.from('*1\r\n$4\r\nPING\r\n*2\r\n$4\r\nEVAL\r\n$6\r\nret'))

  expect(first).toEqual({
    status: 'complete', command: ['PING'], remainder: Buffer.from('*2\r\n$4\r\nEVAL\r\n$6\r\nret'),
  })
  if (first.status !== 'complete') throw new Error('Expected complete PING command')
  expect(parseRedisCommand(first.remainder)).toEqual({ status: 'pending' })
  expect(parseRedisCommand(Buffer.concat([first.remainder, Buffer.from('urn\r\n')]))).toEqual({
    status: 'complete', command: ['EVAL', 'return'], remainder: Buffer.alloc(0),
  })
})

test('Redis parser keeps the existing numeric header and payload slicing behavior', async () => {
  const { parseRedisCommand } = await import('../../fixtures/db/redis-wire')

  expect(parseRedisCommand(Buffer.from('*+1\r\n$+4\r\nPING!!tail'))).toEqual({
    status: 'complete', command: ['PING'], remainder: Buffer.from('tail'),
  })
  expect(parseRedisCommand(Buffer.from('*0\r\nnext'))).toEqual({
    status: 'complete', command: [], remainder: Buffer.from('next'),
  })
})
