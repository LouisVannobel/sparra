import { expect, test } from 'vitest'
import { assertGuidedCoverageCompatibility, assertGuidedCoverageRecord, assertGuidedSourceMap, publishGuidedBrowserCoverage } from './helpers/guided-browser-coverage'

const first = '/owned/src/ui/sparra/calendar-panel.tsx', second = '/owned/tests/helpers/calendar-panel-entry.tsx'
const loc = { start: { line: 1, column: 0 }, end: { line: 1, column: 12 } }
function record(path = first) {
  return {
    path, statementMap: { '0': structuredClone(loc) }, fnMap: { '0': { name: 'persist', decl: structuredClone(loc), loc: structuredClone(loc), line: 1 } },
    branchMap: { '0': { type: 'if', loc: structuredClone(loc), locations: [structuredClone(loc), { start: {}, end: {} }], line: 1 } },
    s: { '0': 1 }, f: { '0': 1 }, b: { '0': [1, 0] },
  }
}

test('accepts Istanbul implicit else geometry without rewriting it', () => {
  const actual = record(), before = structuredClone(actual)
  assertGuidedCoverageRecord(actual, first)
  expect(actual).toEqual(before)
})

test('preserves native implicit else undefined positions and refuses mixed or extra position fields', () => {
  const sentinel = { line: undefined, column: undefined }
  const actual = { ...record(), branchMap: { '0': { ...record().branchMap['0'], locations: [structuredClone(loc), { start: { ...sentinel }, end: { ...sentinel } }] } } }
  const before = structuredClone(actual)
  assertGuidedCoverageRecord(actual, first)
  expect(actual).toEqual(before)
  expect(Object.hasOwn(actual.branchMap['0'].locations[1]!.start, 'line')).toBe(true)
  for (const start of [{ line: null, column: undefined }, { line: undefined }, { line: 1, column: undefined }, { ...sentinel, extra: undefined }, { line: NaN, column: undefined }]) {
    const malformed = { ...actual, branchMap: { '0': { ...actual.branchMap['0'], locations: [structuredClone(loc), { start, end: { ...sentinel } }] } } }
    expect(() => assertGuidedCoverageRecord(malformed, first)).toThrow('Malformed guided browser branch')
  }
})

test('preserves native remapped Infinity end columns while raw coordinates and every start remain finite', () => {
  const native = record()
  native.statementMap['0'].end.column = Infinity
  native.fnMap['0'].decl.end.column = Infinity
  native.fnMap['0'].loc.end.column = Infinity
  native.branchMap['0'].loc.end.column = Infinity
  native.branchMap['0'].locations[0]!.end = { line: 1, column: Infinity }
  const before = structuredClone(native)
  assertGuidedCoverageRecord(native, first, 'remapped')
  expect(native).toEqual(before)
  expect(() => assertGuidedCoverageRecord(native, first)).toThrow(/guided browser/i)
  for (const invalid of [Infinity, NaN, -Infinity]) {
    const start = record(); start.statementMap['0'].start.column = invalid
    expect(() => assertGuidedCoverageRecord(start, first, 'remapped')).toThrow(/guided browser/i)
  }
  for (const invalid of [NaN, -Infinity]) {
    const end = record(); end.statementMap['0'].end.column = invalid
    expect(() => assertGuidedCoverageRecord(end, first, 'remapped')).toThrow(/guided browser/i)
  }
  const nullEnd = { ...record(), statementMap: { '0': { start: { ...loc.start }, end: { line: 1, column: null } } } }
  expect(() => assertGuidedCoverageRecord(nullEnd, first, 'remapped')).toThrow(/guided browser/i)
  const infiniteLine = record(); infiniteLine.statementMap['0'].end.line = Infinity
  expect(() => assertGuidedCoverageRecord(infiniteLine, first, 'remapped')).toThrow(/guided browser/i)
  const infiniteCount = { ...native, s: { '0': Infinity } }
  expect(() => assertGuidedCoverageRecord(infiniteCount, first, 'remapped')).toThrow(/guided browser/i)
  const node = {}
  publishGuidedBrowserCoverage(node, { [first]: native }, [first], true)
  expect(node).toHaveProperty(first, native)
  expect(native.statementMap['0'].end.column).toBe(Infinity)
})

test('refuses aliased paths, unknown counters, negative hits and branch dimension loss', () => {
  const alias = record(second), extra = { ...record(), s: { '0': 1, '1': 4 } }, negative = { ...record(), f: { '0': -1 } }, lostBranch = { ...record(), b: { '0': [1] } }
  for (const malformed of [alias, extra, negative, lostBranch]) expect(() => assertGuidedCoverageRecord(malformed, first)).toThrow(/guided browser/i)
})

test('raw merge compatibility includes names, instrumentation hash and complete input map', () => {
  const raw = { ...record(), hash: 'actual-hash', inputSourceMap: { version: 3, sources: [first], sourcesContent: ['actual TSX'], mappings: 'AAAA' } }
  assertGuidedCoverageCompatibility(raw, structuredClone(raw))
  const name = structuredClone(raw); name.fnMap['0'].name = 'different anonymous ordinal'
  const hash = { ...raw, hash: 'other-hash' }, map = { ...raw, inputSourceMap: { ...raw.inputSourceMap, mappings: 'AACA' } }
  for (const drift of [name, hash, map]) expect(() => assertGuidedCoverageCompatibility(raw, drift)).toThrow('source/map drift')
})

test('distinguishes absolute instrumenter maps from relative maps served for the exact module URL', () => {
  const absolute = { version: 3, sources: [first], sourcesContent: ['source'], mappings: 'AAAA' }
  const relative = { ...absolute, sources: ['calendar-panel.tsx'] }, url = 'http://127.0.0.1:4567/src/ui/sparra/calendar-panel.tsx'
  assertGuidedSourceMap(absolute, first, 'source')
  assertGuidedSourceMap(relative, first, 'source', url)
  for (const map of [absolute, { ...relative, sourceRoot: '/foreign/' }, { ...relative, sourcesContent: ['drift'] }, { ...relative, sources: ['../calendar-panel.tsx'] }]) {
    expect(() => assertGuidedSourceMap(map, first, 'source', url)).toThrow('source-map')
  }
  expect(() => assertGuidedSourceMap(relative, first, 'source', url.replace('calendar-panel.tsx', 'other.tsx'))).toThrow('URL identity')
})

test('admits both native source-map identities and their absent or empty root without mutation', () => {
  const identities = [{ source: first, executedURL: undefined }, { source: 'calendar-panel.tsx', executedURL: 'http://127.0.0.1:4567/src/ui/sparra/calendar-panel.tsx' }]
  for (const identity of identities) {
    for (const root of [{}, { sourceRoot: undefined }, { sourceRoot: '' }]) {
      const map = { version: 3, sources: [identity.source], sourcesContent: ['source'], mappings: 'AAAA', ...root }
      const before = structuredClone(map)
      assertGuidedSourceMap(map, first, 'source', identity.executedURL)
      expect(map).toStrictEqual(before)
    }
  }
})

test('refuses missing source-map identity fields before any map is admitted', () => {
  const { version, sources, sourcesContent, mappings } = { version: 3, sources: [first], sourcesContent: ['source'], mappings: 'AAAA' }
  const incomplete = [undefined, null, [], {}, { sources, sourcesContent, mappings }, { version, sourcesContent, mappings }, { version, sources, mappings }, { version, sources, sourcesContent }]
  for (const map of incomplete) {
    const before = structuredClone(map)
    expect(() => assertGuidedSourceMap(map, first, 'source')).toThrow('source-map fields')
    expect(map).toStrictEqual(before)
  }
})

test('rejects changed map declarations, source cardinality and source contents without altering evidence', () => {
  const valid = { version: 3, sources: [first], sourcesContent: ['source'], mappings: 'AAAA' }
  const altered = [
    { ...valid, version: 2 }, { ...valid, version: '3' },
    { ...valid, sources: null }, { ...valid, sources: first }, { ...valid, sources: [] }, { ...valid, sources: [first, second] },
    { ...valid, sourcesContent: null }, { ...valid, sourcesContent: 'source' }, { ...valid, sourcesContent: [] }, { ...valid, sourcesContent: ['source', 'extra'] }, { ...valid, sourcesContent: ['changed'] },
    { ...valid, mappings: null }, { ...valid, mappings: ['AAAA'] },
    { ...valid, sourceRoot: null }, { ...valid, sourceRoot: '/foreign/' },
  ]
  for (const map of altered) {
    const before = structuredClone(map)
    expect(() => assertGuidedSourceMap(map, first, 'source')).toThrow('source-map identity')
    expect(map).toStrictEqual(before)
  }
})

test('refuses source aliases and mismatched executed module URLs in their actual coordinate space', () => {
  const valid = { version: 3, sources: [first], sourcesContent: ['source'], mappings: 'AAAA' }
  const url = 'http://127.0.0.1:4567/src/ui/sparra/calendar-panel.tsx'
  const aliases = [
    { map: { ...valid, sources: ['calendar-panel.tsx'] }, executedURL: undefined },
    { map: { ...valid, sources: [second] }, executedURL: undefined },
    { map: { ...valid, sources: [first] }, executedURL: url },
    { map: { ...valid, sources: ['./calendar-panel.tsx'] }, executedURL: url },
    { map: { ...valid, sources: ['../sparra/calendar-panel.tsx'] }, executedURL: url },
    { map: { ...valid, sources: ['other.tsx'] }, executedURL: url },
    { map: { ...valid, sources: ['calendar-panel.tsx'] }, executedURL: url.replace('calendar-panel.tsx', 'other.tsx') },
  ]
  for (const { map, executedURL } of aliases) {
    const before = structuredClone(map)
    expect(() => assertGuidedSourceMap(map, first, 'source', executedURL)).toThrow('source-map URL identity')
    expect(map).toStrictEqual(before)
  }
})

test('missing live store fails mandatory native qualification and skips only optional publication', () => {
  const contribution = { [first]: record() }
  expect(() => publishGuidedBrowserCoverage(undefined, contribution, [first], true)).toThrow('store is absent')
  expect(publishGuidedBrowserCoverage(undefined, contribution, [first], false)).toBeUndefined()
})

test('a late collision refuses the entire contribution and preserves every Node entry', () => {
  const existing = record(second), node = { [second]: existing }, before = structuredClone(node)
  expect(() => publishGuidedBrowserCoverage(node, { [first]: record(), [second]: record(second) }, [first, second], true)).toThrow('collision')
  expect(node).toEqual(before)
  expect(node[second]).toBe(existing)
  expect(Object.hasOwn(node, first)).toBe(false)
})

test('foreign keys and residual input maps refuse publication before any record is inserted', () => {
  const node = {}, raw = { ...record(second), inputSourceMap: { sources: [second] } }
  expect(() => publishGuidedBrowserCoverage(node, { [first]: record(), [second]: raw }, [first, second], true)).toThrow('not natively remapped')
  expect(node).toEqual({})
  expect(() => publishGuidedBrowserCoverage(node, { [first]: record(), foreign: record(second) }, [first], true)).toThrow('Invalid')
  expect(node).toEqual({})
})

test('publishes genuine remapped record references while preserving unrelated Node coverage', () => {
  const existing = record(second), browser = record(), node = { [second]: existing } satisfies Record<string, ReturnType<typeof record>>
  publishGuidedBrowserCoverage(node, { [first]: browser }, [first], true)
  expect(node).toHaveProperty(first)
  expect(Object.values(node)).toContain(browser)
  expect(node[second]).toBe(existing)
  expect(browser.f['0']).toBe(1)
})
