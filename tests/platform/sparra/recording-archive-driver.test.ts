import { afterEach, beforeEach, expect, test, vi, type MockInstance } from 'vitest'
import { ChildProcess, type ChildProcessWithoutNullStreams, type spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { retireFixtureDirectory } from '../../helpers/credential-init-retirement'
import { startRecordingArchiveFixture, type NativeRecordingRouting, type NativeRecordingSnapshot, type ReceiptOperation } from '../../helpers/sparra-recording-archive-driver'

// These exercise the Node consumer's wire/lifecycle contract. Controlled frames
// are not archive/provider evidence; the actual Voice/native9 suite owns that.
const external = vi.hoisted(() => ({
  spawn: vi.fn<typeof spawn>(),
  producer: vi.fn<(root: string) => Promise<{ pythonExecutable: string; sourceRoot: string }>>(),
}))
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: external.spawn }))
vi.mock('../../helpers/sparra-crypto-fixture', () => ({ resolveVoiceProducer: external.producer }))

const prefix = 'sparra-recording-native-', callId = '11111111-1111-4111-8111-111111111111', recordingId = '22222222-2222-4222-8222-222222222222'
const at = '2026-10-04T10:00:00.000Z', until = '2026-11-03T10:00:00.000Z', digest = 'a'.repeat(64)
const operation: ReceiptOperation = {
  schema_version: 1, operation_id: '33333333-3333-4333-8333-333333333333', deployment_id: 'fixture-a', call_id: callId, occurred_at: at, kind: 'recording.upsert',
  payload: { recording_id: recordingId, status: 'saved', telnyx_recording_id: 'fixture-provider', channels: 'dual', format: 'wav', started_at: at, ended_at: at, retention_until: until,
    archive_receipt: { recording_id: recordingId, ciphertext_sha256: digest, encrypted_bytes: 188, key_version: 1, retention_until: until } },
}
const receiptBytes = JSON.stringify(operation)
const facts = { call_id: callId, recording_id: recordingId, receipt_operation: receiptBytes, operations: ['unchanged preceding operation', receiptBytes], ciphertext_bytes: 188, ciphertext_sha256: digest, ledger_state: 'archived' }
const routing: NativeRecordingRouting = { schema_version: 1, direction: 'incoming', connection_id: 'fixture-connection', to_e164: '+33123456789', from_e164: null,
  telnyx_call_control_id: 'fixture-call', telnyx_call_leg_id: 'fixture-leg', telnyx_call_session_id: 'fixture-session', admitted_at: at }
const snapshot: NativeRecordingSnapshot = { schema_version: 1, call_id: callId, configuration_revision: 2, recording_enabled: true, transfer_destination: null, retention_until: until,
  knowledge: { business_name: 'Fixture', sector: 'garage', opening_hours: '', services: '', prices: '', faq: '', instructions: '' } }
const input = { url: 'postgresql://fixture.invalid/owned', deployment: 'fixture-a', routing, snapshot }

type RetirementReply = { ok: { retired: boolean } }
type RetirementOptions = { endCloses?: boolean; killCloses?: boolean; exitCode?: number | null; reply?: RetirementReply }
type ChildBoundary = {
  child: ChildProcessWithoutNullStreams; stdout: PassThrough; requests: string[]; kill: MockInstance<ChildProcess['kill']>
  close(code?: number | null): void; readonly directory: string; reply(value: unknown): void; retirement(options: RetirementOptions): void
}
const children: ChildBoundary[] = []
function childBoundary(startup = '{"ready":true}\n'): ChildBoundary {
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough()
  const stdio: ChildProcessWithoutNullStreams['stdio'] = [stdin, stdout, stderr, null, null]
  const child = Object.assign(new ChildProcess(), { stdin, stdout, stderr, stdio })
  let directory = '', endCloses = true, killCloses = false, exitCode: number | null = 0, closeReply: RetirementReply = { ok: { retired: true } }
  const requests: string[] = []
  const close = (code: number | null = exitCode) => { Object.defineProperty(child, 'exitCode', { value: code, configurable: true }); child.emit('close', code) }
  const kill = vi.spyOn(child, 'kill').mockImplementation(() => { if (killCloses) queueMicrotask(() => close(null)); return true })
  stdin.on('data', bytes => {
    const frame = bytes.toString(); requests.push(frame)
    if (JSON.parse(frame).action === 'close') stdout.write(JSON.stringify(closeReply) + '\n')
  })
  stdin.once('finish', () => { if (endCloses) queueMicrotask(() => close()) })
  external.spawn.mockImplementationOnce((_file, args) => {
    if (!Array.isArray(args) || typeof args[4] !== 'string') throw new Error('Unexpected archive child boundary')
    directory = args[4]
    queueMicrotask(() => stdout.write(startup))
    return child
  })
  const boundary = {
    child, stdout, requests, kill, close,
    get directory() { return directory },
    reply(value: unknown) { stdout.write(JSON.stringify(value) + '\n') },
    retirement(options: RetirementOptions) {
      endCloses = options.endCloses ?? endCloses; killCloses = options.killCloses ?? killCloses
      if ('exitCode' in options) exitCode = options.exitCode ?? null
      if (options.reply !== undefined) closeReply = options.reply
    },
  }
  children.push(boundary)
  return boundary
}
beforeEach(() => {
  vi.stubEnv('SPARRA_VOICE_TEST_ROOT', join(tmpdir(), 'controlled-voice-boundary'))
  vi.stubEnv('SPARRA_VOICE_NLTK_DATA', join(tmpdir(), 'controlled-nltk-boundary'))
  vi.stubEnv('SPARRA_VOICE_TEST_HOME', join(tmpdir(), 'controlled-home-boundary'))
  external.producer.mockResolvedValue({ pythonExecutable: join(tmpdir(), 'controlled-python-boundary'), sourceRoot: join(tmpdir(), 'controlled-voice-boundary', 'src') })
})
afterEach(async () => {
  for (const boundary of children.splice(0)) {
    boundary.close()
    boundary.child.stdin.destroy(); boundary.stdout.destroy(); boundary.child.stderr.destroy()
    if (boundary.directory && await access(boundary.directory).then(() => true, () => false)) await retireFixtureDirectory(boundary.directory, prefix, true)
  }
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.resetAllMocks()
})

test('fragmented archive bytes remain exact through the public consumer and native commands stay framed', async () => {
  const boundary = childBoundary(), driver = await startRecordingArchiveFixture()
  const prepared = driver.prepare(input), frame = JSON.stringify({ ok: facts }) + '\n'
  boundary.stdout.write(frame.slice(0, 17)); boundary.stdout.write(frame.slice(17))
  await expect(prepared).resolves.toEqual({ callId, recordingId, operations: facts.operations, receiptBytes, operation, ciphertextBytes: 188, ciphertextSha256: digest, ledgerState: 'archived' })
  const relayed = driver.relay(callId)
  boundary.reply({ ok: { relay: { status: 'delivered', processed: 4, acked: 4, retried: 0, discarded: 0 }, ledger_state: 'acknowledged' } })
  await expect(relayed).resolves.toEqual({ status: 'delivered', processed: 4, acked: 4, ledgerState: 'acknowledged' })
  const ingested = driver.ingest(callId, receiptBytes, true)
  boundary.reply({ ok: { ack: true } }); await expect(ingested).resolves.toEqual({ ack: true })
  const witnessed = driver.witness(callId), witness = { ledger_state: 'acknowledged', outbox_head_kind: null, outbox_head_operation_id: null, recording_outbox_rows: 0 }
  boundary.reply({ ok: witness }); await expect(witnessed).resolves.toEqual(witness)
  const erased = driver.erase(callId, 'fixture-token')
  boundary.reply({ ok: { files_removed: true, ack: true } }); await expect(erased).resolves.toEqual({ files_removed: true, ack: true })
  await driver.cleanup()
  expect(boundary.requests).toEqual([
    JSON.stringify({ action: 'prepare', ...input }) + '\n', JSON.stringify({ action: 'relay', call_id: callId }) + '\n',
    JSON.stringify({ action: 'ingest', call_id: callId, operation: receiptBytes, lost_commit: true }) + '\n',
    JSON.stringify({ action: 'witness', call_id: callId }) + '\n', JSON.stringify({ action: 'erase', call_id: callId, token: 'fixture-token' }) + '\n', '{"action":"close"}\n',
  ])
  await expect(access(boundary.directory)).rejects.toThrow()
})

test.each([
  ['different call', { ...facts, call_id: 'foreign-call' }],
  ['different recording', { ...facts, recording_id: 'foreign-recording' }],
  ['different digest', { ...facts, ciphertext_sha256: 'b'.repeat(64) }],
  ['different length', { ...facts, ciphertext_bytes: 189 }],
  ['non-string operation bytes', { ...facts, operations: [null] }],
  ['unparseable receipt', { ...facts, receipt_operation: '{' }],
  ['missing receipt payload', { ...facts, receipt_operation: JSON.stringify({ call_id: callId, payload: null }) }],
])('prepare rejects %s as a closed archive contract', async (_name, value) => {
  const boundary = childBoundary(), driver = await startRecordingArchiveFixture(), prepared = driver.prepare(input)
  boundary.reply({ ok: value })
  await expect(prepared).rejects.toThrow('Native recording archive fixture contract')
  await driver.cleanup()
})

test.each([null, { status: 1, processed: 4, acked: 4 }, { status: 'delivered', processed: '4', acked: 4 }, { status: 'delivered', processed: 4, acked: null }])('relay rejects malformed nested facts %#', async relay => {
  const boundary = childBoundary(), driver = await startRecordingArchiveFixture(), relayed = driver.relay(callId)
  boundary.reply({ ok: { relay, ledger_state: 'acknowledged' } })
  await expect(relayed).rejects.toThrow('Native recording archive fixture contract')
  await driver.cleanup()
})

test.each([null, [], 42, {}, { ok: null }, { ok: [] }, { ok: 42 }])('ingest rejects malformed reply envelopes %#', async reply => {
  const boundary = childBoundary(), driver = await startRecordingArchiveFixture(), ingested = driver.ingest(callId, receiptBytes)
  boundary.reply(reply)
  await expect(ingested).rejects.toThrow('Native recording archive fixture contract')
})

test('the consumer reports the producer error class without accepting an acknowledgement', async () => {
  const boundary = childBoundary(), driver = await startRecordingArchiveFixture(), ingested = driver.ingest(callId, receiptBytes)
  boundary.reply({ error: 'OperationSinkCommitAmbiguousError' })
  await expect(ingested).rejects.toThrow('Native recording archive fixture: OperationSinkCommitAmbiguousError')
  await driver.cleanup()
})

test('a ready frame cannot revive startup after a malformed coalesced frame', async () => {
  childBoundary('{"ready":true}\nnot-json\n{"ready":true}\n')
  await expect(startRecordingArchiveFixture()).rejects.toThrow('Native recording archive fixture contract')
})

test('a malformed coalesced frame invalidates an already resolved command acknowledgement', async () => {
  const boundary = childBoundary(), driver = await startRecordingArchiveFixture(), ingested = driver.ingest(callId, receiptBytes)
  boundary.stdout.write('{"ok":{"ack":true}}\nnot-json\n')
  await expect(ingested).rejects.toThrow('Native recording archive fixture contract')
  await expect(driver.relay(callId)).rejects.toThrow('Native recording archive fixture contract')
  expect(boundary.requests).toHaveLength(1)
})

test('oversized stdout rejects the waiting command and subsequent dispatch', async () => {
  const boundary = childBoundary(), driver = await startRecordingArchiveFixture(), ingested = driver.ingest(callId, receiptBytes)
  boundary.stdout.write('x'.repeat(1048577))
  await expect(ingested).rejects.toThrow('Native recording archive fixture contract')
  await expect(driver.relay(callId)).rejects.toThrow('Native recording archive fixture contract')
  expect(boundary.requests).toHaveLength(1)
})

test('child close rejects pending work and prevents another command write', async () => {
  const boundary = childBoundary(), driver = await startRecordingArchiveFixture(), ingested = driver.ingest(callId, receiptBytes)
  boundary.close(1)
  await expect(ingested).rejects.toThrow('Native recording archive fixture contract')
  await expect(driver.relay(callId)).rejects.toThrow('Native recording archive fixture contract')
  expect(boundary.requests).toHaveLength(1)
})

test('a missing reply reaches the 30 second deadline and prevents later dispatch', async () => {
  vi.useFakeTimers()
  const boundary = childBoundary(), driver = await startRecordingArchiveFixture(), rejected = expect(driver.ingest(callId, receiptBytes)).rejects.toThrow('30s deadline')
  await vi.advanceTimersByTimeAsync(29999)
  expect(boundary.kill).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1); await rejected
  await expect(driver.relay(callId)).rejects.toThrow('Native recording archive fixture contract')
  expect(boundary.requests).toHaveLength(1)
})

test('cleanup keeps the owned directory until the acknowledged consumer actually closes', async () => {
  vi.useFakeTimers()
  const boundary = childBoundary(), driver = await startRecordingArchiveFixture()
  boundary.retirement({ endCloses: false })
  const cleanup = driver.cleanup()
  await vi.advanceTimersByTimeAsync(2999)
  await expect(access(boundary.directory)).resolves.toBeUndefined()
  boundary.close(0); await cleanup
  await expect(access(boundary.directory)).rejects.toThrow()
  expect(boundary.kill).not.toHaveBeenCalled()
})

test.each([{ exitCode: 1 }, { reply: { ok: { retired: false } } }])('cleanup refuses unsuccessful retirement %# even after confirmed close', async options => {
  const boundary = childBoundary(), driver = await startRecordingArchiveFixture()
  boundary.retirement(options)
  await expect(driver.cleanup()).rejects.toThrow('Native recording archive cleanup failed')
  await expect(access(boundary.directory)).rejects.toThrow()
})

test('cleanup kills a stalled consumer but retains the directory when close stays unknown', async () => {
  vi.useFakeTimers()
  const boundary = childBoundary(), driver = await startRecordingArchiveFixture()
  boundary.retirement({ endCloses: false })
  const rejected = expect(driver.cleanup()).rejects.toThrow('consumer retirement unknown')
  await vi.advanceTimersByTimeAsync(6000); await rejected
  expect(boundary.kill).toHaveBeenCalledOnce()
  await expect(access(boundary.directory)).resolves.toBeUndefined()
})

test('unprepared actual Voice scope is refused before child or temporary-directory work', async () => {
  vi.stubEnv('SPARRA_VOICE_TEST_ROOT', '')
  await expect(startRecordingArchiveFixture()).rejects.toThrow('prepared actual Voice source scope')
  expect(external.spawn).not.toHaveBeenCalled()
})
