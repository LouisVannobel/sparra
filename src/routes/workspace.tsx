import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useState } from 'react'
import { getWorkspace, ensurePersonalWorkspace, renameWorkspace } from '../modules/workspaces/workspace.functions'
import { WorkspacePanel, workspaceMessages } from '../ui/workspaces/workspace-panel'

export const Route = createFileRoute('/workspace')({
  loaderDeps: ({ search }) => ({ lang: search.lang }),
  loader: async ({ deps }) => {
    try {
      const result = await getWorkspace({ data: {} })
      // Client RPC returns raw Responses; the SSR call can throw them.
      if (result instanceof Response) throw result
      return result
    } catch (error) {
      if (error instanceof Response && error.status === 401) throw redirect({ to: '/login', search: { lang: deps.lang, error: undefined } })
      throw new Error('Workspace unavailable')
    }
  }, component: Workspace,
  pendingMs: 150, pendingMinMs: 150,
  pendingComponent: () => { const { lang } = Route.useSearch(); return <main className="auth-content"><p role="status">{workspaceMessages[lang].loading}</p></main> },
  errorComponent: () => { const { lang } = Route.useSearch(); return <main className="auth-content"><p role="alert">{workspaceMessages[lang].unavailable}</p><a href={`/login?lang=${lang}`}>{workspaceMessages[lang].login}</a></main> },
})
function Workspace() {
  const { lang } = Route.useSearch(), workspace = Route.useLoaderData(), router = useRouter()
  const ensure = useServerFn(ensurePersonalWorkspace), rename = useServerFn(renameWorkspace)
  const [pending, setPending] = useState(false), [failed, setFailed] = useState(false), [saved, setSaved] = useState(false)
  async function persist(name?: string) {
    if (pending) return
    setPending(true); setFailed(false); setSaved(false)
    try {
      const result = name === undefined ? await ensure()
        : workspace ? await rename({ data: { workspaceId: workspace.id, displayName: name } }) : null
      if (!result || result instanceof Response) throw new Error('Workspace unavailable')
      await router.invalidate({ sync: true })
      setSaved(name !== undefined)
    } catch { setFailed(true) }
    finally { setPending(false) }
  }
  return <WorkspacePanel key={workspace ? workspace.id + workspace.displayName : 'absent'} locale={lang} workspace={workspace} pending={pending} failed={failed} saved={saved} onEnsure={() => persist()} onRename={persist} />
}
