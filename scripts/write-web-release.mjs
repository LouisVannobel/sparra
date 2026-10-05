import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { webSourceManifest } from './web-source-manifest.mjs'
import { webImageIdentity } from './web-image-identity.mjs'
import { bindWebSbom } from './web-sbom-binding.mjs'
const exec=promisify(execFile),label='sparra.web-release',run=randomUUID()
const docker=async args=>(await exec('docker',['--host','unix:///var/run/docker.sock',...args],{env:{PATH:process.env.PATH},timeout:120000,maxBuffer:1048576})).stdout.trim()
let container
try {
  const args=process.argv.slice(2)
  if(args.length!==12||args[0]!=='--directory'||args[2]!=='--commit'||args[4]!=='--image'||args[6]!=='--run-id'||args[8]!=='--root-index'||args[10]!=='--platform-manifest')throw Error()
  const directory=resolve(args[1]),commit=args[3],reference=args[5],runId=args[7]
  if(!/^ghcr\.io\/louisvannobel\/sparra-web@sha256:[0-9a-f]{64}$/.test(reference)||!/^[0-9a-f]{40}$/.test(commit)||!runId||runId.trim()!==runId||runId.length>256)throw Error()
  if((await exec('git',['rev-parse','HEAD'],{timeout:10000})).stdout.trim()!==commit)throw Error()
  const local=JSON.parse(await docker(['image','inspect',reference,'--format','{"Id":{{json .Id}},"Os":{{json .Os}},"Architecture":{{json .Architecture}},"Config":{"Labels":{{json .Config.Labels}}},"RootFS":{"Layers":{{json .RootFS.Layers}}}}']))
  const identity=webImageIdentity(await readFile(args[9]),await readFile(args[11]),local,reference,commit)
  const sbom=await readFile(join(directory,'sbom.spdx.json'))
  if(sbom.length>67108864)throw Error()
  bindWebSbom(JSON.parse(sbom.toString('utf8')),identity.config_digest,identity.diff_ids,reference.split('@')[1])
  const wanted=await webSourceManifest()
  container=await docker(['create','--name','sparra-web-source-'+run,'--label',label+'='+run,'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--entrypoint','node',reference,'-e',"process.stdout.write(require('node:fs').readFileSync('/app/web-source-manifest.json','utf8'))"])
  if(!/^[0-9a-f]{64}$/.test(container))throw Error()
  const owned=async()=>{if(await docker(['inspect',container,'--format','{{index .Config.Labels "'+label+'"}}'])!==run)throw Error()}
  await owned()
  const packaged=JSON.parse(await docker(['start','--attach',container]))
  if(JSON.stringify(packaged)!==JSON.stringify(wanted))throw Error()
  await owned();await docker(['rm',container]);container=undefined
  const source={...wanted,commit}
  const qualification={...source,image_reference:reference,platform:'linux/amd64',...identity,sbom_sha256:createHash('sha256').update(sbom).digest('hex'),run_id:runId,checks:{startup:true,ingress:true,preload:true,closure:true,cleanup:true}}
  await writeFile(join(directory,'source.json'),JSON.stringify(source)+'\n')
  await writeFile(join(directory,'image-reference.txt'),reference+'\n')
  await writeFile(join(directory,'native-image-qualification.json'),JSON.stringify(qualification)+'\n')
}catch{process.stderr.write('Web release receipt generation failed\n');process.exitCode=1}
finally{
  if(container){try{if(await docker(['inspect',container,'--format','{{index .Config.Labels "'+label+'"}}'])!==run)throw Error();await docker(['rm','--force',container])}catch{process.stderr.write('Web release cleanup failed\n');process.exitCode=1}}
}
