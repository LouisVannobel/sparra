import { afterEach, expect, test, vi } from 'vitest'
import { access, readFile, realpath, rm } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { request } from 'node:https'
import { Server } from 'node:net'

const fault = vi.hoisted(() => ({ exec: false, directory: '' }))
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFile: (...args: unknown[]) => {
    const commandArgs = args[1]
    if (Array.isArray(commandArgs)) {
      const key = commandArgs[commandArgs.indexOf('-keyout') + 1]
      if (typeof key === 'string') fault.directory = key.slice(0, Math.max(key.lastIndexOf('/'), key.lastIndexOf('\\')))
    }
    if (fault.exec) {
      const callback = args.at(-1)
      if (typeof callback !== 'function') throw new Error('Fixture callback unavailable')
      queueMicrotask(() => callback(new Error('Controlled OpenSSL failure')))
      return undefined
    }
    return Reflect.apply(actual.execFile, null, args)
  } }
})
import { startMailHttpPeer } from '../fixtures/mail-http'

afterEach(async () => {
  fault.exec = false
  if (!fault.directory) return
  try {
    const target = await realpath(fault.directory), parent = await realpath(tmpdir())
    if (dirname(target) !== parent || !basename(target).startsWith('auth-mail-peer-')) throw new Error('Refusing unrelated TLS cleanup')
    await rm(target, { recursive: true })
  } catch (error) { if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error }
  fault.directory = ''
})
test('TLS peer acquisition removes its owned directory when OpenSSL fails', async () => {
  fault.exec = true
  expect(await startMailHttpPeer().then(() => false, () => true)).toBe(true)
  expect(await access(fault.directory).then(() => false, () => true)).toBe(true)
})
test('TLS peer acquisition closes and removes owned material when listen fails', async () => {
  const listen = vi.spyOn(Server.prototype, 'listen').mockImplementation(function (this: Server) {
    queueMicrotask(() => this.emit('error', new Error('Controlled listen failure')))
    return this
  })
  try {
    expect(await startMailHttpPeer().then(() => false, () => true)).toBe(true)
    expect(await access(fault.directory).then(() => false, () => true)).toBe(true)
  } finally { listen.mockRestore() }
})
test('TLS peer still serves the existing controlled protocol and removes its owned materials on close', async () => {
  const peer = await startMailHttpPeer()
  const directory = dirname(peer.certificate)
  try {
    const ca = await readFile(peer.certificate)
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(peer.origin + '/v1/send', { method: 'POST', ca, agent: false }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)) })
      req.once('error', reject)
      req.end(JSON.stringify({ to: 'fixture@example.test', body: 'https://app.example.test/auth/magic/confirm#token=synthetic' }))
    })
    expect(status).toBe(200)
    expect(peer.evidence()).toEqual({ calls: 1, directFragment: true })
  } finally { await peer.close() }
  expect(await access(directory).then(() => false, () => true)).toBe(true)
})

test('mailbox diagnostic detects an encoded delimiter adjacent to the proof without treating framework hashes as proof', async () => {
  const peer = await startMailHttpPeer({ appOrigin: 'https://app.example.test' })
  try {
    const ca = await readFile(peer.certificate)
    // Fixed synthetic input only; no production token enters test diagnostics.
    const proof = 'A'.repeat(43)
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(peer.origin + '/v1/send', { method: 'POST', ca, agent: false }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)) })
      req.once('error', () => reject(new Error('Controlled mailbox POST failed')))
      req.end(JSON.stringify({ to: 'fixture@example.test', body: `<a href="https://app.example.test/auth/magic/confirm?lang=en#token=${proof}">Sign in</a>` }))
    })
    expect(status).toBe(200)
    expect({ bare: peer.containsProof(proof), encoded: peer.containsProof('%3D' + proof), prefixed: peer.containsProof('x' + proof),
      unrelated: peer.containsProof('B'.repeat(43)) }).toEqual({ bare: true, encoded: true, prefixed: true, unrelated: false })
  } finally { await peer.close() }
})
