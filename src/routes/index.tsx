import { createFileRoute } from '@tanstack/react-router'
import { SparraLanding } from '../ui/marketing/sparra-landing'
import stylesheet from '../ui/marketing/marketing.css?url'

export const Route = createFileRoute('/')({
  head: () => ({
    meta: [
      { title: 'Sparra — votre assistant téléphonique IA' },
      { name: 'description', content: 'Sparra prépare un assistant téléphonique IA pour les professionnels locaux : répondre aux appels, recueillir les demandes et transmettre l’essentiel à votre équipe.' },
    ],
    links: [{ rel: 'canonical', href: 'https://sparra.fr/' }, { rel: 'stylesheet', href: stylesheet }],
  }),
  component: SparraLanding,
})
