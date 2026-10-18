import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'

export function candidateArguments(args) {
  if(args.length!==8||args[0]!=='--directory'||args[2]!=='--commit'||args[4]!=='--image-id'||args[6]!=='--run-id')throw Error()
  const directory=resolve(args[1]),commit=args[3],imageId=args[5],runId=args[7]
  if(!/^[0-9a-f]{40}$/.test(commit)||!/^sha256:[0-9a-f]{64}$/.test(imageId)||!runId||runId.trim()!==runId||runId.length>256)throw Error()
  return {directory,commit,imageId,runId}
}

export async function requireCheckoutCommit(commit,options) {
  if((await promisify(execFile)('git',['rev-parse','HEAD'],options)).stdout.trim()!==commit)throw Error()
}

function releaseArguments(args) {
  if(args.length!==4||args[0]!=='--directory'||args[2]!=='--commit')throw Error()
  return {directory:args[1],commit:args[3]}
}

export async function runReleaseVerification(verify,successMessage,failureMessage) {
  try{
    const {directory,commit}=releaseArguments(process.argv.slice(2))
    await verify(directory,commit)
    process.stdout.write(successMessage)
  }catch{process.stderr.write(failureMessage);process.exitCode=1}
}
