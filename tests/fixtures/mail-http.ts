import { createServer, type Server } from 'node:https'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'

export async function startMailHttpPeer(mailbox?: { appOrigin: string }) {
  const directory = await mkdtemp(join(tmpdir(), 'auth-mail-peer-'))
  const certificate = join(directory, 'cert.pem')
  const privateKey = join(directory, 'key.pem')
  const mailboxPath = '/mailbox/' + randomUUID()
  let pendingLink: string | undefined, pendingRecipient: string | undefined
  let retention: ReturnType<typeof setTimeout> | undefined
  const proofDigests = new Set<string>()
  function forget() { pendingLink = undefined; pendingRecipient = undefined; clearTimeout(retention) }
  let server: Server | undefined, closing: Promise<void> | undefined
  function close() {
    return closing ??= (async () => {
      forget(); proofDigests.clear()
      if (server) {
        server.closeAllConnections()
        if (server.listening) await new Promise<void>(resolve => server!.close(() => resolve()))
      }
      const target = await realpath(directory), parent = await realpath(tmpdir())
      if (dirname(target) !== parent || !basename(target).startsWith('auth-mail-peer-')) throw new Error('Owned TLS cleanup target rejected')
      await rm(target, { recursive: true })
    })()
  }
  try {
  const openssl = process.platform === 'win32' ? join(process.env.ProgramFiles!, 'Git/usr/bin/openssl.exe') : 'openssl'
  await promisify(execFile)(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'), '-out', certificate, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { windowsHide: true })
  let calls = 0, directFragment = false
  server = createServer({ cert: await readFile(certificate), key: await readFile(privateKey) }, async (req, res) => {
    res.setHeader('cache-control', 'no-store'); res.setHeader('referrer-policy', 'no-referrer')
    if (req.method === 'GET' && mailbox && req.url === mailboxPath) {
      if (!pendingLink) { res.writeHead(404); res.end(); return }
      res.writeHead(302, { location: pendingLink }); forget(); res.end(); return
    }
    if (req.method !== 'POST' || req.url !== '/v1/send') { res.writeHead(404); res.end(); return }
    calls++
    const chunks: Buffer[] = []
    try {
      let bytes = 0
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 16384) throw new Error(); chunks.push(chunk) }
      const body = JSON.parse(Buffer.concat(chunks).toString())
      if (typeof body.body !== 'string' || typeof body.to !== 'string') throw new Error()
      // Preserve the original controlled provider behavior for its existing
      // synthetic callers. Redirect validation applies only to mailbox mode.
      directFragment = /https:\/\/app\.example\.test\/auth\/magic\/confirm(?:\?lang=(?:en|fr))?#token=/.test(body.body)
      if (mailbox) {
        const match = /href="([^"]+)"/.exec(body.body)
        if (!match) throw new Error()
        const link = new URL(match[1])
        directFragment = link.origin === mailbox.appOrigin && link.pathname === '/auth/magic/confirm'
          && (link.search === '' || link.search === '?lang=en' || link.search === '?lang=fr') && /^#token=[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(link.hash)
        if (!directFragment) throw new Error()
        if (pendingLink) throw new Error()
        pendingLink = link.href; pendingRecipient = body.to
        proofDigests.add(createHash('sha256').update(link.hash.slice(7)).digest('hex'))
        retention = setTimeout(forget, 60000); retention.unref()
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ success: true, data: { emails: [{ contact: { id: randomUUID(), email: body.to }, email: randomUUID() }], timestamp: new Date().toISOString() } }))
    } catch { res.writeHead(400); res.end('Controlled mail refused') }
    finally { for (const chunk of chunks) chunk.fill(0) }
  })
  await new Promise<void>((resolve, reject) => {
    const failed = () => reject(new Error('Owned TLS listen failed'))
    server!.once('error', failed)
    server!.listen(0, '127.0.0.1', () => { server!.removeListener('error', failed); resolve() })
  })
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Mail peer failed')
  return { origin: `https://127.0.0.1:${address.port}`, certificate, privateKey,
    mailboxUrl: `https://127.0.0.1:${address.port}${mailboxPath}`,
    hasMailFor: (recipient: string) => pendingRecipient === recipient && pendingLink !== undefined,
    // Only one-way digests remain after handoff. Diagnostics never receive proof.
    containsProof: (text: string) => [...text.matchAll(/(?=([A-Za-z0-9_-]{43}))/g)].some(match => proofDigests.has(createHash('sha256').update(match[1]).digest('hex'))),
    evidence: () => ({ calls, directFragment }), close }
  } catch {
    await close()
    throw new Error('Mail peer initialization failed')
  }
}
