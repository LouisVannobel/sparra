import { spawn,spawnSync } from 'node:child_process'
import { join } from 'node:path'

// A failed phase cannot certify its afterAll resource cleanup. The caller keeps
// its prepared producer until cleanup is independently established.
export async function runNativePhase(executable,args,{cwd,env,timeout}){
  return await new Promise(resolve=>{
    const child=spawn(executable,args,{cwd,env,stdio:'inherit',windowsHide:true,detached:process.platform==='linux'})
    let timedOut=false,failed=false,timer
    const terminate=()=>{
      timedOut=true
      if(child.exitCode!==null||child.signalCode!==null)return
      if(process.platform==='linux'){
        try{process.kill(-child.pid,'SIGKILL')}catch(error){if(error.code!=='ESRCH')failed=true}
      }else if(process.platform==='win32'&&env.SystemRoot){
        // libuv retains the owned process handle while this child is live.
        const killed=spawnSync(join(env.SystemRoot,'System32/taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{env,stdio:'ignore',windowsHide:true,timeout:5000})
        if(killed.error||killed.status!==0){failed=true;child.kill()}
      }else{failed=true;child.kill('SIGKILL')}
    }
    child.on('spawn',()=>{timer=setTimeout(terminate,timeout)})
    child.on('error',()=>{failed=true})
    child.on('close',(code,signal)=>{
      clearTimeout(timer)
      if(process.platform==='linux'&&child.pid){
        try{
          process.kill(-child.pid,0)
          failed=true
          // The exclusively created group still has a member after its leader
          // exited. Its resource cleanup cannot be certified as a clean exit.
          try{process.kill(-child.pid,'SIGKILL')}catch{}
        }catch(error){if(error.code!=='ESRCH')failed=true}
      }else if(process.platform==='win32'&&child.pid&&env.SystemRoot){
        const script='$ErrorActionPreference="Stop";$members=Get-CimInstance Win32_Process -Filter "ParentProcessId = '+child.pid+'";if($members){exit 11}'
        const observed=spawnSync(join(env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',script],{env,stdio:'ignore',windowsHide:true,timeout:5000})
        // A departed leader gives no safe live tree handle. Preserve uncertainty
        // instead of stopping a PID whose incarnation could have changed.
        if(observed.error||observed.status!==0)failed=true
      }
      resolve({cleanExit:!failed&&!timedOut&&code===0&&!signal,timedOut,signal,status:code})
    })
  })
}
