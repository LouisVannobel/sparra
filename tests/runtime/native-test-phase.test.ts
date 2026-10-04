import { expect,test } from 'vitest'
import { mkdtemp,readFile,rm,stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

async function absent(pid:number){
  const until=Date.now()+3000
  while(Date.now()<until){
    try{process.kill(pid,0)}catch(error){return error instanceof Error&&'code'in error&&error.code==='ESRCH'}
    await new Promise(resolve=>setTimeout(resolve,20))
  }
  return false
}

test('owned native phase timeout stops its live descendant and reports unknown test cleanup',async()=>{
  const module:unknown=await import('../../scripts/native-test-phase.mjs').catch(()=>({}))
  if(typeof module!=='object'||module===null||!('runNativePhase'in module)||typeof module.runNativePhase!=='function')throw new Error('Missing owned native phase')
  const owner=await mkdtemp(join(tmpdir(),'sparra-phase-test-'))
  try{
    const marker=join(owner,'alive.txt')
    const script=`const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const child=spawn(process.execPath,['-e',"setInterval(()=>require('node:fs').writeFileSync(process.argv[1],String(Date.now())),20);setTimeout(()=>process.exit(0),6000)",process.argv[1]],{stdio:'ignore'});writeFileSync(process.argv[2],String(child.pid));setInterval(()=>{},1000);setTimeout(()=>process.exit(0),6000);`
    const result=await module.runNativePhase(process.execPath,['-e',script,marker,join(owner,'pid.txt')],{cwd:owner,env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP},timeout:1500})
    expect(result.timedOut).toBe(true)
    const pid=Number(await readFile(join(owner,'pid.txt'),'utf8'))
    const gone=await absent(pid)
    expect(result.cleanExit,'descendant '+pid+' absent='+gone).toBe(false)
    await expect(readFile(marker,'utf8')).resolves.toMatch(/^\d+$/)
    const before=(await stat(marker)).mtimeMs
    await new Promise(resolve=>setTimeout(resolve,150))
    expect((await stat(marker)).mtimeMs).toBe(before)
    expect(gone).toBe(true)
  }finally{await rm(owner,{recursive:true,force:true})}
},10000)

test.runIf(process.platform==='linux').each([0,1])('Linux native phase refuses a leader exit %s while its descendant remains alive',async code=>{
  const {runNativePhase}=await import('../../scripts/native-test-phase.mjs')
  const owner=await mkdtemp(join(tmpdir(),'sparra-early-phase-'))
  try{
    const script=`const {spawn}=require('node:child_process');const fs=require('node:fs');spawn(process.execPath,['-e',"require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);setTimeout(()=>process.exit(0),4000)",process.argv[1]],{stdio:'ignore'});const wait=setInterval(()=>{if(fs.existsSync(process.argv[1])){clearInterval(wait);process.exit(${code})}},10);setTimeout(()=>process.exit(2),5000);`
    const result=await runNativePhase(process.execPath,['-e',script,join(owner,'pid.txt')],{cwd:owner,env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP},timeout:7000})
    const pid=Number(await readFile(join(owner,'pid.txt'),'utf8'))
    const gone=await absent(pid)
    expect(result.timedOut).toBe(false);expect(result.status).toBe(code)
    expect(result.cleanExit,'descendant '+pid+' absent='+gone).toBe(false)
    expect(gone).toBe(true)
  }finally{await rm(owner,{recursive:true,force:true})}
},10000)

test.runIf(process.platform==='linux')('nested phase canaries remain bounded when their enclosing timer owner stops',async()=>{
  const {runNativePhase}=await import('../../scripts/native-test-phase.mjs')
  const owner=await mkdtemp(join(tmpdir(),'sparra-nested-phase-'))
  try{
    const nested=`require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},20);setTimeout(()=>process.exit(0),3500)`
    const script=`import{runNativePhase}from ${JSON.stringify(pathToFileURL(join(process.cwd(),'scripts/native-test-phase.mjs')).href)};setTimeout(()=>process.exit(0),4500);await runNativePhase(process.execPath,['-e',${JSON.stringify(nested)},process.argv[1]],{cwd:process.cwd(),env:process.env,timeout:30000});`
    const result=await runNativePhase(process.execPath,['--input-type=module','-e',script,join(owner,'pid.txt')],{cwd:owner,env:{PATH:process.env.PATH},timeout:1500})
    expect(result.timedOut).toBe(true);expect(result.cleanExit).toBe(false)
    const pid=Number(await readFile(join(owner,'pid.txt'),'utf8'))
    expect(await absent(pid)).toBe(true)
  }finally{await rm(owner,{recursive:true,force:true})}
},10000)
