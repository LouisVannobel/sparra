import { candidateArguments, requireCheckoutCommit } from './release-cli.mjs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { workerArtifactHashes, verifyWorkerArtifact } from './verify-worker-release.mjs'
try{
  const {directory,commit,imageId,runId}=candidateArguments(process.argv.slice(2))
  await requireCheckoutCommit(commit,{timeout:10000,windowsHide:true})
  const receipt={...await workerArtifactHashes(directory),commit,image_id:imageId,platform:'linux/amd64',run_id:runId,
    checks:{closure:true,registration:true,clean_exit:true,cleanup:true,archive_reload:false}}
  await writeFile(join(directory,'worker-receipt.json'),JSON.stringify(receipt)+'\n',{flag:'wx'})
  await verifyWorkerArtifact(directory,commit,'candidate')
}catch{process.stderr.write('Worker candidate generation failed\n');process.exitCode=1}
