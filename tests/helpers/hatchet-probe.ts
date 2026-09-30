import { HatchetClient } from '@hatchet-dev/typescript-sdk/v1/index.js'
import type { ClientConfig } from '@hatchet-dev/typescript-sdk/clients/hatchet-client/client-config.js'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'

export function createHatchetProbeClient(
  config: Pick<ClientConfig, 'token' | 'host_port' | 'api_url' | 'tls_config'>,
  emptyConfigPath: string,
  capture: (message: string, scope?: string) => void,
) {
  // SDK1.28.2 joins its own __dirname to config_path even on Windows. Absolute
  // paths do not override that prefix; use a verified relative path to our file.
  const loaderDirectory = dirname(createRequire(import.meta.url).resolve('@hatchet-dev/typescript-sdk/util/config-loader/config-loader.js'))
  const target = resolve(emptyConfigPath)
  const configPath = relative(loaderDirectory, target)
  if (resolve(join(loaderDirectory, configPath)) !== target) throw new Error('Owned SDK config path cannot resolve on this filesystem')
  return HatchetClient.init({ ...config, namespace: '', healthcheck: { enabled: false, port: 0 }, retrier: { maxAttempts: 1 },
    logger: scope => {
      const scoped = (message: string) => capture(message, scope)
      return { debug: scoped, info: scoped, green: scoped, warn: scoped, error: scoped }
    },
  }, { config_path: configPath }, { timeout: 10_000 })
}

export type ObservationRequest = { signal: AbortSignal; timeout: number }
export async function until(check: (request: ObservationRequest) => boolean | Promise<boolean>, label: string, budgetMs = 10_000) {
  const deadline = performance.now() + budgetMs
  const controller = new AbortController()
  const expired = () => new Error(`Timed out observing ${label}`)
  const timer = setTimeout(() => controller.abort(), budgetMs)
  try {
    while (true) {
      const remaining = Math.ceil(deadline - performance.now())
      if (remaining <= 0 || controller.signal.aborted) throw expired()
      const satisfied = await check({ signal: controller.signal, timeout: remaining })
      if (controller.signal.aborted || performance.now() >= deadline) throw expired()
      if (satisfied) return
      await new Promise<void>(resolve => setTimeout(resolve, Math.max(0, Math.min(50, deadline - performance.now()))))
    }
  } catch (error) {
    if (controller.signal.aborted || performance.now() >= deadline) throw expired()
    throw error
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

export function executionRecorderForWorker(generation: string, executions: Map<string, string[]>) {
  return (outboxId: string) => {
    const entries = executions.get(outboxId) ?? []
    entries.push(generation)
    executions.set(outboxId, entries)
  }
}
