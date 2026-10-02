import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterContextProvider } from '@tanstack/react-router'
import { resolveLocale } from '../../src/ui/auth/messages'

export async function renderPrivatePanel(node: ReactNode, location: string) {
  const root = createRootRoute({ validateSearch: (search: { lang?: unknown }) => ({ lang: resolveLocale(search.lang) }) })
  const routes = ['/app', '/app/entreprise', '/account', '/workspace'].map(path => createRoute({ path, getParentRoute: () => root }))
  const router = createRouter({ routeTree: root.addChildren(routes), history: createMemoryHistory({ initialEntries: [location] }), isServer: true })
  await router.load()
  return renderToStaticMarkup(<RouterContextProvider router={router}>{node}</RouterContextProvider>)
}
