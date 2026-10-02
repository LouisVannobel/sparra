import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { webSourceManifest } from './web-source-manifest.mjs'
import { createHash } from 'node:crypto'
import { bindWebSbom } from './web-sbom-binding.mjs'

const fail=()=>{throw new Error('Invalid web artifact')}
const exact=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join('|')===[...keys].sort().join('|')
const hashes=['lock_sha256','dockerfile_sha256','launcher_sha256'],checks=['startup','ingress','preload','closure','cleanup']
try {
  if(process.argv.length!==6||process.argv[2]!=='--directory'||process.argv[4]!=='--commit'||!/^[0-9a-f]{40}$/.test(process.argv[5]))fail()
  const directory=resolve(process.argv[3]),commit=process.argv[5],files=['source.json','image-reference.txt','sbom.spdx.json','native-image-qualification.json']
  if((await lstat(directory)).isSymbolicLink()||await realpath(directory)!==directory||(await readdir(directory)).sort().join('|')!==files.sort().join('|'))fail()
  for(const name of files){const stat=await lstat(join(directory,name));if(!stat.isFile()||stat.isSymbolicLink()||stat.size>(name==='sbom.spdx.json'?67108864:16384))fail()}
  const source=JSON.parse(await readFile(join(directory,'source.json'),'utf8')),qualification=JSON.parse(await readFile(join(directory,'native-image-qualification.json'),'utf8'))
  const referenceText=await readFile(join(directory,'image-reference.txt'),'utf8'),reference=referenceText.replace(/\n$/,'')
  if(!/^ghcr\.io\/louisvannobel\/sparra-web@sha256:[0-9a-f]{64}$/.test(reference)||![reference,reference+'\n'].includes(referenceText))fail()
  if(!exact(source,['schema_version','commit',...hashes])||source.schema_version!==1||source.commit!==commit
    ||!exact(qualification,['schema_version','commit',...hashes,'image_reference','platform','config_digest','diff_ids','sbom_sha256','run_id','checks'])||qualification.schema_version!==1||qualification.commit!==commit
    ||typeof qualification.image_reference!=='string'||qualification.image_reference!==reference||qualification.platform!=='linux/amd64'
    ||typeof qualification.run_id!=='string'||!qualification.run_id.trim()||qualification.run_id!==qualification.run_id.trim()||qualification.run_id.length>256
    ||!exact(qualification.checks,checks)||checks.some(key=>qualification.checks[key]!==true))fail()
  const wanted=await webSourceManifest()
  if(hashes.some(key=>typeof source[key]!=='string'||!/^[0-9a-f]{64}$/.test(source[key])||source[key]!==wanted[key]||qualification[key]!==wanted[key]))fail()
  const sbom=await readFile(join(directory,'sbom.spdx.json'))
  if(typeof qualification.sbom_sha256!=='string'||qualification.sbom_sha256!==createHash('sha256').update(sbom).digest('hex'))fail()
  bindWebSbom(JSON.parse(sbom.toString('utf8')),qualification.config_digest,qualification.diff_ids)
  process.stdout.write('Web artifact verified\n')
}catch{process.stderr.write('Web artifact verification failed\n');process.exitCode=1}
