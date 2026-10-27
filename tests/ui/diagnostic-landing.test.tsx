import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { DiagnosticLanding } from '../../src/ui/marketing/diagnostic-landing'

test('diagnostic reception offers a bounded accompanied pilot and read-only illustrative request', () => {
  const html = renderToStaticMarkup(<DiagnosticLanding />)
  expect(html).toContain('<h1 id="diagnostic-title">Vos appels accueillis pendant vos diagnostics.</h1>')
  expect(html).toContain('Vous êtes en intervention ou déjà au téléphone.')
  expect(html).toContain('Préparer un pilote accompagné')
  expect(html).toContain('mailto:contact@sparra.fr')
  const privateLinks = [...html.matchAll(/href="([^"]*\/app[^\"]*)"/g)].map(match => match[1])
  expect(privateLinks).toEqual(['https://sparra.fr/app?lang=fr', 'https://sparra.fr/app?lang=fr'])
  for (const copy of ['Exemple illustratif', 'sa surface approximative', 'confirmés par le professionnel', 'capacité et un budget explicites', 'avant engagement', 'Rappeler pour préciser le besoin et établir le devis', 'Le professionnel consulte l’Inbox']) expect(html).toContain(copy)
  expect(html).not.toMatch(/<audio|<form|<input|<iframe|<video|<button|témoignage|illimité|rendez-vous confirmé/i)
  expect((html.match(/<li>/g) ?? []).length).toBe(4)
})
