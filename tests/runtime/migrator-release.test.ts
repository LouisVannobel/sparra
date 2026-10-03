import { afterEach, expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join,resolve,dirname,basename } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import zlib from 'node:zlib'
import { syncBuiltinESMExports } from 'node:module'
import { mock } from 'node:test'
import { ociFixture } from '../helpers/migrator-oci-fixture'
const exec=promisify(execFile),directories:string[]=[]
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex')
async function sourceHash() {
  const { readdir }=await import('node:fs/promises')
  const paths=['scripts/migrate.ts','scripts/fixed-credential-file.mjs','scripts/migration-credentials.mjs','scripts/start-migrate.mjs','src/platform/db/config.server.ts','src/platform/config.server.ts','src/modules/auth/auth-email-normalization.server.ts']
  async function scan(path:string){for(const item of await readdir(path,{withFileTypes:true})){if(item.isDirectory())await scan(path+'/'+item.name);else paths.push(path+'/'+item.name)}}
  await scan('drizzle');const value=createHash('sha256')
  for(const path of paths.sort())value.update(path).update('\0').update(await readFile(path)).update('\0')
  return value.digest('hex')
}
async function fixture(input:Parameters<typeof ociFixture>[0]={}) {
  const directory=await mkdtemp(join(tmpdir(),'sparra-migrator-receipt-'));directories.push(directory)
  const oci=await ociFixture(input),archive=oci.archive,sbom=JSON.stringify(oci.sbom)
  const launch=createHash('sha256')
  for(const path of ['scripts/start-migrate.mjs','scripts/migration-credentials.mjs'])launch.update(path).update('\0').update(await readFile(path)).update('\0')
  const receipt={schema_version:1,commit:'a'.repeat(40),lock_sha256:hash(await readFile('pnpm-lock.yaml')),dockerfile_sha256:hash(await readFile('Dockerfile')),
    cli_sha256:hash(await readFile('scripts/migrate.ts')),reader_sha256:hash(await readFile('scripts/fixed-credential-file.mjs')),launcher_sha256:launch.digest('hex'),migration_source_sha256:await sourceHash(),
    image_id:oci.imageId,platform:'linux/amd64',archive_sha256:hash(archive),sbom_sha256:hash(sbom),run_id:'synthetic-public-run',
    checks:{credential_ordering:true,closure:true,journal:true,unknown_commit:true,no_leakage:true,clean_exit:true,cleanup:true,archive_reload:true}}
  await writeFile(join(directory,'migrator-image.tar'),archive);await writeFile(join(directory,'migrator-sbom.spdx.json'),sbom)
  return {directory,receipt}
}
async function run(directory:string,receipt:Awaited<ReturnType<typeof fixture>>['receipt']) {
  await writeFile(join(directory,'migrator-receipt.json'),JSON.stringify(receipt))
  return invoke(directory)
}
async function invoke(directory:string) {
  try {const result=await exec(process.execPath,['scripts/verify-migrator-release.mjs','--directory',directory,'--commit','a'.repeat(40)],{windowsHide:true});return {code:0,stdout:String(result.stdout)}}
  catch{return {code:1,stdout:''}}
}
async function verifyFixture(directory:string,receipt:Awaited<ReturnType<typeof fixture>>['receipt']) {
  await writeFile(join(directory,'migrator-receipt.json'),JSON.stringify(receipt))
  const verifierPath='../../scripts/verify-migrator-release.mjs',verifier:unknown=await import(verifierPath)
  if(typeof verifier!=='object'||verifier===null||!('verifyMigratorArtifact' in verifier)||typeof verifier.verifyMigratorArtifact!=='function')throw new Error('Missing actual migrator artifact verifier')
  return verifier.verifyMigratorArtifact(directory,receipt.commit)
}
afterEach(async()=>{for(const directory of directories.splice(0)){
  const target=resolve(directory)
  if(dirname(target)!==resolve(tmpdir())||!basename(target).startsWith('sparra-migrator-receipt-'))throw new Error('Non-owned archive fixture cleanup')
  await rm(target,{recursive:true})
}})
test('valid_exact_three_file_artifact_is_consumable',async()=>{const {directory,receipt}=await fixture();expect(await run(directory,receipt)).toEqual({code:0,stdout:'Migrator artifact verified\n'})})
test.each(['root-app','root-opaque','extra-before-opaque','nonempty','dot-target'] as const)('whiteout_cannot_hide_missing_or_current_layer_files: %s',async whiteout=>{
  const {directory,receipt}=await fixture({whiteout});await expect(verifyFixture(directory,receipt)).rejects.toThrow('Invalid migration archive')
})
test.each(['replacement-before','replacement-after','root-replacement-before'] as const)('same_layer_replacement_survives_opacity: %s',async whiteout=>{
  const {directory,receipt}=await fixture({whiteout});await expect(verifyFixture(directory,receipt)).resolves.toEqual(receipt)
})
test.each(['utf8','wrong-byte-length','duplicate-key','unsupported-key'] as const)('pax_records_preserve_byte_lengths_and_supported_keys: %s',async pax=>{
  const {directory,receipt}=await fixture({pax})
  const operation=verifyFixture(directory,receipt)
  if(pax==='utf8')await expect(operation).resolves.toEqual(receipt)
  else await expect(operation).rejects.toThrow('Invalid migration archive')
})
test.each(['unsupported','malformed-gzip','visitor-refusal','source-error'] as const)('archive_stream_owners_settle_before_refusal: %s',async scenario=>{
  const {directory,receipt}=await fixture(scenario==='unsupported'?{unsupportedLayer:true}:scenario==='malformed-gzip'?{malformedGzip:true}:scenario==='visitor-refusal'?{gzip:true,blockedParent:true}:{gzip:true})
  const archivePath='../../scripts/inspect-migration-archive.mjs',sourcePath='../../scripts/migration-source-manifest.mjs'
  const archive:unknown=await import(archivePath),source:unknown=await import(sourcePath)
  if(typeof archive!=='object'||archive===null||!('inspectMigrationArchive' in archive)||typeof archive.inspectMigrationArchive!=='function')throw new Error('Missing actual archive inspector')
  if(typeof source!=='object'||source===null||!('migrationSourceFiles' in source)||typeof source.migrationSourceFiles!=='function')throw new Error('Missing actual source reader')
  const expectedFiles:unknown=await source.migrationSourceFiles()
  if(!(expectedFiles instanceof Map)||[...expectedFiles].some(([path,bytes])=>typeof path!=='string'||!Buffer.isBuffer(bytes)))throw new Error('Invalid actual source file view')
  const sources:fs.ReadStream[]=[],inflaters:zlib.Gunzip[]=[],originalRead=fs.createReadStream,originalGunzip=zlib.createGunzip
  const fault=Object.assign(new Error('owned source EIO'),{code:'EIO'});let consumerErrorListeners=0
  mock.method(fs,'createReadStream',(...args:Parameters<typeof fs.createReadStream>)=>{
    const source=originalRead(...args);sources.push(source)
    const options=args[1]
    if(scenario==='source-error'&&typeof options==='object'&&options?.start!==undefined)source.once('open',()=>{
      consumerErrorListeners=source.listenerCount('error');source.destroy(fault)
      if(!consumerErrorListeners)queueMicrotask(()=>inflaters.at(-1)?.destroy(fault))
    })
    return source
  })
  mock.method(zlib,'createGunzip',(...args:Parameters<typeof zlib.createGunzip>)=>{const inflater=originalGunzip(...args);inflaters.push(inflater);return inflater})
  syncBuiltinESMExports()
  try{
    const expected={schema_version:1,node:'24.14.0',pnpm:'10.32.1',lock_sha256:receipt.lock_sha256,dockerfile_sha256:receipt.dockerfile_sha256,migration_source_sha256:receipt.migration_source_sha256}
    const operation=archive.inspectMigrationArchive(join(directory,'migrator-image.tar'),receipt.image_id,expected,expectedFiles,JSON.parse(await readFile(join(directory,'migrator-sbom.spdx.json'),'utf8')))
    if(scenario==='source-error')await expect(operation).rejects.toBe(fault)
    else await expect(operation).rejects.toThrow()
    await new Promise(resolve=>setImmediate(resolve))
    if(scenario==='unsupported')expect(sources).toHaveLength(1)
    if(scenario==='source-error')expect(consumerErrorListeners).toBeGreaterThan(0)
    expect(sources.every(source=>source.closed&&source.destroyed&&'fd' in source&&source.fd===null)).toBe(true)
    expect(inflaters.every(inflater=>inflater.closed&&inflater.destroyed)).toBe(true)
  }finally{
    sources.forEach(source=>source.destroy());inflaters.forEach(inflater=>inflater.destroy())
    mock.restoreAll();syncBuiltinESMExports()
  }
})
test('candidate_phase_is_strict_and_cannot_be_consumed_as_final_release',async()=>{
  const {directory,receipt}=await fixture();receipt.checks.archive_reload=false
  expect((await run(directory,receipt)).code).toBe(1)
  const previous=process.exitCode
  const module=await import('../../scripts/verify-migrator-release.mjs')
  process.exitCode=previous
  expect(typeof module.verifyMigratorArtifact).toBe('function')
  const candidate=await module.verifyMigratorArtifact(directory,'a'.repeat(40),'candidate')
  expect(candidate.image_id).toBe(receipt.image_id)
  receipt.checks.closure=false;await writeFile(join(directory,'migrator-receipt.json'),JSON.stringify(receipt))
  await expect(module.verifyMigratorArtifact(directory,'a'.repeat(40),'candidate')).rejects.toThrow()
})
test.each(['lock_sha256','dockerfile_sha256','cli_sha256','reader_sha256','launcher_sha256','migration_source_sha256','archive_sha256','sbom_sha256'] as const)('mismatch_is_refused: %s',async key=>{const {directory,receipt}=await fixture();receipt[key]='c'.repeat(64);expect((await run(directory,receipt)).code).toBe(1)})
test.each(['credential_ordering','closure','journal','unknown_commit','no_leakage','clean_exit','cleanup','archive_reload'] as const)('unperformed_check_is_refused: %s',async key=>{const {directory,receipt}=await fixture();receipt.checks[key]=false;expect((await run(directory,receipt)).code).toBe(1)})
test('mutable_id_extra_file_and_extra_receipt_key_are_refused',async()=>{
  const {directory,receipt}=await fixture(),immutable=receipt.image_id;receipt.image_id='mutable:latest';expect((await run(directory,receipt)).code).toBe(1)
  receipt.image_id=immutable;const extra={...receipt,unknown:1};expect((await run(directory,extra)).code).toBe(1)
  await writeFile(join(directory,'unexpected'),'');expect((await run(directory,receipt)).code).toBe(1)
})
test('non_string_image_id_cannot_coerce_into_immutable_authority',async()=>{
  const {directory,receipt}=await fixture()
  await writeFile(join(directory,'migrator-receipt.json'),JSON.stringify({...receipt,image_id:[receipt.image_id]}))
  expect((await invoke(directory)).code).toBe(1)
})
test('missing_file_platform_and_absent_check_are_refused',async()=>{
  const {directory,receipt}=await fixture()
  receipt.platform='linux/arm64';expect((await run(directory,receipt)).code).toBe(1)
  receipt.platform='linux/amd64'
  const {archive_reload: _omitted,...missing}=receipt.checks
  await writeFile(join(directory,'migrator-receipt.json'),JSON.stringify({...receipt,checks:missing}))
  expect((await invoke(directory)).code).toBe(1)
  await rm(join(directory,'migrator-image.tar'));expect((await run(directory,receipt)).code).toBe(1)
})
test('spdx_header_is_required_even_when_hash_matches',async()=>{
  const {directory,receipt}=await fixture(),invalid=JSON.stringify({spdxVersion:'SPDX-2.3',dataLicense:'wrong',SPDXID:'SPDXRef-DOCUMENT',name:'Synthetic',documentNamespace:'https://example.invalid/spdx/synthetic'})
  await writeFile(join(directory,'migrator-sbom.spdx.json'),invalid);receipt.sbom_sha256=hash(invalid)
  expect((await run(directory,receipt)).code).toBe(1)
})
test('non_tar_arbitrary_id_and_packaged_source_misbinding_are_refused',async()=>{
  const first=await fixture(),bytes=Buffer.from('public synthetic non-tar')
  await writeFile(join(first.directory,'migrator-image.tar'),bytes);first.receipt.archive_sha256=hash(bytes)
  expect((await run(first.directory,first.receipt)).code).toBe(1)
  const second=await fixture();second.receipt.image_id='sha256:'+'d'.repeat(64)
  expect((await run(second.directory,second.receipt)).code).toBe(1)
  for(const input of [{badManifest:true},{badSource:true},{blockedParent:true},{badPlatform:true},{repeatedPath:true}]){const candidate=await fixture(input);await expect(verifyFixture(candidate.directory,candidate.receipt)).rejects.toThrow('Invalid migration archive')}
})
test('header_only_spdx_cannot_claim_an_image_subject',async()=>{
  const {directory,receipt}=await fixture(),header=JSON.stringify({spdxVersion:'SPDX-2.3',dataLicense:'CC0-1.0',SPDXID:'SPDXRef-DOCUMENT',name:'Header',documentNamespace:'https://example.invalid/header'})
  await writeFile(join(directory,'migrator-sbom.spdx.json'),header);receipt.sbom_sha256=hash(header)
  expect((await run(directory,receipt)).code).toBe(1)
})
test('spdx_subject_annotation_comments_remain_strings',async()=>{
  const {directory,receipt}=await fixture(),path=join(directory,'migrator-sbom.spdx.json')
  const spdx=JSON.parse(await readFile(path,'utf8'));spdx.packages[0].annotations.push({comment:42})
  const bytes=JSON.stringify(spdx);await writeFile(path,bytes);receipt.sbom_sha256=hash(bytes)
  expect((await run(directory,receipt)).code).toBe(1)
})
test('extra_string_spdx_subject_annotations_remain_accepted',async()=>{
  const {directory,receipt}=await fixture(),path=join(directory,'migrator-sbom.spdx.json')
  const spdx=JSON.parse(await readFile(path,'utf8'));spdx.packages[0].annotations.push({comment:'ordinary public metadata'})
  const bytes=JSON.stringify(spdx);await writeFile(path,bytes);receipt.sbom_sha256=hash(bytes)
  expect((await run(directory,receipt)).code).toBe(0)
})
test.each(['truncated','duplicate','traversal','symlink','extension','oversized'] as const)('unsupported_or_ambiguous_tar_is_refused: %s',async mutation=>{
  const {directory,receipt}=await fixture(),original=await readFile(join(directory,'migrator-image.tar'))
  let bytes=Buffer.from(original)
  if(mutation==='truncated')bytes=bytes.subarray(0,-1)
  else if(mutation==='duplicate')bytes=Buffer.concat([bytes.subarray(0,-1024),bytes.subarray(0,1024),Buffer.alloc(1024)])
  else{
    if(mutation==='traversal'){bytes.fill(0,0,100);bytes.write('../oci-layout',0)}
    if(mutation==='symlink')bytes[156]=50
    if(mutation==='extension')bytes[156]=103
    if(mutation==='oversized')bytes.write((1073741825).toString(8).padStart(11,'0')+'\0',124)
    bytes.fill(32,148,156);bytes.write(bytes.subarray(0,512).reduce((sum,byte)=>sum+byte,0).toString(8).padStart(6,'0')+'\0 ',148)
  }
  await writeFile(join(directory,'migrator-image.tar'),bytes);receipt.archive_sha256=hash(bytes)
  await expect(verifyFixture(directory,receipt)).rejects.toThrow('Invalid migration archive')
})
