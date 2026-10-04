import { writeFile } from 'node:fs/promises'
import { verifyMigratorArtifact } from './verify-migrator-release.mjs'
try{
  const args=process.argv.slice(2)
  if(args.length!==6||args[0]!=='--directory'||args[2]!=='--commit'||args[4]!=='--output')throw Error()
  const receipt=await verifyMigratorArtifact(args[1],args[3],'candidate')
  await writeFile(args[5],receipt.image_id+'\n',{flag:'wx'})
}catch{process.stderr.write('Migrator candidate inspection failed\n');process.exitCode=1}
