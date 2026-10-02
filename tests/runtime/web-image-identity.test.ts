import { createHash } from 'node:crypto'
import { expect, test } from 'vitest'
import { webImageIdentity } from '../../scripts/web-image-identity.mjs'
const sha=(bytes:Buffer)=>'sha256:'+createHash('sha256').update(bytes).digest('hex'),commit='a'.repeat(40),config='sha256:'+'c'.repeat(64)
function fixture(){
  const manifest=Buffer.from(JSON.stringify({schemaVersion:2,mediaType:'application/vnd.oci.image.manifest.v1+json',config:{mediaType:'application/vnd.oci.image.config.v1+json',digest:config,size:100},layers:[]}))
  const root=Buffer.from(JSON.stringify({schemaVersion:2,mediaType:'application/vnd.oci.image.index.v1+json',manifests:[{mediaType:'application/vnd.oci.image.manifest.v1+json',digest:sha(manifest),platform:{os:'linux',architecture:'amd64'}}]}))
  const local={Id:sha(root),Os:'linux',Architecture:'amd64',Config:{Labels:{'org.opencontainers.image.revision':commit}},RootFS:{Layers:['sha256:'+'d'.repeat(64)]}}
  return {root,manifest,local,reference:'ghcr.io/louisvannobel/sparra-web@'+sha(root)}
}
test('Docker29_index_id_and_legacy_config_id_bind_to_the_same_actual_manifest_config',()=>{
  const value=fixture(),expected={config_digest:config,diff_ids:['sha256:'+'d'.repeat(64)]}
  expect(webImageIdentity(value.root,value.manifest,value.local,value.reference,commit)).toEqual(expected)
  value.local.Id=config;expect(webImageIdentity(value.root,value.manifest,value.local,value.reference,commit)).toEqual(expected)
})
test('different_platform_manifest_raw_bytes_revision_or_local_object_are_refused',()=>{
  const value=fixture()
  expect(()=>webImageIdentity(value.root,Buffer.from('{}'),value.local,value.reference,commit)).toThrow()
  expect(()=>webImageIdentity(value.root,value.manifest,value.local,value.reference,'b'.repeat(40))).toThrow()
  value.local.Id='sha256:'+'e'.repeat(64);expect(()=>webImageIdentity(value.root,value.manifest,value.local,value.reference,commit)).toThrow()
})
