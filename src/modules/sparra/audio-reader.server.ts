import { AsyncResource } from 'node:async_hooks'
import { constants, type Stats } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { ServerResponse } from 'node:http'
import { hostname } from 'node:os'
import { finished } from 'node:stream'
import { Schema } from 'effect'
import type { AuthTransactions } from '../../platform/db/transactions.server'
import { PgTransactionError } from '../../platform/db/auth-pg-lease.server'
import type { WebResources } from '../../platform/resources.server'
import { requestAuthDeadlineAtMs } from '../../platform/resources.server'
import { parseRequestInput } from './requests.server'
import { AudioUnavailable, audioRange, createAudioOperations, decryptAudioChunk, wavHeader,
  type AudioIncarnation, type AudioMetadata, type AudioRange, type AudioReadLease } from './audio.server'

const manifest = Schema.Struct({ schema_version: Schema.Literal(1), incarnation: Schema.String.check(Schema.isUUID()),
  container_id: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  deployment_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)) })
function trustedReaderManifestFile(stat: Stats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4096 && stat.uid === 0 && (stat.mode & 0o022) === 0
}
function readerManifestIdentityMatches(value: { container_id: string; incarnation: string; deployment_id: string },
  env: Readonly<Record<string, string | undefined>>, nativeHostname: string): boolean {
  return /^[0-9a-f]{12}$/.test(nativeHostname) && value.container_id.slice(0,12) === nativeHostname
    && value.incarnation === env.SPARRA_AUDIO_READER_INCARNATION
    && value.deployment_id === env.SPARRA_AUDIO_READER_DEPLOYMENT_ID
    && (env.SPARRA_AUDIO_READER_CONTAINER_ID === undefined || value.container_id === env.SPARRA_AUDIO_READER_CONTAINER_ID)
}
export async function readAudioIncarnation(env: Readonly<Record<string, string | undefined>>): Promise<AudioIncarnation | null> {
  if (!env.SPARRA_AUDIO_READER_INCARNATION || !env.SPARRA_AUDIO_READER_DEPLOYMENT_ID) return null
  const path = '/run/sparra/audio-reader-incarnation.json'
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    const before = await lstat(path)
    if (!trustedReaderManifestFile(before) || await realpath(path) !== path) return null
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = await file.stat(), buffer = Buffer.alloc(4097)
    if (opened.ino !== before.ino || opened.dev !== before.dev) return null
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > 4096 || bytesRead !== before.size) return null
    const value = Schema.decodeUnknownSync(manifest, { onExcessProperty: 'error' })(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')))
    const nativeHostname = hostname()
    if (!readerManifestIdentityMatches(value,env,nativeHostname)) return null
    return { incarnation: value.incarnation, containerId: value.container_id, deploymentId: value.deployment_id }
  } catch { return null } finally { await file?.close() }
}
function nativeResponse(request: Request): ServerResponse {
  if ('runtime' in request && typeof request.runtime === 'object' && request.runtime !== null
    && 'node' in request.runtime && typeof request.runtime.node === 'object' && request.runtime.node !== null
    && 'res' in request.runtime.node && request.runtime.node.res instanceof ServerResponse) return request.runtime.node.res
  throw new AudioUnavailable()
}
type ActiveReader = { stop(): void; settled: Promise<void> }
export function createAudioReaderOwner(transactions: AuthTransactions, incarnation: AudioIncarnation | null) {
  const operations = createAudioOperations(transactions), active = new Map<string, ActiveReader>()
  // Created at native startup, outside principal/request transaction inheritance.
  const cleanup = new AsyncResource('sparra-audio-reader-cleanup')
  let stopping = false
  let reservations = 0
  const pending = new Set<Promise<void>>()
  let shutdownPromise: Promise<void> | undefined, cleanupUnconfirmed = false
  async function releaseStoppedAdmission(exact: AudioReadLease): Promise<never> {
    try {
      if (!await cleanup.runInAsyncScope(() => operations.release(exact))) cleanupUnconfirmed = true
    } catch { cleanupUnconfirmed = true }
    throw new AudioUnavailable()
  }
  async function stream(request: Request, resources: WebResources, pin: AudioMetadata, range: AudioRange) {
    if (stopping || !incarnation || reservations >= 8) throw new AudioUnavailable()
    reservations++
    let completePending = () => {}
    const completion = new Promise<void>(resolve => { completePending = resolve })
    pending.add(completion)
    let holderRegistered = false, reservationHeld = true
    let removeNativeObservation: (() => void) | undefined
    function returnReservation() { if (reservationHeld) { reservationHeld = false; reservations-- } }
    function finishPending() { pending.delete(completion); completePending() }
    try {
    const previous = active.get(pin.workspaceId)
    if (previous) { await previous.settled; if (active.has(pin.workspaceId)) throw new AudioUnavailable() }
    const response = nativeResponse(request)
    let nativeTerminal = false, wakeNative = () => {}, onNativeTerminal: (() => void) | undefined
    const nativeDone = new Promise<void>(resolve => { wakeNative = resolve })
    // Observe before auth/acquire awaits; finished also handles an already closed
    // response. An error alone does not establish native output termination.
    removeNativeObservation = finished(response, { readable: false, error: false }, () => {
      nativeTerminal = true; wakeNative(); onNativeTerminal?.()
    })
    if (!resources.auth) throw new AudioUnavailable()
    const deadline = requestAuthDeadlineAtMs(request), controller = new AbortController()
    const principal = await resources.auth.requirePrincipal(request)
    let exact: AudioReadLease
    try { exact = await operations.acquire(principal, pin, incarnation, deadline, request.signal) }
    catch (error) { if (error instanceof PgTransactionError && error.outcome === 'unknown') cleanupUnconfirmed = true; throw error }
    if (stopping) await releaseStoppedAdmission(exact)
    let output: ReadableStreamDefaultController<Uint8Array> | undefined, permitted = true, productionEnded = false
    let producer: Promise<void> | undefined, probe: Promise<void> | undefined
    let authentication: Promise<void> = Promise.resolve()
    let timer: ReturnType<typeof setTimeout> | undefined, release: Promise<void> | undefined
    let retained: Buffer | undefined, sequence = 0, offset = 44, headerSent = false
    const header = wavHeader(pin.totalSamples)
    function stop() {
      if (!permitted) return
      permitted = false; controller.abort(); if (timer) clearTimeout(timer)
      try { output?.error(new Error('Conversation stopped')) } catch { /* Already terminal. */ }
      if (!nativeTerminal) response.destroy(new Error('Conversation stopped'))
      void settle()
    }
    function settle(): Promise<void> {
      return release ??= (async () => {
        permitted = false; controller.abort(); if (timer) clearTimeout(timer)
        await Promise.all([producer?.catch(() => {}), probe?.catch(() => {}), authentication, nativeDone])
        retained?.fill(0); retained = undefined
        const released = await cleanup.runInAsyncScope(() => operations.release(exact))
        if (!released) throw new AudioUnavailable()
        if (active.get(pin.workspaceId) === holder) active.delete(pin.workspaceId)
        returnReservation()
      })().catch(() => {
        // A successor may already own the Workspace map entry. This unresolved
        // exact capability must still prevent successful owner shutdown.
        cleanupUnconfirmed = true
      }).finally(() => {
        request.signal.removeEventListener('abort', stop)
        removeNativeObservation?.()
        finishPending()
      })
    }
    async function freshPrincipal() {
      // The native auth protocol owns one invocation cell on this Request.
      // Producer and probe revalidate separately, after the preceding cell joins.
      const admitted = authentication.then(() => {
        if (!permitted || !resources.auth || request.signal.aborted || response.destroyed || nativeTerminal
          || Date.now() >= deadline) throw new AudioUnavailable()
        return resources.auth.requirePrincipal(request)
      })
      authentication = admitted.then(() => {}, stop)
      return admitted
    }
    function armProbe() {
      if (!permitted) return
      timer = setTimeout(() => {
        probe = (async () => { await operations.check(await freshPrincipal(), pin, exact, controller.signal) })()
        void probe.then(armProbe, stop)
      }, 250)
    }
    request.signal.addEventListener('abort', stop, { once: true })
    const body = new ReadableStream<Uint8Array>({
      start(value) { output = value },
      pull(value) {
        producer = (async () => {
          if (!permitted || productionEnded) return
          retained = undefined
          const admitted = await freshPrincipal()
          if (!headerSent) {
            headerSent = true
            if (range.start < 44) {
              const bytes = Buffer.from(header.subarray(range.start, Math.min(44, range.end + 1)))
              retained = bytes
              await operations.enqueue(admitted, pin, exact, controller.signal, () => { if (!permitted) throw new AudioUnavailable(); value.enqueue(bytes) })
              if (range.end < 44) { productionEnded = true; value.close() }
              return
            }
          }
          while (sequence <= pin.lastSequence) {
            const chunk = await operations.page(admitted, pin, exact, sequence++, controller.signal)
            const end = offset + chunk.sampleCount * 4
            if (end <= range.start) { offset = end; continue }
            const plaintext = await decryptAudioChunk(chunk)
            const bytes = Buffer.from(plaintext.subarray(Math.max(0, range.start - offset), Math.min(plaintext.length, range.end + 1 - offset)))
            plaintext.fill(0); retained = bytes; offset = end
            await operations.enqueue(admitted, pin, exact, controller.signal, () => { if (!permitted) throw new AudioUnavailable(); value.enqueue(bytes) })
            if (offset > range.end) { productionEnded = true; value.close() }
            return
          }
          if (offset !== 44 + pin.totalSamples * 4) throw new AudioUnavailable()
          productionEnded = true; value.close()
        })().catch(stop)
        return producer
      },
      cancel() { stop(); return settle() },
    }, { highWaterMark: 0 })
    const holder: ActiveReader = { stop, settled: nativeDone.then(settle) }
    active.set(pin.workspaceId, holder)
    holderRegistered = true
    onNativeTerminal = stop
    armProbe()
    if (request.signal.aborted || response.destroyed || nativeTerminal) stop()
    return body
    } finally {
      if (!holderRegistered) {
        removeNativeObservation?.()
        returnReservation()
        finishPending()
      }
    }
  }
  function shutdown(): Promise<void> {
    stopping = true
    return shutdownPromise ??= (async () => {
      for (const reader of active.values()) reader.stop()
      await Promise.allSettled([...pending])
      for (const reader of active.values()) reader.stop()
      await Promise.all([...active.values()].map(reader => reader.settled))
      if (active.size || cleanupUnconfirmed) throw new Error('Audio reader cleanup unconfirmed')
      cleanup.emitDestroy()
    })()
  }
  return { stream, shutdown, isAvailable: () => !stopping && incarnation !== null }
}
export async function audioResponse(request: Request, requestId: string, resources: WebResources): Promise<Response> {
  if (!resources.auth) return new Response('Unauthorized', { status: 401 })
  let principal
  try { principal = await resources.auth.requirePrincipal(request) } catch { return new Response('Unauthorized', { status: 401 }) }
  try {
    const { requestId: id } = parseRequestInput({ requestId })
    const operations = createAudioOperations(resources.transactions), pin = await operations.read(principal, id, request.signal)
    const length = 44 + pin.totalSamples * 4, range = audioRange(request.headers.get('range'), length)
    const headers = new Headers({ 'Content-Type': 'audio/wav', 'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff', 'Content-Length': String(range.end - range.start + 1),
      'Accept-Ranges': 'bytes', 'Content-Disposition': 'inline; filename="conversation.wav"' })
    if (range.partial) headers.set('Content-Range', 'bytes ' + range.start + '-' + range.end + '/' + length)
    if (request.method === 'HEAD') return new Response(null, { status: range.partial ? 206 : 200, headers })
    if (!resources.audioReader?.isAvailable()) throw new AudioUnavailable()
    const body = await resources.audioReader.stream(request, resources, pin, range)
    return new Response(body, { status: range.partial ? 206 : 200, headers })
  } catch (error) {
    const status = error instanceof AudioUnavailable ? error.status : error instanceof Error && error.name === 'InvalidRequestInput' ? 400 : 409
    return new Response('Conversation unavailable', { status })
  }
}
