import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { createGunzip } from 'node:zlib'

const fail=()=>{throw Error('Invalid migration archive')}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const digest=value=>{if(typeof value!=='string'||!/^sha256:[0-9a-f]{64}$/.test(value))fail();return value.slice(7)}
const json=bytes=>{if(!bytes||bytes.length>131072)fail();return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}
const indexType='application/vnd.oci.image.index.v1+json',manifestType='application/vnd.oci.image.manifest.v1+json'

/** The Docker-save OCI carrier used by this consumer. No filesystem extraction. */
async function tar(stream,maximum,visit) {
  const iterator=stream[Symbol.asyncIterator](),hash=createHash('sha256')
  let buffer=Buffer.alloc(0),position=0,total=0,entries=0,pax={},longName
  async function consume(size,receive) {
    if(!Number.isSafeInteger(size)||size<0||size>maximum)fail()
    let left=size
    while(left){
      if(!buffer.length){const next=await iterator.next();if(next.done)fail();buffer=Buffer.from(next.value);total+=buffer.length;if(total>maximum)fail();hash.update(buffer)}
      const count=Math.min(left,buffer.length),part=buffer.subarray(0,count)
      receive?.(part);buffer=buffer.subarray(count);position+=count;left-=count
    }
  }
  async function bytes(size){if(size>8388608)fail();const parts=[];await consume(size,part=>parts.push(part));return Buffer.concat(parts)}
  const text=bytes=>new TextDecoder('utf-8',{fatal:true}).decode(bytes).split('\0')[0]
  const number=bytes=>{const value=text(bytes).trim();if(!/^[0-7]+$/.test(value))fail();const result=Number.parseInt(value,8);if(!Number.isSafeInteger(result))fail();return result}
  const names=new Set()
  try{while(true){
    const header=await bytes(512)
    if(header.every(byte=>byte===0)){
      if(!(await bytes(512)).every(byte=>byte===0))fail()
      if(buffer.some(byte=>byte!==0))fail()
      for await(const chunk of { [Symbol.asyncIterator]:()=>iterator }){total+=chunk.length;if(total>maximum||Buffer.from(chunk).some(byte=>byte!==0))fail();hash.update(chunk)}
      if(total%512||Object.keys(pax).length||longName)fail()
      return {hash:hash.digest('hex'),bytes:total}
    }
    if(++entries>100000)fail()
    const checksum=header.reduce((sum,byte,index)=>sum+(index>=148&&index<156?32:byte),0)
    if(checksum!==number(header.subarray(148,156))||!['ustar','ustar '].includes(text(header.subarray(257,263))))fail()
    let name=text(header.subarray(0,100)),prefix=text(header.subarray(345,500))
    if(prefix)name=prefix+'/'+name
    let size=number(header.subarray(124,136)),type=String.fromCharCode(header[156]||48)
    if(type==='x'||type==='L'){
      if(size>65536)fail()
      const data=await bytes(size);await consume((512-size%512)%512)
      if(type==='L'){longName=text(data);continue}
      let offset=0
      while(offset<data.length){
        const space=data.indexOf(32,offset);if(space<offset)fail()
        const length=Number(data.subarray(offset,space).toString('ascii'));if(!Number.isSafeInteger(length)||length<5||offset+length>data.length||data[offset+length-1]!==10)fail()
        const record=new TextDecoder('utf-8',{fatal:true}).decode(data.subarray(space+1,offset+length-1)),equal=record.indexOf('=')
        if(equal<1)fail();const key=record.slice(0,equal),value=record.slice(equal+1)
        if(!['path','linkpath','mtime','atime','ctime','size'].includes(key)&&!key.startsWith('SCHILY.xattr.'))fail()
        if(Object.hasOwn(pax,key))fail();pax[key]=value;offset+=length
      }
      continue
    }
    if(pax.path)name=pax.path
    else if(longName)name=longName
    if(pax.size){if(!/^(0|[1-9][0-9]*)$/.test(pax.size))fail();size=Number(pax.size)}
    pax={};longName=undefined
    name=name.replace(/^\.\//,'').replace(/\/$/,'')
    if(name==='.'&&type==='5')name=''
    if(name.startsWith('/')||name.includes('\\')||name&&name.split('/').some(part=>!part||part==='..'||part==='.')||!name&&type!=='5')fail()
    if(names.has(name))fail();names.add(name)
    if(!['0','1','2','3','4','5','6'].includes(type))fail()
    await visit({name,size,type,offset:position,read:()=>bytes(size),consume:receive=>consume(size,receive)})
    await consume((512-size%512)%512)
  }}finally{stream.destroy();await iterator.return?.()}
}

export async function inspectMigrationArchive(path,imageId,expectedManifest,expectedFiles,spdx) {
  const blobs=new Map(),documents=new Map()
  await tar(createReadStream(path),1073741824,async entry=>{
    if(entry.type==='5'&&['blobs','blobs/sha256'].includes(entry.name)){await entry.consume();return}
    if(entry.type!=='0'||!(/^(?:index\.json|oci-layout|manifest\.json|blobs\/sha256\/[0-9a-f]{64})$/.test(entry.name)))fail()
    if(blobs.size+documents.size>256)fail()
    const hash=createHash('sha256'),parts=[]
    await entry.consume(part=>{hash.update(part);if(entry.size<=131072)parts.push(part)})
    const actual=hash.digest('hex'),data=entry.size<=131072?Buffer.concat(parts):undefined
    if(entry.name.startsWith('blobs/sha256/')){if(actual!==entry.name.slice(13))fail();blobs.set(actual,{offset:entry.offset,size:entry.size,data})}
    else documents.set(entry.name,data)
  })
  if(json(documents.get('oci-layout')).imageLayoutVersion!=='1.0.0')fail()
  const carrier=json(documents.get('index.json')),id=digest(imageId)
  if(carrier.schemaVersion!==2||carrier.mediaType!==indexType||carrier.manifests?.length!==1||digest(carrier.manifests[0].digest)!==id)fail()
  const metadata=reference=>{
    const key=digest(reference.digest),blob=blobs.get(key)
    if(!blob||reference.size!==blob.size)fail()
    return json(blob.data)
  }
  let descriptor=carrier.manifests[0],image=metadata(descriptor)
  if(descriptor.mediaType===indexType){
    if(image.schemaVersion!==2||image.mediaType!==indexType)fail()
    const selected=image.manifests?.filter(item=>item.platform?.os==='linux'&&item.platform?.architecture==='amd64')
    if(selected?.length!==1)fail();descriptor=selected[0];image=metadata(descriptor)
  }
  if(descriptor.mediaType!==manifestType||image.mediaType!==manifestType||image.schemaVersion!==2||!Array.isArray(image.layers)||image.layers.length<1||image.layers.length>64)fail()
  const config=metadata(image.config),configId='sha256:'+digest(image.config.digest)
  if(config.os!=='linux'||config.architecture!=='amd64'||config.config?.User!=='10001:10001'||config.config?.WorkingDir!=='/app'
    ||JSON.stringify(config.config?.Entrypoint)!=='["node","scripts/start-migrate.mjs"]'||config.rootfs?.type!=='layers'||config.rootfs.diff_ids?.length!==image.layers.length)fail()
  const actualFiles=new Map(),critical=new Set(['app']),exactFiles=new Set(['app/migration-source-manifest.json','app/pnpm-lock.yaml','app/package.json',...[...expectedFiles.keys()].map(name=>'app/'+name)])
  for(const name of exactFiles){let parent=name.slice(0,name.lastIndexOf('/'));while(parent){critical.add(parent);parent=parent.includes('/')?parent.slice(0,parent.lastIndexOf('/')):''}}
  const wanted=name=>name==='app/migration-source-manifest.json'||name==='app/pnpm-lock.yaml'||name==='app/package.json'||expectedFiles.has(name.slice(4))&&name.startsWith('app/')||name.startsWith('app/drizzle/')
  let expanded=0,captured=0
  for(const [index,layer]of image.layers.entries()){
    const blob=blobs.get(digest(layer.digest));if(!blob||blob.size!==layer.size)fail()
    const source=createReadStream(path,{start:blob.offset,end:blob.offset+blob.size-1})
    const gzip=['application/vnd.oci.image.layer.v1.tar+gzip','application/vnd.docker.image.rootfs.diff.tar.gzip'].includes(layer.mediaType)
    if(!gzip&&layer.mediaType!=='application/vnd.oci.image.layer.v1.tar')fail()
    const stream=gzip?source.pipe(createGunzip()):source
    const diff=await tar(stream,Math.min(1073741824,2147483648-expanded),async entry=>{
      if(entry.name.includes('/.wh.')){
        const split=entry.name.lastIndexOf('/'),parent=entry.name.slice(0,split),leaf=entry.name.slice(split+1)
        const erased=leaf==='.wh..wh..opq'?parent:parent+'/'+leaf.slice(4)
        for(const key of actualFiles.keys())if(key===erased||key.startsWith(erased+'/'))actualFiles.delete(key)
        await entry.consume();return
      }
      if(critical.has(entry.name)&&entry.type!=='5'||exactFiles.has(entry.name)&&entry.type!=='0'||wanted(entry.name)&&!['0','5'].includes(entry.type))fail()
      if(wanted(entry.name)&&entry.type==='0'){
        captured+=entry.size;if(captured>67108864)fail()
        actualFiles.set(entry.name,await entry.read())
      }else await entry.consume()
    })
    expanded+=diff.bytes
    if('sha256:'+diff.hash!==config.rootfs.diff_ids[index])fail()
  }
  const manifest=json(actualFiles.get('app/migration-source-manifest.json'))
  if(JSON.stringify(Object.entries(manifest).sort())!==JSON.stringify(Object.entries(expectedManifest).sort()))fail()
  if(sha(actualFiles.get('app/pnpm-lock.yaml')??Buffer.alloc(0))!==expectedManifest.lock_sha256)fail()
  const packaged=json(actualFiles.get('app/package.json'))
  if(packaged.engines?.node!=='24.14.0'||packaged.packageManager!=='pnpm@10.32.1')fail()
  for(const [name,bytes]of expectedFiles){const actual=actualFiles.get('app/'+name);if(!actual||!actual.equals(bytes))fail()}
  const drizzle=[...actualFiles.keys()].filter(name=>name.startsWith('app/drizzle/'))
  if(drizzle.some(name=>!expectedFiles.has(name.slice(4))))fail()
  const subjects=spdx.packages?.filter(item=>item.primaryPackagePurpose==='CONTAINER')
  if(subjects?.length!==1||spdx.packages.length<2||!spdx.creationInfo?.creators?.includes('Tool: trivy-0.74.0'))fail()
  const subject=subjects[0],annotations=subject.annotations?.map(item=>item.comment)??[]
  if(annotations.filter(value=>value.startsWith('ImageID: ')).length!==1||!annotations.includes('ImageID: '+configId))fail()
  const differences=annotations.filter(value=>value.startsWith('DiffID: ')).map(value=>value.slice(8)).sort()
  if(JSON.stringify(differences)!==JSON.stringify([...config.rootfs.diff_ids].sort()))fail()
  if(!spdx.relationships?.some(item=>item.spdxElementId==='SPDXRef-DOCUMENT'&&item.relatedSpdxElement===subject.SPDXID&&item.relationshipType==='DESCRIBES')
    ||!spdx.relationships.some(item=>item.spdxElementId===subject.SPDXID&&item.relationshipType==='CONTAINS'&&spdx.packages.some(pkg=>pkg.SPDXID===item.relatedSpdxElement&&pkg!==subject)))fail()
  return {configId,diffIds:config.rootfs.diff_ids}
}
