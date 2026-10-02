import type { ReactNode } from 'react'
import { Heading } from '@astryxdesign/core/Heading'

// Shared page chrome for the confirmation ceremony and route fallback screens.
// Children retain ownership of announcements, recovery links and controls.
export function AuthScreen({ title, children }: { title: string; children: ReactNode }) {
  return <main className="auth-content auth-screen">
    <a className="auth-brand" href="/">sparra</a>
    <header className="auth-heading"><Heading level={1}>{title}</Heading></header>
    {children}
  </main>
}
