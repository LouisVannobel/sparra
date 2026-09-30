import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const startRequire = createRequire(import.meta.resolve('@tanstack/react-start'))
const nativeRequire = createRequire(startRequire.resolve('@tanstack/start-client-core/package.json'))
const { toJSONAsync, toCrossJSONAsync }: { toJSONAsync(value: unknown): Promise<unknown>; toCrossJSONAsync(value: unknown): Promise<unknown> } = nativeRequire('seroval')
export async function rpcBody(data: unknown) { return JSON.stringify(await toJSONAsync({ data })) }
// Match Start's middleware response envelope and native output serializer;
// plain success DTO JSON would be lost at createServerFn's result.result read.
export async function rpcResult(result: unknown) {
  return { status: 200, headers: { 'content-type': 'application/json', 'x-tss-serialized': 'true' }, body: JSON.stringify(await toCrossJSONAsync({ result, context: {} })) }
}
export async function authRpcPath(name: 'beginSessionList' | 'finishSessionList' | 'beginSessionRevocation' | 'finishSessionRevocation' | 'beginGoogleAccountLink' | 'authorizeGoogleAccountLink' | 'beginGoogleAccountUnlink' | 'finishGoogleAccountUnlink' | 'readGoogleAccountIntent' | 'cancelGoogleAccountIntent' | 'beginGoogleSignIn' | 'beginPasskeySignIn' | 'finishPasskeySignIn' | 'beginAdditionalPasskey' | 'authorizeAdditionalPasskey' | 'finishAdditionalPasskey' | 'beginFirstGooglePasskey' | 'readFirstGooglePasskey' | 'prepareFirstGooglePasskey' | 'finishFirstGooglePasskey' | 'cancelFirstGooglePasskey' | 'requestMagicLink' | 'logout' | 'getAccount' | 'getLoginAvailability' | 'getWorkspace' | 'ensurePersonalWorkspace' | 'renameWorkspace') {
  const directory = resolve('.output/server/_ssr')
  for (const file of await readdir(directory)) {
    if (!file.startsWith('auth.functions-') && !file.startsWith('workspace.functions-')) continue
    const source = await readFile(resolve(directory, file), 'utf8')
    const match = new RegExp(`id: "([a-f0-9]{64})",\\s+name: "${name}"`).exec(source)
    if (match) return '/_serverFn/' + match[1]
  }
  throw new Error('Built application auth function missing')
}
