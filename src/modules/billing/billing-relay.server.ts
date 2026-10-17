import type { createBillingTask } from './billing-hatchet.server'
import { admitBillingTask, observeBillingAdmission } from './billing-hatchet.server'
import type { BillingAdmissionResult, BillingStore } from './store.server'

export async function relayBillingOnce(store: Pick<BillingStore, 'claimAdmission' | 'finalizeAdmission'>,
  task: ReturnType<typeof createBillingTask>, signal: AbortSignal,
  markTransportUnproven: () => void): Promise<'admitted' | 'admission_unknown' | 'idle' | 'stopped' | 'unavailable'> {
  try {
    if (signal.aborted) return 'stopped'
    const claim = await store.claimAdmission(signal)
    if (!claim) return 'idle'
    let result: BillingAdmissionResult
    if (signal.aborted) result = { state: 'unknown' }
    else {
      result = claim.state === 'dispatch' ? await admitBillingTask(task, claim.input, signal, markTransportUnproven)
        : await observeBillingAdmission(task, claim, signal, markTransportUnproven)
    }
    // Acknowledgement and SQL settlement remain the same fenced obligation,
    // even when stop arrives after the request or while finalization is pending.
    const finalized = await store.finalizeAdmission(claim.input, claim.fence, result)
    return finalized && result.state !== 'unknown' ? 'admitted' : 'admission_unknown'
  } catch { return 'unavailable' }
}
