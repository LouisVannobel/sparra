import { candidateArguments, requireCheckoutCommit } from './release-cli.mjs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { migratorArtifactHashes,verifyMigratorArtifact } from './verify-migrator-release.mjs'
try{
  const {directory,commit,imageId,runId}=candidateArguments(process.argv.slice(2))
  await requireCheckoutCommit(commit,{timeout:10000})
  const receipt={schema_version:1,commit,...await migratorArtifactHashes(directory),image_id:imageId,platform:'linux/amd64',run_id:runId,
    checks:{credential_ordering:true,closure:true,journal:true,unknown_commit:true,no_leakage:true,clean_exit:true,cleanup:true,archive_reload:false}}
  await writeFile(join(directory,'migrator-receipt.json'),JSON.stringify(receipt)+'\n')
  await verifyMigratorArtifact(directory,commit,'candidate')
}catch{process.stderr.write('Migrator candidate generation failed\n');process.exitCode=1}
