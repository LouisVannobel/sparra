import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises'
const explicit = ['scripts/migrate.ts', 'scripts/fixed-credential-file.mjs', 'scripts/migration-credentials.mjs', 'scripts/start-migrate.mjs',
  'src/platform/db/config.server.ts', 'src/platform/config.server.ts', 'src/modules/auth/auth-email-normalization.server.ts']
async function files(directory) {
  const result = []
  for (const name of await readdir(directory)) {
    const path = `${directory}/${name}`, stat = await lstat(path)
    if (stat.isSymbolicLink()) throw new Error('Source links forbidden')
    if (stat.isDirectory()) result.push(...await files(path))
    else if (stat.isFile()) result.push(path)
    else throw new Error('Source must be regular')
  }
  return result
}
export async function migrationSourceHash() {
  const hash = createHash('sha256')
  for (const path of [...explicit, ...await files('drizzle')].sort()) {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Source must be regular')
    hash.update(path).update('\0').update(await readFile(path)).update('\0')
  }
  return hash.digest('hex')
}
export const fileHash = async path => createHash('sha256').update(await readFile(path)).digest('hex')
if (process.argv[2] === '--write') await writeFile('migration-source-manifest.json', JSON.stringify({ schema_version: 1, node: '24.14.0', pnpm: '10.32.1',
  lock_sha256: await fileHash('pnpm-lock.yaml'), dockerfile_sha256: await fileHash('Dockerfile'), migration_source_sha256: await migrationSourceHash() }) + '\n')
