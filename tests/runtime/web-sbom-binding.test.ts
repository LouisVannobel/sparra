import { expect, test } from 'vitest'
import { bindWebSbom } from '../../scripts/web-sbom-binding.mjs'
const config='sha256:'+'c'.repeat(64),layer='sha256:'+'d'.repeat(64)
function document(){return {spdxVersion:'SPDX-2.3',dataLicense:'CC0-1.0',SPDXID:'SPDXRef-DOCUMENT',name:'Synthetic',documentNamespace:'https://example.invalid/synthetic',creationInfo:{creators:['Tool: trivy-0.74.0']},packages:[{SPDXID:'SPDXRef-Image',primaryPackagePurpose:'CONTAINER',annotations:[{comment:'ImageID: '+config},{comment:'DiffID: '+layer}]},{SPDXID:'SPDXRef-Library'}],relationships:[{spdxElementId:'SPDXRef-DOCUMENT',relatedSpdxElement:'SPDXRef-Image',relationshipType:'DESCRIBES'},{spdxElementId:'SPDXRef-Image',relatedSpdxElement:'SPDXRef-Library',relationshipType:'CONTAINS'}]}}
test('actual_config_and_diff_identity_is_required_for_a_native_trivy_subject',()=>{
  expect(()=>bindWebSbom(document(),config,[layer])).not.toThrow()
  expect(()=>bindWebSbom(document(),'sha256:'+'b'.repeat(64),[layer])).toThrow()
  expect(()=>bindWebSbom(document(),config,['sha256:'+'e'.repeat(64)])).toThrow()
})
test('missing_relationships_or_syft_creator_cannot_claim_a_trivy_container_witness',()=>{
  const value=document();value.relationships=[];expect(()=>bindWebSbom(value,config,[layer])).toThrow()
  const other=document();other.creationInfo.creators=['Tool: syft'];expect(()=>bindWebSbom(other,config,[layer])).toThrow()
  const header=document();header.packages=[];expect(()=>bindWebSbom(header,config,[layer])).toThrow()
})
test('native_containerd_root_subject_requires_the_independently_bound_root_and_exact_layers',()=>{
  const root='sha256:0f7ded8d017366a5ddcc34cd16bd3378039160260fd1a21884fb3b6e00400234'
  const imageConfig='sha256:9c88b640ac24cf7c3469c3b49c3cfdbc1db8ff2a4254a6e3f1a2ed4feec76943'
  const value=document();value.packages[0]!.annotations![0]!.comment='ImageID: '+root
  expect(()=>bindWebSbom(value,imageConfig,[layer],root)).not.toThrow()
  expect(()=>bindWebSbom(value,imageConfig,[layer])).toThrow()
  expect(()=>bindWebSbom(value,imageConfig,[layer],'sha256:'+'f'.repeat(64))).toThrow()
  expect(()=>bindWebSbom(value,imageConfig,['sha256:'+'e'.repeat(64)],root)).toThrow()
  expect(()=>bindWebSbom(document(),config,[layer],root)).not.toThrow()
})
test('optional_root_binding_cannot_accept_malformed_roots_unrelated_subjects_or_duplicate_image_annotations',()=>{
  const root='sha256:'+'b'.repeat(64)
  for(const bad of ['',root.toUpperCase(),'sha256:'+'g'.repeat(64),null,42])expect(()=>bindWebSbom(document(),config,[layer],bad)).toThrow()
  const unrelated=document();unrelated.packages[0]!.annotations![0]!.comment='ImageID: sha256:'+'e'.repeat(64)
  expect(()=>bindWebSbom(unrelated,config,[layer],root)).toThrow()
  const duplicate=document();duplicate.packages[0]!.annotations!.push({comment:'ImageID: '+root})
  expect(()=>bindWebSbom(duplicate,config,[layer],root)).toThrow()
})
