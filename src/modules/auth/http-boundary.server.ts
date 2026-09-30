import type { createApplicationAuth } from './auth.server'
import type { createAuthRateLimiter } from './rate-limit.server'

export function isGoogleAccountCallbackRequest(request: Pick<Request, 'method' | 'url'>, origin: string) {
  const canonical = origin + '/api/auth/account/google/callback'
  return request.method === 'GET' && (request.url === canonical || request.url.startsWith(canonical + '?'))
}
export async function googleAccountCallbackResponse(request: Request, auth: ReturnType<typeof createApplicationAuth>, limiter: ReturnType<typeof createAuthRateLimiter>) {
  const headers = new Headers({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
  try {
    const result = await auth.completeGoogleAccountLinkOAuth(request)
    headers.set('location', result.url)
    for (const cookie of result.headers.getSetCookie()) headers.append('set-cookie', cookie)
    return new Response(null, { status: 303, headers })
  } catch (error) {
    const mapped = auth.googleAccountErrorResponse(error) ?? limiter.errorResponse(error)
    if (mapped) { mapped.headers.forEach((value, name) => headers.set(name, value)); return new Response(mapped.body, { status: mapped.status, headers }) }
    return new Response('Authentication outcome unconfirmed', { status: 500, headers })
  }
}

// All BA 1.7.4 metadata is classified. Only the selected callback is public;
// every other entry is in-process or disabled until its named consumer exists.
const classified = {
  signInSocial: ['/sign-in/social', 'POST'], callbackOAuth: ['/callback/:id', 'GET,POST'],
  getSession: ['/get-session', 'GET,POST'], signOut: ['/sign-out', 'POST'],
  signUpEmail: ['/sign-up/email', 'POST'], signInEmail: ['/sign-in/email', 'POST'],
  resetPassword: ['/reset-password', 'POST'], verifyPassword: ['/verify-password', 'POST'],
  verifyEmail: ['/verify-email', 'GET'], sendVerificationEmail: ['/send-verification-email', 'POST'],
  changeEmail: ['/change-email', 'POST'], changePassword: ['/change-password', 'POST'], setPassword: [undefined, 'POST'],
  updateSession: ['/update-session', 'POST'], updateUser: ['/update-user', 'POST'], deleteUser: ['/delete-user', 'POST'],
  requestPasswordReset: ['/request-password-reset', 'POST'], requestPasswordResetCallback: ['/reset-password/:token', 'GET'],
  listSessions: ['/list-sessions', 'GET'], revokeSession: ['/revoke-session', 'POST'], revokeSessions: ['/revoke-sessions', 'POST'],
  revokeOtherSessions: ['/revoke-other-sessions', 'POST'], linkSocialAccount: ['/link-social', 'POST'], listUserAccounts: ['/list-accounts', 'GET'],
  deleteUserCallback: ['/delete-user/callback', 'GET'], unlinkAccount: ['/unlink-account', 'POST'],
  refreshToken: ['/refresh-token', 'POST'], getAccessToken: ['/get-access-token', 'POST'], accountInfo: ['/account-info', 'GET'],
  ok: ['/ok', 'GET'], error: ['/error', 'GET'],
} satisfies Record<string, readonly [string | undefined, string]>

export function assertEndpointClassification(api: Record<string, { path?: string; options: { method?: string | string[]; metadata?: Record<string, unknown> } }>, magic = false, enrollment = false, firstGoogle = false, googleAccount = false, sessionManagement = false, recovery = false) {
  const expected = new Map(Object.entries(classified))
  if (recovery) {
    expected.set('rotateApplicationRecoveryCodes', ['/application/recovery/codes/rotate', 'POST'])
    expected.set('beginApplicationRecoveryGoogleProof', ['/application/recovery/google/begin', 'POST'])
    expected.set('completeApplicationRecoveryGoogleProof', ['/application/recovery/google/complete', 'GET'])
  }
  if (sessionManagement) expected.set('manageApplicationSessions', ['/application/session-management', 'POST'])
  if (magic) expected.set('consumeApplicationMagic', ['/application/magic/consume', 'POST'])
  if (googleAccount) {
    expected.set('authorizeApplicationGoogleAccount', ['/application/account/google/authorize', 'POST'])
    expected.set('completeApplicationGoogleAccount', ['/application/account/google/complete', 'GET'])
    expected.set('mutateApplicationGoogleAccount', ['/application/account/google/mutate', 'POST'])
  }
  if (firstGoogle) {
    expected.set('beginApplicationFirstGooglePasskey', ['/application/first-passkey/google/begin', 'POST'])
    expected.set('completeApplicationFirstGooglePasskey', ['/application/first-passkey/google/complete', 'GET'])
  }
  if (enrollment) {
    expected.set('generatePasskeyRegistrationOptions', ['/passkey/generate-register-options', 'GET'])
    expected.set('generatePasskeyAuthenticationOptions', ['/passkey/generate-authenticate-options', 'GET'])
    expected.set('verifyPasskeyRegistration', ['/passkey/verify-registration', 'POST'])
    expected.set('verifyPasskeyAuthentication', ['/passkey/verify-authentication', 'POST'])
    expected.set('listPasskeys', ['/passkey/list-user-passkeys', 'GET'])
    expected.set('deletePasskey', ['/passkey/delete-passkey', 'POST'])
    expected.set('updatePasskey', ['/passkey/update-passkey', 'POST'])
  }
  if (Object.keys(api).length !== expected.size) throw new Error('Unclassified auth endpoint')
  for (const [name, endpoint] of Object.entries(api)) {
    const known = expected.get(name)
    const methods = Array.isArray(endpoint.options.method) ? endpoint.options.method.join(',') : endpoint.options.method
    if (!known || endpoint.path !== known[0] || methods !== known[1]
      || ['manageApplicationSessions', 'consumeApplicationMagic', 'beginApplicationFirstGooglePasskey', 'completeApplicationFirstGooglePasskey', 'authorizeApplicationGoogleAccount', 'completeApplicationGoogleAccount', 'mutateApplicationGoogleAccount',
        'rotateApplicationRecoveryCodes', 'beginApplicationRecoveryGoogleProof', 'completeApplicationRecoveryGoogleProof'].includes(name) && endpoint.options.metadata?.SERVER_ONLY !== true) throw new Error('Unclassified auth endpoint')
  }
}

export async function magicConsumeResponse(request: Request, input: unknown,
  auth: ReturnType<typeof createApplicationAuth>, limiter: ReturnType<typeof createAuthRateLimiter>) {
  try {
    const result = await auth.consumeMagicLink(request, input)
    // This is the actual route publication point; native payloads and error
    // headers never become an application Response. Await includes COMMIT and
    // invocation completion, just as publishCookies does for server functions.
    const headers = new Headers({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
    for (const cookie of result.headers.getSetCookie()) headers.append('set-cookie', cookie)
    return Response.json('enrollmentRequired' in result ? { enrollmentRequired: true, options: result.options } : { authenticated: true }, { headers })
  } catch (error) {
    const mapped = auth.magicErrorResponse(error)
    if (mapped) return mapped
    if (error instanceof Response && error.status === 503) return new Response('Service Unavailable', { status: 503 })
    return limiter.errorResponse(error) ?? new Response('Internal Server Error', { status: 500 })
  }
}
export async function magicEnrollmentResponse(request: Request, input: unknown,
  auth: ReturnType<typeof createApplicationAuth>, limiter: ReturnType<typeof createAuthRateLimiter>) {
  try {
    const result = await auth.completeMagicEnrollment(request, input)
    if (!('authenticated' in result) || result.authenticated !== true) throw new Error('Authentication unavailable')
    const headers = new Headers({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
    for (const cookie of result.headers.getSetCookie()) headers.append('set-cookie', cookie)
    return Response.json({ authenticated: true }, { headers })
  } catch (error) {
    const mapped = auth.magicErrorResponse(error)
    if (mapped) return mapped
    if (error instanceof Response && error.status === 503) return new Response('Service Unavailable', { status: 503 })
    return limiter.errorResponse(error) ?? new Response('Internal Server Error', { status: 500 })
  }
}
export function isPublicAuthRequest(request: Pick<Request, 'url' | 'method'>, origin: string): boolean {
  // Compare the received spelling before URL normalization can erase dots,
  // backslashes or encoded segments. Origin is validated server configuration.
  const canonical = origin + '/api/auth/callback/google'
  return request.method === 'GET' && (request.url === canonical || request.url.startsWith(canonical + '?'))
}
export async function firstGooglePasskeyCallbackResponse(request: Request, auth: ReturnType<typeof createApplicationAuth>, limiter: ReturnType<typeof createAuthRateLimiter>) {
  const headers = new Headers({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
  try {
    const result = await auth.completeFirstGooglePasskeyOAuth(request)
    headers.set('location', result.url)
    for (const cookie of result.headers.getSetCookie()) headers.append('set-cookie', cookie)
    return new Response(null, { status: 303, headers })
  } catch (error) {
    const mapped = auth.firstGooglePasskeyErrorResponse(error) ?? limiter.errorResponse(error)
    // Any possible execution failure remains unconfirmed; no native/provider payload escapes.
    if (mapped) {
      mapped.headers.forEach((value, name) => headers.set(name, value))
      return new Response(mapped.body, { status: mapped.status, headers })
    }
    return new Response('Authentication outcome unconfirmed', { status: 500, headers })
  }
}
