import { createFileRoute } from '@tanstack/react-router'
import { DiagnosticLanding } from '../ui/marketing/diagnostic-landing'
import stylesheet from '../ui/marketing/marketing.css?url'

const title = 'Vos appels accueillis pendant vos diagnostics. — Sparra'
const description = 'Un pilote accompagné de réception téléphonique pour les diagnostiqueurs immobiliers : recueillir les demandes avant votre rappel ou votre devis.'
const canonicalUrl = 'https://sparra.fr/metiers/diagnostic-immobilier'

export const Route = createFileRoute('/metiers/diagnostic-immobilier')({
  head: () => ({
    meta: [
      { title }, { name: 'description', content: description },
      { property: 'og:type', content: 'website' }, { property: 'og:title', content: title },
      { property: 'og:description', content: description }, { property: 'og:url', content: canonicalUrl },
      { property: 'og:site_name', content: 'Sparra' }, { property: 'og:locale', content: 'fr_FR' },
      { name: 'twitter:card', content: 'summary' }, { name: 'twitter:title', content: title },
      { name: 'twitter:description', content: description },
    ],
    links: [{ rel: 'canonical', href: canonicalUrl }, { rel: 'stylesheet', href: stylesheet }, { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
  }),
  component: DiagnosticLanding,
})
