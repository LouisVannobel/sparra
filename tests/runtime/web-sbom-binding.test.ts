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
