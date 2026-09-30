import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { HatchetClient } from '@hatchet-dev/typescript-sdk/v1/index.js'
import { IdempotencyCollisionError } from '@hatchet-dev/typescript-sdk/util/errors/idempotency-collision-error.js'
import { Status as RpcStatus } from '@hatchet-dev/typescript-sdk/protoc/google/rpc/status.js'
import { IdempotencyCollisionError as CollisionDetail } from '@hatchet-dev/typescript-sdk/protoc/v1/workflows.js'
import { HATCHET_VERSION } from '@hatchet-dev/typescript-sdk/version.js'
import { startDisposableHatchet } from '../fixtures/db/disposable-stores.ts'
import { bounded } from '../helpers/web-process.ts'
import { createHatchetProbeClient, executionRecorderForWorker, until, type ObservationRequest } from '../helpers/hatchet-probe.ts'
import { recoveryMeasurementDeadline, restartActionObserver, superviseRestartWorker } from '../helpers/hatchet-restart.ts'
import type { RestartSnapshot } from '../fixtures/db/hatchet-restart-observation.ts'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
function httpStatus(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'response' in error
    && typeof error.response === 'object' && error.response !== null && 'status' in error.response
    && typeof error.response.status === 'number' ? error.response.status : undefined
}

// node --test --test-concurrency=1 tests/probes/hatchet-runtime.probe.ts
// HATCHET_RESTART_DIAGNOSTIC=1 isolates the currently failing restart/TTL gate.
// This is source-to-runtime characterization, not a mail worker or business TTL.
const diagnosticOnly = process.env.HATCHET_RESTART_DIAGNOSTIC === '1'
test(diagnosticOnly ? 'diagnostic only: admitted run remains observable across restart and TTL' : 'exact engine preserves auth admission identity and exposes cooperative lifecycle limits', { timeout: 180_000 }, async () => {
  const wholeStarted = performance.now(), wholeObservationDeadline = wholeStarted + 155_000
  const at = () => performance.now() - wholeStarted
  const fixture = await startDisposableHatchet()
  const observations: Record<string, unknown> = {}
  const messages: string[] = []
  const actionObserver = restartActionObserver(at)
  const lifecycles = new Map<string, ReturnType<typeof superviseRestartWorker>>()
  const handlerEvents: { generation: string; outboxId: string; enteredAt: number; releasedAt?: number; completedAt?: number }[] = []
  const latches = new Map<string, { promise: Promise<void>; release: () => void }>()
  let currentGeneration: string | undefined
  const checkWorkers = () => { for (const worker of lifecycles.values()) worker.check() }
  // SDK OFF still logs in this version. Capture strings, never SDK error objects.
  const capture = (message: string, scope?: string) => {
    if (diagnosticOnly) actionObserver.accept(scope, message)
    else messages.push(message)
  }
  const executions = new Map<string, string[]>()
  const executionCount = (outboxId: string) => executions.get(outboxId)?.length
  const completed = new Set<string>(), aborted = new Set<string>()
  const failingId = randomUUID(), cooperativeId = randomUUID(), noncooperativeId = randomUUID()
  let releaseHandler = () => {}
  const release = { promise: new Promise<void>(resolve => { releaseHandler = resolve }), resolve: () => releaseHandler() }
  let currentWorker: Awaited<ReturnType<HatchetClient['worker']>> | undefined
  let startOutcome: Promise<string> | undefined
  let phase = 'compatibility'
  try {
    const client = createHatchetProbeClient(fixture.config, fixture.clientConfigPath, capture)
    assert.equal(client.tenantId, fixture.tenantId)
    assert.equal(HATCHET_VERSION, '1.28.2')
    assert.equal((await client.tenant.get()).version, 'V1')
    assert.equal(await client.dispatcher.getVersion(), 'v0.101.27')
    const taskOptions = {
      name: 'auth-email-delivery', retries: 0,
      idempotency: { strategy: 'ttl' as const, ttlMs: 30_000, expression: "'auth-email-delivery:' + input.outboxId" },
    }
    const task = client.task<{ outboxId: string }, { done: true }>(taskOptions)
    const taskForWorker = (recordEntry: (outboxId: string) => void, generation: string) => client.task<{ outboxId: string }, { done: true }>({
      ...taskOptions,
      fn: async ({ outboxId }, ctx) => {
        assert.match(outboxId, uuid)
        recordEntry(outboxId)
        const entry = { generation, outboxId, enteredAt: at(), completedAt: undefined as number | undefined, releasedAt: undefined as number | undefined }
        if (diagnosticOnly) handlerEvents.push(entry)
        try {
          if (diagnosticOnly) {
            await bounded(latches.get(generation)!.promise, 10_000)
            entry.releasedAt = at()
          }
          if (outboxId === failingId) throw new Error('synthetic handler failure')
          if (outboxId === cooperativeId || outboxId === noncooperativeId) {
            const signal = ctx.abortController.signal
            const cancelled = new Promise<void>(resolve => {
              const observe = () => { aborted.add(outboxId); resolve() }
              if (signal.aborted) observe()
              else signal.addEventListener('abort', observe, { once: true })
            })
            if (outboxId === noncooperativeId) await release.promise
            else await cancelled
          }
          return { done: true }
        } finally { completed.add(outboxId); if (diagnosticOnly) entry.completedAt = at() }
      },
    })
    // Structural controls prove that key scope spans task declarations.
    const sameNamespace = client.task<{ outboxId: string }, void>({ name: 'synthetic-same-key', retries: 0,
      idempotency: { strategy: 'ttl', ttlMs: 30_000, expression: "'auth-email-delivery:' + input.outboxId" }, fn: async () => {},
    })
    const otherNamespace = client.task<{ outboxId: string }, void>({ name: 'synthetic-other-key', retries: 0,
      idempotency: { strategy: 'ttl', ttlMs: 30_000, expression: "'synthetic-other-key:' + input.outboxId" }, fn: async () => {},
    })
    async function startWorker() {
      const generation = randomUUID()
      // This worker's task closure retains its immutable generation, including
      // callbacks delivered after a different currentWorker has been installed.
      if (diagnosticOnly) {
        checkWorkers(); actionObserver.ownWorker(generation)
        let release = () => {}
        const promise = new Promise<void>(resolve => { release = resolve })
        latches.set(generation, { promise, release })
      }
      const workerTask = taskForWorker(executionRecorderForWorker(generation, executions), generation)
      currentWorker = await client.worker(`synthetic-${generation}`, { workflows: diagnosticOnly ? [workerTask] : [workerTask, sameNamespace, otherNamespace], slots: 1, handleKill: false })
      currentGeneration = generation
      const start = currentWorker.start()
      if (diagnosticOnly) {
        const supervised = superviseRestartWorker(generation, start, at)
        lifecycles.set(generation, supervised); startOutcome = supervised.settled
      } else startOutcome = start.then(() => 'resolved', () => 'rejected')
      await bounded(currentWorker.waitUntilReady(20_000), 21_000)
      checkWorkers()
      return generation
    }
    async function stopWorker() {
      assert.ok(currentWorker)
      checkWorkers()
      if (currentGeneration) lifecycles.get(currentGeneration)?.requestStop()
      await bounded(currentWorker.stop(), 10_000)
      const outcome = await bounded(startOutcome!, 10_000)
      currentWorker = undefined
      currentGeneration = undefined
      assert.equal(outcome, 'resolved')
      return outcome
    }
    async function expectCollision(promise: Promise<unknown>, expected: string) {
      await assert.rejects(promise, error => {
        assert.ok(error instanceof IdempotencyCollisionError)
        assert.match(error.existingRunExternalId, uuid)
        assert.equal(error.existingRunExternalId, expected)
        return true
      })
    }
    async function runState(id: string, request: ObservationRequest) {
      checkWorkers()
      try { return (await client.api.v1WorkflowRunGet(id, request)).data.run.status }
      catch (error) {
        // Observed REST 404 immediately after successful gRPC admission. Poll
        // this read only within until's existing bound; never readmit the task.
        if (httpStatus(error) === 404) {
          observations.read404Count = Number(observations.read404Count ?? 0) + 1
          return 'NOT_YET_VISIBLE'
        }
        throw error
      }
    }
    const originalGeneration = await startWorker()
    if (diagnosticOnly) {
      const native = fixture.restartObservation
      observations.attempt = 11
      observations.sqlDeadline = await native.proveStatementDeadline()
      observations.wholeObservationCeilingMs = 155_000
      const names = [`synthetic-${originalGeneration}`]
      let partitionIds: string[] = [], partitionsSince: number | null = null
      let restartAt: number | undefined, restartCeiling = wholeObservationDeadline
      let latest: RestartSnapshot | undefined, lastRetainedAt = -Infinity, lastSignature = ''
      const heartbeatHistory = new Map<string, number>()
      const frames: { atMs: number; snapshot: RestartSnapshot }[] = []
      const budget = (ceiling = restartCeiling) => {
        const remaining = Math.floor(Math.min(ceiling, wholeObservationDeadline) - performance.now())
        if (remaining <= 0) throw new Error('Restart diagnostic observation deadline')
        return remaining
      }
      async function sample(label: string, runId: string | null, request: ObservationRequest) {
        checkWorkers()
        latest = await native.snapshot(names, runId, partitionIds, partitionsSince, Math.min(performance.now() + request.timeout, restartCeiling))
        assert.equal(latest.workers.length, names.length, 'exact owned worker lookup')
        if (latest.task) {
          assert.equal(latest.task.externalId, runId)
          assert.equal(latest.task.actionId, 'auth-email-delivery:auth-email-delivery')
          assert.equal(latest.task.retryCount, 0)
        }
        const progression = [...latest.workers.map(w => ({ id: w.id, kind: 'worker', heartbeatMs: w.heartbeatMs })), ...latest.partitions.map(p => ({ id: p.id, kind: 'partition', heartbeatMs: p.heartbeatMs }))].map(row => {
          const prior = heartbeatHistory.get(row.id)
          const advanced = prior !== undefined && row.heartbeatMs !== null && row.heartbeatMs > prior
          if (row.heartbeatMs !== null) heartbeatHistory.set(row.id, row.heartbeatMs)
          return { id: row.id, kind: row.kind, ageMs: row.heartbeatMs === null ? null : latest!.nowMs - row.heartbeatMs, advanced }
        })
        const signature = JSON.stringify({ partition: latest.schedulerPartitionId, task: latest.task?.workerId, queued: latest.task?.queueItems, entries: handlerEvents.length, workers: latest.workers.map(w => [w.id,w.isActive,w.isPaused,w.dispatcherId]) })
        if (at() - lastRetainedAt >= 2000 || signature !== lastSignature || label !== 'poll') {
          const frame = { phase, label, atMs: at(), restartElapsedMs: restartAt === undefined ? null : performance.now() - restartAt, snapshot: latest, progression, lifecycle: [...lifecycles.values()].map(w => ({ ...w.observation })), receipts: actionObserver.receipts.map(r => ({ ...r })), handlerEvents: handlerEvents.map(e => ({ ...e })) }
          console.log('HATCHET_RESTART_SNAPSHOT ' + JSON.stringify(frame))
          frames.push({ atMs: frame.atMs, snapshot: latest }); lastRetainedAt = at(); lastSignature = signature
        }
        return latest
      }
      async function sampleOnce(label: string, runId: string | null) {
        let result: RestartSnapshot | undefined
        await until(async request => { result = await sample(label, runId, request); return true }, label, Math.min(10_000, budget()))
        return result!
      }
      phase = 'diagnostic-schema-original-registration'
      await sampleOnce('schema-and-registration', null)
      phase = 'diagnostic-single-admission'
      const outboxId = randomUUID()
      checkWorkers()
      const runId = await (await task.runNoWait({ outboxId })).getWorkflowRunId()
      observations.diagnosticRunId = runId
      try {
        await until(() => { checkWorkers(); return executionCount(outboxId) === 1 }, 'original handler entry', Math.min(10_000, budget()))
        const calibrated = await sampleOnce('original-held-handler', runId)
        assert.equal(calibrated.task?.workerId, calibrated.workers[0].id)
        assert.equal(calibrated.workers[0].actionMatch, true)
        assert.equal(calibrated.workers[0].capacity, 1)
        assert.equal(calibrated.workers[0].used, 1)
        assert.deepEqual(executions.get(outboxId), [originalGeneration])
        assert.equal(actionObserver.receipts.find(r => r.generation === originalGeneration && r.runId === runId)?.count, 1, 'calibrate exact public action marker')
      } finally { latches.get(originalGeneration)!.release() }
      await until(async request => await runState(runId, request) === 'COMPLETED', 'diagnostic original completion', Math.min(10_000, budget()))
      const expiresMs = await native.claimExpiry(outboxId, wholeObservationDeadline)
      const beforeRestart = await sampleOnce('before-restart', runId)
      const originalPartition = beforeRestart.schedulerPartitionId
      assert.ok(originalPartition)
      partitionIds = beforeRestart.partitions.map(p => p.id); partitionsSince = beforeRestart.nowMs
      phase = 'diagnostic-original-worker-stop'
      await stopWorker()
      restartAt = performance.now()
      restartCeiling = Math.min(restartAt + 130_000, wholeObservationDeadline)
      observations.restartInvocationAtMs = at()
      observations.frozenRestartCeilingAtMs = restartCeiling - wholeStarted
      phase = 'diagnostic-engine-restart-ready'
      await fixture.restart()
      budget(); checkWorkers()
      phase = 'diagnostic-sdk-worker-ready'
      const replacementGeneration = await startWorker()
      names.push(`synthetic-${replacementGeneration}`)
      const registered = await sampleOnce('replacement-registered', runId)
      observations.remainingTtlMs = expiresMs - registered.nowMs
      assert.ok(registered.nowMs < expiresMs, 'restart retains observed live TTL')
      phase = 'diagnostic-restart-live-collision'
      checkWorkers(); await expectCollision(task.runNoWait({ outboxId }), runId)
      phase = 'diagnostic-wait-actual-ttl'
      await until(async request => {
        checkWorkers()
        const clock = await native.clock(Math.min(performance.now() + request.timeout, restartCeiling))
        if (clock > expiresMs + 50) return true
        await delay(Math.min(250, expiresMs + 50 - clock), undefined, { signal: request.signal }); return false
      }, 'persisted TTL boundary', Math.min(budget(), Math.ceil(expiresMs - registered.nowMs + 2000)))
      phase = 'diagnostic-after-ttl-admission'
      checkWorkers(); budget()
      const afterRun = await (await task.runNoWait({ outboxId })).getWorkflowRunId()
      const firstTenEnd = Math.min(performance.now() + 10_000, restartCeiling)
      observations.afterRun = afterRun; assert.notEqual(afterRun, runId)
      const replacementId = registered.workers.find(w => w.name === `synthetic-${replacementGeneration}`)!.id
      let lastStatus = 'NOT_YET_VISIBLE'
      let partitionRecoveryAt: number | undefined, assignmentAt: number | undefined
      const observeRun = async (request: ObservationRequest) => {
        checkWorkers()
        const snapshot = await sample('poll', afterRun, request)
        const entries = executions.get(outboxId) ?? []
        assert.ok(entries.length <= 2 && entries[0] === originalGeneration && (entries.length < 2 || entries[1] === replacementGeneration), 'wrong generation or duplicate execution')
        if (snapshot.schedulerPartitionId !== originalPartition) partitionRecoveryAt ??= at()
        if (snapshot.task?.workerId === replacementId) assignmentAt ??= at()
        if (entries.length === 2) {
          assert.equal(actionObserver.receipts.find(r => r.generation === replacementGeneration && r.runId === afterRun)?.count, 1)
          if (handlerEvents.find(e => e.generation === replacementGeneration)?.completedAt === undefined) assert.equal(snapshot.task?.workerId, replacementId, 'held replacement handler assignment')
          assert.ok(assignmentAt !== undefined, 'native replacement assignment observed before latch release')
          latches.get(replacementGeneration)!.release()
        }
        lastStatus = await runState(afterRun, { ...request, timeout: Math.min(request.timeout, budget()) })
        observations.afterRunStatus = lastStatus
        if (lastStatus === 'FAILED' || lastStatus === 'CANCELLED') throw new Error('Unexpected diagnostic run termination')
        if (lastStatus === 'COMPLETED') return true
        await delay(Math.min(500, request.timeout), undefined, { signal: request.signal }); return false
      }
      phase = 'diagnostic-initial-10s'
      let complete = false
      try { await until(observeRun, 'diagnostic initial 10s', budget(firstTenEnd)); complete = true }
      catch (error) { if (!(error instanceof Error) || error.message !== 'Timed out observing diagnostic initial 10s') throw error }
      observations.initial10s = { outcome: complete ? 'completed' : 'not_completed', status: lastStatus, executions: executionCount(outboxId), endedAtMs: at() }
      if (!complete) {
        const old = latest!.partitions.find(p => p.id === originalPartition)
        const registeredOld = registered.partitions.find(p => p.id === originalPartition)
        const stalePartition = latest!.schedulerPartitionId === originalPartition && old && registeredOld && old.heartbeatMs === registeredOld.heartbeatMs && latest!.partitions.some(p => p.id !== originalPartition && latest!.nowMs - p.heartbeatMs < 60_000)
        const unrecoveredLease = latest!.task?.queueItems ? latest!.leases.find(lease => beforeRestart.leases.some(before => before.id === lease.id && before.kind === lease.kind && before.resourceId === lease.resourceId && before.expiresMs === lease.expiresMs)) : undefined
        const ceiling = recoveryMeasurementDeadline(restartAt, wholeObservationDeadline, performance.now(), latest!.nowMs, stalePartition ? old!.heartbeatMs : undefined, unrecoveredLease?.expiresMs)
        observations.recoveryCondition = { stalePartition: !!stalePartition, unrecoveredLease: unrecoveredLease ?? null, frozenCeilingAtMs: ceiling === undefined ? null : ceiling - wholeStarted }
        if (ceiling === undefined) throw new Error('Restart diagnostic has no remaining source-backed recovery observation')
        phase = 'diagnostic-separate-recovery-measurement'
        await until(observeRun, 'diagnostic recovery ceiling', budget(ceiling))
      }
      assert.deepEqual(executions.get(outboxId), [originalGeneration, replacementGeneration])
      observations.nativeTransition = { originalPartition, finalPartition: latest!.schedulerPartitionId, partitionRecoveryAt, assignmentAt, replacementGeneration, replacementWorkerId: replacementId, actionCalibrated: true, finalStatus: lastStatus, retainedSnapshots: frames.length }
      await stopWorker()
      return
    }
    phase = 'concurrent-admission'
    assert.equal((await fixture.administrator.query('SELECT count(*)::int AS count FROM v1_task WHERE tenant_id=$1', [fixture.tenantId])).rows[0].count, 0)
    const outboxId = randomUUID()
    const admissions = await Promise.allSettled([task.runNoWait({ outboxId }), task.runNoWait({ outboxId })])
    const accepted = admissions.filter(item => item.status === 'fulfilled')
    const rejected = admissions.filter(item => item.status === 'rejected')
    assert.equal(accepted.length, 1, 'concurrent identical inputs must admit exactly one run')
    assert.equal(rejected.length, 1)
    const runId = await accepted[0].value.getWorkflowRunId()
    assert.match(runId, uuid)
    assert.ok(rejected[0].reason instanceof IdempotencyCollisionError)
    assert.equal(rejected[0].reason.existingRunExternalId, runId)
    const claim = (await fixture.administrator.query<{ key: string; expires_at: Date; claimed_by_external_id: string }>(
      'SELECT key, expires_at, claimed_by_external_id FROM v1_idempotency_key WHERE tenant_id=$1 AND key=$2',
      [fixture.tenantId, `auth-email-delivery:${outboxId}`],
    )).rows[0]
    assert.equal(claim.key, `auth-email-delivery:${outboxId}`)
    assert.equal(claim.claimed_by_external_id, runId)
    // Native CreateTasks persists input={} and stores TASKINPUT separately.
    // This fresh tenant has had only the two identical admissions at this point.
    const persisted = (await fixture.administrator.query<{ external_id: string }>('SELECT external_id FROM v1_task WHERE tenant_id=$1', [fixture.tenantId])).rows
    const count = persisted.length
    assert.equal(count, 1)
    assert.equal(persisted[0].external_id, runId)
    observations.concurrent = { outboxId, runId, runCount: count, collisions: 1, expiresAt: claim.expires_at }
    phase = 'namespaces'
    await expectCollision(sameNamespace.runNoWait({ outboxId }), runId)
    const namespacedId = await (await otherNamespace.runNoWait({ outboxId })).getWorkflowRunId()
    assert.notEqual(namespacedId, runId)
    const distinctId = await (await task.runNoWait({ outboxId: randomUUID() })).getWorkflowRunId()
    assert.notEqual(distinctId, runId)
    observations.namespaces = { crossTaskCollision: true, namespacedId, distinctId }
    assert.equal((await fixture.administrator.query('SELECT count(*)::int AS count FROM v1_task WHERE tenant_id=$1', [fixture.tenantId])).rows[0].count, 3)
    await until(async request => await runState(runId, request) === 'COMPLETED', 'original run completion')
    assert.equal(executionCount(outboxId), 1)
    phase = 'uninterrupted-live-ttl'
    const remaining = (await fixture.administrator.query('SELECT EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp()))::float8 AS seconds', [claim.expires_at])).rows[0].seconds
    assert.ok(remaining > 2, 'admission controls must leave an observed live TTL boundary')
    await expectCollision(task.runNoWait({ outboxId }), runId)
    phase = 'before-ttl'
    // Clock authority is the persisted claim and engine PostgreSQL clock.
    await fixture.administrator.query('SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp()))-1.5))', [claim.expires_at])
    const before = (await fixture.administrator.query('SELECT clock_timestamp() AS now')).rows[0].now
    assert.ok(before < claim.expires_at)
    await expectCollision(task.runNoWait({ outboxId }), runId)
    phase = 'after-ttl'
    await fixture.administrator.query('SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.05)', [claim.expires_at])
    const after = (await fixture.administrator.query('SELECT clock_timestamp() AS now')).rows[0].now
    assert.ok(after > claim.expires_at)
    const afterTtlId = await (await task.runNoWait({ outboxId })).getWorkflowRunId()
    assert.notEqual(afterTtlId, runId)
    phase = 'after-ttl-execution'
    await until(async request => {
      const state = await runState(afterTtlId, request)
      observations.afterTtlState = state
      observations.afterTtlHandlerCount = executionCount(outboxId)
      return state === 'COMPLETED'
    }, 'after TTL run completion')
    assert.equal(executionCount(outboxId), 2)
    observations.ttl = { before, expiresAt: claim.expires_at, after, afterTtlId, uninterruptedCollision: true, executions: 2 }
    phase = 'zero-retries'
    const failureRun = await (await task.runNoWait({ outboxId: failingId })).getWorkflowRunId()
    await until(async request => await runState(failureRun, request) === 'FAILED', 'failed run')
    const failedTask = (await fixture.administrator.query('SELECT retry_count, app_retry_count, internal_retry_count FROM v1_task WHERE external_id=$1', [failureRun])).rows[0]
    assert.equal(executionCount(failingId), 1)
    assert.equal(failedTask.retry_count, 0)
    assert.equal(failedTask.app_retry_count, 0)
    observations.failure = { failureRun, executions: 1, ...failedTask }
    phase = 'cooperative-cancel'
    const cooperative = await task.runNoWait({ outboxId: cooperativeId })
    await until(() => executionCount(cooperativeId) === 1, 'cooperative handler entry')
    await cooperative.cancel()
    await until(() => aborted.has(cooperativeId) && completed.has(cooperativeId), 'actual cooperative handler completion')
    const cooperativeRun = await cooperative.getWorkflowRunId()
    await until(async request => await runState(cooperativeRun, request) === 'CANCELLED', 'cooperative cancellation state')
    observations.cooperative = { cooperativeRun, abortObserved: true, handlerCompleted: true, executions: executionCount(cooperativeId) }
    phase = 'noncooperative-cancel-and-stop'
    const noncooperative = await task.runNoWait({ outboxId: noncooperativeId })
    await until(() => executionCount(noncooperativeId) === 1, 'noncooperative handler entry')
    await noncooperative.cancel()
    await until(() => aborted.has(noncooperativeId), 'noncooperative abort signal')
    const noncooperativeRun = await noncooperative.getWorkflowRunId()
    await until(async request => await runState(noncooperativeRun, request) === 'CANCELLED', 'noncooperative wrapper cancelled')
    assert.equal(completed.has(noncooperativeId), false)
    assert.ok(currentWorker)
    let stopped = false
    const stop = currentWorker.stop().then(() => { stopped = true; return 'resolved' }, () => 'rejected')
    const earlyStop = await Promise.race([stop, pause(1500).then(() => 'pending')])
    assert.ok(earlyStop === 'resolved' || earlyStop === 'pending', 'noncooperative stop observation must not reject')
    assert.equal(completed.has(noncooperativeId), false, 'wrapper cancellation is not handler completion')
    observations.noncooperative = { noncooperativeRun, abortObserved: true, earlyStop, stopped, handlerCompletedAtStopObservation: false }
    release.resolve()
    await until(() => completed.has(noncooperativeId), 'released handler completion')
    const stopOutcome = await bounded(stop, 10_000)
    const workerStartOutcome = await bounded(startOutcome!, 10_000)
    assert.equal(stopOutcome, 'resolved')
    assert.equal(workerStartOutcome, 'resolved')
    observations.noncooperative = { noncooperativeRun, abortObserved: true, earlyStop, handlerCompletedAtStopObservation: false, handlerCompletedAfterRelease: completed.has(noncooperativeId), stopOutcome, workerStartOutcome }
    currentWorker = undefined
    phase = 'shutdown-refusal'
    const stoppedGeneration = executions.get(noncooperativeId)![0]
    const stoppedWorkerEntries = () => [...executions.values()].flat().filter(generation => generation === stoppedGeneration).length
    const stoppedCount = stoppedWorkerEntries()
    const queuedId = randomUUID()
    const queuedRun = await (await task.runNoWait({ outboxId: queuedId })).getWorkflowRunId()
    await until(async request => await runState(queuedRun, request) === 'QUEUED', 'engine admission after worker stop')
    assert.equal(executionCount(queuedId), undefined)
    const replacementGeneration = await startWorker()
    await until(async request => await runState(queuedRun, request) === 'COMPLETED', 'new worker takes queued admission')
    assert.deepEqual(executions.get(queuedId), [replacementGeneration])
    await stopWorker()
    assert.equal(stoppedWorkerEntries(), stoppedCount, 'stopped generation must receive no entries across replacement startup/execution/stop')
    assert.deepEqual(executions.get(queuedId), [replacementGeneration])
    observations.shutdown = { queuedRun, stoppedGeneration, replacementGeneration, stoppedWorkerExecutions: 0, replacementWorkerExecutions: 1 }
    phase = 'collision-decoder'
    // Fault injection is below the real SDK decoder and never touches the engine.
    // Mapping these IDs to admission_unknown is still future application work.
    const trigger = client.admin.workflowsGrpc.triggerWorkflow
    let decoderCalls = 0
    try {
      for (const existingRunExternalId of ['', 'invalid-run-id']) {
        client.admin.workflowsGrpc.triggerWorkflow = async request => {
          assert.equal(request.name, 'auth-email-delivery')
          assert.ok(request.input)
          assert.deepEqual(JSON.parse(request.input), { outboxId: failingId })
          decoderCalls++
          const detail = CollisionDetail.encode({ existingRunExternalId, collidingRunExternalId: '' }).finish()
          const bytes = Buffer.from(RpcStatus.encode({ code: 6, message: 'synthetic collision', details: [{ typeUrl: 'type.googleapis.com/IdempotencyCollisionError', value: detail }] }).finish())
          throw Object.assign(new Error('synthetic collision'), { code: 6, metadata: { get: (key: string) => { assert.equal(key, 'grpc-status-details-bin'); return [bytes] } } })
        }
        await assert.rejects(task.runNoWait({ outboxId: failingId }), error => {
          assert.ok(error instanceof IdempotencyCollisionError)
          assert.equal(error.existingRunExternalId, existingRunExternalId)
          return true
        })
      }
    } finally { client.admin.workflowsGrpc.triggerWorkflow = trigger }
    assert.equal(decoderCalls, 2)
    observations.collisionDecoder = { empty: true, invalid: true, transportCalls: decoderCalls, applicationMapping: 'unimplemented' }
    assert.equal(executionCount(failingId), 1)
    assert.equal(executionCount(cooperativeId), 1)
    assert.equal(executionCount(noncooperativeId), 1)
    assert.equal(messages.some(message => /legacy|deprecated|v0 tenant/i.test(message)), false)
    observations.applicationAdmissionMapping = 'unimplemented: DEV-only qualification; invalid collision IDs require admission_unknown in later actual admission consumer'
  } catch (error) {
    const detail = error instanceof Error && error.name === 'AssertionError' ? error.message
      : error instanceof Error && 'routine' in error && 'code' in error ? `SQLSTATE ${String(error.code)}`
      : error instanceof Error && /^(Exact Hatchet engine|Owned process operation|Owned PostgreSQL|Owned native|Owned V1|Owned claim|Timed out observing|Restart diagnostic|Unexpected worker|Unexpected diagnostic|SQL observation|restart must)/.test(error.message) ? error.message : `sanitized dependency failure; HTTP=${httpStatus(error) ?? 'none'}; class=${error instanceof Error ? error.name : 'unknown'}`
    throw new Error(`Hatchet runtime gate failed in ${phase}: ${detail}`)
  } finally {
    release.resolve()
    for (const latch of latches.values()) latch.release()
    try {
      if (diagnosticOnly) await until(() => handlerEvents.every(e => e.completedAt !== undefined), 'diagnostic handler release during cleanup', 2000)
      if (currentGeneration) lifecycles.get(currentGeneration)?.requestStop()
      if (currentWorker) observations.cleanupStopOutcome = await bounded(currentWorker.stop().then(() => 'resolved', () => 'rejected'), 10_000)
      if (startOutcome) observations.cleanupStartOutcome = await bounded(startOutcome, 10_000)
    } finally {
      if (diagnosticOnly) { observations.workers = [...lifecycles.values()].map(w => w.observation); observations.actionReceipts = actionObserver.receipts; observations.handlerEvents = handlerEvents }
      console.log('HATCHET_RUNTIME_OBSERVATIONS ' + JSON.stringify({ phase, ...observations }))
      await fixture.cleanup()
    }
  }
})
