import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { createGunzip } from 'node:zlib'
import { finished, pipeline } from 'node:stream/promises'
import { bindWebSbom } from './web-sbom-binding.mjs'

const fail=()=>{throw Error('Invalid migration archive')}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const digest=value=>{if(typeof value!=='string'||!/^sha256:[0-9a-f]{64}$/.test(value))fail();return value.slice(7)}
const json=bytes=>{if(!bytes||bytes.length>131072)fail();return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}
const indexType='application/vnd.oci.image.index.v1+json',manifestType='application/vnd.oci.image.manifest.v1+json'

const tarText=bytes=>new TextDecoder('utf-8',{fatal:true}).decode(bytes).split('\0')[0]
function tarNumber(bytes) {
  const value=tarText(bytes).trim()
  if(!/^[0-7]+$/.test(value))fail()
  const result=Number.parseInt(value,8)
  if(!Number.isSafeInteger(result))fail()
  return result
}
function decodeTarHeader(header) {
  const checksum=header.reduce((sum,byte,index)=>sum+(index>=148&&index<156?32:byte),0)
  if(checksum!==tarNumber(header.subarray(148,156))||!['ustar','ustar '].includes(tarText(header.subarray(257,263))))fail()
  const leaf=tarText(header.subarray(0,100)),prefix=tarText(header.subarray(345,500))
  return {name:prefix?prefix+'/'+leaf:leaf,size:tarNumber(header.subarray(124,136)),type:String.fromCharCode(header[156]||48)}
}
function decodePax(data,pax) {
  let offset=0
  while(offset<data.length){
    const space=data.indexOf(32,offset);if(space<offset)fail()
    const length=Number(data.subarray(offset,space).toString('ascii'))
    if(!Number.isSafeInteger(length)||length<5||offset+length>data.length||data[offset+length-1]!==10)fail()
    const record=new TextDecoder('utf-8',{fatal:true}).decode(data.subarray(space+1,offset+length-1)),equal=record.indexOf('=')
    if(equal<1)fail()
    const key=record.slice(0,equal),value=record.slice(equal+1)
    if(!['path','linkpath','mtime','atime','ctime','size'].includes(key)&&!key.startsWith('SCHILY.xattr.'))fail()
    if(Object.hasOwn(pax,key))fail()
    pax[key]=value;offset+=length
  }
}

function normalizeTarEntry(entry,pax,longName,names) {
  let {name,size,type}=entry
  if(pax.path)name=pax.path
  else if(longName)name=longName
  if(pax.size){if(!/^(0|[1-9][0-9]*)$/.test(pax.size))fail();size=Number(pax.size)}
  name=name.replace(/^\.\//,'').replace(/\/$/,'')
  if(name==='.'&&type==='5')name=''
  if(name.startsWith('/')||name.includes('\\')||name&&name.split('/').some(part=>!part||part==='..'||part==='.')||!name&&type!=='5')fail()
  if(names.has(name))fail();names.add(name)
  if(!['0','1','2','3','4','5','6'].includes(type))fail()
  return {name,size,type}
}

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
  async function finishArchive() {
    if(!(await bytes(512)).every(byte=>byte===0))fail()
    if(buffer.some(byte=>byte!==0))fail()
    for await(const chunk of { [Symbol.asyncIterator]:()=>iterator }){total+=chunk.length;if(total>maximum||Buffer.from(chunk).some(byte=>byte!==0))fail();hash.update(chunk)}
    if(total%512||Object.keys(pax).length||longName)fail()
    return {hash:hash.digest('hex'),bytes:total}
  }
  const names=new Set()
  try{while(true){
    const header=await bytes(512)
    if(header.every(byte=>byte===0))return await finishArchive()
    if(++entries>100000)fail()
    const entry=decodeTarHeader(header)
    if(entry.type==='x'||entry.type==='L'){
      if(entry.size>65536)fail()
      const data=await bytes(entry.size);await consume((512-entry.size%512)%512)
      if(entry.type==='L'){longName=tarText(data);continue}
      decodePax(data,pax)
      continue
    }
    const {name,size,type}=normalizeTarEntry(entry,pax,longName,names)
    pax={};longName=undefined
    await visit({name,size,type,offset:position,read:()=>bytes(size),consume:receive=>consume(size,receive)})
    await consume((512-size%512)%512)
  }}finally{stream.destroy();await iterator.return?.()}
}

function applyWhiteout(lower,entry) {
  const split=entry.name.lastIndexOf('/'),parent=split<0?'':entry.name.slice(0,split),leaf=entry.name.slice(split+1)
  if(!leaf.startsWith('.wh.'))return false
  if(entry.type!=='0'||entry.size!==0||['','.','..'].includes(leaf.slice(4)))fail()
  const erased=leaf==='.wh..wh..opq'?parent:(parent?parent+'/':'')+leaf.slice(4)
  for(const key of lower.keys())if(erased===''||key===erased||key.startsWith(erased+'/'))lower.delete(key)
  return true
}

async function readLayer(path,blob,mediaType,maximum,visit) {
  const gzip=['application/vnd.oci.image.layer.v1.tar+gzip','application/vnd.docker.image.rootfs.diff.tar.gzip'].includes(mediaType)
  if(!gzip&&mediaType!=='application/vnd.oci.image.layer.v1.tar')fail()
  let source,inflater,transfer,transferError
  try{
    source=createReadStream(path,{start:blob.offset,end:blob.offset+blob.size-1})
    inflater=gzip?createGunzip():undefined
    if(inflater)transfer=pipeline(source,inflater).catch(error=>{transferError=error})
    const diff=await tar(inflater??source,maximum,visit)
    await transfer
    if(transferError)throw transferError
    return diff
  }finally{
    source?.destroy();inflater?.destroy()
    await Promise.allSettled([transfer,...[source,inflater].filter(Boolean).map(stream=>finished(stream,{cleanup:true}))])
  }
}

async function readMigrationLayers(path,blobs,image,config,expectedFiles) {
  const actualFiles=new Map(),critical=new Set(['app']),exactFiles=new Set(['app/migration-source-manifest.json','app/pnpm-lock.yaml','app/package.json',...[...expectedFiles.keys()].map(name=>'app/'+name)])
  for(const name of exactFiles){let parent=name.slice(0,name.lastIndexOf('/'));while(parent){critical.add(parent);parent=parent.includes('/')?parent.slice(0,parent.lastIndexOf('/')):''}}
  const wanted=name=>name==='app/migration-source-manifest.json'||name==='app/pnpm-lock.yaml'||name==='app/package.json'||expectedFiles.has(name.slice(4))&&name.startsWith('app/')||name.startsWith('app/drizzle/')
  let expanded=0,captured=0
  for(const [index,layer]of image.layers.entries()){
    const blob=blobs.get(digest(layer.digest));if(!blob||blob.size!==layer.size)fail()
    const pendingWrites=new Map()
    const diff=await readLayer(path,blob,layer.mediaType,Math.min(1073741824,2147483648-expanded),async entry=>{
      if(applyWhiteout(actualFiles,entry)){
        await entry.consume();return
      }
      if(critical.has(entry.name)&&entry.type!=='5'||exactFiles.has(entry.name)&&entry.type!=='0'||wanted(entry.name)&&!['0','5'].includes(entry.type))fail()
      if(wanted(entry.name)&&entry.type==='0'){
        captured+=entry.size;if(captured>67108864)fail()
        pendingWrites.set(entry.name,await entry.read())
      }else await entry.consume()
    })
    expanded+=diff.bytes
    if('sha256:'+diff.hash!==config.rootfs.diff_ids[index])fail()
    for(const [name,bytes]of pendingWrites)actualFiles.set(name,bytes)
  }
  return actualFiles
}

async function readArchiveCarrier(path) {
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
  return {blobs,carrier:json(documents.get('index.json'))}
}

function selectMigrationImage(blobs,carrier,imageId) {
  const id=digest(imageId)
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
  assertMigrationConfig(config,image.layers.length)
  return {image,config,configId}
}

function assertMigrationConfig(config,layerCount) {
  if(config.os!=='linux'||config.architecture!=='amd64'||config.config?.User!=='10001:10001'||config.config?.WorkingDir!=='/app'
    ||JSON.stringify(config.config?.Entrypoint)!=='["node","scripts/start-migrate.mjs"]'||config.rootfs?.type!=='layers'||config.rootfs.diff_ids?.length!==layerCount)fail()
}

function assertMigrationFiles(actualFiles,expectedManifest,expectedFiles) {
  const manifest=json(actualFiles.get('app/migration-source-manifest.json'))
  if(JSON.stringify(Object.entries(manifest).sort())!==JSON.stringify(Object.entries(expectedManifest).sort()))fail()
  if(sha(actualFiles.get('app/pnpm-lock.yaml')??Buffer.alloc(0))!==expectedManifest.lock_sha256)fail()
  const packaged=json(actualFiles.get('app/package.json'))
  if(packaged.engines?.node!=='24.14.0'||packaged.packageManager!=='pnpm@10.32.1')fail()
  for(const [name,bytes]of expectedFiles){const actual=actualFiles.get('app/'+name);if(!actual||!actual.equals(bytes))fail()}
  const drizzle=[...actualFiles.keys()].filter(name=>name.startsWith('app/drizzle/'))
  if(drizzle.some(name=>!expectedFiles.has(name.slice(4))))fail()
}

export async function inspectMigrationArchive(path,imageId,expectedManifest,expectedFiles,spdx) {
  const {blobs,carrier}=await readArchiveCarrier(path)
  const {image,config,configId}=selectMigrationImage(blobs,carrier,imageId)
  const actualFiles=await readMigrationLayers(path,blobs,image,config,expectedFiles)
  assertMigrationFiles(actualFiles,expectedManifest,expectedFiles)
  const subject=spdx.packages?.find(item=>item.primaryPackagePurpose==='CONTAINER')
  if(subject?.annotations?.some(item=>typeof item.comment!=='string'))fail()
  bindWebSbom(spdx,configId,config.rootfs.diff_ids,imageId)
  return {configId,diffIds:config.rootfs.diff_ids}
}
