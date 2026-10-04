import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

export async function webSourceManifest() {
  const sha256=async path=>createHash('sha256').update(await readFile(path)).digest('hex')
  const launcher=createHash('sha256')
  for(const path of ['scripts/start-web.mjs','scripts/web-credentials.mjs','scripts/fixed-credential-file.mjs'])launcher.update(path).update('\0').update(await readFile(path)).update('\0')
  return {schema_version:1,lock_sha256:await sha256('pnpm-lock.yaml'),dockerfile_sha256:await sha256('Dockerfile'),launcher_sha256:launcher.digest('hex')}
}
if(process.argv[2]==='--write')await writeFile('web-source-manifest.json',JSON.stringify(await webSourceManifest())+'\n')
