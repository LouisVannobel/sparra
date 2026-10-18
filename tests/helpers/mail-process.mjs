const sdkCodes = new Map([
  ['Owned worker cleanup failed', 'SDK_CLEANUP_FAILED'],
  ['Native operation settlement is unknown; owned resources must not be released', 'NATIVE_SETTLEMENT_UNKNOWN'],
  ['Owned HTTP outcome has no public native ClientRequest', 'HTTP_NATIVE_HANDLE_MISSING'],
  ['Stream ended without observed local status', 'STREAM_STATUS_MISSING'],
  ['Unary result without observed local status', 'UNARY_STATUS_MISSING'],
  ['Owned cleanup deadline expired before all work joined', 'CLEANUP_DEADLINE_EXPIRED'],
  ['Owned cleanup exceeded its original deadline', 'CLEANUP_DEADLINE_EXCEEDED'],
  ['Owned worker cleanup deadline expired', 'CLEANUP_ADMISSION_EXPIRED'],
  ['Owned heartbeat thread exited unexpectedly', 'HEARTBEAT_THREAD_EXITED'],
  ['Owned worker start failed', 'SDK_START_FAILED'],
  ['Owned worker delay cancelled', 'SDK_DELAY_CANCELLED'],
  ['Owned listener retry limit exceeded', 'LISTENER_RETRY_EXHAUSTED'],
])
const grpcCodes = ['GRPC_OK', 'GRPC_CANCELLED', 'GRPC_UNKNOWN', 'GRPC_INVALID_ARGUMENT', 'GRPC_DEADLINE_EXCEEDED',
  'GRPC_NOT_FOUND', 'GRPC_ALREADY_EXISTS', 'GRPC_PERMISSION_DENIED', 'GRPC_RESOURCE_EXHAUSTED', 'GRPC_FAILED_PRECONDITION',
  'GRPC_ABORTED', 'GRPC_OUT_OF_RANGE', 'GRPC_UNIMPLEMENTED', 'GRPC_INTERNAL', 'GRPC_UNAVAILABLE', 'GRPC_DATA_LOSS', 'GRPC_UNAUTHENTICATED']
const nodeCodes = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNABORTED', 'ERR_CANCELED', 'ERR_NETWORK', 'ERR_BAD_REQUEST', 'ERR_BAD_RESPONSE', 'ABORT_ERR']
const rpcCodes = new Map([
  ['/Dispatcher/SendStepActionEvent', 'RPC_TASK_EVENT'], ['/Dispatcher/Unsubscribe', 'RPC_UNSUBSCRIBE'],
  ['/Dispatcher/Listen', 'RPC_LISTEN'], ['/Dispatcher/ListenV2', 'RPC_LISTEN_V2'], ['/Dispatcher/Heartbeat', 'RPC_HEARTBEAT'],
])
export const MAIL_CLEANUP_CODES = Object.freeze([...sdkCodes.values(), ...grpcCodes, ...nodeCodes.map(code => `NODE_${code}`),
  ...rpcCodes.values(), 'UNAVAILABLE_NO_CONNECTION_PATTERN', 'UNKNOWN', 'TRUNCATED', 'OBSERVER_UNAVAILABLE'])

// Inspect only own data properties. Error serializers, getters, details,
// messages outside the exact SDK allowlist and transport/config data stay private.
const ownData = (value, name) => Object.getOwnPropertyDescriptor(value, name)?.value

function classifyCleanupNode(value, codes) {
  let recognized = false
  const sdk = sdkCodes.get(ownData(value, 'message')), rpc = rpcCodes.get(ownData(value, 'path')), code = ownData(value, 'code')
  if (sdk) { codes.add(sdk); recognized = true }
  if (rpc) { codes.add(rpc); recognized = true }
  if (Number.isInteger(code) && code >= 0 && code < grpcCodes.length) { codes.add(grpcCodes[code]); recognized = true }
  if (nodeCodes.includes(code)) { codes.add(`NODE_${code}`); recognized = true }
  if (code === 14 && rpc === 'RPC_UNSUBSCRIBE') {
    const details = ownData(value, 'details')
    if (typeof details === 'string' && details.startsWith('No connection established. Last error: ')) codes.add('UNAVAILABLE_NO_CONNECTION_PATTERN')
  }
  if (!recognized) codes.add('UNKNOWN')
}

function appendCleanupChildren(value, depth, pending, seen, codes) {
  const append = child => {
    if (child && typeof child === 'object' && seen.has(child)) return
    if (depth >= 6 || pending.length >= 32) { codes.add('TRUNCATED'); return }
    pending.push({ value: child, depth: depth + 1 })
  }
  const cause = Object.getOwnPropertyDescriptor(value, 'cause')
  if (cause && 'value' in cause) append(cause.value)
  const errors = ownData(value, 'errors')
  if (value instanceof AggregateError && Array.isArray(errors)) {
    const length = ownData(errors, 'length')
    if (!Number.isSafeInteger(length) || length < 0) return false
    if (length > 32) codes.add('TRUNCATED')
    for (let child = 0; child < Math.min(length, 32); child++) {
      const descriptor = Object.getOwnPropertyDescriptor(errors, String(child))
      if (descriptor && 'value' in descriptor) append(descriptor.value)
    }
  }
  return true
}

export function classifyMailCleanup(error) {
  const codes = new Set(), seen = new Set(), pending = [{ value: error, depth: 0 }]
  try {
    for (let index = 0; index < pending.length; index++) {
      const { value, depth } = pending[index]
      if (!value || typeof value !== 'object') { codes.add('UNKNOWN'); continue }
      if (seen.has(value)) continue
      seen.add(value)
      classifyCleanupNode(value, codes)
      if (!appendCleanupChildren(value, depth, pending, seen, codes)) return ['OBSERVER_UNAVAILABLE']
    }
    return [...codes].sort()
  } catch { return ['OBSERVER_UNAVAILABLE'] }
}

export function installMailCleanupObserver(factory, emit) {
  const originalInit = factory.init, clients = new WeakSet(), promises = new WeakSet()
  const publish = (outcome, error) => {
    try { emit({ type: 'fixture-mail-cleanup', outcome, codes: outcome === 'REJECTED' ? classifyMailCleanup(error) : [] }) } catch {}
  }
  factory.init = function (...args) {
    const client = originalInit.apply(this, args)
    if (clients.has(client)) return client
    clients.add(client)
    const originalDispose = client.dispose
    client.dispose = function (...disposeArgs) {
      let original
      try { original = originalDispose.apply(this, disposeArgs) }
      catch (error) { publish('REJECTED', error); throw error }
      if (original instanceof Promise && !promises.has(original)) {
        promises.add(original)
        void original.then(() => publish('FULFILLED'), error => publish('REJECTED', error)).catch(() => {})
      }
      return original
    }
    return client
  }
}

const diagnostics = process.env.FIXTURE_MAIL_SHUTDOWN_DIAGNOSTICS === 'yes'
if (diagnostics) {
  const { HatchetClient } = await import('@hatchet-dev/typescript-sdk/v1/index.js')
  installMailCleanupObserver(HatchetClient, value => { if (process.connected) process.send(value, () => {}) })
}
// Windows child.kill does not deliver a cooperative POSIX signal. The fixture
// emits the same signal event inside its exclusively owned child process.
if (typeof process.send === 'function') process.on('message', message => {
  if (message !== 'shutdown') return
  process.emit('SIGTERM')
  // Keep the diagnostic channel usable without retaining the child's lifetime.
  if (diagnostics) process.channel?.unref()
  else process.disconnect()
})
