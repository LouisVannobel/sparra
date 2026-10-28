import { createFileRoute } from '@tanstack/react-router'
import { DiagnosticLanding } from '../ui/marketing/diagnostic-landing'
import { marketingHead } from '../ui/marketing/marketing-head'

const title = 'Vos appels accueillis pendant vos diagnostics. — Sparra'
const description = 'Un pilote accompagné de réception téléphonique pour les diagnostiqueurs immobiliers : recueillir les demandes avant votre rappel ou votre devis.'
const canonicalUrl = 'https://sparra.fr/metiers/diagnostic-immobilier'

export const Route = createFileRoute('/metiers/diagnostic-immobilier')({
  head: () => marketingHead({ title, description, canonicalUrl }),
  component: DiagnosticLanding,
})
