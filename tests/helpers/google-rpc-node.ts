import type { SerovalNode as RpcNode } from 'seroval'

const base = { i: undefined, s: undefined, c: undefined, m: undefined, p: undefined, e: undefined,
  a: undefined, f: undefined, b: undefined, o: undefined, l: undefined }

function googleRpcProperties(value: unknown, depth: number): { k: string[]; v: RpcNode[] } | undefined {
  if (!value || typeof value !== 'object' || !('k' in value) || !('v' in value)
    || !Array.isArray(value.k) || !Array.isArray(value.v) || value.k.length > 8
    || value.k.length !== value.v.length) return undefined
  const keys: string[] = []
  for (const key of value.k) {
    if (typeof key !== 'string' || key.length > 128) throw new Error('Native Google node unavailable')
    keys.push(key)
  }
  return { k: keys, v: value.v.map(child => googleRpcNode(child, depth + 1)) }
}

function googleRpcObject(value: object & { t: unknown }, depth: number): RpcNode {
  if ((value.t === 10 || value.t === 11) && 'i' in value && typeof value.i === 'number'
    && Number.isSafeInteger(value.i) && value.i >= 0 && 'o' in value
    && (value.o === 0 || value.o === 1 || value.o === 2 || value.o === 3) && 'p' in value) {
    const properties = googleRpcProperties(value.p, depth)
    if (properties) return { ...base, t: value.t, i: value.i, o: value.o, p: properties }
  }
  console.log('PAIRED_SEROVAL_NODE rejected depth=' + depth + ' tag=' +
    (typeof value.t === 'number' && Number.isSafeInteger(value.t) ? value.t : 'non-numeric'))
  throw new Error('Native Google node unavailable')
}

// Only the consumed Google DTOs: objects, URL/receipt strings and the native
// envelope's null/undefined constants. Seroval owns object construction.
export function googleRpcNode(value: unknown, depth = 0): RpcNode {
  if (!value || typeof value !== 'object' || depth > 3 || !('t' in value)) throw new Error('Native Google node unavailable')
  if (value.t === 2 && 's' in value && (value.s === 0 || value.s === 1)) {
    return { ...base, t: 2, s: value.s }
  }
  if (value.t === 1 && 's' in value && typeof value.s === 'string' && value.s.length <= 8192) {
    return { ...base, t: 1, s: value.s }
  }
  return googleRpcObject(value, depth)
}
