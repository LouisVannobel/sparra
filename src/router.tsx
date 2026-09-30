import { createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'
import { createIsomorphicFn } from '@tanstack/react-start'
import { readRequestNonce } from './platform/csp.server'

const nonce = createIsomorphicFn().server(readRequestNonce).client(() => document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce)

export function getRouter() {
  return createRouter({ routeTree, scrollRestoration: true, ssr: { nonce: nonce() } })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
