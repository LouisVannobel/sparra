import type { WorkspaceDto } from '../../modules/workspaces/personal.server'
import type { Locale } from '../auth/messages'
import { useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { Heading } from '@astryxdesign/core/Heading'
import { TextInput } from '@astryxdesign/core/TextInput'
import { useHydrated } from '@tanstack/react-router'
import { AppShell } from '../sparra/app-shell'

export const workspaceMessages = {
  fr: { title: 'Votre espace personnel', create: 'Créer mon espace', empty: 'Créez votre espace personnel pour commencer.', name: 'Nom affiché', help: '80 caractères maximum, sur une seule ligne.', save: 'Enregistrer le nom', saved: 'Nom enregistré.', pending: 'Enregistrement en cours…', loading: 'Chargement…', failed: 'Enregistrement impossible. Vérifiez le nom ou reconnectez-vous.', back: 'Retour au compte', unavailable: 'Espace indisponible.', login: 'Aller à la connexion' },
  en: { title: 'Your personal workspace', create: 'Create my workspace', empty: 'Create your personal workspace to get started.', name: 'Display name', help: 'Up to 80 characters, on one line.', save: 'Save name', saved: 'Name saved.', pending: 'Saving…', loading: 'Loading…', failed: 'Unable to save. Check the name or sign in again.', back: 'Back to account', unavailable: 'Workspace unavailable.', login: 'Go to sign in' },
} as const

type Props = { locale: Locale; workspace: WorkspaceDto | null; pending: boolean; failed: boolean; saved: boolean; onEnsure(): Promise<void>; onRename(name: string): Promise<void> }
export function WorkspacePanel({ locale, workspace, pending, failed, saved, onEnsure, onRename }: Props) {
  const t = workspaceMessages[locale]
  const hydrated = useHydrated()
  const [name, setName] = useState(workspace?.displayName ?? '')
  return <AppShell locale={locale}><section className="auth-content auth-workspace">
    <a className="auth-back" href={`/account?lang=${locale}`}>{t.back}</a>
    <Heading level={1}>{t.title}</Heading>
    {workspace ? <><p data-workspace-name>{workspace.displayName}</p>
      <form className="workspace-form" aria-busy={pending} onSubmit={event => { event.preventDefault(); if (!pending) void onRename(name) }}>
        <TextInput label={t.name} description={t.help} htmlName="displayName" value={name} onChange={setName} isRequired isDisabled={pending || !hydrated} width="100%" size="lg" />
        <Button label={t.save} type="submit" variant="primary" size="lg" isLoading={pending} isDisabled={!hydrated} />
      </form></> : <><p>{t.empty}</p><Button label={t.create} variant="primary" size="lg" isLoading={pending} isDisabled={!hydrated} onClick={() => { if (!pending) void onEnsure() }} /></>}
    {pending && <p role="status">{t.pending}</p>}{failed && <p role="alert">{t.failed}</p>}{saved && <p role="status">{t.saved}</p>}
  </section></AppShell>
}
