import { HatchetClient } from '@hatchet-dev/typescript-sdk/v1/index.js'
import type { ClientConfig } from '@hatchet-dev/typescript-sdk/clients/hatchet-client/client-config.js'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import type { createAuthMailHandler, HandlerResult } from './mail-worker.server'

export function createAuthMailHatchet(config: Pick<ClientConfig, 'token' | 'host_port' | 'api_url' | 'tls_config'>, emptyConfigPath: string, ownerSignal: AbortSignal = new AbortController().signal) {
  const loaderDirectory = dirname(createRequire(import.meta.url).resolve('@hatchet-dev/typescript-sdk/util/config-loader/config-loader.js'))
  const target = resolve(emptyConfigPath), configPath = relative(loaderDirectory, target)
  if (resolve(join(loaderDirectory, configPath)) !== target) throw new Error('Auth mail SDK configuration rejected')
  const client = HatchetClient.init({ ...config, namespace: '', healthcheck: { enabled: false, port: 0 }, retrier: { maxAttempts: 1 },
    // SDK1.28.2's built-in OFF=-1 enables its thread logger. Its heartbeat
    // thread emits direct DEBUG only; ERROR suppresses those. All forwarded
    // thread/error messages reach this deliberately non-content logger.
    log_level: 'ERROR', logger: () => ({ debug() {}, info() {}, green() {}, warn() {}, error() {} }),
  }, { config_path: configPath }, { timeout: 10000, maxRedirects: 0, proxy: false })
  ownAuthMailListeners(client.dispatcher.client, ownerSignal)
  return client
}

export function ownAuthMailListeners(rpc: Pick<HatchetClient['dispatcher']['client'], 'listen' | 'listenV2'>, ownerSignal: AbortSignal) {
  // Undocumented SDK1.28.2 instance adaptation. Keep installed for this owned
  // client's terminal lifetime; nice-grpc's pinned patch owns setup cancellation.
  for (const name of ['listen', 'listenV2'] as const) {
    const original = rpc[name].bind(rpc)
    rpc[name] = (request, options) => {
      const signal = options?.signal ? AbortSignal.any([ownerSignal, options.signal]) : ownerSignal
      const check = () => { if (signal.aborted) throw new DOMException('Auth mail listener stopped', 'AbortError') }
      check() // Must throw before the SDK can start the V2 heartbeat.
      return (async function* () {
        check() // An iterable created before stop may not have been advanced.
        yield* original(request, { ...options, signal })
      })()
    }
  }
}

export function createAuthMailTask(client: HatchetClient, handler: ReturnType<typeof createAuthMailHandler>) {
  return client.task<{ outboxId: string }, Awaited<ReturnType<typeof runAuthMailTask>>>({
    name: 'auth-email-delivery', retries: 4, backoff: { factor: 5, maxSeconds: 30 },
    executionTimeout: '30s', scheduleTimeout: '10m',
    // Auth commands expire within ten minutes. SQL refuses every late job even
    // after this finite native TTL; the TTL never grants provider replay.
    idempotency: { strategy: 'ttl', ttlMs: 600000, expression: "'auth-email-delivery:' + input.outboxId" },
    fn: (input, ctx) => runAuthMailTask(handler, input, ctx.abortController.signal),
  })
}

// Throw only at the native boundary, after the owned handler has fulfilled.
// These codes request bounded re-entry through SQL, never provider replay.
export async function runAuthMailTask(handler: Pick<ReturnType<typeof createAuthMailHandler>, 'handle'>,
  input: unknown, signal: AbortSignal): Promise<Exclude<HandlerResult, { state: 'deferred' }>> {
  const result = await handler.handle(input, signal)
  if (result.state === 'deferred') {
    switch (result.reason) {
      case 'worker_stopping': throw new Error('AUTH_MAIL_WORKER_STOPPING')
      case 'outbox_in_flight': throw new Error('AUTH_MAIL_OUTBOX_IN_FLIGHT')
      case 'capacity_busy': throw new Error('AUTH_MAIL_CAPACITY_BUSY')
      case 'claim_unresolved': throw new Error('AUTH_MAIL_CLAIM_UNRESOLVED')
      default: return { state: 'effect_unknown' }
    }
  }
  return result
}
