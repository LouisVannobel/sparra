import { createMiddleware, createServerFn } from '@tanstack/react-start'
import { getRequest, setResponseHeader } from '@tanstack/react-start/server'
import { requestResources } from '../../platform/resources.server'
import { parseBillingInput } from './checkout.server'

const billingErrors = createMiddleware({ type: 'function' }).server(async ({ next }) => {
  setResponseHeader('cache-control', 'no-store')
  try { return await next() }
  catch (error) {
    if (error instanceof Response) throw error
    throw new Response('Billing unavailable', { status: 503 })
  }
})

export const getBilling = createServerFn({ method: 'GET' }).middleware([billingErrors])
  .validator((input: unknown) => parseBillingInput(input))
  .handler(async ({ data }) => {
    const request = getRequest(), resources = requestResources(request)
    if (!resources.billing) throw new Response('Billing unavailable', { status: 503 })
    return resources.billing.readBilling(request, data)
  })

export const startBillingCheckout = createServerFn({ method: 'POST' }).middleware([billingErrors])
  .validator((input: unknown) => parseBillingInput(input))
  .handler(async ({ data }) => {
    const request = getRequest(), resources = requestResources(request)
    if (!resources.billing) throw new Response('Billing unavailable', { status: 503 })
    return resources.billing.startBillingCheckout(request, data)
  })

export const cancelBillingAtPeriodEnd = createServerFn({ method: 'POST' }).middleware([billingErrors])
  .validator((input: unknown) => parseBillingInput(input))
  .handler(async ({ data }) => {
    const request = getRequest(), resources = requestResources(request)
    if (!resources.billing) throw new Response('Billing unavailable', { status: 503 })
    return resources.billing.cancelBillingAtPeriodEnd(request, data)
  })
