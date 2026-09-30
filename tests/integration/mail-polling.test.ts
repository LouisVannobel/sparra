import { afterAll, beforeAll, expect, test } from 'vitest'
import { startDisposableStores } from '../fixtures/db/disposable-stores'

type Stores = Awaited<ReturnType<typeof startDisposableStores>>
type PlanNode = {
  'Node Type': string
  'Relation Name'?: string
  'Actual Rows': number
  'Actual Loops': number
  'Rows Removed by Filter'?: number
  'Rows Removed by Index Recheck'?: number
  'Shared Hit Blocks': number
  'Shared Read Blocks': number
  Plans?: PlanNode[]
}
type Explain = { Plan: PlanNode; 'Planning Time': number; 'Execution Time': number }[]
type Selectors = { admission: string; purge: string }
const tenant = '00000000-0000-0000-0000-000000000000'
let stores: Stores
const evidence: { stage: string; shapes: unknown[]; [key: string]: unknown } = { stage: 'starting', shapes: [] }

beforeAll(async () => {
  stores = await startDisposableStores()
  stores.evidence.mailPolling = evidence
  await stores.migrate()
  evidence.stage = 'migrated'
}, 0)
afterAll(async () => { if (stores) await stores.cleanup() }, 0)

async function transaction<T>(statementMs: 1000 | 15000, body: () => Promise<T>): Promise<T> {
  const client = stores.administrator
  await client.query('BEGIN')
  try {
    await client.query(`SET LOCAL statement_timeout='${statementMs}ms'`)
    await client.query("SET LOCAL lock_timeout='500ms'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout='5000ms'")
    const result = await body()
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

async function definer(context: string | null) {
  await stores.administrator.query('SET LOCAL ROLE auth_mail_definer')
  if (context === null) await stores.administrator.query('RESET app.tenant_id')
  else await stores.administrator.query("SELECT set_config('app.tenant_id',$1,true)", [context])
}

async function seedRetired(first: number, last: number) {
  const client = stores.administrator
  await transaction(15000, async () => {
    await client.query(`INSERT INTO public.auth_email_request (id,email,purpose,generation,state)
      SELECT md5('polling-request-'||g)::uuid,'polling-retired-'||g||'@example.invalid','magic-link',1,'terminal'
      FROM generate_series($1::integer,$2::integer) AS g`, [first, last])
    await client.query(`INSERT INTO public.auth_email_command (id,request_id,generation,purpose,recipient,locale,created_at,expires_at)
      SELECT md5('polling-command-'||g)::uuid,md5('polling-request-'||g)::uuid,1,'magic-link','polling-retired-'||g||'@example.invalid','en',
        transaction_timestamp()-interval '20 minutes',transaction_timestamp()-interval '11 minutes'
      FROM generate_series($1::integer,$2::integer) AS g`, [first, last])
    await client.query(`INSERT INTO public.email_delivery (id,command_id,state,key_id,snapshot_format,snapshot_hash,replay_window_seconds)
      SELECT md5('polling-delivery-'||g)::uuid,md5('polling-command-'||g)::uuid,'expired','polling-synthetic',
        'auth-plunk-v1',repeat('d',64),60 FROM generate_series($1::integer,$2::integer) AS g`, [first, last])
    // The INSERT guard requires pending first; the real definer performs retirement.
    await client.query(`INSERT INTO public.auth_email_outbox (id,delivery_id)
      SELECT md5('polling-outbox-'||g)::uuid,md5('polling-delivery-'||g)::uuid
      FROM generate_series($1::integer,$2::integer) AS g`, [first, last])
    await definer(tenant)
    await client.query(`UPDATE public.auth_email_outbox SET admission_state='admitted',admission_fence=1,
      run_id=md5('polling-retired-run-'||id::text)::uuid
      WHERE id IN (SELECT md5('polling-outbox-'||g)::uuid FROM generate_series($1::integer,$2::integer) AS g)`, [first, last])
  })
}

async function seedPositive() {
  const client = stores.administrator
  await transaction(15000, async () => {
    await client.query(`INSERT INTO public.auth_email_request (id,email,purpose,generation,state)
      SELECT ('10000000-0000-0000-0000-'||lpad(g::text,12,'0'))::uuid,'polling-positive-'||g||'@example.invalid','magic-link',1,'active'
      FROM generate_series(1,20) AS g`)
    await client.query(`INSERT INTO public.auth_email_command (id,request_id,generation,purpose,recipient,locale,created_at,expires_at)
      SELECT ('20000000-0000-0000-0000-'||lpad(g::text,12,'0'))::uuid,('10000000-0000-0000-0000-'||lpad(g::text,12,'0'))::uuid,
        1,'magic-link','polling-positive-'||g||'@example.invalid','en',
        CASE WHEN g<=10 THEN transaction_timestamp() ELSE transaction_timestamp()-interval '20 minutes' END,
        CASE WHEN g<=10 THEN transaction_timestamp()+interval '9 minutes'
          ELSE transaction_timestamp()-interval '11 minutes'+(21-g)*interval '1 second' END
      FROM generate_series(1,20) AS g`)
    await client.query(`INSERT INTO public.email_delivery
      (id,command_id,state,verifier_hash,key_id,ciphertext,nonce,tag,snapshot_format,snapshot_hash,replay_window_seconds)
      SELECT ('30000000-0000-0000-0000-'||lpad(g::text,12,'0'))::uuid,('20000000-0000-0000-0000-'||lpad(g::text,12,'0'))::uuid,
        'active',CASE WHEN g=11 THEN NULL ELSE repeat('a',64) END,'polling-synthetic',
        CASE WHEN g=20 THEN NULL ELSE 'synthetic-ciphertext' END,
        CASE WHEN g=20 THEN NULL ELSE repeat('b',24) END,CASE WHEN g=20 THEN NULL ELSE repeat('c',32) END,
        'auth-plunk-v1',repeat('d',64),60 FROM generate_series(1,20) AS g`)
    await client.query(`INSERT INTO public.auth_email_outbox (id,delivery_id)
      SELECT ('40000000-0000-0000-0000-'||lpad(g::text,12,'0'))::uuid,('30000000-0000-0000-0000-'||lpad(g::text,12,'0'))::uuid
      FROM generate_series(1,20) AS g`)
    await definer(tenant)
    await client.query(`UPDATE public.auth_email_outbox SET admission_state='admitting',admission_fence=1,
      admission_lease_until=CASE WHEN id='40000000-0000-0000-0000-000000000010'::uuid
        THEN transaction_timestamp()-interval '1 minute' ELSE transaction_timestamp()+interval '9 minutes' END
      WHERE id IN ('40000000-0000-0000-0000-000000000010','40000000-0000-0000-0000-000000000011')`)
    await client.query(`UPDATE public.auth_email_outbox SET admission_state='admitted',admission_fence=1,
      run_id=md5('polling-positive-run-'||id::text)::uuid
      WHERE id IN (SELECT ('40000000-0000-0000-0000-'||lpad(g::text,12,'0'))::uuid FROM generate_series(12,20) AS g)`)
  })
}

async function readSelectors(): Promise<Selectors> {
  const selectors: Selectors = { admission: '', purge: '' }
  for (const [kind, name, start, order] of [
    ['admission', 'auth_mail_claim_admission', 'SELECT id FROM public.auth_email_outbox WHERE ', 'ORDER BY id LIMIT 100'],
    ['purge', 'auth_mail_purge', 'SELECT o.id FROM public.auth_email_outbox o JOIN ', 'ORDER BY c.expires_at,o.id LIMIT 100'],
  ] as const) {
    const { rows } = await stores.administrator.query<{ definition: string }>('SELECT pg_get_functiondef($1::regprocedure) AS definition', [`public.${name}()`])
    // Deliberately narrow extraction: execute the current stored selector, never a second SQL copy.
    const matches = [...rows[0].definition.matchAll(/FOR candidate IN (SELECT [\s\S]*? LIMIT 100) LOOP/g)]
    if (matches.length !== 1) throw new Error(`${name}: expected one candidate SELECT ending in LIMIT 100 LOOP`)
    const query = matches[0][1]
    if (!query.startsWith(start) || !query.endsWith(order) || query.includes(';')) {
      throw new Error(`${name}: candidate SELECT shape changed; review the focused extraction`)
    }
    selectors[kind] = query
  }
  return selectors
}

async function maintainRetiredHistory() {
  const client = stores.administrator
  // Ordinary maintenance removes dead index entries from the legal pending ->
  // admitted seed transition. This test does not claim to bound arbitrary churn.
  await client.query("SET statement_timeout='15000ms'")
  await client.query("SET lock_timeout='500ms'")
  try {
    await client.query('VACUUM (ANALYZE) public.auth_email_outbox,public.email_delivery,public.auth_email_command')
  } finally {
    await client.query('RESET statement_timeout')
    await client.query('RESET lock_timeout')
  }
}

async function measure(selectors: Selectors, label: string) {
  const client = stores.administrator
  return transaction(1000, async () => {
    await definer(tenant)
    const context = (await client.query(`SELECT current_user AS role,session_user AS login,
      current_setting('app.tenant_id',true) AS tenant,current_setting('statement_timeout') AS statement_timeout,
      current_setting('lock_timeout') AS lock_timeout,current_setting('idle_in_transaction_session_timeout') AS idle_timeout,
      rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`)).rows[0]
    const cardinalities = (await client.query(`SELECT
      (SELECT count(*)::integer FROM public.auth_email_request) AS requests,
      (SELECT count(*)::integer FROM public.auth_email_command) AS commands,
      (SELECT count(*)::integer FROM public.email_delivery) AS deliveries,
      (SELECT count(*)::integer FROM public.auth_email_outbox) AS outbox`)).rows[0]
    const admission = (await client.query<{ id: string }>(selectors.admission)).rows.map(row => row.id)
    const purge = (await client.query<{ id: string }>(selectors.purge)).rows.map(row => row.id)
    const admissionPlan = (await client.query<{ 'QUERY PLAN': Explain }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${selectors.admission}`)).rows[0]['QUERY PLAN']
    const purgePlan = (await client.query<{ 'QUERY PLAN': Explain }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${selectors.purge}`)).rows[0]['QUERY PLAN']
    return { label, cardinalities, context, admission, purge, admissionPlan, purgePlan }
  })
}

function scanWork(node: PlanNode): { relation: string; type: string; rows: number; loops: number; buffers: number }[] {
  const own = node['Relation Name'] ? [{
    relation: node['Relation Name'], type: node['Node Type'],
    rows: (node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0) + (node['Rows Removed by Index Recheck'] ?? 0)) * node['Actual Loops'],
    loops: node['Actual Loops'], buffers: node['Shared Hit Blocks'] + node['Shared Read Blocks'],
  }] : []
  return own.concat((node.Plans ?? []).flatMap(scanWork))
}

// Removing either candidate index must expose retained-row work, even with identical results.
test('polling selectors examine candidate subsets across maintained retained history and preserve ordered RLS results', async () => {
  const client = stores.administrator
  const selectors = await readSelectors()
  evidence.selectors = selectors
  evidence.fidelity = 'Direct SELECTs extracted from migrated pg_get_functiondef under auth_mail_definer and live RLS; no nested function, locking, worker or provider execution.'
  evidence.maintenance = 'Identical ordinary VACUUM (ANALYZE) after each seed, outside transactions, with statement_timeout=15s and lock_timeout=500ms. Pre-maintenance 100k plans separately expose synthetic churn; bounded work assertions apply after maintenance only.'
  evidence.indexes = (await client.query(`SELECT tablename,indexname,indexdef FROM pg_indexes
    WHERE schemaname='public' AND tablename IN ('auth_email_outbox','email_delivery','auth_email_command') ORDER BY tablename,indexname`)).rows
  const rls = (await client.query(`SELECT relname,relrowsecurity,pg_get_userbyid(relowner) AS owner FROM pg_class
    WHERE oid IN ('public.auth_email_outbox'::regclass,'public.email_delivery'::regclass,'public.auth_email_command'::regclass) ORDER BY relname`)).rows
  evidence.rls = rls
  expect(rls).toEqual(['auth_email_command', 'auth_email_outbox', 'email_delivery'].map(relname => ({ relname, relrowsecurity: true, owner: 'auth_mail_owner' })))
  await seedRetired(1, 10_000)
  evidence.stage = 'seeded-10000'
  await maintainRetiredHistory()
  const small = await measure(selectors, '10000-retired')
  evidence.shapes.push(small)
  await seedRetired(10_001, 100_000)
  evidence.stage = 'seeded-100000'
  evidence.preMaintenance100k = await measure(selectors, '100000-retired-before-maintenance')
  await maintainRetiredHistory()
  const large = await measure(selectors, '100000-retired')
  evidence.shapes.push(large)
  await seedPositive()
  evidence.stage = 'seeded-sparse-positive'
  await maintainRetiredHistory()
  const positive = await measure(selectors, '100000-retired-plus-20-controls')
  evidence.shapes.push(positive)
  const denied = []
  for (const context of [null, '99999999-9999-9999-9999-999999999999']) {
    denied.push(await transaction(1000, async () => {
      await definer(context)
      return { tenant: (await client.query("SELECT current_setting('app.tenant_id',true) AS tenant")).rows[0].tenant,
        admission: (await client.query(selectors.admission)).rows, purge: (await client.query(selectors.purge)).rows }
    }))
  }
  evidence.deniedContexts = denied
  evidence.stage = 'measured-all-shapes'
  expect(denied[0].tenant === null || denied[0].tenant === '').toBe(true)
  for (const result of denied) expect({ admission: result.admission, purge: result.purge }).toEqual({ admission: [], purge: [] })
  for (const [shape, count] of [[small, 10_000], [large, 100_000], [positive, 100_020]] as const) {
    expect(shape.cardinalities).toEqual({ requests: count, commands: count, deliveries: count, outbox: count })
    expect(shape.context).toEqual({ role: 'auth_mail_definer', login: 'migrator', tenant, statement_timeout: '1s', lock_timeout: '500ms', idle_timeout: '5s', rolsuper: false, rolbypassrls: false })
  }
  for (const shape of [small, large]) expect({ admission: shape.admission, purge: shape.purge }).toEqual({ admission: [], purge: [] })
  const outboxId = (n: number) => `40000000-0000-0000-0000-${String(n).padStart(12, '0')}`
  expect(positive.admission).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(outboxId))
  // Expiry runs opposite to ID order. 20 has only verifier material; 11 only ciphertext.
  expect(positive.purge).toEqual([20, 19, 18, 17, 16, 15, 14, 13, 12, 11].map(outboxId))
  for (const shape of [small, large, positive]) {
    for (const [kind, plan, subset] of [['admission', shape.admissionPlan, shape === positive ? 11 : 0], ['purge', shape.purgePlan, shape === positive ? 20 : 0]] as const) {
      const scans = scanWork(plan[0].Plan)
      expect(scans.length).toBeGreaterThan(0)
      for (const scan of scans) {
        const label = `${shape.label}/${kind}/${scan.relation}: ${JSON.stringify(scan)}`
        expect.soft(scan.rows, `${label}: retained rows must not be examined`).toBeLessThanOrEqual(subset)
        expect.soft(scan.loops, `${label}: joins must follow the candidate subset`).toBeLessThanOrEqual(Math.max(1, subset))
        // Per relation: 32 startup pages plus 8 per candidate allow B-tree descent
        // and heap probes (including repeated join probes) at these cardinalities.
        // This fixed structural allowance cannot grow with retained rows or be
        // satisfied by walking a 100k-row history index. No elapsed-time threshold.
        expect.soft(scan.buffers, `${label}: retained pages must not be walked`).toBeLessThanOrEqual(32 + subset * 8)
      }
    }
  }
  evidence.stage = 'assertions-complete'
}, 0)
