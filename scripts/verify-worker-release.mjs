import { runReleaseVerification } from './release-cli.mjs'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { workerSourceManifest } from './worker-source-manifest.mjs'
import { inspectWorkerArchive } from './inspect-migration-archive.mjs'

const fail=()=>{throw new Error('Invalid worker artifact')}
const exact=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join('|')===[...keys].sort().join('|')
const hashes=['lock_sha256','dockerfile_sha256','source_sha256','archive_sha256','sbom_sha256']
const checks=['closure','registration','clean_exit','cleanup','archive_reload']
async function streamHash(path,maximum) {
  const hash=createHash('sha256');let size=0
  for await(const bytes of createReadStream(path)){size+=bytes.length;if(size>maximum)fail();hash.update(bytes)}
  return hash.digest('hex')
}
async function artifactFiles(directory,names) {
  if((await lstat(directory)).isSymbolicLink()||await realpath(directory)!==directory)fail()
  for(const name of names){
    const stat=await lstat(join(directory,name)),maximum=name==='worker-image.tar'?1073741824:name==='worker-sbom.spdx.json'?67108864:16384
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>maximum||stat.size===0)fail()
  }
}
export async function workerArtifactHashes(directory) {
  const resolved=resolve(directory)
  await artifactFiles(resolved,['worker-image.tar','worker-sbom.spdx.json'])
  return {...await workerSourceManifest(),archive_sha256:await streamHash(join(resolved,'worker-image.tar'),1073741824),
    sbom_sha256:await streamHash(join(resolved,'worker-sbom.spdx.json'),67108864)}
}
function admitReceipt(receipt,commit,phase) {
  if(!exact(receipt,['schema_version','node_version','pnpm_version','commit',...hashes,'image_id','platform','run_id','checks'])
    ||receipt.schema_version!==1||receipt.node_version!=='24.14.0'||receipt.pnpm_version!=='10.32.1'||receipt.commit!==commit||receipt.platform!=='linux/amd64')fail()
  if(typeof receipt.image_id!=='string'||!/^sha256:[0-9a-f]{64}$/.test(receipt.image_id)
    ||typeof receipt.run_id!=='string'||!receipt.run_id.trim()||receipt.run_id!==receipt.run_id.trim()||receipt.run_id.length>256)fail()
  if(hashes.some(key=>typeof receipt[key]!=='string'||!/^[0-9a-f]{64}$/.test(receipt[key])))fail()
  if(!exact(receipt.checks,checks)||checks.some(key=>receipt.checks[key]!== (key==='archive_reload'?phase==='release':true)))fail()
}
export async function verifyWorkerArtifact(inputDirectory,commit,phase='release') {
  if(!['candidate','release'].includes(phase)||typeof commit!=='string'||!/^[0-9a-f]{40}$/.test(commit))fail()
  const directory=resolve(inputDirectory),files=['worker-image.tar','worker-sbom.spdx.json','worker-receipt.json']
  await artifactFiles(directory,files)
  if((await readdir(directory)).sort().join('|')!==[...files].sort().join('|'))fail()
  const receipt=JSON.parse(await readFile(join(directory,'worker-receipt.json'),'utf8'))
  admitReceipt(receipt,commit,phase)
  const expected=await workerArtifactHashes(directory)
  if(hashes.some(key=>receipt[key]!==expected[key]))fail()
  const spdx=JSON.parse(await readFile(join(directory,'worker-sbom.spdx.json'),'utf8'))
  const image=await inspectWorkerArchive(join(directory,'worker-image.tar'),receipt.image_id,spdx)
  if(image.archiveHash!==receipt.archive_sha256)fail()
  return receipt
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  await runReleaseVerification(verifyWorkerArtifact,'Worker artifact verified\n','Worker artifact verification failed\n')
}
