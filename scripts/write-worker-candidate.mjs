import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { workerArtifactHashes, verifyWorkerArtifact } from './verify-worker-release.mjs'
try{
  const args=process.argv.slice(2)
  if(args.length!==8||args[0]!=='--directory'||args[2]!=='--commit'||args[4]!=='--image-id'||args[6]!=='--run-id')throw Error()
  const directory=resolve(args[1]),commit=args[3],imageId=args[5],runId=args[7]
  if(!/^[0-9a-f]{40}$/.test(commit)||!/^sha256:[0-9a-f]{64}$/.test(imageId)||!runId||runId.trim()!==runId||runId.length>256)throw Error()
  if((await promisify(execFile)('git',['rev-parse','HEAD'],{timeout:10000,windowsHide:true})).stdout.trim()!==commit)throw Error()
  const receipt={...await workerArtifactHashes(directory),commit,image_id:imageId,platform:'linux/amd64',run_id:runId,
    checks:{closure:true,registration:true,clean_exit:true,cleanup:true,archive_reload:false}}
  await writeFile(join(directory,'worker-receipt.json'),JSON.stringify(receipt)+'\n',{flag:'wx'})
  await verifyWorkerArtifact(directory,commit,'candidate')
}catch{process.stderr.write('Worker candidate generation failed\n');process.exitCode=1}
