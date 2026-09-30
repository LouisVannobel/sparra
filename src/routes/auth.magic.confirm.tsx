import { createFileRoute } from '@tanstack/react-router'
import { MagicConfirmPanel } from '../ui/auth/magic-confirm-panel'
import { magicMessages } from '../ui/auth/messages'

// A non-mutating shell: no server loader, session lookup or proof inspection.
export const Route = createFileRoute('/auth/magic/confirm')({
  head: ({ match }) => ({ meta: [{ title: magicMessages[match.search.lang].confirm }] }),
  component: () => { const { lang } = Route.useSearch(); return <MagicConfirmPanel locale={lang} /> },
})
