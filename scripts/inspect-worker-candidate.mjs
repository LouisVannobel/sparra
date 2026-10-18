import { writeFile } from 'node:fs/promises'
import { verifyWorkerArtifact } from './verify-worker-release.mjs'
try{
  const args=process.argv.slice(2)
  if(args.length!==6||args[0]!=='--directory'||args[2]!=='--commit'||args[4]!=='--output')throw Error()
  const receipt=await verifyWorkerArtifact(args[1],args[3],'candidate')
  await writeFile(args[5],receipt.image_id+'\n',{flag:'wx'})
}catch{process.stderr.write('Worker candidate inspection failed\n');process.exitCode=1}
