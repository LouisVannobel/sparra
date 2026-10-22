import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { Writable } from 'node:stream'
import { isDeepStrictEqual } from 'node:util'
import react from '@vitejs/plugin-react'
import istanbul from '@vitest/coverage-istanbul'
import { IstanbulCoverageProvider } from '@vitest/coverage-istanbul/dist/provider.js'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { createServer, normalizePath, type Plugin, type ViteDevServer } from 'vite'
import { createVitest, type Vitest } from 'vitest/node'

type CoverageRecord = ReturnType<IstanbulCoverageProvider['instrumenter']['lastFileCoverage']> & {
  hash?: string
  inputSourceMap?: unknown
}
type Coverage = Record<string, CoverageRecord>
type CoverageMap = ReturnType<IstanbulCoverageProvider['createCoverageMap']>
type SourceResponse = { url: string; status: 200; text: string } | { url: string; status: 304; text: null }
type Witness = { pending: Promise<void>[]; responses: SourceResponse[]; errors: unknown[] }
type Executed = Awaited<ReturnType<Page['coverage']['stopJSCoverage']>>
type BrowserSnapshot = { nonce: unknown; coverage: unknown }
type CoordinateSpace = 'instrumented' | 'remapped'
const coverageVariable = '__VITEST_COVERAGE__'
const uiSources = ['src/ui/sparra/activity-panel.tsx', 'src/ui/sparra/calendar-panel.tsx', 'src/ui/sparra/use-business-navigation.ts']
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const object = (value: unknown): value is object => !!value && typeof value === 'object' && !Array.isArray(value)
const geometry = (value: CoverageRecord) => ({ statementMap: value.statementMap, fnMap: value.fnMap, branchMap: value.branchMap })
function sameKeys(left: string[], right: string[]) {
  return isDeepStrictEqual([...left].sort(), [...right].sort())
}
function position(value: unknown, space: CoordinateSpace = 'instrumented'): value is { line: number; column: number } {
  if (!object(value) || !('line' in value) || !('column' in value)) return false
  return typeof value.line === 'number' && Number.isSafeInteger(value.line) && value.line > 0
    && typeof value.column === 'number' && value.column >= 0
    && (Number.isSafeInteger(value.column) || (space === 'remapped' && value.column === Infinity))
}
function location(value: unknown, space: CoordinateSpace) {
  // Native remapping may extend only an end column to positive Infinity.
  if (!object(value) || !('start' in value) || !('end' in value) || !position(value.start) || !position(value.end, space)) return false
  const { start, end } = value
  return start.line < end.line || (start.line === end.line && start.column <= end.column)
}
function nativeUndefinedPosition(value: unknown) {
  if (!object(value) || Object.getOwnPropertySymbols(value).length) return false
  return sameKeys(Object.getOwnPropertyNames(value), ['line', 'column']) && 'line' in value && 'column' in value
    && value.line === undefined && value.column === undefined
}
function branchLocation(value: unknown, space: CoordinateSpace) {
  // Actual Istanbul uses undefined coordinates; JSON round trips omit those keys.
  return location(value, space) || (object(value) && 'start' in value && 'end' in value && object(value.start) && object(value.end)
    && ((Object.getOwnPropertyNames(value.start).length === 0 && Object.getOwnPropertyNames(value.end).length === 0
      && Object.getOwnPropertySymbols(value.start).length === 0 && Object.getOwnPropertySymbols(value.end).length === 0)
      || (nativeUndefinedPosition(value.start) && nativeUndefinedPosition(value.end))))
}
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

function assertCounterMap(map: unknown, hits: unknown) {
  if (!object(map) || !object(hits) || !sameKeys(Object.keys(map), Object.keys(hits))) throw new Error('Malformed guided browser counter map')
}
function assertFunctions(map: unknown, space: CoordinateSpace): asserts map is CoverageRecord['fnMap'] {
  if (!object(map)) throw new Error('Missing guided browser function map')
  if (!Object.keys(map).length) throw new Error('Empty guided browser function map')
  for (const entry of Object.values(map)) {
    const fn: unknown = entry
    if (!object(fn) || !('name' in fn) || !('decl' in fn) || !('loc' in fn)
      || typeof fn.name !== 'string' || !location(fn.decl, space) || !location(fn.loc, space)) throw new Error('Malformed guided browser function')
  }
}
function branchHits(value: unknown): value is CoverageRecord['b'] {
  return object(value) && Object.values(value).every(hits => Array.isArray(hits) && hits.every(count))
}
function assertBranches(map: unknown, hits: unknown, space: CoordinateSpace): asserts map is CoverageRecord['branchMap'] {
  if (!object(map) || !branchHits(hits)) throw new Error('Missing guided browser branch map/hits')
  for (const [id, entry] of Object.entries(map)) {
    const counters = hits[id], branch: unknown = entry
    if (!object(branch) || !('type' in branch) || !('loc' in branch) || !('locations' in branch)
      || typeof branch.type !== 'string' || !location(branch.loc, space) || !Array.isArray(branch.locations)
      || !branch.locations.every(span => branchLocation(span, space)) || !Array.isArray(counters) || counters.length !== branch.locations.length || !counters.every(count)) {
      throw new Error('Malformed guided browser branch')
    }
  }
}

// Validate before Istanbul merge: merge itself does not reject incompatible maps.
export function assertGuidedCoverageRecord(value: unknown, path: string, space: CoordinateSpace = 'instrumented'): asserts value is CoverageRecord {
  if (!object(value) || !('path' in value) || !('s' in value) || !('f' in value) || !('b' in value)
    || value.path !== path || !object(value.s) || !object(value.f) || !object(value.b)) throw new Error(`Malformed guided browser coverage: ${path}`)
  if (!('statementMap' in value) || !('fnMap' in value) || !('branchMap' in value) || !object(value.statementMap)) throw new Error(`Missing guided browser geometry: ${path}`)
  assertCounterMap(value.statementMap, value.s)
  assertCounterMap(value.fnMap, value.f)
  assertCounterMap(value.branchMap, value.b)
  if (!Object.keys(value.statementMap).length || !Object.values(value.statementMap).every(span => location(span, space))
    || !Object.values(value.s).every(count) || !Object.values(value.f).every(count)) throw new Error(`Malformed guided browser counters/statements: ${path}`)
  assertFunctions(value.fnMap, space)
  assertBranches(value.branchMap, value.b, space)
}

export function assertGuidedCoverageCompatibility(previous: CoverageRecord, current: CoverageRecord) {
  if (!isDeepStrictEqual(geometry(previous), geometry(current)) || previous.hash !== current.hash
    || !isDeepStrictEqual(previous.inputSourceMap, current.inputSourceMap)) throw new Error(`Guided browser source/map drift: ${current.path}`)
}

// This is deliberately synchronous: validate the entire contribution before a single write.
export function publishGuidedBrowserCoverage(store: unknown, coverage: Coverage, paths: string[], required: boolean) {
  if (store === undefined) {
    if (required) throw new Error('Required guided browser native coverage store is absent')
    return
  }
  if (!object(store) || !Object.isExtensible(store) || !sameKeys(Object.keys(coverage), paths)) {
    throw new Error('Invalid guided browser native coverage publication')
  }
  for (const path of paths) {
    assertGuidedCoverageRecord(coverage[path], path, 'remapped')
    if (Object.hasOwn(coverage[path], 'inputSourceMap')) throw new Error(`Guided browser output was not natively remapped: ${path}`)
    if (path in store) throw new Error(`Guided browser/Node coverage collision: ${path}`)
  }
  Object.assign(store, coverage)
}

export function assertGuidedSourceMap(value: unknown, path: string, source: string, executedURL?: string) {
  if (!object(value) || !('version' in value) || !('sources' in value) || !('sourcesContent' in value) || !('mappings' in value)) throw new Error(`Missing guided browser source-map fields: ${path}`)
  if (value.version !== 3 || !Array.isArray(value.sources) || !Array.isArray(value.sourcesContent)
    || value.sources.length !== 1 || value.sourcesContent.length !== 1 || value.sourcesContent[0] !== source || typeof value.mappings !== 'string'
    || ('sourceRoot' in value && value.sourceRoot !== undefined && value.sourceRoot !== '')) {
    throw new Error(`Guided browser source-map identity mismatch: ${path}`)
  }
  const identity = executedURL ? basename(path) : path
  if (value.sources[0] !== identity || (executedURL && new URL(identity, executedURL).href !== executedURL)) throw new Error(`Guided browser source-map URL identity mismatch: ${path}`)
}

/** Only the two static guided UI fixtures consume this bridge. Destroyed documents
 * are not captured retroactively: their earlier hits are conservatively lost. */
export function createGuidedBrowserFixture(consumer: 'calendar-panel' | 'business-navigation') {
  const root = normalizePath(resolve('.'))
  const relatives = consumer === 'calendar-panel' ? [uiSources[1]!, 'tests/helpers/calendar-panel-entry.tsx'] : [...uiSources, 'tests/helpers/business-navigation-entry.tsx']
  const paths = relatives.map(path => `${root}/${path}`)
  const required = process.env.SPARRA_GUIDED_BROWSER_COVERAGE_REQUIRED === 'true'
  const sources = new Map<string, string>()
  const transforms = new Map<string, { inputMap: unknown; code: string }>()
  const documents = new Set<string>()
  const contexts = new Map<BrowserContext, Page>()
  const witnesses = new Map<Page, Witness>()
  const failures: unknown[] = [], diagnostics: string[] = []
  const pageOperations: Promise<unknown>[] = []
  const sink = () => new Writable({ write(chunk, _encoding, callback) { diagnostics.push(String(chunk)); callback() } })
  let directory: string | undefined, vitest: Vitest | undefined, provider: IstanbulCoverageProvider | undefined
  let directoryOwner: Awaited<ReturnType<typeof lstat>> | undefined
  let server: ViteDevServer | undefined, browser: Browser | undefined, aggregate: CoverageMap | undefined
  let origin = '', retiring = false
  let starting: Promise<void> | undefined
  const ownedServers = new Set<ViteDevServer>()

  async function initialize() {
    try {
      directory = await mkdtemp(join(tmpdir(), 'sparra-guided-browser-'))
      directoryOwner = await lstat(directory)
      for (const path of paths) sources.set(path, await readFile(path, 'utf8'))
      vitest = await createVitest('test', {
        root, config: false, watch: false, run: true, api: false, environment: 'node',
        coverage: { enabled: true, provider: 'istanbul', include: relatives, reporter: [], reportsDirectory: join(directory, 'coverage'), clean: false, cleanOnRerun: true, processingConcurrency: 1 },
      }, { root, envDir: false, cacheDir: join(directory, 'vitest-cache'), logLevel: 'error', server: { hmr: false } }, { stdout: sink(), stderr: sink() })
      ownedServers.add(vitest.vite)
      for (const project of vitest.projects) ownedServers.add(project.vite)
      const actual = await vitest.createCoverageProvider()
      if (!(actual instanceof IstanbulCoverageProvider)) throw new Error('Concrete public Istanbul provider unavailable')
      provider = actual
      await provider.clean(false)
      await provider.onTestRunStart()
      aggregate = provider.createCoverageMap()
      const instrument: Plugin = {
        name: 'guided-browser-native-istanbul', enforce: 'post',
        transform(code, id) {
          if (!paths.includes(id)) return
          if (transforms.has(id)) throw new Error(`Repeated guided browser transform: ${id}`)
          const source = sources.get(id)!
          const inputMap: unknown = structuredClone(this.getCombinedSourcemap())
          assertGuidedSourceMap(inputMap, id, source)
          const transformed = actual.onFileTransform(code, id, this)
          if (!transformed) throw new Error(`Missing genuine guided browser instrumentation: ${id}`)
          transforms.set(id, { inputMap, code: transformed.code })
          return transformed
        },
      }
      server = await createServer({ root, configFile: false, envDir: false, cacheDir: join(directory, 'fixture-cache'), plugins: [react(), instrument], logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } })
      ownedServers.add(server)
      await server.listen()
      const address = server.httpServer?.address()
      if (!address || typeof address === 'string') throw new Error('Fixture listener missing')
      origin = `http://127.0.0.1:${address.port}`
      browser = await chromium.launch({ headless: true })
    } catch (error) { failures.push(error); throw error }
  }

  async function createPage() {
    if (retiring || !browser) throw new Error('Guided browser fixture is not running')
    const context = await browser.newContext()
    try {
      // Immutable per actual Document, installed before the first navigation.
      // Source strings stay independent of this Node helper's Istanbul counters.
      await context.addInitScript("Object.defineProperty(window, '__SPARRA_GUIDED_DOCUMENT__', { value: crypto.randomUUID(), writable: false, configurable: false })")
      const page = await context.newPage()
      contexts.set(context, page)
      const witness: Witness = { pending: [], responses: [], errors: [] }
      witnesses.set(page, witness)
      page.on('pageerror', error => { witness.errors.push(error) })
      page.on('response', response => {
        const url = new URL(response.url())
        const ownedSource = paths.find(path => url.pathname === path.slice(root.length))
        if (url.origin !== origin || !ownedSource) return
        const status = response.status()
        if (status === 304) {
          // A cached response has no body. Only an actual earlier 200 can witness its executed bytes.
          witness.responses.push({ url: response.url(), status, text: null })
          return
        }
        if (status !== 200) {
          witness.errors.push(new Error(`Unexpected guided browser owned source response: HTTP ${status}, ${ownedSource}`))
          return
        }
        witness.pending.push(response.text().then(text => { witness.responses.push({ url: response.url(), status, text }) }).catch(error => {
          witness.errors.push(new Error(`Guided browser owned source response body unavailable: HTTP ${status}, ${ownedSource}, ${response.request().resourceType()}`, { cause: error }))
        }))
      })
      await page.coverage.startJSCoverage({ resetOnNavigation: true, reportAnonymousScripts: false })
      return { context, page }
    } catch (error) {
      failures.push(error)
      try { await context.close() } finally { contexts.delete(context) }
      throw error
    }
  }

  async function verifySourceWitness(path: string, record: CoverageRecord, witness: Witness, executed: Executed) {
    const transform = transforms.get(path), source = sources.get(path)!
    if (!transform || sha(await readFile(path, 'utf8')) !== sha(source)) throw new Error(`Guided browser source changed: ${path}`)
    assertGuidedSourceMap(record.inputSourceMap, path, source)
    if (!isDeepStrictEqual(record.inputSourceMap, transform.inputMap)) throw new Error(`Guided browser runtime/input-map drift: ${path}`)
    const scripts = executed.filter(script => new URL(script.url).origin === origin && new URL(script.url).pathname === path.slice(root.length))
    if (scripts.length !== 1 || typeof scripts[0]!.source !== 'string') throw new Error(`Missing exact guided browser executed source: ${path}`)
    const script = scripts[0]!, code = script.source!
    if (!witness.responses.some(response => response.url === script.url && response.status === 200 && response.text === code)
      || typeof record.hash !== 'string' || !record.hash || !code.includes(record.hash) || !transform.code.includes(record.hash) || !code.includes(coverageVariable)) throw new Error(`Guided browser served/executed identity mismatch: ${path}`)
    const inline = code.match(/\/\/# sourceMappingURL=data:application\/json(?:;charset=[^;,]+)?;base64,([^\s]+)/)
    if (!inline) throw new Error(`Missing guided browser executed source map: ${path}`)
    assertGuidedSourceMap(JSON.parse(Buffer.from(inline[1]!, 'base64').toString('utf8')), path, source, script.url)
  }

  async function capture(page: Page) {
    if (!provider || !aggregate) throw new Error('Guided browser provider missing')
    const witness = witnesses.get(page)
    if (!witness) throw new Error('Foreign guided browser page')
    const captured = await page.evaluate<BrowserSnapshot>('({ nonce: window.__SPARRA_GUIDED_DOCUMENT__, coverage: window.__VITEST_COVERAGE__ })')
    if (typeof captured.nonce !== 'string' || !/^[a-f0-9-]{36}$/.test(captured.nonce) || documents.has(captured.nonce)
      || !object(captured.coverage) || !sameKeys(Object.keys(captured.coverage), paths)) throw new Error('Missing, duplicated or foreign guided browser document coverage')
    documents.add(captured.nonce)
    const executed = await page.coverage.stopJSCoverage()
    const nonce = await page.evaluate<unknown>('window.__SPARRA_GUIDED_DOCUMENT__')
    if (nonce !== captured.nonce) throw new Error('Guided browser document changed during capture')
    await Promise.all(witness.pending)
    if (witness.errors.length) throw new AggregateError(witness.errors, 'Guided browser source response failed')
    const raw: Coverage = {}
    for (const path of paths) {
      const record: unknown = Object.entries(captured.coverage).find(([key]) => key === path)?.[1]
      assertGuidedCoverageRecord(record, path)
      await verifySourceWitness(path, record, witness, executed)
      if (aggregate.files().includes(path)) assertGuidedCoverageCompatibility(aggregate.fileCoverageFor(path).toJSON(), record)
      raw[path] = record
    }
    aggregate.merge(raw)
  }

  async function captureAndClose(context: BrowserContext, page: Page) {
    const errors: unknown[] = []
    try {
      if (contexts.get(context) !== page) throw new Error('Foreign or already captured guided browser context')
      await capture(page)
    } catch (error) { errors.push(error) }
    finally {
      try { await context.close(); contexts.delete(context) } catch (error) { errors.push(error) }
    }
    if (errors.length) { failures.push(...errors); throw new AggregateError(errors, 'Guided browser capture/close failed') }
  }

  async function retireDirectory() {
    if (!directory) return
    const resolved = await realpath(directory), temporary = await realpath(tmpdir()), metadata = await lstat(directory)
    if (dirname(resolved) !== temporary || !basename(resolved).startsWith('sparra-guided-browser-') || metadata.isSymbolicLink() || !metadata.isDirectory()
      || !directoryOwner || metadata.dev !== directoryOwner.dev || metadata.ino !== directoryOwner.ino) throw new Error('Unsafe guided browser temporary directory')
    await rm(resolved, { recursive: true })
  }

  async function retire() {
    // Every resource is retired even if an earlier capture, remap or close failed.
    for (const context of contexts.keys()) {
      try { await context.close() } catch (error) { failures.push(error) }
    }
    for (const witness of witnesses.values()) {
      await Promise.all(witness.pending)
      failures.push(...witness.errors)
    }
    const listeners = [...ownedServers].map(owned => owned.httpServer)
    for (const operation of [() => browser?.close(), () => server?.close(), () => vitest?.close()]) {
      try { await operation() } catch (error) { failures.push(error) }
    }
    if (browser?.isConnected() || listeners.some(listener => listener?.listening)) failures.push(new Error('Guided browser owned listener/browser remains open'))
    if (diagnostics.some(message => message.trim())) failures.push(new Error('Auxiliary Vitest reported unexpected stdout/stderr'))
    try {
      for (const [path, source] of sources) if (sha(await readFile(path, 'utf8')) !== sha(source)) throw new Error(`Guided browser source changed before publication: ${path}`)
    } catch (error) { failures.push(error) }
    try { await retireDirectory() } catch (error) { failures.push(error) }
  }

  async function close() {
    retiring = true
    let remapped: Coverage | undefined
    try {
      if (starting) await starting
      const operations = await Promise.allSettled(pageOperations)
      for (const result of operations) if (result.status === 'rejected') failures.push(result.reason)
      if (failures.length || contexts.size || !provider || !vitest || !aggregate || !documents.size) throw new Error('Guided browser captures are incomplete')
      await provider.onAfterSuiteRun({ coverage: aggregate.toJSON(), environment: 'browser', projectName: vitest.getRootProject().name, testFiles: [`${root}/tests/integration/${consumer}-browser.test.ts`] })
      const generated = await provider.generateCoverage({ allTestsRun: false })
      remapped = {}
      for (const path of generated.files()) remapped[path] = generated.fileCoverageFor(path).toJSON()
    } catch (error) { failures.push(error) }
    finally { await retire() }
    if (failures.length) throw new AggregateError(failures, 'Guided browser coverage was not published')
    if (!remapped) throw new Error('Guided browser remapped coverage missing')
    const store: unknown = await istanbul.takeCoverage?.()
    publishGuidedBrowserCoverage(store, remapped, paths, required)
    const raw: Coverage = {}
    for (const path of aggregate!.files()) raw[path] = aggregate!.fileCoverageFor(path).toJSON()
    const observedResponses = [...witnesses.values()].flatMap(witness => witness.responses)
    const responseStatuses = paths.map(path => {
      const responses = observedResponses.filter(response => new URL(response.url).pathname === path.slice(root.length))
      return { path, received200: responses.filter(response => response.status === 200).length, received304: responses.filter(response => response.status === 304).length }
    })
    return { consumer, documents: documents.size, raw, remapped, published: store !== undefined, responseStatuses }
  }

  return {
    start() { if (starting) throw new Error('Guided browser fixture already started'); starting = initialize(); return starting },
    newPage() { const operation = createPage(); pageOperations.push(operation); return operation },
    closePage(context: BrowserContext, page: Page) { const operation = captureAndClose(context, page); pageOperations.push(operation); return operation },
    close,
    get origin() { return origin },
  }
}
