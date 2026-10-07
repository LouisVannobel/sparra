import { expect, test } from 'vitest'
import { AudioUnavailable, audioRange } from '../../src/modules/sparra/audio.server'

test.each([
  [null, 108, { start: 0, end: 107, partial: false }],
  ['bytes=0-43', 108, { start: 0, end: 43, partial: true }],
  ['bytes=44-', 108, { start: 44, end: 107, partial: true }],
  ['bytes=-16', 108, { start: 92, end: 107, partial: true }],
  ['bytes=-999', 108, { start: 0, end: 107, partial: true }],
  ['bytes=100-999', 108, { start: 100, end: 107, partial: true }],
  ['bytes=0-', 2_000_000, { start: 0, end: 1_048_575, partial: true }],
  ['bytes=20-1999999', 2_000_000, { start: 20, end: 1_048_595, partial: true }],
  ['bytes=-2000000', 2_000_000, { start: 0, end: 1_048_575, partial: true }],
] as const)('bounded audio range %s keeps its byte contract', (value, length, expected) => {
  expect(audioRange(value, length)).toEqual(expected)
})

test.each([
  'bytes=-', 'bytes=-0', 'bytes=108-', 'bytes=9-8', 'bytes=1-2,4-5',
  'bytes= 0-1', 'Bytes=0-1', 'bytes=0-1 ', 'bytes=1.5-2',
  'bytes=9007199254740992-', 'bytes=0-9007199254740992',
  'bytes=' + '0'.repeat(81) + '-1',
])('invalid audio range %s remains a 416', value => {
  try { audioRange(value, 108); throw new Error('Invalid range admitted') }
  catch (error) { expect(error).toBeInstanceOf(AudioUnavailable); expect(error).toMatchObject({ status: 416 }) }
})
