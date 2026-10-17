import type { HatchetClient } from '@hatchet-dev/typescript-sdk/v1/index.js'
import type { TaskWorkflowDeclaration } from '@hatchet-dev/typescript-sdk/v1/declaration.js'
import type { RequestParams } from '@hatchet-dev/typescript-sdk/clients/rest/generated/http-client.js'
import { Schema } from 'effect'
import { Agent as HttpAgent, ClientRequest, globalAgent as httpGlobalAgent } from 'node:http'
import { Agent as HttpsAgent, globalAgent as httpsGlobalAgent } from 'node:https'
import type { createBillingHandler } from './worker.server'
import type { BillingAdmissionResult, BillingJobInput } from './store.server'
import { billingUuid, decodeBilling } from './billing-agreement.server'

type Handler = ReturnType<typeof createBillingHandler>
type Result = Awaited<ReturnType<Handler['handle']>>
type BillingTask = TaskWorkflowDeclaration<BillingJobInput, Result>
type Operation = { original?: Promise<unknown>; closed: Promise<boolean> }
type Binding = { client: HatchetClient; operations: Set<Operation>; admissionClosed: boolean; unsafe: boolean;
  stop?: Promise<void>; baseURL: string; adapter: unknown; requestTransforms: unknown; responseTransforms: unknown;
  paramsSerializer: unknown }
const clients = new WeakMap<BillingTask, Binding>()
const name = 'billing-reconciliation'
const unknown: BillingAdmissionResult = Object.freeze({ state: 'unknown' })
const job = Schema.Struct({ outboxId: billingUuid, tenantId: billingUuid })
const nativeInput = Schema.Struct({ input: job, overrides: Schema.Null, parents: Schema.Record(Schema.String, Schema.Never),
  triggered_by: Schema.Literal('manual'), triggers: Schema.Struct({ filter_payload: Schema.Null }), user_data: Schema.Null })
const status = Schema.Literals(['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'])
const observedRun = Schema.Struct({ id: billingUuid, tenantId: billingUuid, workflowId: billingUuid, input: nativeInput, status })

function bindingFor(task: BillingTask) {
  const binding = clients.get(task)
  if (!binding) throw new Error('Billing task is not bound')
  return binding
}

function sameOption(actual: unknown, expected: unknown) {
  return Array.isArray(expected)
    ? Array.isArray(actual) && actual.length === expected.length && actual.every((value, index) => value === expected[index])
    : actual === expected
}

function snapshotOption(value: unknown) { return Array.isArray(value) ? [...value] : value }

function sameSerializer(actual: unknown, expected: unknown) {
  return actual === expected || (typeof expected === 'function' && actual !== null && typeof actual === 'object'
    && Reflect.get(actual, 'serialize') === expected)
}

function nativeAgent(protocol: string, configured: unknown) {
  if (protocol !== 'https:' && protocol !== 'http:') throw new TypeError('Billing relay protocol rejected')
  if (protocol === 'https:' && process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new TypeError('Billing relay TLS validation rejected')
  const agent = configured ?? (protocol === 'https:' ? httpsGlobalAgent : httpGlobalAgent)
  const expected = protocol === 'https:' ? HttpsAgent : HttpAgent
  if (!(agent instanceof expected) || Object.getPrototypeOf(agent) !== expected.prototype) throw new TypeError('Billing relay native agent rejected')
  const options: unknown = Reflect.get(agent, 'options')
  if (options && typeof options === 'object' && Reflect.get(options, 'proxyEnv') != null) throw new TypeError('Billing relay proxy agent rejected')
  if (protocol === 'https:' && options && typeof options === 'object' && Reflect.get(options, 'rejectUnauthorized') === false) {
    throw new TypeError('Billing relay TLS validation rejected')
  }
  if (Reflect.get(agent, 'proxyEnv') != null) throw new TypeError('Billing relay proxy agent rejected')
}

function validateDefaults(binding: Binding) {
  const defaults = binding.client.api.instance.defaults
  if (defaults.baseURL !== binding.baseURL || !sameOption(defaults.adapter, binding.adapter)
    || !sameOption(defaults.transformRequest, binding.requestTransforms)
    || !sameOption(defaults.transformResponse, binding.responseTransforms)
    || defaults.paramsSerializer !== binding.paramsSerializer) throw new TypeError('Billing relay REST instance changed')
}

function requestClosed(request: ClientRequest) {
  if (request.closed) return Promise.resolve()
  return new Promise<void>(resolve => {
    const onClose = () => { request.removeListener('close', onClose); resolve() }
    request.once('close', onClose)
    if (request.closed) onClose()
  })
}

function publicRequest(outcome: unknown, rejected: boolean): ClientRequest | undefined {
  if (!outcome || typeof outcome !== 'object') return undefined
  const direct = Reflect.get(outcome, 'request')
  const response = rejected ? Reflect.get(outcome, 'response') : undefined
  const nested = response && typeof response === 'object' ? Reflect.get(response, 'request') : undefined
  const candidates = [direct, nested].filter(value => value !== undefined && value !== null)
  return candidates.length > 0 && candidates.every(value => value instanceof ClientRequest && value === candidates[0])
    ? candidates[0] as ClientRequest : undefined
}

function nativeRequest<T>(binding: Binding, params: RequestParams, method: 'get' | 'post', path: string,
  maxContentLength: number, markTransportUnproven: () => void, invoke: (params: RequestParams) => Promise<T>): Promise<T> {
  if (binding.admissionClosed) throw new Error('Billing relay admission closed')
  validateDefaults(binding)
  const instance = binding.client.api.instance
  let refused = false
  const interceptor = instance.interceptors.request.use(config => {
    const destination = new URL(binding.baseURL)
    const selectedAgent = destination.protocol === 'https:' ? config.httpsAgent : config.httpAgent
    if (binding.admissionClosed || config.adapter !== 'http' || config.httpVersion !== 1
      || config.maxRedirects !== 0 || config.proxy !== false || config.transport !== undefined
      || config.socketPath !== undefined || config.cancelToken !== undefined || config.signal !== params.signal
      || config.baseURL !== binding.baseURL || config.url !== path || config.method !== method
      || config.timeout !== 10000 || config.maxBodyLength !== 1024 || config.maxContentLength !== maxContentLength
      || config.decompress !== false || config.responseType !== 'json'
      || config.transitional?.legacyInterceptorReqResOrdering !== false
      || config.headers.get('Accept-Encoding') !== 'identity'
      || !sameOption(config.transformRequest, binding.requestTransforms)
      || !sameOption(config.transformResponse, binding.responseTransforms)
      || !sameSerializer(config.paramsSerializer, binding.paramsSerializer)) {
      refused = true
      throw new TypeError('Billing relay effective HTTP options rejected')
    }
    try { nativeAgent(destination.protocol, selectedAgent) }
    catch (error) { refused = true; throw error }
    return config
  }, undefined, { synchronous: true, runWhen: config => config.signal === params.signal })
  let finish!: (closed: boolean) => void
  const closed = new Promise<boolean>(resolve => { finish = resolve })
  const operation: Operation = { closed }
  binding.operations.add(operation) // reserve ownership before generated preparation
  let original: Promise<T>
  try { original = invoke({ ...params, adapter: 'http', httpVersion: 1 }) }
  catch (cause) { original = Promise.reject(cause) }
  operation.original = original
  const unsafe = () => {
    if (!binding.unsafe) {
      binding.unsafe = true
      try { markTransportUnproven() } catch { /* The private unsafe state still bars cleanup. */ }
    }
  }
  void (async () => {
    let result: unknown, rejected = false
    try { result = await original } catch (cause) { result = cause; rejected = true }
    try {
      if (refused) { finish(true); return }
      const request = publicRequest(result, rejected)
      if (!request) { unsafe(); finish(false); return }
      await requestClosed(request)
      finish(true)
    } catch {
      unsafe(); finish(false)
    } finally {
      instance.interceptors.request.eject(interceptor)
      binding.operations.delete(operation)
    }
  })()
  return original.then(async response => {
    if (!await closed || refused) throw new Error('Billing relay REST close unproven')
    return response
  })
}

export function stopBillingRelay(task: BillingTask, deadlineAtMs: number): Promise<void> {
  const binding = bindingFor(task)
  if (binding.stop) return binding.stop
  binding.admissionClosed = true
  const existing = [...binding.operations]
  binding.stop = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { binding.unsafe = true; reject(new Error('Billing relay REST close deadline exceeded')) }, Math.max(0, deadlineAtMs - Date.now()))
      })
      await Promise.race([Promise.all(existing.map(operation => operation.closed)), deadline])
      if (binding.unsafe) throw new Error('Billing relay REST transport closure unproven')
    } finally { if (timer) clearTimeout(timer) }
  })()
  return binding.stop
}

// Concrete REST phase limits; the close tracker is separate from the SDK worker owner.
function requestBudget(signal: AbortSignal, maxContentLength: number) {
  const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), 10000)
  const combined = AbortSignal.any([signal, deadline.signal])
  const params: RequestParams = { signal: combined, timeout: 10000, maxRedirects: 0, proxy: false,
    maxBodyLength: 1024, maxContentLength, decompress: false, headers: { 'Accept-Encoding': 'identity' },
    transitional: { silentJSONParsing: false, forcedJSONParsing: true, clarifyTimeoutError: true,
      legacyInterceptorReqResOrdering: false } }
  return { params, check() { combined.throwIfAborted() }, close() { clearTimeout(timer) } }
}

export function createBillingTask(client: HatchetClient, handler: Handler) {
  if (client.config.namespace !== '') throw new Error('Billing task namespace rejected')
  const task = client.task<BillingJobInput, Result>({
    name, retries: 4, backoff: { factor: 5, maxSeconds: 30 },
    executionTimeout: '30s', scheduleTimeout: '10m',
    // Native TTL only suppresses duplicate triggers within its finite window.
    // SQL owns durable identity, completion, risk and effect authorization.
    idempotency: { strategy: 'ttl', ttlMs: 600000,
      expression: "'billing-reconciliation:' + input.tenantId + ':' + input.outboxId" },
    fn: async (input, context) => {
      const result = await handler.handle(input, context.abortController.signal)
      if (!result.commandCompleted) throw new Error('BILLING_RECONCILIATION_INCOMPLETE')
      return result
    },
  })
  const defaults = client.api.instance.defaults
  clients.set(task, { client, operations: new Set(), admissionClosed: false, unsafe: false,
    baseURL: defaults.baseURL ?? '', adapter: snapshotOption(defaults.adapter),
    requestTransforms: snapshotOption(defaults.transformRequest),
    responseTransforms: snapshotOption(defaults.transformResponse), paramsSerializer: defaults.paramsSerializer })
  return task
}

export async function admitBillingTask(task: BillingTask, input: BillingJobInput, signal: AbortSignal,
  markTransportUnproven: () => void): Promise<BillingAdmissionResult> {
  const budget = requestBudget(signal, 16384)
  try {
    budget.check()
    const binding = bindingFor(task), client = binding.client, checked = decodeBilling(job, input)
    const response = await nativeRequest(binding, budget.params, 'post', `/api/v1/stable/tenants/${client.tenantId}/workflow-runs/trigger`,
      16384, markTransportUnproven, params => client.api.v1WorkflowRunCreate(client.tenantId,
        { workflowName: name, input: checked, return_only_id: true }, params))
    // The engine returns a partial DTO here: only the ACK ID is authority.
    const runId = decodeBilling(billingUuid, response.data?.run?.metadata?.id)
    return { state: 'admitted', runId }
  } catch { return unknown }
  finally { budget.close() }
}

export async function observeBillingAdmission(task: BillingTask, claim: { input: BillingJobInput; runId: string | null }, signal: AbortSignal,
  markTransportUnproven: () => void): Promise<BillingAdmissionResult> {
  const budget = requestBudget(signal, 262144)
  try {
    budget.check()
    const binding = bindingFor(task), client = binding.client, input = decodeBilling(job, claim.input)
    const version = await nativeRequest(binding, budget.params, 'get', '/api/v1/version', 262144,
      markTransportUnproven, params => client.api.infoGetVersion(params))
    budget.check()
    if (version.data?.version !== 'v0.101.27') return unknown
    const tenant = await nativeRequest(binding, budget.params, 'get', `/api/v1/tenants/${client.tenantId}`, 262144,
      markTransportUnproven, params => client.api.tenantGet(client.tenantId, params))
    budget.check()
    if (tenant.data?.version !== 'V1' || tenant.data?.metadata?.id !== client.tenantId) return unknown
    const listing = await nativeRequest(binding, budget.params, 'get', `/api/v1/tenants/${client.tenantId}/workflows`, 262144,
      markTransportUnproven, params => client.api.workflowList(client.tenantId, { name, limit: 100, offset: 0 }, params))
    budget.check()
    if (!listing.data.rows || listing.data.rows.length >= 100 || (listing.data.pagination?.num_pages ?? 1) > 1) return unknown
    const workflows = listing.data.rows.filter(workflow => workflow.name === name)
    if (workflows.length !== 1) return unknown
    // v0.101.27 ToWorkflowFromSQLC emits tenantId ""; the authenticated tenant-scoped list supplies provenance.
    if (workflows[0]?.tenantId !== '' && workflows[0]?.tenantId !== client.tenantId) return unknown
    const workflowId = decodeBilling(billingUuid, workflows[0]?.metadata?.id)
    if (claim.runId !== null) {
      const runId = decodeBilling(billingUuid, claim.runId)
      const response = await nativeRequest(binding, budget.params, 'get', `/api/v1/stable/workflow-runs/${runId}`, 262144,
        markTransportUnproven, params => client.api.v1WorkflowRunGet(runId, params))
      budget.check()
      const run = response.data?.run
      const value = decodeBilling(observedRun, { id: run?.metadata?.id, tenantId: run?.tenantId,
        workflowId: run?.workflowId, input: run?.input, status: run?.status })
      if (value.id !== runId || value.tenantId !== client.tenantId || value.workflowId !== workflowId
        || value.input.input.outboxId !== input.outboxId || value.input.input.tenantId !== input.tenantId) return unknown
      switch (value.status) {
        case 'COMPLETED': return { state: 'terminal', runId, terminalDisposition: 'completed' }
        case 'FAILED': return { state: 'terminal', runId, terminalDisposition: 'failed' }
        case 'CANCELLED': return { state: 'terminal', runId, terminalDisposition: 'cancelled' }
        default: return { state: 'admitted', runId }
      }
    }
    const found = new Set<string>()
    for (let page = 0; page < 5; page++) {
      budget.check()
      const query = {
        since: new Date(0).toISOString(), only_tasks: true, include_payloads: true, workflow_ids: [workflowId],
        idempotency_keys: [`${name}:${input.tenantId}:${input.outboxId}`], limit: 100, offset: page * 100,
      }
      const response = await nativeRequest(binding, budget.params, 'get', `/api/v1/stable/tenants/${client.tenantId}/workflow-runs`, 262144,
        markTransportUnproven, params => client.api.v1WorkflowRunList(client.tenantId, query, params))
      budget.check()
      if (!Array.isArray(response.data.rows) || response.data.rows.length > 100) return unknown
      for (const row of response.data.rows) {
        const value = decodeBilling(observedRun, { id: row.workflowRunExternalId, tenantId: row.tenantId,
          workflowId: row.workflowId, input: row.input, status: row.status })
        if (value.id !== row.metadata?.id || value.id !== row.taskExternalId) return unknown
        if (value.tenantId === client.tenantId && value.workflowId === workflowId
          && value.input.input.outboxId === input.outboxId && value.input.input.tenantId === input.tenantId) found.add(value.id)
      }
      const pagination = response.data.pagination
      const exhausted = response.data.rows.length < 100 && (pagination?.num_pages === undefined || pagination.num_pages <= page + 1)
      if (exhausted) {
        const [runId] = found
        return found.size === 1 && runId ? { state: 'admitted', runId } : unknown
      }
    }
    // Incomplete scans, including historical retention gaps, never authorize
    // another POST. A discovered ID is associated before a later terminal read.
    return unknown
  } catch { return unknown }
  finally { budget.close() }
}
