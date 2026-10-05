import { afterEach, expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const roots:string[]=[],commit='a'.repeat(40),image='ghcr.io/louisvannobel/sparra-web@sha256:'+'b'.repeat(64)
const launcherPaths=['scripts/start-web.mjs','scripts/web-credentials.mjs','scripts/fixed-credential-file.mjs']
const validator=resolve('scripts/verify-web-release.mjs')
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex')
async function fixture() {
  const root=await mkdtemp(join(tmpdir(),'sparra-web-handoff-'));roots.push(root)
  const sourceRoot=join(root,'source'),directory=join(root,'receipt')
  await mkdir(join(sourceRoot,'scripts'),{recursive:true});await mkdir(directory)
  const launcher=createHash('sha256')
  for(const path of ['pnpm-lock.yaml','Dockerfile',...launcherPaths])await cp(path,join(sourceRoot,path))
  for(const path of launcherPaths)launcher.update(path).update('\0').update(await readFile(path)).update('\0')
  const source={schema_version:1,commit,lock_sha256:hash(await readFile('pnpm-lock.yaml')),dockerfile_sha256:hash(await readFile('Dockerfile')),launcher_sha256:launcher.digest('hex')}
  const qualification={...source,image_reference:image,platform:'linux/amd64',config_digest:'sha256:'+'c'.repeat(64),diff_ids:['sha256:'+'d'.repeat(64)],sbom_sha256:'',run_id:'synthetic-public-run',checks:{startup:true,ingress:true,preload:true,closure:true,cleanup:true}}
  const sbom={spdxVersion:'SPDX-2.3',dataLicense:'CC0-1.0',SPDXID:'SPDXRef-DOCUMENT',name:'Synthetic exact web image',documentNamespace:'https://example.invalid/spdx/web',
    creationInfo:{creators:['Tool: trivy-0.74.0'],created:'2026-10-02T00:00:00Z'},
    packages:[{name:image,SPDXID:'SPDXRef-Image',primaryPackagePurpose:'CONTAINER',annotations:[{comment:'ImageID: sha256:'+'c'.repeat(64)},{comment:'DiffID: sha256:'+'d'.repeat(64)}]},{name:'synthetic-library',SPDXID:'SPDXRef-Library'}],
    relationships:[{spdxElementId:'SPDXRef-DOCUMENT',relationshipType:'DESCRIBES',relatedSpdxElement:'SPDXRef-Image'},{spdxElementId:'SPDXRef-Image',relationshipType:'CONTAINS',relatedSpdxElement:'SPDXRef-Library'}]}
  async function save(){const sbomBytes=JSON.stringify(sbom);qualification.sbom_sha256=hash(sbomBytes);await writeFile(join(directory,'source.json'),JSON.stringify(source));await writeFile(join(directory,'native-image-qualification.json'),JSON.stringify(qualification));await writeFile(join(directory,'image-reference.txt'),image+'\n');await writeFile(join(directory,'sbom.spdx.json'),sbomBytes)}
  await save()
  return {root,sourceRoot,directory,source,qualification,sbom,save}
}
function invoke(candidate:Awaited<ReturnType<typeof fixture>>,expectedCommit=commit) {
  return spawnSync(process.execPath,[validator,'--directory',candidate.directory,'--commit',expectedCommit],{cwd:candidate.sourceRoot,encoding:'utf8',windowsHide:true,timeout:10000})
}
function refused(result:ReturnType<typeof invoke>) {
  expect(result.error).toBeUndefined();expect(result.status).toBe(1)
  expect(result.stdout).toBe('');expect(result.stderr).toBe('Web artifact verification failed\n')
}
afterEach(async()=>{for(const root of roots.splice(0)){if(dirname(root)!==tmpdir()||!basename(root).startsWith('sparra-web-handoff-'))throw new Error('Non-owned handoff cleanup');await rm(root,{recursive:true})}})

test('valid_exact_four_file_artifact_uses_all_three_native_launcher_inputs',async()=>{
  const candidate=await fixture(),result=invoke(candidate)
  expect(result.error).toBeUndefined();expect(result.status,result.stderr).toBe(0);expect(result.stdout).toBe('Web artifact verified\n');expect(result.stderr).toBe('')
})
test.each(['lock_sha256','dockerfile_sha256','launcher_sha256'] as const)('source_binding_mismatch_is_refused: %s',async key=>{const candidate=await fixture();candidate.source[key]='c'.repeat(64);candidate.qualification[key]='c'.repeat(64);await candidate.save();refused(invoke(candidate))})
test('shared_credential_reader_change_invalidates_a_previously_matching_receipt',async()=>{const candidate=await fixture();await writeFile(join(candidate.sourceRoot,'scripts/fixed-credential-file.mjs'),'// changed synthetic source\n');refused(invoke(candidate))})
test('legacy_two_file_launcher_hash_omits_real_reader_and_is_refused',async()=>{const candidate=await fixture(),legacy=createHash('sha256');for(const path of launcherPaths.slice(0,2))legacy.update(path).update('\0').update(await readFile(path)).update('\0');candidate.source.launcher_sha256=legacy.digest('hex');candidate.qualification.launcher_sha256=candidate.source.launcher_sha256;await candidate.save();refused(invoke(candidate))})
test.each(['startup','ingress','preload','closure','cleanup'] as const)('unperformed_native_check_is_refused: %s',async key=>{const candidate=await fixture();candidate.qualification.checks[key]=false;await candidate.save();refused(invoke(candidate))})
test('mutable_wrong_repository_and_different_qualified_digest_are_refused',async()=>{
  const candidate=await fixture()
  for(const reference of ['ghcr.io/louisvannobel/sparra-web:latest','ghcr.io/louisvannobel/other@sha256:'+'b'.repeat(64),'ghcr.io/louisvannobel/sparra-web@sha256:'+'c'.repeat(64)]){await writeFile(join(candidate.directory,'image-reference.txt'),reference+'\n');refused(invoke(candidate))}
})
test('wrong_commit_platform_missing_qualification_and_extra_file_are_refused',async()=>{
  const candidate=await fixture();refused(invoke(candidate,'d'.repeat(40)))
  candidate.qualification.platform='linux/arm64';await candidate.save();refused(invoke(candidate))
  candidate.qualification.platform='linux/amd64';await candidate.save();await writeFile(join(candidate.directory,'extra.txt'),'synthetic');refused(invoke(candidate));await rm(join(candidate.directory,'extra.txt'))
  await rm(join(candidate.directory,'native-image-qualification.json'));refused(invoke(candidate))
})
test('exact_schema_and_non_string_authority_cannot_be_coerced',async()=>{
  const candidate=await fixture()
  await writeFile(join(candidate.directory,'source.json'),JSON.stringify({...candidate.source,extra:'synthetic'}));refused(invoke(candidate))
  await candidate.save();await writeFile(join(candidate.directory,'native-image-qualification.json'),JSON.stringify({...candidate.qualification,image_reference:[image]}));refused(invoke(candidate))
})
test('invalid_spdx_header_is_refused',async()=>{const candidate=await fixture();candidate.sbom.dataLicense='wrong';await candidate.save();refused(invoke(candidate))})
test('actual_config_digest_is_distinct_from_oci_index_and_subject_mismatch_is_refused',async()=>{const candidate=await fixture();candidate.qualification.config_digest='sha256:'+'b'.repeat(64);await candidate.save();refused(invoke(candidate))})
test('containerd_root_image_id_is_bound_to_the_exact_web_reference_and_keeps_layer_checks',async()=>{
  const candidate=await fixture();candidate.sbom.packages[0]!.annotations![0]!.comment='ImageID: '+image.split('@')[1];await candidate.save()
  const accepted=invoke(candidate);expect(accepted.error).toBeUndefined();expect(accepted.status,accepted.stderr).toBe(0)
  candidate.sbom.packages[0]!.annotations![0]!.comment='ImageID: sha256:'+'f'.repeat(64);await candidate.save();refused(invoke(candidate))
  candidate.sbom.packages[0]!.annotations![0]!.comment='ImageID: '+image.split('@')[1];candidate.qualification.diff_ids=['sha256:'+'e'.repeat(64)];await candidate.save();refused(invoke(candidate))
})
test('different_diff_ids_or_sbom_bytes_cannot_reuse_qualification',async()=>{const candidate=await fixture();candidate.qualification.diff_ids=['sha256:'+'e'.repeat(64)];await candidate.save();refused(invoke(candidate));candidate.qualification.diff_ids=['sha256:'+'d'.repeat(64)];await candidate.save();await writeFile(join(candidate.directory,'sbom.spdx.json'),JSON.stringify({...candidate.sbom,name:'changed'}));refused(invoke(candidate))})
test('downloaded_syft_or_header_only_document_is_not_the_final_trivy_subject_witness',async()=>{const candidate=await fixture();candidate.sbom.creationInfo.creators=['Tool: buildkit-syft-scanner'];await candidate.save();refused(invoke(candidate));await writeFile(join(candidate.directory,'sbom.spdx.json'),JSON.stringify({spdxVersion:'SPDX-2.3',dataLicense:'CC0-1.0',SPDXID:'SPDXRef-DOCUMENT',name:'synthetic',documentNamespace:'https://example.invalid/header'}));refused(invoke(candidate))})
