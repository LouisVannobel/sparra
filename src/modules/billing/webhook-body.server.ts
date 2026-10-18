import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import type { StripeConfig } from './stripe-config.server'
import { StripeWebhookError, verifyStripeWebhook } from './stripe-webhook.server'
import type { VerifiedStripeEvent } from './stripe-webhook.server'

const maxBodyBytes = 256 * 1024
const maxIngressMs = 10_000

type NativeRequest = Request & {
  runtime?: { name?: unknown; node?: { req?: unknown; res?: unknown } }
}

function ownedTransport(request: Request): { req: IncomingMessage; socket: Socket } | null {
  // SAFETY: Only optional unknown runtime fields are exposed here; the native
  // request/response classes and their exact request/socket identities are checked below.
  const runtime = (request as NativeRequest).runtime
  const req = runtime?.node?.req
  const res = runtime?.node?.res
  if (runtime?.name !== 'node' || !(req instanceof IncomingMessage)
    || !(res instanceof ServerResponse) || !(req.socket instanceof Socket)
    || res.req !== req || res.socket !== req.socket) return null
  return { req, socket: req.socket }
}

async function closeOwnedTransport(req: IncomingMessage, socket: Socket): Promise<void> {
  const reqClosed = req.closed ? Promise.resolve() : new Promise<void>(resolve => req.once('close', resolve))
  const socketClosed = socket.closed ? Promise.resolve() : new Promise<void>(resolve => socket.once('close', resolve))
  req.destroy()
  socket.destroy()
  await Promise.all([reqClosed, socketClosed])
}

function ingressSignature(request: Request, req: IncomingMessage, deadlineAtMs: number,
  startedAtMs: number, signal: AbortSignal, stopped: boolean): string {
  const signature = request.headers.get('Stripe-Signature')
  if (!Number.isSafeInteger(deadlineAtMs) || deadlineAtMs <= startedAtMs
    || signal.aborted || !signature || signature.length > 8192
    || req.method !== 'POST' || stopped) throw new StripeWebhookError()
  return signature
}

function appendWebhookChunk(chunk: unknown, chunks: Uint8Array[], totalBytes: number,
  stopped: boolean, signal: AbortSignal, effectiveDeadlineAtMs: number): number {
  if (stopped || signal.aborted || Date.now() >= effectiveDeadlineAtMs
    || !(chunk instanceof Uint8Array) || chunk.byteLength > maxBodyBytes - totalBytes) {
    throw new StripeWebhookError()
  }
  totalBytes += chunk.byteLength
  chunks.push(Uint8Array.from(chunk))
  return totalBytes
}

export async function readStripeWebhook(
  config: StripeConfig,
  request: Request,
  deadlineAtMs: number,
  ownerSignal: AbortSignal = request.signal,
): Promise<VerifiedStripeEvent> {
  const startedAtMs = Date.now()
  const transport = ownedTransport(request)
  if (!transport) throw new StripeWebhookError()
  const { req, socket } = transport
  const signal = AbortSignal.any([request.signal, ownerSignal])
  const effectiveDeadlineAtMs = Math.min(deadlineAtMs, startedAtMs + maxIngressMs)
  let stopped = false
  const stop = () => { stopped = true; req.destroy(); socket.destroy() }
  const onAbort = () => stop()
  signal.addEventListener('abort', onAbort, { once: true })
  const timer = Number.isSafeInteger(deadlineAtMs) && deadlineAtMs > startedAtMs
    ? setTimeout(stop, Math.max(0, effectiveDeadlineAtMs - Date.now())) : null
  let complete = false

  try {
    const signature = ingressSignature(request, req, deadlineAtMs, startedAtMs, signal, stopped)

    const chunks: Uint8Array[] = []
    let totalBytes = 0
    for await (const chunk of req) {
      totalBytes = appendWebhookChunk(chunk, chunks, totalBytes, stopped, signal, effectiveDeadlineAtMs)
    }
    if (stopped || signal.aborted || Date.now() >= effectiveDeadlineAtMs || !req.complete) {
      throw new StripeWebhookError()
    }
    const raw = new Uint8Array(totalBytes)
    let offset = 0
    for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength }
    const verified = verifyStripeWebhook(config, raw, signature, Date.now())
    if (stopped || signal.aborted || Date.now() >= effectiveDeadlineAtMs) {
      throw new StripeWebhookError()
    }
    complete = true
    return verified
  } catch { throw new StripeWebhookError() }
  finally {
    if (timer !== null) clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
    if (!complete) await closeOwnedTransport(req, socket)
  }
}
