import { createHash } from 'node:crypto'
const fail=()=>{throw new Error('Invalid web image identity')}
const digest=value=>typeof value==='string'&&/^sha256:[0-9a-f]{64}$/.test(value)
function boundJson(bytes,type,wanted) {
  if(!Buffer.isBuffer(bytes)||bytes.length>1048576)fail()
  const sha=value=>'sha256:'+createHash('sha256').update(value).digest('hex')
  if(sha(bytes)!==wanted&&!(bytes.at(-1)===10&&sha(bytes.subarray(0,-1))===wanted))fail()
  const parsed=JSON.parse(bytes.toString('utf8'))
  if(parsed.schemaVersion!==2||parsed.mediaType!==type)fail()
  return parsed
}
function platformDescriptor(root) {
  if(!Array.isArray(root.manifests)||root.manifests.length>16)fail()
  const runnable=root.manifests.filter(item=>item.annotations?.['vnd.docker.reference.type']!=='attestation-manifest')
  if(runnable.length!==1)fail()
  const selected=runnable[0]
  if(selected.mediaType!=='application/vnd.oci.image.manifest.v1+json'||selected.platform?.os!=='linux'||selected.platform.architecture!=='amd64'||!digest(selected.digest))fail()
  return selected
}
function admitLocalImage(local,rootDigest,configDigest,commit) {
  if(local.Os!=='linux'||local.Architecture!=='amd64')fail()
  if(![rootDigest,configDigest].includes(local.Id)||local.Config?.Labels?.['org.opencontainers.image.revision']!==commit)fail()
}
function localLayers(local) {
  const layers=local.RootFS?.Layers
  if(!Array.isArray(layers)||!layers.length||layers.length>128||!layers.every(digest))fail()
  return [...layers]
}
/** Bind actual root/platform raw bytes and both Docker image-store ID forms. */
export function webImageIdentity(rootBytes,manifestBytes,local,reference,commit) {
  if(typeof reference!=='string'||!/^ghcr\.io\/louisvannobel\/sparra-web@sha256:[0-9a-f]{64}$/.test(reference))fail()
  if(typeof commit!=='string'||!/^[0-9a-f]{40}$/.test(commit))fail()
  const rootDigest=reference.split('@')[1]
  const root=boundJson(rootBytes,'application/vnd.oci.image.index.v1+json',rootDigest),selected=platformDescriptor(root)
  const manifest=boundJson(manifestBytes,'application/vnd.oci.image.manifest.v1+json',selected.digest)
  if(manifest.config?.mediaType!=='application/vnd.oci.image.config.v1+json'||!digest(manifest.config.digest))fail()
  admitLocalImage(local,rootDigest,manifest.config.digest,commit)
  return {config_digest:manifest.config.digest,diff_ids:localLayers(local)}
}
