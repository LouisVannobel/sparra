import { getRequest } from '@tanstack/react-start/server'

type NonceRequest = Request & { appCspNonce?: string }
export function readRequestNonce() {
  const request: NonceRequest = getRequest()
  if (!request.appCspNonce) throw new Error('Request nonce missing')
  return request.appCspNonce
}
