import { createServer, createConnection, type Socket } from 'node:net'

export type CommitCut = 'observe' | 'before-write' | 'after-write' | 'before-command-complete' | 'after-command-complete' | 'delay-error-ready'

// PostgreSQL wire relay over only a newly owned loopback target. Records no
// SQL values/password messages; it cuts specific actual COMMIT proof edges.
export async function pgRelay(targetUrl: string, mode: CommitCut = 'observe', armOnSessionInsert = false) {
  const target = new URL(targetUrl)
  if (target.hostname !== '127.0.0.1') throw new Error('Relay target must be owned loopback')
  const targetPort = Number(target.port)
  if (!Number.isSafeInteger(targetPort) || targetPort < 1 || targetPort > 65535) throw new Error('Invalid owned relay target port')
  const sockets = new Set<Socket>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const controls: string[] = [], preparedNames: string[] = []
  const held: (() => void)[] = []
  let errorResponses = 0, commitCompletions = 0, sessionInserts = 0
  let listenPort = 0, accepted = 0, rejected = false
  const server = createServer(downstream => {
    // These cases need at most the test pool's four clients. Refuse a self-loop
    // or unexpected fan-out before creating any upstream socket.
    if (!listenPort || targetPort === listenPort || ++accepted > 4) { rejected = true; downstream.destroy(); return }
    const upstream = createConnection({ host: '127.0.0.1', port: targetPort })
    for (const socket of [downstream, upstream]) {
      sockets.add(socket)
      socket.on('error', () => {})
      socket.on('close', () => { sockets.delete(socket); downstream.destroy(); upstream.destroy() })
    }
    let startup = true, errorSeen = false, cutting = false
    let armed = !armOnSessionInsert
    let input = Buffer.alloc(0), output = Buffer.alloc(0)
    const cut = () => { downstream.destroy(); upstream.destroy() }
    downstream.on('data', data => {
      input = Buffer.concat([input, typeof data === 'string' ? Buffer.from(data) : data])
      while (input.length) {
        if (input.length < (startup ? 4 : 5)) return
        const length = startup ? input.readInt32BE(0) : 1 + input.readInt32BE(1)
        if (input.length < length) return
        const frame = input.subarray(0, length); input = input.subarray(length)
        if (startup) { startup = false; upstream.write(frame); continue }
        const type = String.fromCharCode(frame[0])
        if (type === 'P') {
          preparedNames.push(frame.subarray(5, frame.indexOf(0, 5)).toString())
          if (frame.subarray(5).toString().split('\0')[1]?.startsWith('insert into "session"')) { sessionInserts++; if (armOnSessionInsert) armed = true }
        }
        if (type === 'Q') {
          const text = frame.subarray(5, -1).toString()
          const command = text.split(' ')[0]
          if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(command)) controls.push(command)
          if (text === 'COMMIT' && armed) {
            if (mode === 'before-write') { cut(); return }
            if (mode === 'after-write') { upstream.write(frame, cut); return }
          }
        }
        upstream.write(frame)
      }
    })
    upstream.on('data', data => {
      output = Buffer.concat([output, typeof data === 'string' ? Buffer.from(data) : data])
      while (output.length >= 5) {
        const length = 1 + output.readInt32BE(1)
        if (output.length < length) return
        const frame = output.subarray(0, length); output = output.subarray(length)
        const type = String.fromCharCode(frame[0])
        if (type === 'E') { errorSeen = true; errorResponses++ }
        if (type === 'C' && frame.subarray(5, -1).toString() === 'COMMIT') {
          commitCompletions++
          if (mode === 'before-command-complete' && armed) { cut(); return }
          if (mode === 'after-command-complete' && armed) {
            cutting = true
            downstream.write(frame, () => { const timer = setTimeout(() => { timers.delete(timer); cut() }, 20); timers.add(timer) })
            continue
          }
        }
        if (cutting) continue
        if (type === 'Z' && errorSeen && mode === 'delay-error-ready') { errorSeen = false; held.push(() => downstream.write(frame)); continue }
        downstream.write(frame)
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing relay port')
  listenPort = address.port
  if (listenPort === targetPort) {
    await new Promise<void>(resolve => server.close(() => resolve()))
    throw new Error('Refusing relay self-connection')
  }
  target.port = String(address.port)
  return {
    url: target.href, controls, preparedNames,
    errorResponses: () => errorResponses, commitCompletions: () => commitCompletions, sessionInserts: () => sessionInserts,
    releaseReady() { for (const send of held.splice(0)) send() },
    async close() {
      for (const timer of timers) clearTimeout(timer)
      const closed = [...sockets].map(socket => new Promise<void>(resolve => socket.once('close', () => resolve())))
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await Promise.all(closed)
      if (sockets.size || rejected) throw new Error('Unexpected relay socket lifecycle')
    },
  }
}
