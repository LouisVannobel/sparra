import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isAbsolute, join, resolve } from 'node:path'
import { realpath, stat } from 'node:fs/promises'

const commit='7fb8d72742c42e65455e0ea8634f72556a8a17e2'
const tree='8b8ecb004fa47d2112a5613e0ad6e3ee79a7f6d9'
const archiveHash='26c3ea4d4022c0500fbc00e4abcd5d77e98793ff703ef191ed74a02c6ead71c1'
const inputRoots=['.python-version','pyproject.toml','uv.lock','README.md','src','scripts','agents','deployment-profiles']
const invalid=()=>new Error('Invalid native Voice source fixture')

async function assertFixtureInterpreter(pythonExecutable){
  if(typeof pythonExecutable!=='string'||!isAbsolute(pythonExecutable)||pythonExecutable.split(/[\\/]/).some(part=>part==='.'||part==='..'))throw invalid()
  try{if(!(await stat(pythonExecutable)).isFile()||(process.platform==='win32'&&(await realpath(pythonExecutable)).toLowerCase()!==resolve(pythonExecutable).toLowerCase()))throw invalid()}catch{throw invalid()}
}

function assertFixtureProvenance(manifest){
  if(!manifest||manifest.repository!=='LouisVannobel/projetV0-voice'||manifest.commit!==commit||manifest.tree!==tree
    ||manifest.owned_ref!=='refs/heads/z/sparra-voice-pilot'||JSON.stringify(manifest.input_roots)!==JSON.stringify(inputRoots))throw invalid()
}

function assertFixtureArchive(archive,manifest){
  if(!Buffer.isBuffer(archive)||archive.length!==263482||createHash('sha256').update(archive).digest('hex')!==archiveHash
    ||manifest.archive_sha256!==archiveHash||manifest.archive_size!==archive.length||manifest.decoded_source_bytes!==1255844)throw invalid()
}

function assertFixtureMembers(manifest){
  if(!Array.isArray(manifest.members)||manifest.members.length!==48)throw invalid()
  if(manifest.members.some(row=>!row||typeof row.path!=='string'||typeof row.sha256!=='string'||!/^([0-9a-f]{64})$/.test(row.sha256)||typeof row.git_blob!=='string'||!/^([0-9a-f]{40})$/.test(row.git_blob)||!Number.isSafeInteger(row.size)||row.size<0||row.size>1048576))throw invalid()
}

function fixtureVerifierInput(archive,manifest){
  const input=Buffer.from(JSON.stringify({archive:archive.toString('base64'),manifest}))
  if(input.length>1048576)throw invalid()
  return input
}

async function runFixtureVerifier(pythonExecutable,input){
  const verifier=fileURLToPath(new URL('./verify-voice-source-fixture.py',import.meta.url))
  const env=Object.fromEntries(['PATH','SystemRoot','TEMP','TMP'].flatMap(key=>process.env[key]===undefined?[]:[[key,process.env[key]]]))
  return await new Promise((resolve,reject)=>{
    const child=spawn(pythonExecutable,['-I','-B',verifier],{env,windowsHide:true,detached:process.platform==='linux',stdio:['pipe','pipe','pipe']})
    const chunks=[];let length=0,error
    const terminate=()=>{
      error=invalid()
      if(process.platform==='win32'&&child.pid&&process.env.SystemRoot)spawnSync(join(process.env.SystemRoot,'System32/taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{env,windowsHide:true,stdio:'ignore',timeout:2000})
      else try{process.platform==='linux'?process.kill(-child.pid,'SIGKILL'):child.kill()}catch{}
    }
    const timer=setTimeout(terminate,10000)
    child.on('error',()=>{error=invalid()})
    child.stdout.on('data',bytes=>{length+=bytes.length;if(length>4194304)terminate();else chunks.push(bytes)})
    child.stderr.resume()
    child.stdin.on('error',()=>{error=invalid()})
    child.on('close',code=>{clearTimeout(timer);if(error||code!==0)reject(invalid());else resolve(Buffer.concat(chunks).toString('utf8'))})
    child.stdin.end(input)
  })
}

function admitDecodedMember(row,expected){
  const member=expected.get(row.path)
  if(!member||typeof row.bytes!=='string'||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row.bytes))throw invalid()
  const bytes=Buffer.from(row.bytes,'base64')
  if(bytes.length!==member.size||createHash('sha256').update(bytes).digest('hex')!==member.sha256)throw invalid()
  return [row.path,bytes]
}

function admitVerifierResult(result,manifest){
  let decoded
  try{decoded=JSON.parse(result)}catch{throw invalid()}
  if(decoded.commit!==commit||decoded.tree!==tree||!Array.isArray(decoded.members)||decoded.members.length!==48)throw invalid()
  const expected=new Map(manifest.members.map(row=>[row.path,row]))
  const members=new Map(decoded.members.map(row=>admitDecodedMember(row,expected)))
  if(members.size!==48)throw invalid()
  return {commit,tree,members}
}

export async function readVoiceSourceFixture(archive,manifest,pythonExecutable){
  await assertFixtureInterpreter(pythonExecutable)
  assertFixtureProvenance(manifest)
  assertFixtureArchive(archive,manifest)
  assertFixtureMembers(manifest)
  return admitVerifierResult(await runFixtureVerifier(pythonExecutable,fixtureVerifierInput(archive,manifest)),manifest)
}
