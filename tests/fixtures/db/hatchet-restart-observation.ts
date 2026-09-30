import type { Client, QueryResultRow } from 'pg'
import { statementBudget } from '../../helpers/hatchet-restart.ts'

// Pinned release sqlcv1/{workers,queue,lease,tenants}.sql and models.go.
// This file reads only the disposable engine; it is not an application DB API.
export type RestartSnapshot = {
  nowMs: number
  schedulerPartitionId: string | null
  workers: { id: string; name: string; dispatcherId: string | null; isActive: boolean; isPaused: boolean; heartbeatMs: number | null; listenerMs: number | null; actionMatch: boolean; capacity: number; used: number }[]
  partitions: { id: string; heartbeatMs: number }[]
  leases: { id: string; kind: string; resourceId: string; expiresMs: number }[]
  task: { externalId: string; taskId: string; insertedAt: string; retryCount: number; actionId: string; queue: string; queueItems: number; workerId: string | null } | null
}

async function read<T extends QueryResultRow>(db: Client, text: string, values: unknown[], deadline: number) {
  await db.query("SELECT set_config('statement_timeout', $1, false)", [`${statementBudget(deadline)}ms`])
  // Re-sample after configuration so the actual observation statement consumes
  // no more than its remaining budget. SET itself runs under the prior timeout.
  const remaining = statementBudget(deadline)
  await db.query(`SET statement_timeout = '${remaining}ms'`)
  return db.query<T>(text, values)
}

export async function proveHatchetStatementDeadline(db: Client) {
  // Only entry to the restart diagnostic changes this session default. The
  // normal Hatchet matrix retains its persisted-TTL pg_sleep observations.
  await db.query('SET statement_timeout = 1000')
  const started = performance.now()
  try { await read(db, 'SELECT pg_sleep(0.2)', [], started + 60) }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '57014') return { sqlstate: '57014', elapsedMs: performance.now() - started }
    throw error
  }
  throw new Error('Owned PostgreSQL statement deadline did not cancel the read')
}

export async function readHatchetClaimExpiry(db: Client, tenantId: string, outboxId: string, deadline: number) {
  const result = await read<{ expiresMs: number }>(db, 'SELECT EXTRACT(EPOCH FROM expires_at)*1000::float8 AS "expiresMs" FROM v1_idempotency_key WHERE tenant_id=$1 AND key=$2 LIMIT 1', [tenantId, `auth-email-delivery:${outboxId}`], deadline)
  if (result.rows.length !== 1) throw new Error('Owned claim missing')
  return result.rows[0].expiresMs
}

export async function readHatchetClock(db: Client, deadline: number) {
  return (await read<{ nowMs: number }>(db, 'SELECT EXTRACT(EPOCH FROM clock_timestamp())*1000::float8 AS "nowMs"', [], deadline)).rows[0].nowMs
}

export async function readHatchetRestartSnapshot(db: Client, tenantId: string, names: string[], runId: string | null, partitionIds: string[], sinceMs: number | null, deadline: number): Promise<RestartSnapshot> {
  if (names.length > 2 || partitionIds.length > 2) throw new Error('Restart observation ownership limit')
  const result = await read<{ snapshot: RestartSnapshot }>(db, `
    WITH tenant AS (SELECT "schedulerPartitionId" FROM "Tenant" WHERE id=$1 AND version='V1' LIMIT 1),
    workers AS (SELECT w.id,w.name,w."dispatcherId",w."isActive",w."isPaused",w."lastHeartbeatAt",w."lastListenerEstablished" FROM "Worker" w WHERE w."tenantId"=$1 AND w.name=ANY($2::text[]) LIMIT 3),
    target AS (SELECT id, inserted_at, external_id, retry_count, action_id, queue FROM v1_task WHERE tenant_id=$1 AND external_id=$3::uuid LIMIT 1)
    SELECT json_build_object(
      'nowMs', EXTRACT(EPOCH FROM clock_timestamp())*1000::float8,
      'schedulerPartitionId', (SELECT "schedulerPartitionId" FROM tenant),
      'workers', COALESCE((SELECT json_agg(json_build_object(
        'id', w.id, 'name', w.name, 'dispatcherId', w."dispatcherId", 'isActive', w."isActive", 'isPaused', w."isPaused",
        'heartbeatMs', EXTRACT(EPOCH FROM w."lastHeartbeatAt" AT TIME ZONE 'UTC')*1000::float8,
        'listenerMs', EXTRACT(EPOCH FROM w."lastListenerEstablished" AT TIME ZONE 'UTC')*1000::float8,
        'actionMatch', EXISTS(SELECT 1 FROM "_ActionToWorker" aw JOIN "Action" a ON a.id=aw."A" WHERE aw."B"=w.id AND a."tenantId"=$1 AND a."actionId"='auth-email-delivery:auth-email-delivery'),
        'capacity', COALESCE((SELECT max_units FROM v1_worker_slot_config WHERE tenant_id=$1 AND worker_id=w.id AND slot_type='default'),0),
        'used', (SELECT (COALESCE(SUM(CASE WHEN tr.batch_id IS NULL THEN rs.units ELSE 0 END),0)+COUNT(DISTINCT tr.batch_id))::int
          FROM v1_task_runtime_slot rs LEFT JOIN v1_task_runtime tr ON tr.task_id=rs.task_id AND tr.task_inserted_at=rs.task_inserted_at AND tr.retry_count=rs.retry_count
          WHERE rs.tenant_id=$1 AND rs.worker_id=w.id AND rs.slot_type='default')
      ) ORDER BY w.name) FROM workers w),'[]'::json),
      'partitions', COALESCE((SELECT json_agg(json_build_object('id',p.id,'heartbeatMs',EXTRACT(EPOCH FROM p."lastHeartbeat" AT TIME ZONE 'UTC')*1000::float8))
        FROM (SELECT id,"lastHeartbeat" FROM "SchedulerPartition" WHERE id=(SELECT "schedulerPartitionId" FROM tenant) OR id=ANY($4::text[]) OR ($5::float8 IS NOT NULL AND "createdAt" AT TIME ZONE 'UTC'>=to_timestamp($5::float8/1000)) ORDER BY "createdAt" LIMIT 3) p),'[]'::json),
      'leases', COALESCE((SELECT json_agg(json_build_object('id',l.id::text,'kind',l.kind,'resourceId',l."resourceId",'expiresMs',EXTRACT(EPOCH FROM l."expiresAt" AT TIME ZONE 'UTC')*1000::float8))
        FROM (SELECT id,kind,"resourceId","expiresAt" FROM "Lease" WHERE "tenantId"=$1 AND ((kind='WORKER' AND "resourceId" IN (SELECT id::text FROM workers)) OR (kind='QUEUE' AND "resourceId"=(SELECT queue FROM target))) ORDER BY id LIMIT 4) l),'[]'::json),
      'task', (SELECT json_build_object('externalId',t.external_id,'taskId',t.id::text,'insertedAt',t.inserted_at,'retryCount',t.retry_count,'actionId',t.action_id,'queue',t.queue,
        'queueItems',(SELECT count(*)::int FROM v1_queue_item q WHERE q.tenant_id=$1 AND q.task_id=t.id AND q.task_inserted_at=t.inserted_at AND q.retry_count=t.retry_count),
        'workerId',(SELECT worker_id FROM v1_task_runtime r WHERE r.tenant_id=$1 AND r.task_id=t.id AND r.task_inserted_at=t.inserted_at AND r.retry_count=t.retry_count)) FROM target t)
    ) AS snapshot FROM tenant`, [tenantId, names, runId, partitionIds, sinceMs], deadline)
  if (result.rows.length !== 1) throw new Error('Owned V1 tenant observation mismatch')
  const snapshot = result.rows[0].snapshot
  if (!Number.isFinite(snapshot.nowMs) || snapshot.workers.length > 2 || snapshot.partitions.length > 2 || snapshot.leases.length > 3) throw new Error('Owned native schema/observation mismatch')
  return snapshot
}
