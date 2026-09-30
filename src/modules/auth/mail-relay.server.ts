import { IdempotencyCollisionError } from '@hatchet-dev/typescript-sdk/util/errors/idempotency-collision-error.js'
import { Schema } from 'effect'
import type { MailStore } from './mail-store.server'

type AdmissionTask = { runNoWait(input: { outboxId: string }): Promise<{ getWorkflowRunId(): Promise<string> }> }
const runIdSchema = Schema.String.check(Schema.isUUID(), Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i))
export async function admitAuthMail(task: AdmissionTask, outboxId: string) {
  let value: unknown
  try { value = await (await task.runNoWait({ outboxId })).getWorkflowRunId() }
  catch (error) { value = error instanceof IdempotencyCollisionError ? error.existingRunExternalId : null }
  try { return { state: 'admitted' as const, runId: Schema.decodeUnknownSync(runIdSchema)(value) } }
  catch { return { state: 'admission_unknown' as const, runId: null } }
}
export async function relayAuthMailOnce(store: Pick<MailStore, 'claimAdmission' | 'finalizeAdmission'>, task: AdmissionTask, signal: AbortSignal) {
  try {
    if (signal.aborted) return 'stopped'
    const claim = await store.claimAdmission(signal)
    if (!claim) return 'idle'
    const admission = signal.aborted ? { state: 'admission_unknown' as const, runId: null } : await admitAuthMail(task, claim.outboxId)
    return await store.finalizeAdmission(claim.outboxId, claim.fence, admission.runId) ? admission.state : 'admission_unknown'
  } catch { return 'unavailable' }
}
