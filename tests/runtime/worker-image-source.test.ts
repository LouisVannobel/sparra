import { afterEach, expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { workerSourceManifest } from '../../scripts/worker-source-manifest.mjs'

const roots: string[] = []
const pins = { name: 'synthetic-worker-source', engines: { node: '24.22.1', pnpm: '10.32.1' }, packageManager: 'pnpm@10.32.1' }
const files = {
  'package.json': JSON.stringify(pins),
  'vite.worker.config.ts': 'synthetic external worker build\n',
  'patches/@hatchet-dev__typescript-sdk@1.28.2.patch': 'synthetic SDK lifecycle patch\n',
  'patches/nice-grpc@2.1.17.patch': 'synthetic gRPC lifecycle patch\n',
  'src/worker.ts': 'synthetic worker entry\n',
  'src/platform/a.ts': 'synthetic owned runtime\n',
}
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sparra-worker-source-')); roots.push(root)
  for (const [path, bytes] of Object.entries(files).reverse()) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), bytes)
  }
  await writeFile(join(root, 'pnpm-lock.yaml'), 'synthetic frozen graph\n')
  await writeFile(join(root, 'Dockerfile'), 'synthetic image stages\n')
  return root
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(root) !== tmpdir() || !basename(root).startsWith('sparra-worker-source-')) throw new Error('Non-owned worker source cleanup')
    await rm(root, { recursive: true })
  }
})

test('worker manifest binds the declared pins, lock, Dockerfile and canonical full source inventory', async () => {
  const root = await fixture(), inventory = createHash('sha256')
  // Independent fixture bytes and literal paths; production traversal is not the expectation.
  for (const path of [
    'package.json', 'patches/@hatchet-dev__typescript-sdk@1.28.2.patch', 'patches/nice-grpc@2.1.17.patch',
    'src/platform/a.ts', 'src/worker.ts', 'vite.worker.config.ts',
  ] as const) inventory.update(path).update('\0').update(files[path]).update('\0')
  expect(await workerSourceManifest(root)).toEqual({
    schema_version: 1, node_version: '24.22.1', pnpm_version: '10.32.1',
    lock_sha256: sha256('synthetic frozen graph\n'), dockerfile_sha256: sha256('synthetic image stages\n'),
    source_sha256: inventory.digest('hex'),
  })
})

test.each(Object.keys(files).filter(path => path !== 'package.json'))('changing included worker input changes the source binding: %s', async path => {
  const root = await fixture(), before = await workerSourceManifest(root)
  await writeFile(join(root, path), 'changed source bytes\n')
  expect((await workerSourceManifest(root)).source_sha256).not.toBe(before.source_sha256)
})

test('added and removed nested source files cannot reuse an older worker binding', async () => {
  const root = await fixture(), before = await workerSourceManifest(root)
  await writeFile(join(root, 'src/platform/new.ts'), 'new runtime input\n')
  expect((await workerSourceManifest(root)).source_sha256).not.toBe(before.source_sha256)
  await rm(join(root, 'src/platform/new.ts')); await rm(join(root, 'src/platform/a.ts'))
  expect((await workerSourceManifest(root)).source_sha256).not.toBe(before.source_sha256)
})

test('lock and Dockerfile changes have distinct bindings while checkout-only files are excluded', async () => {
  const root = await fixture(), before = await workerSourceManifest(root)
  await mkdir(join(root, 'tests')); await writeFile(join(root, 'tests/unrelated.ts'), 'not an image input')
  expect(await workerSourceManifest(root)).toEqual(before)
  await writeFile(join(root, 'pnpm-lock.yaml'), 'another graph\n')
  const graph = await workerSourceManifest(root)
  expect(graph.lock_sha256).not.toBe(before.lock_sha256); expect(graph.source_sha256).toBe(before.source_sha256)
  await writeFile(join(root, 'Dockerfile'), 'different image\n')
  expect((await workerSourceManifest(root)).dockerfile_sha256).not.toBe(before.dockerfile_sha256)
})

test('package changes remain source inputs and mismatched pins refuse manifest publication', async () => {
  const root = await fixture(), before = await workerSourceManifest(root)
  await writeFile(join(root, 'package.json'), JSON.stringify({ ...pins, name: 'different synthetic package' }))
  expect((await workerSourceManifest(root)).source_sha256).not.toBe(before.source_sha256)
  await writeFile(join(root, 'package.json'), JSON.stringify({ ...pins, engines: { ...pins.engines, node: '>=24' } }))
  await expect(workerSourceManifest(root)).rejects.toThrow('Worker source pins mismatch')
})

test('builder CLI writes the source manifest into its owned working directory', async () => {
  const root = await fixture()
  const result = spawnSync(process.execPath, [resolve('scripts/worker-source-manifest.mjs'), '--write'], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
  })
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toBe(''); expect(result.stderr).toBe('')
  expect(JSON.parse(await readFile(join(root, 'worker-source-manifest.json'), 'utf8'))).toEqual(await workerSourceManifest(root))
})
