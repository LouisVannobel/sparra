import { expect, test } from 'vitest'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const helper = await import('../helpers/mail-process.mjs')

test('cleanup observer preserves init and dispose receivers arguments return values and original rejected promise', async () => {
  expect(typeof helper.installMailCleanupObserver).toBe('function')
  const failure = new AggregateError([Object.assign(new Error('private-native-sentinel'), {
    path: '/Dispatcher/Unsubscribe', code: 14, config: { Authorization: 'private-native-sentinel' },
  })], 'Owned worker cleanup failed')
  let reject!: (error: unknown) => void
  const originalPromise = new Promise<void>((_, failed) => { reject = failed })
  const calls: unknown[][] = [], observations: unknown[] = []
  const client = { dispose(...args: unknown[]) { calls.push([this, ...args]); return originalPromise } }
  const factory = { init(...args: unknown[]) { calls.push([this, ...args]); return client } }
  helper.installMailCleanupObserver(factory, (value: unknown) => { observations.push(value) })
  const config = { private: 'private-native-sentinel' }
  expect(factory.init(config)).toBe(client)
  const marker = {}
  expect(client.dispose(marker)).toBe(originalPromise)
  expect(client.dispose(marker)).toBe(originalPromise)
  expect(calls).toEqual([[factory, config], [client, marker], [client, marker]])
  expect(calls[0][0]).toBe(factory); expect(calls[0][1]).toBe(config)
  expect(calls[1][0]).toBe(client); expect(calls[1][1]).toBe(marker)
  reject(failure)
  await expect(originalPromise).rejects.toBe(failure)
  await Promise.resolve()
  expect(observations).toEqual([{ type: 'fixture-mail-cleanup', outcome: 'REJECTED',
    codes: ['GRPC_UNAVAILABLE', 'RPC_UNSUBSCRIBE', 'SDK_CLEANUP_FAILED'] }])
  expect(JSON.stringify(observations).includes('private-native-sentinel')).toBe(false)
})

test('cleanup observer keeps fulfilled values and synchronous throws unchanged even when its sink fails', async () => {
  expect(typeof helper.installMailCleanupObserver).toBe('function')
  const marker = {}, failure = new Error('private-sync-sentinel')
  const originalPromise = Promise.resolve(marker)
  const client = { dispose() { return originalPromise } }, factory = { init() { return client } }
  helper.installMailCleanupObserver(factory, () => { throw new Error('private-observer-sentinel') })
  factory.init()
  expect(client.dispose()).toBe(originalPromise)
  expect(await client.dispose()).toBe(marker)
  await Promise.resolve()
  const throwing = { dispose() { throw failure } }, otherFactory = { init() { return throwing } }
  helper.installMailCleanupObserver(otherFactory, () => { throw new Error('private-observer-sentinel') })
  otherFactory.init()
  let caught: unknown
  try { throwing.dispose() } catch (error) { caught = error }
  expect(caught).toBe(failure)
})

test('cleanup classification emits only exact constant codes and never invokes private getters or serializers', () => {
  expect(typeof helper.classifyMailCleanup).toBe('function')
  let getterReads = 0
  const privateError = Object.assign(new Error('private-message-sentinel'), {
    code: 'private-code-sentinel', path: '/private-path-sentinel',
    config: { secret: 'private-config-sentinel' },
    toJSON() { throw new Error('private-serializer-sentinel') },
  })
  Object.defineProperty(privateError, 'cause', { get() { getterReads++; throw new Error('private-getter-sentinel') } })
  const failure = new AggregateError([
    new Error('Native operation settlement is unknown; owned resources must not be released', {
      cause: new Error('Owned HTTP outcome has no public native ClientRequest'),
    }),
    Object.assign(new Error('private-node-sentinel'), { code: 'ECONNRESET' }), privateError,
  ], 'Owned worker cleanup failed')
  const codes = helper.classifyMailCleanup(failure)
  expect(codes).toEqual(['HTTP_NATIVE_HANDLE_MISSING', 'NATIVE_SETTLEMENT_UNKNOWN', 'NODE_ECONNRESET', 'SDK_CLEANUP_FAILED', 'UNKNOWN'])
  expect(getterReads).toBe(0)
  expect(JSON.stringify(codes).includes('private-')).toBe(false)
  const errors = new Proxy([privateError], { get() { getterReads++; throw new Error('private-array-getter-sentinel') } })
  const guarded = new AggregateError([], 'Owned worker cleanup failed')
  Object.defineProperty(guarded, 'errors', { value: errors })
  expect(helper.classifyMailCleanup(guarded)).toEqual(['SDK_CLEANUP_FAILED', 'UNKNOWN'])
  expect(getterReads).toBe(0)
})

test('cleanup classification bounds cyclic deep wide and hostile error graphs', () => {
  expect(typeof helper.classifyMailCleanup).toBe('function')
  const cycle = new Error('private-cycle-sentinel'); Object.defineProperty(cycle, 'cause', { value: cycle })
  expect(helper.classifyMailCleanup(cycle)).toEqual(['UNKNOWN'])
  let deep = new Error('Stream ended without observed local status')
  for (let index = 0; index < 10; index++) deep = new Error('private-depth-sentinel', { cause: deep })
  expect(helper.classifyMailCleanup(deep)).toEqual(['TRUNCATED', 'UNKNOWN'])
  expect(helper.classifyMailCleanup(new AggregateError(Array.from({ length: 100 }, () => new Error('private-wide-sentinel')))))
    .toEqual(['TRUNCATED', 'UNKNOWN'])
  const hostile = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('private-proxy-sentinel') } })
  expect(helper.classifyMailCleanup(hostile)).toEqual(['OBSERVER_UNAVAILABLE'])
})

test('cleanup classification recognizes only the published gRPC status and method whitelist', () => {
  expect(typeof helper.classifyMailCleanup).toBe('function')
  expect(helper.classifyMailCleanup(Object.assign(new Error('private-rpc-sentinel'), {
    path: '/Dispatcher/SendStepActionEvent', code: 1,
  }))).toEqual(['GRPC_CANCELLED', 'RPC_TASK_EVENT'])
  expect(helper.classifyMailCleanup(Object.assign(new Error('private-rpc-sentinel'), {
    path: '/private/Unsubscribe', code: 99,
  }))).toEqual(['UNKNOWN'])
})

test('opt-in preload can report asynchronous cleanup over IPC after shutdown without holding the child alive', async () => {
  expect(typeof helper.installMailCleanupObserver).toBe('function')
  const preload = pathToFileURL(resolve('tests/helpers/mail-process.mjs')).href
  const source = `
    import { installMailCleanupObserver } from ${JSON.stringify(preload)};
    let reject;
    const original = new Promise((_, failed) => { reject = failed });
    const client = { dispose() { return original; } }, factory = { init() { return client; } };
    installMailCleanupObserver(factory, value => process.send(value, () => {})); factory.init();
    process.once('SIGTERM', () => {
      client.dispose().catch(() => {});
      queueMicrotask(() => reject(new AggregateError([new Error('Stream ended without observed local status')], 'Owned worker cleanup failed')));
    });
    process.send({ type: 'fixture-ready' });
  `
  const child = spawn(process.execPath, ['--import', preload, '--input-type=module', '--eval', source], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
      NODE_ENV: 'test', FIXTURE_MAIL_SHUTDOWN_DIAGNOSTICS: 'yes' },
  })
  let stdout = '', stderr = ''
  const observations: unknown[] = []
  child.stdout!.on('data', value => { stdout += String(value) }); child.stderr!.on('data', value => { stderr += String(value) })
  child.on('message', value => {
    if (value && typeof value === 'object' && 'type' in value && value.type === 'fixture-ready') child.send('shutdown')
    else observations.push(value)
  })
  const exited = new Promise<number | null>((done, failed) => { child.once('error', failed); child.once('close', done) })
  try {
    expect(await exited).toBe(0)
    expect(observations).toEqual([{ type: 'fixture-mail-cleanup', outcome: 'REJECTED', codes: ['SDK_CLEANUP_FAILED', 'STREAM_STATUS_MISSING'] }])
    expect({ stdout, stderr }).toEqual({ stdout: '', stderr: '' })
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
  }
}, 5000)
