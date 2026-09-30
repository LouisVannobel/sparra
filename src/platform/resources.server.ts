import type { AuthTransactions } from './db/transactions.server'
import type { createAuthRateLimiter } from '../modules/auth/rate-limit.server'
import type { createApplicationAuth } from '../modules/auth/auth.server'
import type { createPersonalWorkspaces } from '../modules/workspaces/personal.server'

export type WebResources = Readonly<{
  transactions: AuthTransactions
  limiter: ReturnType<typeof createAuthRateLimiter>
  auth: ReturnType<typeof createApplicationAuth> | null
  workspaces: ReturnType<typeof createPersonalWorkspaces>
  isReady(): boolean
}>

type ResourceRequest = Request & { context?: { appResources?: WebResources } }
export function requestResources(request: ResourceRequest): WebResources {
  const resources = request.context?.appResources
  if (!resources) throw new Error('Application request resources missing')
  return resources
}

export function requestAuthDeadlineAtMs(request: Request): number {
  const descriptor = Object.getOwnPropertyDescriptor(request, 'appAuthDeadlineAtMs')
  const value: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined
  if (!descriptor || descriptor.enumerable || descriptor.writable || descriptor.configurable
    || !Number.isSafeInteger(value) || typeof value !== 'number' || value <= 0 || value <= Date.now()) {
    throw new Error('Application auth deadline unavailable')
  }
  return value
}
