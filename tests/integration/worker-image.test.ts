import { afterAll, beforeAll, expect, test } from 'vitest'
import { readFile } from 'node:fs/promises'
import { Redacted, Schema } from 'effect'
import { nativeImage } from '../helpers/native-image'
import { seedBillingWorker } from '../helpers/billing-worker-fixture'
import { config } from '../helpers/billing-fixtures'
import { startDisposableHatchet, startDisposableStores } from '../fixtures/db/disposable-stores'
import { workerSourceManifest } from '../../scripts/worker-source-manifest.mjs'

const runtimeFile = Schema.Struct({ package: Schema.Literals(['hatchet', 'nice-grpc']), path: Schema.String, sha256: Schema.String })
const runtimeFixture = Schema.Struct({ schema_version: Schema.Literals([1]), postimages: Schema.Array(runtimeFile), assets: Schema.Array(runtimeFile),
  dependencies: Schema.Array(Schema.Struct({ from: Schema.Literals(['hatchet', 'nice-grpc']), name: Schema.String, version: Schema.String })) })
let image: string, app: { id: string; retire(): Promise<void> } | undefined, running = false
let stores: Awaited<ReturnType<typeof startDisposableStores>> | undefined
let engine: Awaited<ReturnType<typeof startDisposableHatchet>> | undefined
const logins = ['auth_mail_relay', 'auth_mail_worker', 'billing_relay', 'billing_worker']

beforeAll(async () => {
  image = await nativeImage('worker')
  stores = await startDisposableStores(); await stores.migrate()
  const billing = await seedBillingWorker(stores)
  engine = await startDisposableHatchet()
  app = await stores.startWorkerImage(image, {
    NODE_ENV: 'test', APP_ORIGIN: config.origin, DB_POOL_MAX: '2', DB_STATEMENT_TIMEOUT_MS: '1000', DB_CLEANUP_TIMEOUT_MS: '1000',
    HATCHET_CLIENT_TOKEN: engine.config.token, HATCHET_CLIENT_HOST_PORT: engine.config.host_port,
    HATCHET_CLIENT_API_URL: engine.config.api_url, HATCHET_CLIENT_TLS_STRATEGY: 'none',
    STRIPE_API_KEY: Redacted.value(config.apiKey), STRIPE_WEBHOOK_SECRET: Redacted.value(config.webhookSecret),
    STRIPE_ACCOUNT_ID: config.accountId, STRIPE_ENVIRONMENT: config.environment,
    BILLING_RELAY_DATABASE_URL: billing.relay, BILLING_WORKER_DATABASE_URL: billing.worker,
  })
  running = true
  const readyDeadline = Date.now() + 30000
  while (Date.now() < readyDeadline) {
    if ((await stores.imageLogs(app.id)).stdout.includes('Application worker ready\n')) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Worker image readiness deadline exceeded')
}, 600000)

async function stopOwnedWorkerImage(failures:unknown[]) {
  if (running && app && stores) {
    try { await stores.signalWeb(app.id, 'SIGTERM'); expect(await stores.waitWeb(app.id, 30000)).toBe(0); running = false }
    catch (error) {
      failures.push(error)
      // Emergency fixture retirement never proves a normal application stop.
      // The original failure stays fatal; both signals check exact ownership.
      try { await stores.signalWeb(app.id, 'SIGKILL') } catch (killError) { failures.push(killError) }
      try { await stores.waitWeb(app.id, 30000); running = false } catch (waitError) { failures.push(waitError) }
    }
  }
}
async function retireOwnedWorkerImage(failures:unknown[]) {
  if (app) {
    try { await app.retire() } catch (error) { failures.push(error) }
  }
}
async function cleanupOwnedImageFixtures(failures:unknown[]) {
  // The nested engine must retire before the stores' unrelated-inventory check.
  for (const fixture of [engine, stores]) {
    if (!fixture) continue
    try {
      await fixture.cleanup()
      expect(fixture.evidence.unrelatedUnchanged).toBe(true); expect(fixture.evidence.inventoryDelta).toEqual([])
    } catch (error) { failures.push(error) }
  }
}
afterAll(async () => {
  const failures: unknown[] = []
  await stopOwnedWorkerImage(failures)
  await retireOwnedWorkerImage(failures)
  await cleanupOwnedImageFixtures(failures)
  if (failures.length) throw new AggregateError(failures, 'Worker image fixture retirement failed')
}, 90000)

test('worker image contains the pinned external runtime without a checkout', async () => {
  if (!stores || !app) throw new Error('Worker image fixture unavailable')
  const fixture = Schema.decodeUnknownSync(runtimeFixture)(JSON.parse(await readFile('tests/fixtures/hatchet/owned-runtime-postimages.json', 'utf8')))
  expect(fixture.postimages).toHaveLength(28); expect(fixture.assets).toHaveLength(6)
  const actual = JSON.parse(await stores.command(app.id, ['node', '--input-type=module', '-e', `
    import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
    import { createHash } from 'node:crypto'; import { pathToFileURL } from 'node:url';
    const fixture = JSON.parse(process.argv[1]), require = createRequire('/app/package.json');
    const sdkRoot = path.dirname(require.resolve('@hatchet-dev/typescript-sdk/package.json'));
    const sdkRequire = createRequire(path.join(sdkRoot, 'package.json'));
    const niceRoot = path.dirname(sdkRequire.resolve('nice-grpc/package.json'));
    const niceRequire = createRequire(path.join(niceRoot, 'package.json'));
    const roots = { hatchet: sdkRoot, 'nice-grpc': niceRoot };
    const sdk = await import(pathToFileURL(path.join(sdkRoot, 'v1/index.js')).href);
    if (typeof sdk.HatchetClient !== 'function' || typeof sdk.HatchetClient.prototype.getStartupInfo !== 'function'
      || typeof sdk.HatchetClient.prototype.dispose !== 'function') throw new Error('Owned external SDK unavailable');
    for (const name of ['.git','src','tests','scripts','tools','public','drizzle','Dockerfile','vite.config.ts','vite.worker.config.ts',
      'pnpm-lock.yaml','pnpm-workspace.yaml','.output/server','.output/public']) {
      if (fs.existsSync('/app/' + name)) throw new Error('Unexpected checkout or other image output');
    }
    for (const name of ['npm','npx','corepack','pnpm','pnpx','yarn','yarnpkg']) {
      if (fs.existsSync('/usr/local/bin/' + name)) throw new Error('Unexpected package manager');
    }
    if (fs.readFileSync('/app/.output/worker/hatchet-empty.yaml', 'utf8') !== '{}\\n') throw new Error('Owned SDK config missing');
    const inspect = entries => entries.map(entry => ({ ...entry,
      sha256: createHash('sha256').update(fs.readFileSync(path.join(roots[entry.package], entry.path))).digest('hex') }));
    const dependencies = fixture.dependencies.map(entry => ({ ...entry,
      version: (entry.from === 'hatchet' ? sdkRequire : niceRequire)(entry.name + '/package.json').version }));
    process.stdout.write(JSON.stringify({ schema_version: 1, postimages: inspect(fixture.postimages), assets: inspect(fixture.assets), dependencies,
      manifest: JSON.parse(fs.readFileSync('/app/worker-source-manifest.json', 'utf8')), node: process.versions.node }));
  `, JSON.stringify(fixture)]))
  expect(actual).toEqual({ ...fixture, manifest: await workerSourceManifest(), node: '24.22.1' })
  const metadata = await stores.imageMetadata(app.id)
  expect(metadata.entrypoint).toEqual(['node', '.output/worker/index.mjs'])
  expect(metadata.readonly).toBe(true); expect(metadata.caps).toEqual(['ALL'])
  expect(metadata.security).toEqual(['no-new-privileges']); expect(metadata.mounts).toEqual([])
  expect(metadata.networkMode).toBe('host'); expect(metadata.restartPolicy).toBe('no')
})

test('worker image registers billing only and drains its native client and SQL pools', async () => {
  if (!stores || !engine || !app) throw new Error('Worker image fixture unavailable')
  const response = await fetch(`${engine.config.api_url}/api/v1/tenants/${engine.tenantId}/workflows?limit=100&offset=0`, {
    headers: { authorization: `Bearer ${engine.config.token}` }, signal: AbortSignal.timeout(3000), redirect: 'error',
  })
  expect(response.status).toBe(200)
  const catalogue = Schema.decodeUnknownSync(Schema.Struct({ rows: Schema.Array(Schema.Struct({ name: Schema.String })) }))(await response.json())
  expect(catalogue.rows.map(row => row.name)).toEqual(['billing-reconciliation'])
  expect((await engine.administrator.query('SELECT name,count(*)::int AS n FROM "Worker" WHERE "tenantId"=$1 GROUP BY name', [engine.tenantId])).rows)
    .toEqual([{ name: 'auth-email-worker', n: 1 }])
  expect((await stores.administrator.query('SELECT usename,count(*)::int AS n FROM pg_stat_activity WHERE usename=ANY($1::text[]) GROUP BY usename ORDER BY usename', [logins])).rows)
    .toEqual([{ usename: 'billing_relay', n: 1 }, { usename: 'billing_worker', n: 1 }])
  expect((await stores.administrator.query('SELECT (SELECT count(*)::int FROM billing_event_receipt) AS receipts,(SELECT count(*)::int FROM billing_outbox) AS outboxes')).rows)
    .toEqual([{ receipts: 0, outboxes: 0 }])
  const identity = await stores.command(app.id, ['node', '-e', "process.stdout.write(process.getuid()+':'+process.getgid())"])
  const metadata = await stores.imageMetadata(app.id)
  await stores.signalWeb(app.id, 'SIGTERM')
  expect(await stores.waitWeb(app.id, 30000)).toBe(0); running = false
  const logs = await stores.imageLogs(app.id)
  expect(logs.stderr).toBe('')
  expect(logs.stdout).toContain('Application worker lifecycle billing-handler-stopped\n')
  expect(logs.stdout).toContain('Application worker lifecycle relay-stopped\n')
  expect(logs.stdout).toContain('Application worker lifecycle native-stop-completed\n')
  expect(logs.stdout).toContain('Application worker stopped\n')
  await expect.poll(async () => (await stores!.administrator.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename=ANY($1::text[])', [logins])).rows[0].n).toBe(0)
  // Deliberately last: the runnable root candidate must prove startup and normal
  // retirement before its one observed hosted policy RED, then become nonroot.
  expect(identity, 'worker image UID:GID policy after registration and clean shutdown').toBe('10001:10001')
  expect(metadata.user).toBe('10001:10001')
}, 60000)

test('worker image rejects empty capabilities before native registration', async () => {
  if (!stores || !engine) throw new Error('Worker image fixture unavailable')
  const workers = () => engine!.administrator.query('SELECT id,name FROM "Worker" WHERE "tenantId"=$1 ORDER BY id', [engine!.tenantId])
  const before = (await workers()).rows
  const empty = await stores.startWorkerImage(image, { NODE_ENV: 'test', APP_ORIGIN: config.origin,
    HATCHET_CLIENT_TOKEN: engine.config.token, HATCHET_CLIENT_HOST_PORT: engine.config.host_port,
    HATCHET_CLIENT_API_URL: engine.config.api_url, HATCHET_CLIENT_TLS_STRATEGY: 'none' })
  try {
    expect(await stores.waitWeb(empty.id, 15000)).toBe(1)
    expect(await stores.imageLogs(empty.id)).toEqual({ stdout: '', stderr: 'Application worker unavailable\n' })
    expect((await workers()).rows).toEqual(before)
  } finally { await empty.retire() }
}, 30000)
