import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'

const names = new Set(['app_database_url', 'app_redis_url', 'app_rate_limit_hmac_secret', 'app_auth_secret', 'app_google_client_id', 'app_google_client_secret', 'migration_database_url'])
const same = (a, b) => ['ino', 'dev', 'size', 'mtimeMs', 'ctimeMs', 'mode', 'uid', 'gid'].every(key => a[key] === b[key])
const refuse = () => { throw new Error('Credential unavailable') }
function admitDirectory(stat) {
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 10001 || (stat.mode & 0o7777) !== 0o750) refuse()
}
function admitFile(stat) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 10001 || (stat.mode & 0o7777) !== 0o440 || stat.size < 1 || stat.size > 16384) refuse()
}

/** Shared only by the two fixed native credential scopes; no path override. */
export async function readFixedCredentialFile(name) {
  if (!names.has(name)) refuse()
  const parent = '/run/secrets', path = `${parent}/${name}`
  let descriptor
  const buffer = Buffer.alloc(16385)
  try {
    const directory = await lstat(parent)
    admitDirectory(directory)
    if (await realpath(parent) !== parent || await realpath(path) !== path) refuse()
    const before = await lstat(path)
    admitFile(before)
    descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const opened = await descriptor.stat()
    admitFile(opened)
    if (!same(before, opened)) refuse()
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await descriptor.read(buffer, length, buffer.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    const after = await lstat(path), final = await descriptor.stat(), finalDirectory = await lstat(parent)
    admitFile(after); admitFile(final); admitDirectory(finalDirectory)
    if (length !== before.size || length > 16384 || !same(before, after) || !same(before, final) || !same(directory, finalDirectory)
      || await realpath(parent) !== parent || await realpath(path) !== path) refuse()
    const value = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))
    if (!value || value.trim() !== value || /[\r\n\0]/.test(value)) refuse()
    return value
  } catch { refuse() } finally { buffer.fill(0); await descriptor?.close().catch(() => {}) }
}
