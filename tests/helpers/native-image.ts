import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fixtureDockerEndpoint, fixtureDockerEnvironment } from '../fixtures/db/docker-endpoint'
const exec = promisify(execFile)
async function publishedImage(reference:string,args:readonly string[]) {
  const result=await exec('docker',[...args,'image','inspect',reference,'--format','{{.Id}}|{{.Os}}/{{.Architecture}}'],{env:fixtureDockerEnvironment(),windowsHide:true,timeout:120000,maxBuffer:1024*1024})
  const metadata=result.stdout.trim().split('|')
  if(metadata.length!==2||!/^sha256:[0-9a-f]{64}$/.test(metadata[0])||metadata[1]!=='linux/amd64')throw new Error('Pulled image mismatch')
  return metadata[0]
}
export async function nativeImage(target: 'web' | 'migrator') {
  const selected = target === 'migrator' ? process.env.SPARRA_TEST_MIGRATOR_IMAGE_ID : process.env.SPARRA_TEST_WEB_IMAGE_ID
  const reference = target === 'web' ? process.env.SPARRA_TEST_IMAGE_REFERENCE : undefined
  if(reference!==undefined&&selected!==undefined)throw new Error('Ambiguous image authority')
  if(reference!==undefined&&!/^ghcr\.io\/louisvannobel\/sparra-web@sha256:[0-9a-f]{64}$/.test(reference))throw new Error('Immutable published web image required')
  if (selected !== undefined && !/^sha256:[0-9a-f]{64}$/.test(selected)) throw new Error('Immutable test image required')
  const args = fixtureDockerEndpoint(process.platform).args
  if(reference!==undefined)return publishedImage(reference,args)
  if (selected) {
    const result = await exec('docker', [...args, 'image', 'inspect', selected, '--format', '{{.Id}}|{{.Os}}/{{.Architecture}}'], { env: fixtureDockerEnvironment(), windowsHide: true })
    if (result.stdout.trim() !== selected + '|linux/amd64') throw new Error('Loaded image mismatch')
    return selected
  }
  const tag = 'sparra-' + target + ':qualification'
  await exec('docker', [...args, 'build', '--platform', 'linux/amd64', '--target', target, '--tag', tag, '.'], { env: { ...fixtureDockerEnvironment(), ...(process.platform === 'win32' ? { ProgramFiles: process.env.ProgramFiles } : {}) }, windowsHide: true, timeout: 600000, maxBuffer: 8 * 1024 * 1024 })
  const id = (await exec('docker', [...args, 'image', 'inspect', tag, '--format', '{{.Id}}'], { env: fixtureDockerEnvironment(), windowsHide: true })).stdout.trim()
  if (!/^sha256:[0-9a-f]{64}$/.test(id)) throw new Error('Immutable image ID missing')
  console.log('NATIVE_IMAGE_ID ' + target + ' ' + id)
  return id
}
