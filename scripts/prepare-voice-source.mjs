import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { resolveVoiceProducer } from '../tests/helpers/sparra-crypto-fixture.ts'
import { readVoiceSourceFixture } from './voice-source-fixture.mjs'

const invalid=()=>new Error('Native Voice preparation failed')
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const uvHash='c8c60f47e6f88d18dbf6f33d7279fb1fbf7ae76631768152cf5578c3d65729b4'
const scannerHash='551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb'
const safeAbsolute=path=>typeof path==='string'&&isAbsolute(path)&&!path.split(/[\\/]/).some(part=>part==='.'||part==='..')
const samePath=(left,right)=>process.platform==='win32'?left.toLowerCase()===right.toLowerCase():left===right
const baselineEnv=()=>Object.fromEntries(['PATH','SystemRoot','TEMP','TMP'].flatMap(key=>process.env[key]===undefined?[]:[[key,process.env[key]]]))

async function directory(path,owner){
  const current=await lstat(path)
  if(!current.isDirectory()||current.isSymbolicLink()||!samePath(await realpath(path),path)||(owner&&(current.dev!==owner.dev||current.ino!==owner.ino)))throw invalid()
  return current
}

async function run(executable,args,{cwd,env,timeout=30000,maxOutput=4194304,input}={}){
  return await new Promise((resolveRun,reject)=>{
    const child=spawn(executable,args,{cwd,env:env??baselineEnv(),windowsHide:true,detached:process.platform==='linux',stdio:['pipe','pipe','pipe']})
    const output=[];let size=0,failed=false
    const terminate=()=>{failed=true;try{process.platform==='linux'?process.kill(-child.pid,'SIGKILL'):child.kill()}catch{}}
    const timer=setTimeout(terminate,timeout)
    child.on('error',()=>{failed=true})
    child.stdout.on('data',bytes=>{size+=bytes.length;if(size>maxOutput)terminate();else output.push(bytes)})
    child.stderr.on('data',bytes=>{size+=bytes.length;if(size>maxOutput)terminate()})
    child.stdin.on('error',()=>{failed=true})
    child.on('close',code=>{clearTimeout(timer);if(failed||code!==0)reject(invalid());else resolveRun(Buffer.concat(output))})
    child.stdin.end(input)
  })
}

async function downloadBytes(response){
  let size=0;const parts=[]
  try{for await(const part of response.body){size+=part.length;if(size>33554432)throw invalid();parts.push(part)}}catch(error){await response.body.cancel().catch(()=>{});throw error}
  return Buffer.concat(parts)
}

async function download(url,hash,destination){
  const response=await fetch(url,{signal:AbortSignal.timeout(60000),redirect:'follow'})
  if(!response.ok||!response.url.startsWith('https:'))throw invalid()
  const bytes=await downloadBytes(response)
  if(sha(bytes)!==hash)throw invalid()
  await writeFile(destination,bytes,{flag:'wx',mode:0o600})
}

// The OS interpreter only decodes checksum-verified public tools. The native
// producer archive is verified with the owned, pinned 3.13.15 installation.
async function tool(archive,destination,member){
  const script=String.raw`
import io,sys,tarfile
from pathlib import Path
data=Path(sys.argv[1]).read_bytes()
assert len(data)<=33554432
with tarfile.open(fileobj=io.BytesIO(data),mode='r:gz') as source:
    entries=[];total=0;count=0
    for entry in source:
        count+=1;total+=entry.size
        assert count<=32 and total<=100663296
        assert not entry.name.startswith('/') and '\\' not in entry.name
        assert all(part not in ('','.','..') for part in entry.name.rstrip('/').split('/'))
        assert entry.isreg() or entry.isdir()
        if entry.name==sys.argv[3]: entries.append(entry)
    assert len(entries)==1
    entry=entries[0]
    assert entry.isreg() and not entry.pax_headers and 0<entry.size<=67108864
    value=source.extractfile(entry).read(entry.size+1)
    assert len(value)==entry.size
    with Path(sys.argv[2]).open('xb') as output: output.write(value)
`
  await run('/usr/bin/python3',['-I','-B','-c',script,archive,destination,member])
  await chmod(destination,0o500)
}

async function sourceIdentity(root,members){
  const expected=new Set(members.keys())
  async function inspect(child,logical){
    const current=await lstat(child)
    if(current.isSymbolicLink())throw invalid()
    if(current.isDirectory())return await visit(child,logical)
    if(!current.isFile()||!expected.delete(logical))throw invalid()
    if(!(await readFile(child)).equals(members.get(logical)))throw invalid()
  }
  async function visit(path,relative=''){
    for(const name of await readdir(path)){
      if(!relative&&name==='.venv')continue
      await inspect(join(path,name),relative?relative+'/'+name:name)
    }
  }
  await directory(root);await visit(root)
  if(expected.size)throw invalid()
}

async function interpreterIdentity(executable){
  const canonical=await realpath(executable),current=await stat(canonical)
  if(!current.isFile()||current.size>134217728)throw invalid()
  return canonical+'\0'+current.dev+'\0'+current.ino+'\0'+sha(await readFile(canonical))
}

export async function createVoiceTestHome(scope){
  const owner=await directory(scope),home=join(scope,'home')
  await mkdir(home,{mode:0o700})
  const homeOwner=await directory(home),identity=await environmentIdentity(home)
  return {environment:{HOME:home,APPDATA:home},assertIdentity:async()=>{
    await directory(scope,owner);await directory(home,homeOwner)
    if(await environmentIdentity(home)!==identity)throw invalid()
  }}
}

async function assertNativeDescriptor(descriptor,testEnvironment){
  const script=String.raw`
import importlib.metadata,inspect,sys
from pathlib import Path
source=Path(sys.argv[1]);venv=source.parent/'.venv'
assert source.resolve()==source and venv.resolve()==venv
assert sys.version_info[:3]==(3,13,15) and sys.prefix!=sys.base_prefix
assert Path(sys.prefix).resolve()==venv
import cryptography,pydantic
assert cryptography.__version__=='50.0.0' and pydantic.__version__=='2.13.4'
assert Path(cryptography.__file__).resolve().is_relative_to(venv)
assert Path(pydantic.__file__).resolve().is_relative_to(venv)
assert importlib.metadata.version('pipecat-ai')=='1.12.0'
sys.path.insert(0,str(source))
from projetv0_voice import models,production_wiring,crypto
for module,name in [(models,'models.py'),(production_wiring,'production_wiring.py'),(crypto,'crypto.py')]:
    assert Path(module.__file__).resolve()==source/'projetv0_voice'/name
assert Path(inspect.getsourcefile(models.TurnUpsertPayloadV1)).resolve()==source/'projetv0_voice/models.py'
assert Path(inspect.getsourcefile(production_wiring._decode_keyring_value)).resolve()==source/'projetv0_voice/production_wiring.py'
assert Path(inspect.getsourcefile(crypto.CryptoKeyring.encrypt)).resolve()==source/'projetv0_voice/crypto.py'
assert production_wiring.CryptoKeyring is crypto.CryptoKeyring
`
  await run(descriptor.pythonExecutable,['-I','-B','-c',script,descriptor.sourceRoot],{cwd:dirname(descriptor.sourceRoot),env:{...baselineEnv(),...testEnvironment},timeout:60000})
}

export async function environmentIdentity(root,sourceOnly=false){
  const digest=createHash('sha256')
  const sourceRoots=['.python-version','pyproject.toml','uv.lock','README.md','src','scripts','agents','deployment-profiles']
  const sourceTests=['tests','tests/integration','tests/integration/sparra_connected_scenario.py']
  function selected(name,logical,label){
    if(!sourceOnly)return true
    if(label.split('/')[0]==='tests')return sourceTests.includes(label)
    if(!logical)return sourceRoots.includes(name)
    return name!=='__pycache__'
  }
  async function hashEntry(child,label){
    const current=await lstat(child)
    if(current.isSymbolicLink()){
      if(sourceOnly)throw invalid()
      digest.update('link\0').update(await readlink(child));return
    }
    if(current.isDirectory()){
      digest.update('directory\0');await visit(child,label);return
    }
    if(!current.isFile())throw invalid()
    digest.update('file\0').update(await readFile(child))
  }
  async function visit(path,logical=''){
    for(const name of (await readdir(path)).sort()){
      const label=logical?logical+'/'+name:name
      if(!selected(name,logical,label))continue
      digest.update(label).update('\0')
      await hashEntry(join(path,name),label)
      digest.update('\0')
    }
  }
  await directory(root);await visit(root)
  return digest.digest('hex')
}

export async function createVoiceSourceScope(parent,members){
  if(!safeAbsolute(parent))throw invalid()
  await directory(parent)
  const scope=await mkdtemp(join(parent,'sparra-native-voice-'))
  let owner
  try{owner=await directory(scope)}catch(error){await rm(scope,{recursive:true});throw error}
  let retired=false,installed=false
  const root=join(scope,'source')
  const retire=async()=>{
    if(retired)return
    await directory(scope,owner)
    await rm(scope,{recursive:true})
    if(await lstat(scope).then(()=>true,error=>error.code!=='ENOENT'))throw invalid()
    retired=true
  }
  const install=async values=>{
    try{
      if(retired||installed||!(values instanceof Map)||!values.size)throw invalid()
      await directory(scope,owner)
      for(const [path,bytes]of values){
        if(typeof path!=='string'||path.startsWith('/')||path.includes('\\')||path.split('/').some(part=>!part||part==='.'||part==='..')||!Buffer.isBuffer(bytes))throw invalid()
        const destination=join(root,path)
        await mkdir(dirname(destination),{recursive:true,mode:0o700});await writeFile(destination,bytes,{flag:'wx',mode:0o400})
      }
      members=new Map([...values].map(([path,bytes])=>[path,Buffer.from(bytes)]));installed=true;await sourceIdentity(root,members)
    }catch(error){try{await retire()}catch(cleanup){throw new AggregateError([error,cleanup],'Native Voice source and retirement failed')}throw error}
  }
  try{
    await mkdir(root,{mode:0o700})
    if(members)await install(members)
    return {directory:scope,root,install,assertIdentity:async()=>{if(retired||!installed)throw invalid();await directory(scope,owner);await sourceIdentity(root,members)},retire}
  }catch(error){try{await retire()}catch(cleanup){throw new AggregateError([error,cleanup],'Native Voice source and retirement failed')}throw error}
}

async function prepareExternalVoiceSource(explicitRoot,scopeParent){
  const descriptor=await resolveVoiceProducer(explicitRoot)
  const owned=await createVoiceSourceScope(scopeParent)
  try{
    const scopeOwner=await directory(owned.directory)
    const home=await createVoiceTestHome(owned.directory)
    await assertNativeDescriptor(descriptor,home.environment)
    const producerRoot=dirname(descriptor.sourceRoot),identity=await interpreterIdentity(descriptor.pythonExecutable),source=await environmentIdentity(producerRoot,true)
    let retired=false
    return {root:producerRoot,descriptor,fixturePython:descriptor.pythonExecutable,testEnvironment:home.environment,
      assertIdentity:async()=>{await directory(owned.directory,scopeOwner);await home.assertIdentity();if(retired||JSON.stringify(await resolveVoiceProducer(explicitRoot))!==JSON.stringify(descriptor)||await interpreterIdentity(descriptor.pythonExecutable)!==identity||await environmentIdentity(producerRoot,true)!==source)throw invalid()},
      retire:async()=>{await owned.retire();retired=true}}
  }catch(error){try{await owned.retire()}catch(cleanup){throw new AggregateError([error,cleanup],'Native Voice preparation and retirement failed')}throw error}
}

async function scanVoiceSource(appRoot,producerRoot,tools,env){
  const scannerArchive=join(tools,'gitleaks.tar.gz'),scanner=join(tools,'gitleaks')
  await download('https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz',scannerHash,scannerArchive)
  await tool(scannerArchive,scanner,'gitleaks')
  const config=join(appRoot,'.gitleaks.toml'),args=['dir',producerRoot,'--redact','--no-banner','--exit-code','1']
  if(await lstat(config).then(()=>true,error=>error.code!=='ENOENT')){
    if(!(await lstat(config)).isFile()||(await lstat(config)).isSymbolicLink())throw invalid()
    args.push('--config',config)
  }
  await run(scanner,args,{env,timeout:30000})
}

async function prepareLinuxVoiceSource(appRoot,scopeParent){
  const owned=await createVoiceSourceScope(scopeParent),scope=owned.directory,retire=owned.retire
  let members,descriptor,identity,environment
  let stage='owned directories'
  try{
    const producerRoot=owned.root,tools=join(scope,'tools'),cache=join(scope,'cache'),python=join(scope,'python'),temporary=join(scope,'tmp')
    for(const path of [tools,cache,python,temporary])await mkdir(path,{mode:0o700})
    const home=await createVoiceTestHome(scope)
    const env={PATH:'/usr/bin:/bin',...home.environment,TMPDIR:temporary,UV_CACHE_DIR:cache,UV_PYTHON_INSTALL_DIR:python,UV_PYTHON_BIN_DIR:join(scope,'bin'),UV_NO_CONFIG:'1',UV_PYTHON_PREFERENCE:'only-managed',UV_PYTHON_DOWNLOADS:'automatic',UV_CONCURRENT_BUILDS:'1',UV_CONCURRENT_DOWNLOADS:'2',UV_CONCURRENT_INSTALLS:'1',PYTHONDONTWRITEBYTECODE:'1'}
    const uvArchive=join(tools,'uv.tar.gz'),uv=join(tools,'uv')
    stage='uv archive download'
    await download('https://releases.astral.sh/github/uv/releases/download/0.12.4/uv-x86_64-unknown-linux-gnu.tar.gz',uvHash,uvArchive)
    stage='uv archive extraction'
    await tool(uvArchive,uv,'uv-x86_64-unknown-linux-gnu/uv')
    stage='uv executable version'
    if((await run(uv,['--version'],{env})).toString().trim()!=='uv 0.12.4 (x86_64-unknown-linux-gnu)')throw invalid()
    stage='Python installation'
    await run(uv,['python','install','3.13.15','--no-bin'],{env,timeout:180000})
    stage='Python lookup'
    const bootstrap=(await run(uv,['python','find','--no-project','3.13.15'],{env})).toString().trim()
    if(!safeAbsolute(bootstrap)||!bootstrap.startsWith(python+'/'))throw invalid()
    const fixture=join(appRoot,'tests/fixtures/voice-source')
    const archive=await readFile(join(fixture,'voice-producer-source.tar.gz')),manifest=JSON.parse(await readFile(join(fixture,'voice-producer-source.manifest.json'),'utf8'))
    stage='source archive verification'
    const verified=await readVoiceSourceFixture(archive,manifest,bootstrap);members=verified.members
    await owned.install(members)
    stage='scanner acquisition'
    await scanVoiceSource(appRoot,producerRoot,tools,env)
    stage='project lock verification'
    await sourceIdentity(producerRoot,members)
    await run(uv,['lock','--check','--python',bootstrap],{cwd:producerRoot,env,timeout:120000})
    await sourceIdentity(producerRoot,members)
    stage='project dependency installation'
    await run(uv,['sync','--all-groups','--frozen','--python',bootstrap],{cwd:producerRoot,env,timeout:300000})
    await sourceIdentity(producerRoot,members)
    descriptor=await resolveVoiceProducer(producerRoot)
    stage='native package and module imports'
    await assertNativeDescriptor(descriptor,home.environment)
    identity=await interpreterIdentity(descriptor.pythonExecutable)
    environment=await environmentIdentity(join(producerRoot,'.venv'))
    const assertIdentity=async()=>{
      await owned.assertIdentity()
      await home.assertIdentity()
      if(JSON.stringify(await resolveVoiceProducer(producerRoot))!==JSON.stringify(descriptor)||await interpreterIdentity(descriptor.pythonExecutable)!==identity||await environmentIdentity(join(producerRoot,'.venv'))!==environment)throw invalid()
    }
    await assertIdentity()
    return {root:producerRoot,descriptor,fixturePython:descriptor.pythonExecutable,testEnvironment:home.environment,assertIdentity,retire}
  }catch(error){
    try{await retire()}catch(cleanup){throw new AggregateError([error,cleanup],'Native Voice preparation and retirement failed')}
    throw new Error('Native Voice preparation failed at '+stage)
  }
}

export async function prepareVoiceSource({appRoot,explicitRoot=process.env.SPARRA_VOICE_TEST_ROOT,scopeParent=tmpdir()}={}){
  if(!safeAbsolute(appRoot)||!samePath(await realpath(appRoot),resolve(appRoot)))throw invalid()
  if(explicitRoot===undefined&&process.platform==='win32')explicitRoot='C:/Users/louis/Documents/ChatGPT/.worktrees/sparra-voice-pilot'
  if(explicitRoot===null)explicitRoot=undefined
  if(explicitRoot!==undefined)return await prepareExternalVoiceSource(explicitRoot,scopeParent)
  if(process.platform!=='linux'||process.arch!=='x64')throw new Error('Native Voice bootstrap requires Linux x64')
  if(!safeAbsolute(scopeParent))throw invalid()
  await directory(scopeParent)
  return await prepareLinuxVoiceSource(appRoot,scopeParent)
}
