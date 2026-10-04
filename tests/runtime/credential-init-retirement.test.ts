import { expect,test } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp,access,rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { awaitCredentialInit,retireFixtureDirectory } from '../helpers/credential-init-retirement'
test('timeout_does_not_settle_before_actual_child_terminal_close',async()=>{
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'pipe'})
  let closed=false;child.once('close',()=>{closed=true})
  await expect(awaitCredentialInit(child,async()=>{},30,2000)).rejects.toThrow('Credential init timeout')
  expect(closed).toBe(true)
})
test('unresolved_consumer_retirement_retains_actual_owned_directory',async()=>{
  const prefix='template-auth-retirement-',directory=await mkdtemp(join(tmpdir(),prefix))
  try{
    expect(await retireFixtureDirectory(directory,prefix,false)).toBe(false)
    await expect(access(directory)).resolves.toBeUndefined()
    expect(await retireFixtureDirectory(directory,prefix,true)).toBe(true)
    await expect(access(directory)).rejects.toThrow()
  }finally{await rm(directory,{recursive:true,force:true})}
})
