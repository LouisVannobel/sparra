import { Schema } from 'effect'
import type { AuthEmailEnvelope } from './auth-email-envelope.server'
import { decodeMailSnapshot, type MailSnapshot } from './mail-snapshot.server'
import { mailJob, type MailStore } from './mail-store.server'
import type { PlunkResult } from './plunk.server'

export type MailDeferralReason = 'worker_stopping' | 'outbox_in_flight' | 'capacity_busy' | 'claim_unresolved'
export type HandlerResult =
  | { state: 'inert' | 'cancelled' | 'held' | 'effect_unknown' | 'plunk_queued' }
  | { state: 'deferred'; reason: MailDeferralReason }
  | { state: 'effect_unknown'; queuedEvidence: 'response_200' | 'duplicate_409'; emailId: string | null }
export function createAuthMailHandler(store: Pick<MailStore, 'claimDelivery' | 'finalizeDelivery'>, envelope: AuthEmailEnvelope,
  transport: { send(snapshot: MailSnapshot, signal: AbortSignal, deadlineAt: number): Promise<PlunkResult> }) {
  let stopping = false
  const active = new Map<string, { controller: AbortController; done: Promise<HandlerResult> }>()
  function handle(input: unknown, parentSignal: AbortSignal): Promise<HandlerResult> {
    if (parentSignal.aborted) return Promise.resolve({ state: 'cancelled' })
    let outboxId: string
    try { outboxId = Schema.decodeUnknownSync(mailJob)(input, { onExcessProperty: 'error' }).outboxId }
    catch { return Promise.resolve({ state: 'inert' }) }
    if (stopping) return Promise.resolve({ state: 'deferred', reason: 'worker_stopping' })
    if (active.has(outboxId)) return Promise.resolve({ state: 'deferred', reason: 'outbox_in_flight' })
    if (active.size >= 1) return Promise.resolve({ state: 'deferred', reason: 'capacity_busy' })
    const controller = new AbortController(), abort = () => controller.abort()
    parentSignal.addEventListener('abort', abort, { once: true })
    async function run(): Promise<HandlerResult> {
      try {
        const started = performance.now()
        // The physical owner resolves only after a successful COMMIT. A lost
        // commit acknowledgement never releases payload to the transport.
        let claim
        try { claim = await store.claimDelivery(outboxId, controller.signal) }
        catch {
          return parentSignal.aborted ? { state: 'effect_unknown' }
            : { state: 'deferred', reason: 'claim_unresolved' }
        }
        if (!claim) return { state: 'inert' }
        let result: PlunkResult = { state: 'held' }
        try {
          const now = new Date(claim.databaseTime), expiresAt = new Date(claim.expiresAt)
          // PostgreSQL's clock can carry microseconds; JS Date truncates them.
          // Use its upper millisecond bound so decoding cannot extend authority.
          const budgetTime = now.getTime() + 1
          // SQL increments the durable fence on every claim: 1 is the first
          // attempt, >1 a retry requiring the original persisted replay limit.
          const replayEnd = claim.fence === 1 ? Infinity
            : claim.replayNotAfter === null ? NaN : new Date(claim.replayNotAfter).getTime()
          const deadlineAt = started + Math.min(10000, expiresAt.getTime() - budgetTime,
            new Date(claim.leaseUntil).getTime() - budgetTime, replayEnd - budgetTime)
          if (controller.signal.aborted || stopping || !Number.isFinite(deadlineAt) || deadlineAt <= performance.now()) throw new Error()
          const bytes = envelope.open(claim, { deliveryId: claim.deliveryId, purpose: claim.purpose, generation: claim.generation, expiresAt }, now)
          let snapshot: MailSnapshot
          try { snapshot = decodeMailSnapshot(bytes, claim.hash) } finally { bytes.fill(0) }
          if (snapshot.idempotencyKey !== `auth-email-delivery:${outboxId}` || snapshot.replayWindowSeconds !== claim.replayWindowSeconds) throw new Error()
          if (controller.signal.aborted || stopping || deadlineAt <= performance.now()) throw new Error()
          result = { state: 'effect_unknown' }
          result = await transport.send(snapshot, controller.signal, deadlineAt)
        } catch { /* A possibly invoked provider remains unknown. */ }
        let finalized = false
        try { finalized = await store.finalizeDelivery(outboxId, claim.fence, result) }
        catch { /* A finalization failure is not a new claim-acquisition deferral. */ }
        if (finalized) return { state: result.state }
        return result.state === 'plunk_queued'
          ? { state: 'effect_unknown', queuedEvidence: result.evidence, emailId: result.emailId }
          : { state: 'effect_unknown' }
      } catch { return { state: 'effect_unknown' } }
      finally { parentSignal.removeEventListener('abort', abort); active.delete(outboxId) }
    }
    const done = run()
    active.set(outboxId, { controller, done })
    return done
  }
  async function stop() {
    stopping = true
    const pending = [...active.values()]
    for (const handler of pending) handler.controller.abort()
    await Promise.all(pending.map(handler => handler.done))
  }
  return { handle, stop }
}
