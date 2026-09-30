import { createMiddleware, createServerFn } from '@tanstack/react-start'
import { getRequest, setResponseHeader } from '@tanstack/react-start/server'
import { Schema } from 'effect'
import { requestResources } from '../../platform/resources.server'

const workspaceErrors = createMiddleware({ type: 'function' }).server(async ({ next }) => {
  setResponseHeader('cache-control', 'no-store')
  try { return await next() }
  catch (error) {
    if (error instanceof Response) throw error
    // Nitro owns the operations; SSR has a separate module graph. Use the
    // fixed safe error name across that boundary, not class identity.
    const invalidName = error instanceof Error && error.name === 'InvalidDisplayName'
    throw new Response('Workspace unavailable', { status: Schema.isSchemaError(error) || invalidName ? 400 : 500 })
  }
})
const selector = Schema.Struct({ workspaceId: Schema.optional(Schema.String.check(Schema.isUUID())) })
const renameInput = Schema.Struct({ workspaceId: Schema.String.check(Schema.isUUID()), displayName: Schema.String })
export const getWorkspace = createServerFn({ method: 'GET' }).middleware([workspaceErrors])
  .validator((input: unknown) => Schema.decodeUnknownSync(selector, { onExcessProperty: 'error' })(input))
  .handler(async ({ data }) => {
    const request = getRequest(), resources = requestResources(request)
    if (!resources.auth) throw new Response('Unauthorized', { status: 401 })
    const principal = await resources.auth.requirePrincipal(request)
    return resources.workspaces.readWorkspace(principal, data.workspaceId, request.signal)
  })
export const ensurePersonalWorkspace = createServerFn({ method: 'POST' }).middleware([workspaceErrors]).handler(async () => {
  const request = getRequest(), resources = requestResources(request)
  if (!resources.auth) throw new Response('Unauthorized', { status: 401 })
  const principal = await resources.auth.requirePrincipal(request)
  const workspace = await resources.workspaces.ensurePersonalWorkspace(principal, request.signal)
  if (!workspace) throw new Response('Workspace unavailable', { status: 404 })
  return workspace
})
export const renameWorkspace = createServerFn({ method: 'POST' }).middleware([workspaceErrors])
  .validator((input: unknown) => Schema.decodeUnknownSync(renameInput, { onExcessProperty: 'error' })(input))
  .handler(async ({ data }) => {
    const request = getRequest(), resources = requestResources(request)
    if (!resources.auth) throw new Response('Unauthorized', { status: 401 })
    const principal = await resources.auth.requirePrincipal(request)
    const workspace = await resources.workspaces.renameWorkspace(principal, data.workspaceId, data.displayName, request.signal)
    if (!workspace) throw new Response('Workspace unavailable', { status: 404 })
    return workspace
  })
