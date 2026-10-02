import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileHash, migrationSourceHash } from './migration-source-manifest.mjs'
const fail=()=>{throw new Error('Invalid migrator artifact')}
const exact=(object,keys)=>object!==null&&typeof object==='object'&&!Array.isArray(object)&&Object.keys(object).sort().join('|')===[...keys].sort().join('|')
const hashes=['lock_sha256','dockerfile_sha256','cli_sha256','reader_sha256','launcher_sha256','migration_source_sha256','archive_sha256','sbom_sha256']
const checks=['credential_ordering','closure','journal','unknown_commit','no_leakage','clean_exit','cleanup','archive_reload']
async function streamHash(path){const hash=createHash('sha256');for await(const bytes of createReadStream(path))hash.update(bytes);return hash.digest('hex')}
try {
  if(process.argv.length!==6||process.argv[2]!=='--directory'||process.argv[4]!=='--commit'||!/^[0-9a-f]{40}$/.test(process.argv[5]))fail()
  const directory=resolve(process.argv[3]),commit=process.argv[5],expected=['migrator-receipt.json','migrator-image.tar','migrator-sbom.spdx.json']
  if((await lstat(directory)).isSymbolicLink()||await realpath(directory)!==directory||(await readdir(directory)).sort().join('|')!==expected.sort().join('|'))fail()
  for(const name of expected){const stat=await lstat(join(directory,name));if(!stat.isFile()||stat.isSymbolicLink())fail()}
  if((await lstat(join(directory,'migrator-receipt.json'))).size>16384||(await lstat(join(directory,'migrator-sbom.spdx.json'))).size>67108864)fail()
  const receipt=JSON.parse(await readFile(join(directory,'migrator-receipt.json'),'utf8'))
  if(!exact(receipt,['schema_version','commit',...hashes,'image_id','platform','run_id','checks'])||receipt.schema_version!==1||receipt.commit!==commit
    ||receipt.platform!=='linux/amd64'||typeof receipt.run_id!=='string'||!receipt.run_id.trim()||receipt.run_id!==receipt.run_id.trim()||receipt.run_id.length>256
    ||typeof receipt.image_id!=='string'||!/^sha256:[0-9a-f]{64}$/.test(receipt.image_id)||hashes.some(key=>typeof receipt[key]!=='string'||!/^[0-9a-f]{64}$/.test(receipt[key]))
    ||!exact(receipt.checks,checks)||checks.some(key=>receipt.checks[key]!==true))fail()
  const launch=createHash('sha256')
  for(const path of ['scripts/start-migrate.mjs','scripts/migration-credentials.mjs'])launch.update(path).update('\0').update(await readFile(path)).update('\0')
  const wanted={lock_sha256:await fileHash('pnpm-lock.yaml'),dockerfile_sha256:await fileHash('Dockerfile'),cli_sha256:await fileHash('scripts/migrate.ts'),
    reader_sha256:await fileHash('scripts/fixed-credential-file.mjs'),launcher_sha256:launch.digest('hex'),migration_source_sha256:await migrationSourceHash(),
    archive_sha256:await streamHash(join(directory,'migrator-image.tar')),sbom_sha256:await streamHash(join(directory,'migrator-sbom.spdx.json'))}
  if(hashes.some(key=>receipt[key]!==wanted[key]))fail()
  const spdx=JSON.parse(await readFile(join(directory,'migrator-sbom.spdx.json'),'utf8'))
  if(spdx.spdxVersion!=='SPDX-2.3'||spdx.dataLicense!=='CC0-1.0'||spdx.SPDXID!=='SPDXRef-DOCUMENT'||typeof spdx.name!=='string'||!spdx.name.trim()
    ||typeof spdx.documentNamespace!=='string'||!/^https?:\/\/\S+$/.test(spdx.documentNamespace))fail()
  process.stdout.write('Migrator artifact verified\n')
} catch {process.stderr.write('Migrator artifact verification failed\n');process.exitCode=1}
