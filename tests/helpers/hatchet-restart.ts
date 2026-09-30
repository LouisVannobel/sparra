export type StartObservation = { generation: string; state: 'pending' | 'resolved' | 'rejected'; stopRequested: boolean; settledAt?: number }
export function superviseRestartWorker(generation: string, start: Promise<void>, now = performance.now.bind(performance)) {
  const observation: StartObservation = { generation, state: 'pending', stopRequested: false }
  let unexpected = false
  const settle = (state: 'resolved' | 'rejected') => { unexpected = !observation.stopRequested; observation.state = state; observation.settledAt = now(); return state }
  const settled = start.then(() => settle('resolved'), () => settle('rejected'))
  return { observation, settled, requestStop: () => { observation.stopRequested = true }, check: () => { if (unexpected) throw new Error('Unexpected worker start settlement') } }
}

export function restartActionObserver(now = performance.now.bind(performance)) {
  const names = new Set<string>()
  const receipts: { generation: string; runId: string; at: number; count: number }[] = []
  return { receipts, ownWorker: (generation: string) => {
    if (names.size >= 2) throw new Error('Restart diagnostic permits only two workers')
    names.add(`Worker/synthetic-${generation}`)
  }, accept: (scope: string | undefined, message: string) => {
    if (!scope || !names.has(scope)) return
    const match = /^Task run starting\.\.\. \t auth-email-delivery\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}) $/i.exec(message)
    if (!match) return
    const generation = scope.slice('Worker/synthetic-'.length), runId = match[1]
    const existing = receipts.find(row => row.generation === generation && row.runId === runId)
    if (existing) existing.count++
    else {
      if (receipts.length >= 4) throw new Error('Unexpected extra action receipt')
      receipts.push({ generation, runId, at: now(), count: 1 })
    }
  } }
}

export function recoveryMeasurementDeadline(restartAt: number, wholeDeadline: number, now: number, databaseNow: number, stalePartitionHeartbeat?: number, unrecoveredLeaseExpiry?: number) {
  if (stalePartitionHeartbeat === undefined && unrecoveredLeaseExpiry === undefined) return undefined
  const nativeCeiling = stalePartitionHeartbeat !== undefined ? stalePartitionHeartbeat + 130_000 : unrecoveredLeaseExpiry! + 15_000
  const ceiling = Math.min(restartAt + 130_000, wholeDeadline, now + nativeCeiling - databaseNow)
  return ceiling > now ? ceiling : undefined
}

export function statementBudget(deadline: number, now = performance.now()) {
  const remaining = Math.floor(deadline - now)
  if (!Number.isFinite(remaining) || remaining <= 0) throw new Error('SQL observation deadline')
  return Math.min(1000, remaining)
}
