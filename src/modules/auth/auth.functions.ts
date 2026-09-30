import { createMiddleware, createServerFn, createServerOnlyFn } from '@tanstack/react-start'
import { getRequest, setResponseHeader } from '@tanstack/react-start/server'
import { Schema } from 'effect'
import { requestResources } from '../../platform/resources.server'

const localeInput = Schema.Struct({ locale: Schema.Literals(['fr', 'en']) })
// Start serializes function errors before request middleware can catch them.
// Use the process owner's mapper at this actual function boundary as well.
const authErrors = createMiddleware({ type: 'function' }).server(async ({ next }) => {
  try { return await next() }
  catch (error) {
    if (error instanceof Response) throw error
    throw requestResources(getRequest()).limiter.errorResponse(error) ?? new Response('Internal Server Error', { status: 500 })
  }
})
function configuredAuth() {
  const auth = requestResources(getRequest()).auth
  if (!auth) throw new Response('Service Unavailable', { status: 503 })
  return auth
}
function publishCookies(headers: Headers) {
  setResponseHeader('set-cookie', headers.getSetCookie())
  setResponseHeader('cache-control', 'no-store')
}
export const getLoginAvailability = createServerFn({ method: 'GET' }).middleware([authErrors]).handler(() => {
  setResponseHeader('cache-control', 'no-store')
  return requestResources(getRequest()).auth?.availability ?? { google: false, magic: false, magicSignup: false, passkey: false }
})
export const beginGoogleSignIn = createServerFn({ method: 'POST' })
  .middleware([authErrors])
  .validator((input: unknown) => Schema.decodeUnknownSync(localeInput, { onExcessProperty: 'error' })(input))
  .handler(async ({ data }) => {
    const result = await configuredAuth().beginGoogleSignIn(getRequest(), data.locale)
    publishCookies(result.headers)
    return { url: result.url }
  })
export const beginPasskeySignIn = createServerFn({ method: 'POST' })
  .middleware([authErrors])
  .handler(async () => {
    const auth = configuredAuth()
    try {
      const result = await auth.beginPasskeySignIn(getRequest())
      publishCookies(result.headers)
      return { options: result.options }
    } catch (error) { throw auth.passkeyErrorResponse(error) ?? error }
  })
export const finishPasskeySignIn = createServerFn({ method: 'POST' })
  .middleware([authErrors])
  // The private factory charges the limiter before strict assertion decoding.
  .validator((input: unknown) => input)
  .handler(async ({ data }) => {
    const auth = configuredAuth()
    try {
      const result = await auth.finishPasskeySignIn(getRequest(), data)
      publishCookies(result.headers)
      return { authenticated: result.authenticated }
    } catch (error) { throw auth.passkeyErrorResponse(error) ?? error }
  })
export const getAccount = createServerFn({ method: 'GET' }).middleware([authErrors]).handler(async () => {
  setResponseHeader('cache-control', 'no-store')
  const request = getRequest()
  return configuredAuth().readAccount(request)
})
export const beginSessionRevocation = createServerFn({ method: 'POST' }).middleware([authErrors]).validator((input: unknown) => input).handler(async ({ data }) => {
  setResponseHeader('cache-control', 'no-store'); setResponseHeader('pragma', 'no-cache'); setResponseHeader('referrer-policy', 'no-referrer')
  const auth = configuredAuth()
  try { return await auth.beginSessionRevocation(getRequest(), data) } catch (error) { throw auth.sessionManagementErrorResponse(error) ?? error }
})
export const beginSessionList = createServerFn({ method: 'POST' }).middleware([authErrors]).validator((input: unknown) => input).handler(async ({ data }) => {
  setResponseHeader('cache-control', 'no-store'); setResponseHeader('pragma', 'no-cache'); setResponseHeader('referrer-policy', 'no-referrer')
  const auth = configuredAuth()
  try { return await auth.beginSessionList(getRequest(), data) } catch (error) { throw auth.sessionManagementErrorResponse(error) ?? error }
})
export const finishSessionList = createServerFn({ method: 'POST' }).middleware([authErrors]).validator((input: unknown) => input).handler(async ({ data }) => {
  setResponseHeader('cache-control', 'no-store'); setResponseHeader('pragma', 'no-cache'); setResponseHeader('referrer-policy', 'no-referrer')
  const auth = configuredAuth()
  try { return await auth.finishSessionList(getRequest(), data) } catch (error) { throw auth.sessionManagementErrorResponse(error) ?? error }
})
export const finishSessionRevocation = createServerFn({ method: 'POST' }).middleware([authErrors]).validator((input: unknown) => input).handler(async ({ data }) => {
  setResponseHeader('cache-control', 'no-store'); setResponseHeader('pragma', 'no-cache'); setResponseHeader('referrer-policy', 'no-referrer')
  const auth = configuredAuth()
  try { return await auth.finishSessionRevocation(getRequest(), data) } catch (error) { throw auth.sessionManagementErrorResponse(error) ?? error }
})
export const beginGoogleAccountLink = createServerFn({ method: 'POST' }).middleware([authErrors]).validator((input: unknown) => input).handler(async ({ data }) => {
  const auth = configuredAuth()
  setResponseHeader('cache-control', 'no-store'); setResponseHeader('referrer-policy', 'no-referrer')
  try { return await auth.beginGoogleAccountLink(getRequest(), data) } catch (error) { throw auth.googleAccountErrorResponse(error) ?? error }
})
export const authorizeGoogleAccountLink = createServerFn({ method: 'POST' }).middleware([authErrors]).validator((input: unknown) => input).handler(async ({ data }) => {
  const auth = configuredAuth()
  setResponseHeader('cache-control', 'no-store'); setResponseHeader('referrer-policy', 'no-referrer')
  try {
    const result = await auth.authorizeGoogleAccountLink(getRequest(), data)
    publishCookies(result.headers)
    return { intentId: result.intentId, url: result.url }
  } catch (error) { throw auth.googleAccountErrorResponse(error) ?? error }
})
export const beginGoogleAccountUnlink = createServerFn({ method: 'POST' }).middleware([authErrors]).validator((input: unknown) => input).handler(async ({ data }) => {
  const auth = configuredAuth()
  setResponseHeader('cache-control', 'no-store'); setResponseHeader('referrer-policy', 'no-referrer')
  try { return await auth.beginGoogleAccountUnlink(getRequest(), data) } catch (error) { throw auth.googleAccountErrorResponse(error) ?? error }
})
export const finishGoogleAccountUnlink = createServerFn({ method: 'POST' }).middleware([authErrors]).validator((input: unknown) => input).handler(async ({ data }) => {
  const auth = configuredAuth()
  setResponseHeader('cache-control', 'no-store'); setResponseHeader('referrer-policy', 'no-referrer')
  try { return await auth.finishGoogleAccountUnlink(getRequest(), data) } catch (error) { throw auth.googleAccountErrorResponse(error) ?? error }
})
export const readGoogleAccountIntent = createServerFn({ method: 'POST' }).middleware([authErrors]).validator((input: unknown) => input).handler(async ({ data }) => {
  const auth = configuredAuth()
  setResponseHeader('cache-control', 'no-store'); setResponseHeader('referrer-policy', 'no-referrer')
  try { return await auth.readGoogleAccountIntent(getRequest(), data) } catch (error) { throw auth.googleAccountErrorResponse(error) ?? error }
})
export const cancelGoogleAccountIntent = createServerFn({ method: 'POST' }).middleware([authErrors]).validator((input: unknown) => input).handler(async ({ data }) => {
  const auth = configuredAuth()
  setResponseHeader('cache-control', 'no-store'); setResponseHeader('referrer-policy', 'no-referrer')
  try { return await auth.cancelGoogleAccountIntent(getRequest(), data) } catch (error) { throw auth.googleAccountErrorResponse(error) ?? error }
})
export const beginAdditionalPasskey = createServerFn({ method: 'POST' }).middleware([authErrors]).handler(async () => {
  const auth = configuredAuth()
  setResponseHeader('cache-control', 'no-store')
  try { return await auth.beginAdditionalPasskey(getRequest()) }
  catch (error) { throw auth.additionalPasskeyErrorResponse(error) ?? error }
})
export const authorizeAdditionalPasskey = createServerFn({ method: 'POST' }).middleware([authErrors])
  .validator((input: unknown) => input).handler(async ({ data }) => {
    const auth = configuredAuth()
    setResponseHeader('cache-control', 'no-store')
    try {
      const result = await auth.authorizeAdditionalPasskey(getRequest(), data)
      publishCookies(result.headers)
      return { intentId: result.intentId, expiresAt: result.expiresAt, options: result.options }
    } catch (error) { throw auth.additionalPasskeyErrorResponse(error) ?? error }
  })
export const finishAdditionalPasskey = createServerFn({ method: 'POST' }).middleware([authErrors])
  .validator((input: unknown) => input).handler(async ({ data }) => {
    const auth = configuredAuth()
    setResponseHeader('cache-control', 'no-store')
    try { return await auth.finishAdditionalPasskey(getRequest(), data) }
    catch (error) { throw auth.additionalPasskeyErrorResponse(error) ?? error }
  })
export const logout = createServerFn({ method: 'POST' }).middleware([authErrors]).handler(async () => {
  const result = await configuredAuth().logout(getRequest())
  publishCookies(result.headers)
  return { signedOut: true }
})
export const beginFirstGooglePasskey = createServerFn({ method: 'POST' }).middleware([authErrors])
  .validator((input: unknown) => input).handler(async ({ data }) => {
    const auth = configuredAuth()
    setResponseHeader('cache-control', 'no-store'); setResponseHeader('referrer-policy', 'no-referrer')
    try {
      const result = await auth.beginFirstGooglePasskey(getRequest(), data)
      publishCookies(result.headers)
      return { url: result.url, intentId: result.intentId }
    } catch (error) { throw auth.firstGooglePasskeyErrorResponse(error) ?? error }
  })
export const readFirstGooglePasskey = createServerFn({ method: 'POST' }).middleware([authErrors])
  .validator((input: unknown) => input).handler(async ({ data }) => {
    const auth = configuredAuth()
    setResponseHeader('cache-control', 'no-store'); setResponseHeader('referrer-policy', 'no-referrer')
    try { return await auth.readFirstGooglePasskey(getRequest(), data) }
    catch (error) { throw auth.firstGooglePasskeyErrorResponse(error) ?? error }
  })
export const prepareFirstGooglePasskey = createServerFn({ method: 'POST' }).middleware([authErrors])
  .validator((input: unknown) => input).handler(async ({ data }) => {
    const auth = configuredAuth()
    setResponseHeader('cache-control', 'no-store'); setResponseHeader('referrer-policy', 'no-referrer')
    try {
      const result = await auth.prepareFirstGooglePasskey(getRequest(), data)
      publishCookies(result.headers)
      return { intentId: result.intentId, expiresAt: result.expiresAt, options: result.options }
    } catch (error) { throw auth.firstGooglePasskeyErrorResponse(error) ?? error }
  })
export const finishFirstGooglePasskey = createServerFn({ method: 'POST' }).middleware([authErrors])
  .validator((input: unknown) => input).handler(async ({ data }) => {
    const auth = configuredAuth()
    setResponseHeader('cache-control', 'no-store'); setResponseHeader('referrer-policy', 'no-referrer')
    try { return await auth.finishFirstGooglePasskey(getRequest(), data) }
    catch (error) { throw auth.firstGooglePasskeyErrorResponse(error) ?? error }
  })
export const cancelFirstGooglePasskey = createServerFn({ method: 'POST' }).middleware([authErrors])
  .validator((input: unknown) => input).handler(async ({ data }) => {
    const auth = configuredAuth()
    setResponseHeader('cache-control', 'no-store'); setResponseHeader('referrer-policy', 'no-referrer')
    try { return await auth.cancelFirstGooglePasskey(getRequest(), data) }
    catch (error) { throw auth.firstGooglePasskeyErrorResponse(error) ?? error }
  })
export const validateMagicRequestForm = createServerOnlyFn((input: unknown) => {
  try { return Schema.decodeUnknownSync(Schema.Struct({ email: Schema.String, locale: Schema.Literals(['fr', 'en']) }), { onExcessProperty: 'error' })(input) }
  catch { throw new Response('Authentication rejected', { status: 400 }) }
})
export const requestMagicLink = createServerFn({ method: 'POST' }).middleware([authErrors])
  .validator(validateMagicRequestForm)
  .handler(async ({ data }) => {
    const auth = configuredAuth()
    try {
      const result = await auth.requestMagicLink(getRequest(), data)
      setResponseHeader('cache-control', 'no-store')
      return result
    } catch (error) {
      // The configured factory owns class identity across Nitro/SSR copies.
      // Deliberate email refusals reach the caller before generic error mapping.
      throw auth.magicErrorResponse(error) ?? error
    }
  })
