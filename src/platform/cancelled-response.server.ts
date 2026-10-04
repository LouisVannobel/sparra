export async function cancelledResponse(response: Response, clientSignal: AbortSignal): Promise<Response> {
  await response.body?.cancel().catch(() => {})
  return clientSignal.aborted
    ? new Response('Request Cancelled', { status: 499 })
    : new Response('Gateway Timeout', { status: 504 })
}
