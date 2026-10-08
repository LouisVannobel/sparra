import { createFileRoute } from '@tanstack/react-router'
import { SparraLanding } from '../ui/marketing/sparra-landing'
import stylesheet from '../ui/marketing/marketing.css?url'

export const Route = createFileRoute('/')({
  head: () => ({
    meta: [
      { title: 'Sparra — votre assistant téléphonique IA' },
      { name: 'description', content: 'Sparra est un assistant téléphonique IA pour les professionnels locaux. Découvrez sa démo et son pilote : répondre aux appels et transmettre les demandes à votre équipe.' },
    ],
    links: [{ rel: 'canonical', href: 'https://sparra.fr/' }, { rel: 'stylesheet', href: stylesheet }],
  }),
  component: SparraLanding,
})
