import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function workerSourceManifest(root = process.cwd()) {
  const read = path => readFile(join(root, path))
  const sha256 = async path => createHash('sha256').update(await read(path)).digest('hex')
  const manifest = JSON.parse((await read('package.json')).toString('utf8'))
  if (manifest.engines?.node !== '24.14.0' || manifest.engines?.pnpm !== '10.32.1' || manifest.packageManager !== 'pnpm@10.32.1') {
    throw new Error('Worker source pins mismatch')
  }
  async function sources(directory) {
    const files = []
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const path = directory + '/' + entry.name
      if (entry.isDirectory()) files.push(...await sources(path))
      else if (entry.isFile()) files.push(path)
      else throw new Error('Worker source requires regular files')
    }
    return files
  }
  const paths = ['package.json', 'vite.worker.config.ts',
    'patches/@hatchet-dev__typescript-sdk@1.28.2.patch', 'patches/nice-grpc@2.1.17.patch', ...await sources('src')].sort()
  const source = createHash('sha256')
  for (const path of paths) source.update(path).update('\0').update(await read(path)).update('\0')
  return { schema_version: 1, node_version: '24.14.0', pnpm_version: '10.32.1',
    lock_sha256: await sha256('pnpm-lock.yaml'), dockerfile_sha256: await sha256('Dockerfile'), source_sha256: source.digest('hex') }
}
if (process.argv[2] === '--write') await writeFile('worker-source-manifest.json', JSON.stringify(await workerSourceManifest()) + '\n')
