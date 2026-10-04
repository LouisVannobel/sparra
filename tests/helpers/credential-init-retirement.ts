import type { ChildProcess } from 'node:child_process'
import { realpath,rm } from 'node:fs/promises'
import { basename,dirname } from 'node:path'
import { tmpdir } from 'node:os'
export async function awaitCredentialInit(child:ChildProcess,retire:()=>Promise<void>,timeoutMs:number,closeBudgetMs=3000) {
  let terminal=false
  const closed=new Promise<number|null>(accept=>{child.once('error',()=>{});child.once('close',code=>{terminal=true;accept(code)})})
  const budget=async(ms:number)=>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([closed,new Promise<'timeout'>(accept=>{timer=setTimeout(()=>accept('timeout'),ms)})])}finally{clearTimeout(timer)}}
  const first=await budget(timeoutMs)
  if(first==='timeout')child.kill('SIGTERM')
  let retirementFailure=false
  try{await retire()}catch{retirementFailure=true}
  if(!terminal&&await budget(closeBudgetMs)==='timeout'){child.kill('SIGKILL');await budget(closeBudgetMs)}
  if(!terminal)throw Error('Credential init retirement unresolved')
  if(retirementFailure)throw Error('Credential init container retirement failed')
  if(first==='timeout')throw Error('Credential init timeout')
  if(first!==0)throw Error('Credential init failed')
}
export async function retireFixtureDirectory(directory:string,prefix:string,consumersRetired:boolean) {
  if(!consumersRetired)return false
  const target=await realpath(directory),parent=await realpath(tmpdir())
  if(dirname(target)!==parent||basename(target)!==basename(directory)||!basename(target).startsWith(prefix))throw Error('Refusing non-owned temporary path')
  await rm(target,{recursive:true});return true
}
