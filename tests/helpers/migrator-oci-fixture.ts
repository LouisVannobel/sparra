import { createHash } from 'node:crypto'
import { readdir,readFile } from 'node:fs/promises'
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex')
function tar(files:ReadonlyMap<string,Buffer>) {
  const parts:Buffer[]=[]
  for(const [path,body]of files){const header=Buffer.alloc(512);header.write(path);header.write('0000444\0',100);header.write('0000000\0',108);header.write('0000000\0',116);header.write(body.length.toString(8).padStart(11,'0')+'\0',124);header.write('00000000000\0',136);header.fill(32,148,156);header[156]=48;header.write('ustar\0',257);header.write('00',263);header.write(header.reduce((sum,byte)=>sum+byte,0).toString(8).padStart(6,'0')+'\0 ',148);parts.push(header,body,Buffer.alloc((512-body.length%512)%512))}
  return Buffer.concat([...parts,Buffer.alloc(1024)])
}
export async function ociFixture(input:Readonly<{badManifest?:boolean;badSource?:boolean;blockedParent?:boolean;badPlatform?:boolean;repeatedPath?:boolean}>={}) {
  const paths=['scripts/migrate.ts','scripts/fixed-credential-file.mjs','scripts/migration-credentials.mjs','scripts/start-migrate.mjs','src/platform/db/config.server.ts','src/platform/config.server.ts','src/modules/auth/auth-email-normalization.server.ts']
  async function scan(path:string){for(const entry of await readdir(path,{withFileTypes:true})){if(entry.isDirectory())await scan(path+'/'+entry.name);else paths.push(path+'/'+entry.name)}}
  await scan('drizzle');const source=createHash('sha256'),files=new Map<string,Buffer>()
  for(const path of paths.sort()){const bytes=await readFile(path);source.update(path).update('\0').update(bytes).update('\0');files.set('app/'+path,bytes)}
  const manifest={schema_version:1,node:'24.14.0',pnpm:'10.32.1',lock_sha256:digest(await readFile('pnpm-lock.yaml')),dockerfile_sha256:digest(await readFile('Dockerfile')),migration_source_sha256:source.digest('hex')}
  files.set('app/migration-source-manifest.json',Buffer.from(JSON.stringify({...manifest,...(input.badManifest?{migration_source_sha256:'c'.repeat(64)}:{})})))
  files.set('app/pnpm-lock.yaml',await readFile('pnpm-lock.yaml'));files.set('app/package.json',await readFile('package.json'))
  if(input.badSource)files.set('app/scripts/migrate.ts',Buffer.from('process.exit(0)\n'))
  const layer=tar(files),layers=[layer,...(input.blockedParent?[tar(new Map([['app/scripts',Buffer.from('blocking-file')]]))]:[]),...(input.repeatedPath?[tar(new Map([['app//scripts/migrate.ts',Buffer.from('replacement')]]))]:[])],layerIds=layers.map(digest)
  const config=Buffer.from(JSON.stringify({architecture:input.badPlatform?'arm64':'amd64',os:'linux',rootfs:{type:'layers',diff_ids:layerIds.map(value=>'sha256:'+value)},config:{User:'10001:10001',WorkingDir:'/app',Entrypoint:['node','scripts/start-migrate.mjs'],Env:['NODE_VERSION=24.14.0']}})),configId=digest(config)
  const image=Buffer.from(JSON.stringify({schemaVersion:2,mediaType:'application/vnd.oci.image.manifest.v1+json',config:{mediaType:'application/vnd.oci.image.config.v1+json',digest:'sha256:'+configId,size:config.length},layers:layers.map((value,index)=>({mediaType:'application/vnd.oci.image.layer.v1.tar',digest:'sha256:'+layerIds[index],size:value.length}))})),imageDigest=digest(image)
  const index=Buffer.from(JSON.stringify({schemaVersion:2,mediaType:'application/vnd.oci.image.index.v1+json',manifests:[{mediaType:'application/vnd.oci.image.manifest.v1+json',digest:'sha256:'+imageDigest,size:image.length,platform:{os:'linux',architecture:'amd64'}}]})),imageId=digest(index)
  const carrier=Buffer.from(JSON.stringify({schemaVersion:2,mediaType:'application/vnd.oci.image.index.v1+json',manifests:[{mediaType:'application/vnd.oci.image.index.v1+json',digest:'sha256:'+imageId,size:index.length}]}))
  const archive=tar(new Map([['oci-layout',Buffer.from('{"imageLayoutVersion":"1.0.0"}')],['index.json',carrier],['blobs/sha256/'+imageId,index],['blobs/sha256/'+imageDigest,image],['blobs/sha256/'+configId,config],...layers.map((value,index):[string,Buffer]=>['blobs/sha256/'+layerIds[index],value])]))
  const sbom={spdxVersion:'SPDX-2.3',dataLicense:'CC0-1.0',SPDXID:'SPDXRef-DOCUMENT',name:'Synthetic OCI',documentNamespace:'https://example.invalid/spdx/oci',creationInfo:{creators:['Tool: trivy-0.74.0']},
    packages:[{name:'Synthetic OCI',SPDXID:'SPDXRef-Container',primaryPackagePurpose:'CONTAINER',annotations:[{comment:'ImageID: sha256:'+configId},...layerIds.map(value=>({comment:'DiffID: sha256:'+value}))]},{name:'pg',SPDXID:'SPDXRef-Package-pg',versionInfo:'8.23.0'}],
    relationships:[{spdxElementId:'SPDXRef-DOCUMENT',relatedSpdxElement:'SPDXRef-Container',relationshipType:'DESCRIBES'},{spdxElementId:'SPDXRef-Container',relatedSpdxElement:'SPDXRef-Package-pg',relationshipType:'CONTAINS'}]}
  return {archive,imageId:'sha256:'+imageId,sbom,manifest}
}
