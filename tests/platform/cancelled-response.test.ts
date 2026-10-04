import { expect, test } from 'vitest'
import { cancelledResponse } from '../../src/platform/cancelled-response.server'

test.each([
  { name: 'HTTP timeout with a live client', clientAborted: false, status: 504, body: 'Gateway Timeout' },
  { name: 'client cancellation', clientAborted: true, status: 499, body: 'Request Cancelled' },
])('$name replaces a null body with its public error', async ({ clientAborted, status, body }) => {
  const client = new AbortController()
  if (clientAborted) client.abort(new Error('private-client-reason'))
  const original = new Response(null, { status: 204, headers: { 'x-private': 'discarded' } })
  const response = await cancelledResponse(original, client.signal)

  expect(response.status).toBe(status)
  expect(response.headers.get('x-private')).toBeNull()
  expect(await response.text()).toBe(body)
})

test.each([
  { name: 'HTTP timeout', clientAborted: false, status: 504, body: 'Gateway Timeout' },
  { name: 'client cancellation', clientAborted: true, status: 499, body: 'Request Cancelled' },
])('$name disposes the unread body without forwarding a private reason', async ({ clientAborted, status, body }) => {
  const client = new AbortController()
  if (clientAborted) client.abort(new Error('private-client-reason'))
  let pulls = 0, cancellations = 0
  let cancellationReason: unknown
  const stream = new ReadableStream<Uint8Array>({
    pull() { pulls++ },
    cancel(reason) { cancellations++; cancellationReason = reason },
  }, { highWaterMark: 0 })
  const original = new Response(stream, { headers: { 'x-private': 'discarded' } })
  const response = await cancelledResponse(original, client.signal)

  expect(cancellations).toBe(1)
  expect(cancellationReason).toBeUndefined()
  expect(pulls).toBe(0)
  expect(response.body).not.toBe(stream)
  expect(response.status).toBe(status)
  expect(response.headers.get('x-private')).toBeNull()
  expect(await response.text()).toBe(body)
})

test.each([
  { name: 'HTTP timeout', clientAborted: false, status: 504, body: 'Gateway Timeout' },
  { name: 'client cancellation', clientAborted: true, status: 499, body: 'Request Cancelled' },
])('$name still returns its public error when native body cancellation rejects', async ({ clientAborted, status, body }) => {
  const client = new AbortController()
  if (clientAborted) client.abort(new Error('private-client-reason'))
  let cancellations = 0
  const stream = new ReadableStream<Uint8Array>({
    cancel() { cancellations++; throw new Error('private-disposal-reason') },
  }, { highWaterMark: 0 })
  const response = await cancelledResponse(new Response(stream), client.signal)

  expect(cancellations).toBe(1)
  expect(response.status).toBe(status)
  expect(await response.text()).toBe(body)
})

test.each([
  { name: 'live client after disposal', abortDuringCancellation: false, status: 504, body: 'Gateway Timeout' },
  { name: 'client abort during disposal', abortDuringCancellation: true, status: 499, body: 'Request Cancelled' },
])('$name waits for native cancellation before choosing and settling the response', async ({ abortDuringCancellation, status, body }) => {
  const client = new AbortController()
  let releaseCancellation!: () => void
  let markCancellationStarted!: () => void
  const cancellationRelease = new Promise<void>(resolve => { releaseCancellation = resolve })
  const cancellationStarted = new Promise<void>(resolve => { markCancellationStarted = resolve })
  let cancellationCompleted = false, responseSettled = false
  let cancellationReason: unknown
  const stream = new ReadableStream<Uint8Array>({
    async cancel(reason) {
      cancellationReason = reason
      markCancellationStarted()
      await cancellationRelease
      cancellationCompleted = true
    },
  }, { highWaterMark: 0 })
  const pending = cancelledResponse(new Response(stream), client.signal).then(response => {
    responseSettled = true
    return response
  })

  await cancellationStarted
  expect(responseSettled).toBe(false)
  expect(cancellationCompleted).toBe(false)
  expect(cancellationReason).toBeUndefined()
  if (abortDuringCancellation) client.abort(new Error('private-late-client-reason'))
  releaseCancellation()
  const response = await pending

  expect(cancellationCompleted).toBe(true)
  expect(response.status).toBe(status)
  expect(await response.text()).toBe(body)
})

test('a client abort across the null-body await takes priority over HTTP timeout', async () => {
  const client = new AbortController()
  const pending = cancelledResponse(new Response(null), client.signal)
  client.abort(new Error('private-late-client-reason'))
  const response = await pending

  expect(response.status).toBe(499)
  expect(await response.text()).toBe('Request Cancelled')
})
