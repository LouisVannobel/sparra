// Both preparations consume already migrated stores and generated crypto.
// The caller retains this promise and joins it before retiring either owner.
export async function preparePairedAudioFixture(
  prepareVoice: () => Promise<void>, prepareWeb: () => Promise<void>,
): Promise<void> {
  // Promise continuations also turn a synchronous spawn failure into an
  // observed rejection without skipping the other independently owned start.
  const results = await Promise.allSettled([
    Promise.resolve().then(prepareVoice), Promise.resolve().then(prepareWeb),
  ])
  const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
  if (failures.length) throw new AggregateError(failures, 'Paired native capture startup failed')
}

export type AudioFixtureOwners = Partial<Record<'voice' | 'web' | 'issuer' | 'crypto' | 'stores', () => Promise<void>>>

// One per hook: callbacks close over the current handles, never previous globals.
export function startPairedAudioFixture(prepare: (owners: AudioFixtureOwners) => Promise<void>) {
  const owners: AudioFixtureOwners = {}
  const ready = Promise.resolve().then(() => prepare(owners))
  return { ready, async cleanup() {
    // Hook timeouts do not cancel promises. Join prerequisites and both starts
    // before retiring resources; the hook itself reports startup rejection.
    await ready.catch(() => {})
    const failures: unknown[] = []
    for (const close of [owners.voice, owners.web, owners.issuer, owners.crypto, owners.stores]) {
      if (!close) continue
      try { await close() } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'Paired native capture cleanup failed')
  } }
}
