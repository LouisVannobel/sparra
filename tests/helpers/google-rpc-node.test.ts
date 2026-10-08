import { expect, test } from 'vitest'
import { fromCrossJSON, toCrossJSON } from 'seroval'
import { rpcResult } from './auth-rpc'
import { googleRpcNode } from './google-rpc-node'

test('decodes the response serialized by the selected Start fixture package', async () => {
  const result = { url: 'https://accounts.google.test/oauth?state=fixture' }
  const response = await rpcResult(result)
  expect(fromCrossJSON(googleRpcNode(JSON.parse(response.body)), { refs: new Map() }))
    .toEqual({ result, context: {} })
})

test('decodes the native Google envelope including its undefined error member', () => {
  const envelope = { result: { url: 'https://accounts.google.test/oauth?state=fixture' }, error: undefined, context: {} }
  const payload: unknown = JSON.parse(JSON.stringify(toCrossJSON(envelope)))
  expect(fromCrossJSON(googleRpcNode(payload), { refs: new Map() })).toEqual(envelope)
})

test.each([null, undefined])('decodes native constant %s', value => {
  expect(fromCrossJSON(googleRpcNode(toCrossJSON(value)), { refs: new Map() })).toBe(value)
})

test('decodes a null-constructor receipt using its native object tag and ID', () => {
  const receipt = Object.assign(Object.create(null), { receipt: 'fixture-receipt' })
  const decoded = fromCrossJSON(googleRpcNode(toCrossJSON(receipt)), { refs: new Map() })
  expect(decoded).toEqual(receipt)
  expect(Object.getPrototypeOf(decoded)).toBeNull()
})

test.each([Object.preventExtensions, Object.seal, Object.freeze])('preserves native object flags for %s', flag => {
  const receipt = flag({ receipt: 'fixture-receipt' })
  const decoded = fromCrossJSON(googleRpcNode(toCrossJSON(receipt)), { refs: new Map() })
  expect(decoded).toEqual(receipt)
  expect(Object.isExtensible(decoded)).toBe(Object.isExtensible(receipt))
  expect(Object.isSealed(decoded)).toBe(Object.isSealed(receipt))
  expect(Object.isFrozen(decoded)).toBe(Object.isFrozen(receipt))
})

test('accepts the existing string, key, property and nesting bounds', () => {
  const properties = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [String(index).padEnd(128, 'x'), 'x'.repeat(8192)]))
  const envelope = { result: { receipt: properties } }
  expect(fromCrossJSON(googleRpcNode(toCrossJSON(envelope)), { refs: new Map() })).toEqual(envelope)
})

const stringNode = { t: 1, s: 'fixture' }
const objectNode = { t: 10, i: 0, o: 0, p: { k: ['url'], v: [stringNode] } }
test.each([
  ['empty payload', null],
  ['primitive payload', 'fixture'],
  ['missing tag', {}],
  ['unknown tag', { t: 99 }],
  ['non-numeric tag', { t: '10' }],
  ['non-public constant', { t: 2, s: 2 }],
  ['missing constant', { t: 2 }],
  ['non-string value', { t: 1, s: false }],
  ['oversized string', { t: 1, s: 'x'.repeat(8193) }],
  ['missing ID', { t: 10, o: 0, p: objectNode.p }],
  ['non-numeric ID', { ...objectNode, i: '0' }],
  ['negative ID', { ...objectNode, i: -1 }],
  ['fractional ID', { ...objectNode, i: 0.5 }],
  ['unsafe ID', { ...objectNode, i: Number.MAX_SAFE_INTEGER + 1 }],
  ['invalid flags', { ...objectNode, o: 4 }],
  ['missing properties', { t: 10, i: 0, o: 0 }],
  ['null properties', { ...objectNode, p: null }],
  ['non-array keys', { ...objectNode, p: { k: 'url', v: [stringNode] } }],
  ['non-array values', { ...objectNode, p: { k: ['url'], v: stringNode } }],
  ['mismatched properties', { ...objectNode, p: { k: ['url'], v: [] } }],
  ['oversized object', { ...objectNode, p: { k: Array(9).fill('url'), v: Array(9).fill(stringNode) } }],
  ['non-string key', { ...objectNode, p: { k: [1], v: [stringNode] } }],
  ['oversized key', { ...objectNode, p: { k: ['x'.repeat(129)], v: [stringNode] } }],
  ['invalid child', { ...objectNode, p: { k: ['url'], v: [{ t: 0, s: 1 }] } }],
])('rejects %s before native deserialization', (_name, payload) => {
  expect(() => googleRpcNode(payload)).toThrow('Native Google node unavailable')
})

test.each([[], true, 1, new Date(0)])('rejects native tags outside the consumed DTOs for %s', value => {
  expect(() => googleRpcNode(toCrossJSON(value))).toThrow('Native Google node unavailable')
})

test('rejects nesting beyond the existing three-level bound', () => {
  expect(() => googleRpcNode(toCrossJSON({ result: { receipt: { nested: { value: 'fixture' } } } })))
    .toThrow('Native Google node unavailable')
})
