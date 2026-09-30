import { StrictMode, startTransition } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { StartClient } from '@tanstack/react-start/client'
import { installMagicFragmentGuard } from './ui/auth/magic-fragment'
import { magicMessages } from './ui/auth/messages'

if (installMagicFragmentGuard()) {
  startTransition(() => {
    hydrateRoot(document, <StrictMode><StartClient /></StrictMode>)
  })
} else {
  // Router must never initialize against a URL that failed native cleaning.
  // Keep the SSR shell and its safe escape link, without enabling auth controls.
  const failure = document.createElement('p')
  failure.setAttribute('role', 'alert')
  failure.textContent = magicMessages[document.documentElement.lang === 'en' ? 'en' : 'fr'].clearFailed
  document.querySelector('main [role="status"]')?.replaceWith(failure)
}
