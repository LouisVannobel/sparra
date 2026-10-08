import { createDecipheriv, createHash, randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import type { AuthTransactions } from '../../platform/db/transactions.server'
import type { PersonalWorkspaceLease } from '../../platform/db/auth-pg-lease.server'
import type { AdmittedPrincipal } from '../auth/session.server'
import { readKeyring } from './message-crypto.server'
import { sparraAudioChunk, sparraAudioReader, sparraCall } from './schema.server'

export class AudioUnavailable extends Error {
  constructor(readonly status: 404 | 409 | 416 = 409) { super('Conversation unavailable'); this.name = 'AudioUnavailable' }
}
export type AudioIncarnation = Readonly<{ incarnation: string; containerId: string; deploymentId: string }>
export type AudioMetadata = Readonly<{
  requestId: string; workspaceId: string; recordingId: string; deploymentId: string
  configurationRevision: number; retentionUntil: string; state: 'ready' | 'partial'
  totalSamples: number; lastSequence: number; reason: string | null
}>
export type AudioReadLease = Readonly<AudioIncarnation & {
  workspaceId: string; callId: string; recordingId: string; leaseId: string; token: string; expiresAt: Date
}>
export type AudioRange = Readonly<{ start: number; end: number; partial: boolean }>
export type AudioDto = Readonly<{ state: typeof sparraCall.$inferSelect.audioState; durationSeconds: number | null; expiresAt: string; partialReason: string | null; available: boolean }>
export function audioDto(row: typeof sparraCall.$inferSelect): AudioDto {
  return { state: row.audioState, durationSeconds: row.audioTotalSamples === null ? null : row.audioTotalSamples / 8000,
    expiresAt: row.retentionUntil.toISOString(), partialReason: row.audioFinishReason,
    available: ['ready', 'partial'].includes(row.audioState) && (row.audioTotalSamples ?? 0) > 0
      && row.audioDeniedAt === null && row.erasureRequestedAt === null && row.retentionUntil.getTime() > Date.now() }
}
export function wavHeader(samples: number): Buffer {
  if (!Number.isInteger(samples) || samples < 0 || samples > 4_800_000) throw new AudioUnavailable()
  const header = Buffer.alloc(44)
  header.write('RIFF', 0); header.writeUInt32LE(36 + samples * 4, 4); header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22)
  header.writeUInt32LE(8000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(4, 32)
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(samples * 4, 40)
  return header
}
function rangeNumber(value: string): number | null {
  if (value === '') return null
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw new AudioUnavailable(416)
  return number
}
function rangeBounds(value: string) {
  const match = /^bytes=([0-9]*)-([0-9]*)$/.exec(value)
  if (value.length > 80 || !match || (!match[1] && !match[2])) throw new AudioUnavailable(416)
  return { first: rangeNumber(match[1]), last: rangeNumber(match[2]) }
}
export function audioRange(value: string | null, length: number): AudioRange {
  if (value === null) return { start: 0, end: length - 1, partial: false }
  const { first, last } = rangeBounds(value)
  if (first === null && last === 0) throw new AudioUnavailable(416)
  const start = first === null ? Math.max(0, length - (last ?? 0)) : first
  const requestedEnd = first === null ? length - 1 : last ?? length - 1
  const end = Math.min(requestedEnd, length - 1, start + 1_048_576 - 1)
  if (start >= length || end < start) throw new AudioUnavailable(416)
  return { start, end, partial: true }
}
function metadata(row: typeof sparraCall.$inferSelect): AudioMetadata {
  if (!audioDto(row).available || !row.recordingId || row.configurationRevision === null
    || row.audioTotalSamples === null || row.audioLastSequence === null) throw new AudioUnavailable()
  return { requestId: row.id, workspaceId: row.workspaceId, recordingId: row.recordingId,
    deploymentId: row.deploymentId, configurationRevision: row.configurationRevision,
    retentionUntil: row.retentionUntil.toISOString(), state: row.audioState === 'ready' ? 'ready' : 'partial',
    totalSamples: row.audioTotalSamples, lastSequence: row.audioLastSequence, reason: row.audioFinishReason }
}
export function createAudioOperations(owner: AuthTransactions) {
  const options = (signal?: AbortSignal, deadline = Date.now() + 10000) => ({
    deadlineAtMs: deadline, statementTimeoutMs: 1000, cleanupTimeoutMs: 1000, correlationId: randomUUID(), signal,
  })
  async function read(principal: AdmittedPrincipal, id: string, signal?: AbortSignal): Promise<AudioMetadata> {
    return owner.withPersonalWorkspacePromise(options(signal), principal, false, async lease => {
      if (!lease) throw new AudioUnavailable(404)
      const [row] = await lease.db.select().from(sparraCall).where(and(eq(sparraCall.workspaceId, lease.workspaceId), eq(sparraCall.id, id),
        sql`${sparraCall.retentionUntil} > clock_timestamp()`, sql`${sparraCall.erasureRequestedAt} is null`))
      if (!row) throw new AudioUnavailable(404)
      return metadata(row)
    })
  }
  async function release(exact: AudioReadLease): Promise<boolean> {
    return owner.withAuthPromise(options(), async lease => {
      const [result] = await lease.db.select({ released: sql<boolean>`public.sparra_audio_release_reader_v1(
        ${exact.leaseId}::uuid,${exact.token}::uuid,${exact.incarnation}::uuid)` }).from(sql`(select 1) AS audio_release`)
      return result?.released === true
    })
  }
  async function acquire(principal: AdmittedPrincipal, pin: AudioMetadata, incarnation: AudioIncarnation,
    deadline: number, signal: AbortSignal): Promise<AudioReadLease> {
    const exact: AudioReadLease = { ...incarnation, workspaceId: pin.workspaceId, callId: pin.requestId,
      recordingId: pin.recordingId, leaseId: randomUUID(), token: randomUUID(), expiresAt: new Date(deadline) }
    try {
      await owner.withPersonalWorkspacePromise(options(signal, deadline), principal, false, async lease => {
        if (!lease || lease.workspaceId !== pin.workspaceId) throw new AudioUnavailable(404)
        const [row] = await lease.db.select().from(sparraCall).where(eq(sparraCall.id, pin.requestId))
        if (!row || row.erasureRequestedAt || row.retentionUntil.getTime() <= Date.now()) throw new AudioUnavailable(404)
        const current = metadata(row)
        if (JSON.stringify(current) !== JSON.stringify(pin)) throw new AudioUnavailable()
        const [previous] = await lease.db.select().from(sparraAudioReader).where(eq(sparraAudioReader.workspaceId, pin.workspaceId))
        if (previous && previous.state !== 'released') throw new AudioUnavailable()
        const values = { workspaceId: exact.workspaceId, callId: exact.callId, recordingId: exact.recordingId,
          leaseId: exact.leaseId, tokenHash: createHash('sha256').update(exact.token).digest('hex'),
          incarnation: exact.incarnation, containerId: exact.containerId, readerDeploymentId: exact.deploymentId,
          expiresAt: exact.expiresAt, state: 'active' as const, releasedAt: null }
        await lease.db.insert(sparraAudioReader).values(values).onConflictDoUpdate({ target: sparraAudioReader.workspaceId, set: values })
      })
      return exact
    } catch (error) {
      // No holder/plaintext/native body exists until acknowledged acquire COMMIT.
      // Reconcile only this opaque capability; unknown release remains occupied.
      try { await release(exact) } catch { /* The database slot keeps the obligation. */ }
      throw error
    }
  }
  async function authorized<A>(principal: AdmittedPrincipal, pin: AudioMetadata, exact: AudioReadLease,
    signal: AbortSignal, use: (lease: PersonalWorkspaceLease) => Promise<A>): Promise<A> {
    return owner.withPersonalWorkspacePromise(options(signal, exact.expiresAt.getTime()), principal, false, async lease => {
      if (!lease || lease.workspaceId !== exact.workspaceId) throw new AudioUnavailable(404)
      const [slot] = await lease.db.select().from(sparraAudioReader).where(eq(sparraAudioReader.workspaceId, exact.workspaceId))
      const [row] = await lease.db.select().from(sparraCall).where(eq(sparraCall.id, exact.callId))
      if (!slot || slot.leaseId !== exact.leaseId || slot.tokenHash !== createHash('sha256').update(exact.token).digest('hex')
        || slot.incarnation !== exact.incarnation || slot.containerId !== exact.containerId || slot.state !== 'active'
        || slot.expiresAt.getTime() <= Date.now() || !row || row.erasureRequestedAt
        || row.retentionUntil.getTime() <= Date.now() || row.audioDeniedAt
        || row.recordingId !== pin.recordingId || row.configurationRevision !== pin.configurationRevision
        || row.retentionUntil.toISOString() !== pin.retentionUntil) throw new AudioUnavailable(404)
      return use(lease)
    })
  }
  async function check(principal: AdmittedPrincipal, pin: AudioMetadata, exact: AudioReadLease, signal: AbortSignal) {
    await authorized(principal, pin, exact, signal, async () => {})
  }
  async function page(principal: AdmittedPrincipal, pin: AudioMetadata, exact: AudioReadLease, sequence: number,
    signal: AbortSignal) {
    return authorized(principal, pin, exact, signal, async lease => {
      const [chunk] = await lease.db.select().from(sparraAudioChunk).where(and(eq(sparraAudioChunk.callId, pin.requestId),
        eq(sparraAudioChunk.recordingId, pin.recordingId), eq(sparraAudioChunk.sequence, sequence)))
      if (!chunk || chunk.workspaceId !== pin.workspaceId || chunk.deploymentId !== pin.deploymentId
        || chunk.configurationRevision !== pin.configurationRevision || chunk.retentionUntil.toISOString() !== pin.retentionUntil
        || chunk.sampleCount < 1 || chunk.sampleCount > 8000 || chunk.sampleRate !== 8000 || chunk.channels !== 2
        || chunk.sampleFormat !== 's16le' || chunk.nonce.length !== 12 || chunk.ciphertext.length !== chunk.sampleCount * 4 + 16) throw new AudioUnavailable()
      return chunk
    })
  }
  async function enqueue(principal: AdmittedPrincipal, pin: AudioMetadata, exact: AudioReadLease,
    signal: AbortSignal, output: () => void) {
    await authorized(principal, pin, exact, signal, async () => { signal.throwIfAborted(); output() })
  }
  return { read, acquire, release, check, page, enqueue }
}
export async function decryptAudioChunk(chunk: typeof sparraAudioChunk.$inferSelect): Promise<Buffer> {
  const keys = await readKeyring(), key = keys?.get(chunk.keyVersion)
  if (!key) throw new AudioUnavailable()
  const values = { schema_version: 2, workspace_id: chunk.workspaceId, deployment_id: chunk.deploymentId,
    call_id: chunk.callId, recording_id: chunk.recordingId, sequence: chunk.sequence, sample_count: chunk.sampleCount,
    sample_rate: chunk.sampleRate, channels: chunk.channels, sample_format: chunk.sampleFormat,
    configuration_revision: chunk.configurationRevision, retention_until: chunk.retentionUntil.toISOString(),
    crypto_version: chunk.cryptoVersion, key_version: chunk.keyVersion }
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b))))
  const aad = Buffer.concat([Buffer.from('sparra.audio.chunk.v1\0'), Buffer.from(canonical)])
  if (aad.length > 2048) throw new AudioUnavailable()
  const decipher = createDecipheriv('aes-256-gcm', key, chunk.nonce)
  decipher.setAAD(aad); decipher.setAuthTag(chunk.ciphertext.subarray(-16))
  const update = decipher.update(chunk.ciphertext.subarray(0, -16))
  try {
    const final = decipher.final(), result = Buffer.concat([update, final])
    final.fill(0)
    if (result.length !== chunk.sampleCount * 4) { result.fill(0); throw new AudioUnavailable() }
    return result
  } catch { throw new AudioUnavailable() } finally { update.fill(0); for (const value of keys?.values() ?? []) value.fill(0) }
}
