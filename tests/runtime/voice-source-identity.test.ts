import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test } from 'vitest'
import { environmentIdentity } from '../../scripts/prepare-voice-source.mjs'

const scenario='tests/integration/sparra_connected_scenario.py'

async function fixture(){
  return await mkdtemp(join(tmpdir(),'sparra-source-identity-'))
}

async function file(root:string,path:string,value='frozen'){
  const destination=join(root,path)
  await mkdir(dirname(destination),{recursive:true})
  await writeFile(destination,value)
}

test('importing Voice preparation from a foreign root does not start a preparation',async()=>{
  const root=await fixture()
  try{
    const module=new URL('../../scripts/prepare-voice-source.mjs',import.meta.url).href
    const result=spawnSync(process.execPath,['--max-old-space-size=512','--input-type=module','-e',
      'globalThis.fetch=()=>{throw new Error("Import initiated a download")}; await import(process.argv[1]);',module],
      {cwd:root,timeout:5000,maxBuffer:8192,encoding:'utf8',windowsHide:true})
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
    expect(await readdir(root)).toEqual([])
  }finally{await rm(root,{recursive:true,force:true})}
})

test.each(['tests','tests/integration',scenario])('source identity includes the exact native scenario path %s',async path=>{
  const root=await fixture()
  try{
    const before=await environmentIdentity(root,true)
    if(path===scenario)await file(root,path)
    else await mkdir(join(root,path),{recursive:true})
    expect(await environmentIdentity(root,true)).not.toBe(before)
    if(path===scenario){
      const frozen=await environmentIdentity(root,true)
      await file(root,path,'changed')
      expect(await environmentIdentity(root,true)).not.toBe(frozen)
    }
  }finally{await rm(root,{recursive:true,force:true})}
})

test.each(['.python-version','pyproject.toml','uv.lock','README.md','src/nested/module.py','scripts/check.py','agents/agent.json','deployment-profiles/profile.json','src/tests/integration/scenario.py'])('source identity continues to bind producer input %s',async path=>{
  const root=await fixture()
  try{
    await file(root,path)
    const before=await environmentIdentity(root,true)
    await file(root,path,'changed')
    expect(await environmentIdentity(root,true)).not.toBe(before)
  }finally{await rm(root,{recursive:true,force:true})}
})

test.each(['tests/unit.py','tests/integration/other.py','tests/integration/sparra_connected_scenario.py.bak','tests/integration/Sparra_connected_scenario.py','tests/integration-extra/sparra_connected_scenario.py','tests-extra/integration/sparra_connected_scenario.py','.venv/package.py','src/__pycache__/module.py','src/nested/__pycache__/module.py'])('source identity excludes the unrelated path %s',async path=>{
  const root=await fixture()
  try{
    await mkdir(join(root,'tests/integration'),{recursive:true})
    await mkdir(join(root,'src/nested'),{recursive:true})
    const before=await environmentIdentity(root,true)
    await file(root,path)
    expect(await environmentIdentity(root,true)).toBe(before)
    await file(root,path,'changed')
    expect(await environmentIdentity(root,true)).toBe(before)
  }finally{await rm(root,{recursive:true,force:true})}
})

test.each(['tests','tests/integration',scenario,'src/linked'])('source identity refuses a selected symbolic link at %s without following it',async path=>{
  const parent=await fixture(),root=join(parent,'source'),outside=join(parent,'outside')
  try{
    await mkdir(root);await mkdir(outside);await file(outside,'owner.txt','external')
    await mkdir(dirname(join(root,path)),{recursive:true})
    await symlink(outside,join(root,path),process.platform==='win32'?'junction':'dir')
    await expect(environmentIdentity(root,true)).rejects.toThrow('Native Voice preparation failed')
    expect(await readFile(join(outside,'owner.txt'),'utf8')).toBe('external')
  }finally{await rm(parent,{recursive:true,force:true})}
})

test('source identity ignores an unrelated test link and environment identity binds its target path without following it',async()=>{
  const parent=await fixture(),root=join(parent,'source'),outside=join(parent,'outside'),replacement=join(parent,'replacement')
  try{
    await mkdir(root);await mkdir(outside);await mkdir(replacement);await file(root,scenario);await file(outside,'owner.txt','external')
    const source=await environmentIdentity(root,true),link=join(root,'tests/integration/other')
    await symlink(outside,link,process.platform==='win32'?'junction':'dir')
    expect(await environmentIdentity(root,true)).toBe(source)
    const environment=await environmentIdentity(root)
    await file(outside,'owner.txt','changed external')
    expect(await environmentIdentity(root)).toBe(environment)
    await rm(link);await symlink(replacement,link,process.platform==='win32'?'junction':'dir')
    expect(await environmentIdentity(root)).not.toBe(environment)
    expect(await environmentIdentity(root,true)).toBe(source)
  }finally{await rm(parent,{recursive:true,force:true})}
})

test('full environment identity binds files omitted from source identity',async()=>{
  const root=await fixture()
  try{
    await file(root,'.venv/package.py')
    const source=await environmentIdentity(root,true),environment=await environmentIdentity(root)
    await file(root,'.venv/package.py','changed')
    expect(await environmentIdentity(root,true)).toBe(source)
    expect(await environmentIdentity(root)).not.toBe(environment)
  }finally{await rm(root,{recursive:true,force:true})}
})

test('source identity orders names deterministically and distinguishes a file from a directory',async()=>{
  const parent=await fixture(),left=join(parent,'left'),right=join(parent,'right')
  try{
    await mkdir(left);await mkdir(right)
    await file(left,'src/z.py');await file(left,'src/a.py')
    await file(right,'src/a.py');await file(right,'src/z.py')
    expect(await environmentIdentity(left,true)).toBe(await environmentIdentity(right,true))
    const before=await environmentIdentity(right,true)
    await rm(join(right,'src/z.py'));await mkdir(join(right,'src/z.py'))
    expect(await environmentIdentity(right,true)).not.toBe(before)
  }finally{await rm(parent,{recursive:true,force:true})}
})
