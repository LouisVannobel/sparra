import { createFileRoute } from '@tanstack/react-router'
import { SparraLanding } from '../ui/marketing/sparra-landing'
import stylesheet from '../ui/marketing/marketing.css?url'

const title = 'Sparra — votre assistant téléphonique IA'
const description = 'Sparra est un assistant téléphonique IA pour les professionnels locaux. Découvrez sa démo et son pilote : répondre aux appels et transmettre les demandes à votre équipe.'
const canonicalUrl = 'https://sparra.fr/'

export const Route = createFileRoute('/')({
  head: () => ({
    meta: [
      { title },
      { name: 'description', content: description },
      { property: 'og:type', content: 'website' },
      { property: 'og:title', content: title },
      { property: 'og:description', content: description },
      { property: 'og:url', content: canonicalUrl },
      { property: 'og:site_name', content: 'Sparra' },
      { property: 'og:locale', content: 'fr_FR' },
      { name: 'twitter:card', content: 'summary' },
      { name: 'twitter:title', content: title },
      { name: 'twitter:description', content: description },
    ],
    links: [{ rel: 'canonical', href: canonicalUrl }, { rel: 'stylesheet', href: stylesheet }],
  }),
  component: SparraLanding,
})
