import { createFileRoute } from '@tanstack/react-router'
import { SparraLanding } from '../ui/marketing/sparra-landing'
import { marketingHead } from '../ui/marketing/marketing-head'

const title = 'Sparra — votre assistant téléphonique IA'
const description = 'Sparra est un assistant téléphonique IA pour les professionnels locaux. Découvrez sa démo et son pilote : répondre aux appels et transmettre les demandes à votre équipe.'
const canonicalUrl = 'https://sparra.fr/'

export const Route = createFileRoute('/')({
  head: () => marketingHead({ title, description, canonicalUrl }),
  component: SparraLanding,
})
