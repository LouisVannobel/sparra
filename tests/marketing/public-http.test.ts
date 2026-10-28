import { afterAll, afterEach, beforeAll, expect, test } from 'vitest'
import { pgWire } from '../fixtures/db/pg-wire'
import { redisWire, tuple } from '../fixtures/db/redis-wire'
import { bounded, startWeb } from '../helpers/web-process'

let pg: Awaited<ReturnType<typeof pgWire>>
let redis: Awaited<ReturnType<typeof redisWire>>
const owned: ReturnType<typeof startWeb>[] = []
beforeAll(async () => {
  pg = await pgWire()
  redis = await redisWire((_, socket) => socket.write(tuple(1, 1, 10000)))
})
afterEach(async () => { for (const child of owned.splice(0)) await child.cleanup() })
afterAll(async () => { await redis.close(); await pg.close() })

async function launch(overrides: Record<string, string> = {}) {
  const child = startWeb({
    DATABASE_URL: pg.url, REDIS_URL: redis.url,
    RATE_LIMIT_HMAC_SECRET: 'public-http-fixture-only-012345678901234567890123456789', RATE_LIMIT_KEY_ID: 'public-http',
    TRUSTED_PROXY_IPS: '127.0.0.2', ...overrides,
  })
  owned.push(child)
  const { port } = await bounded(child.ready)
  return `http://127.0.0.1:${port}`
}

function security(response: Response, indexable: boolean) {
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(response.headers.get('x-robots-tag')).toBe(indexable ? null : 'noindex')
  expect(response.headers.get('referrer-policy')).toBe('no-referrer')
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  const csp = response.headers.get('content-security-policy')!
  expect(csp).toContain("default-src 'none'")
  expect(csp).toContain("object-src 'none'")
  expect(csp).toContain("frame-ancestors 'none'")
  expect(csp).toContain("form-action 'self'")
  expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+'/)
  expect(csp).not.toMatch(/script-src[^;]*(unsafe-inline|unsafe-eval)/)
  if (indexable) expect(csp).toContain("media-src 'self'")
  else expect(csp).not.toContain('media-src')
  return /'nonce-([^']+)'/.exec(csp)![1]
}

test('only successful root documents are indexable', async () => {
  const base = await launch()
  for (const path of ['/', '/?lang=en']) {
    for (const method of ['GET', 'HEAD']) {
      const response = await fetch(`${base}${path}`, { method, redirect: 'manual', signal: AbortSignal.timeout(3000) })
      expect(response.status, `${method} ${path}: ${response.headers.get('location')}`).toBe(200)
      const nonce = security(response, true)
      const html = await response.text()
      if (method === 'HEAD') { expect(html).toBe(''); continue }
      expect(html).toContain('<html lang="fr"')
      expect(html).toContain(`nonce="${nonce}"`)
      expect(html).toContain('Sparra — votre assistant téléphonique IA')
      expect(html).toMatch(/<meta name="description" content="[^"]*appels[^"]*"/)
      expect(html).toContain('<link rel="canonical" href="https://sparra.fr/"')
      expect(html).toContain('mailto:contact@sparra.fr')
      for (const anchor of ['fonctionnement', 'offre', 'controle']) {
        expect(html).toContain(`href="#${anchor}"`)
        expect(html).toContain(`id="${anchor}"`)
      }
      expect(html).not.toMatch(/recoveryGeneration|session_token|AUTH_SECRET|DATABASE_URL|REDIS_URL|public-http-fixture-only/)
      expect(html).not.toContain('auth-language')
    }
  }
  const post = await fetch(`${base}/`, { method: 'POST', signal: AbortSignal.timeout(3000) })
  security(post, false)
})

test('private and missing routes keep their protected headers', async () => {
  const base = await launch()
  for (const path of ['/login', '/login?lang=fr', '/login?lang=en', '/workspace', '/inconnu']) {
    const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(3000) })
    security(response, false)
    const html = await response.text()
    if (path.startsWith('/login')) {
      expect(response.status).toBe(200)
      expect(html).toContain(path === '/login?lang=en' ? '<html lang="en"' : '<html lang="fr"')
      expect(html).toContain('auth-language')
      expect(html).toContain(path === '/login?lang=en' ? 'Sign in' : 'Connexion')
    }
    if (path === '/inconnu') expect(response.status).toBe(404)
  }
})

test('public privacy page explains Calendar use and independent event retention without sign-in', async () => {
  const base = await launch()
  for (const locale of [
    { path: '/confidentialite', lang: 'fr', title: 'Confidentialité', headings: ['Données Google consultées et conservées', 'Utilisation des données Google', 'Destinataires et traitements externes', 'Protection des données', 'Conservation et suppression'], callRetention: '30 jours', eventRetention: 'ne supprime pas les événements', externalProcessing: 'traitements IA externes', uncertain: 'opérations incertaines' },
    { path: '/confidentialite?lang=en', lang: 'en', title: 'Privacy', headings: ['Google data accessed and stored', 'How Google data is used', 'Recipients and external processing', 'Data protection', 'Retention and deletion'], callRetention: '30 days', eventRetention: 'does not delete events', externalProcessing: 'external AI processing', uncertain: 'uncertain operations' },
  ]) {
    const response = await fetch(base + locale.path, { redirect: 'manual', signal: AbortSignal.timeout(3000) })
    expect(response.status).toBe(200)
    security(response, false)
    const html = await response.text()
    const main = /<main\b[^>]*>([\s\S]*?)<\/main>/.exec(html)?.[1]
    expect(main).toBeDefined()
    expect.soft(html).toContain(`<html lang="${locale.lang}"`)
    expect.soft(html).toContain(`<title>${locale.title} — Sparra</title>`)
    expect.soft(main).toContain(`<h1>${locale.title}</h1>`)
    for (const heading of locale.headings) expect.soft(main).toContain(`<h2>${heading}</h2>`)
    for (const disclosure of [locale.callRetention, locale.eventRetention, locale.externalProcessing, locale.uncertain, 'Telnyx', 'OpenRouter', 'AES-256-GCM', 'Limited Use']) expect.soft(main).toContain(disclosure)
    expect(main).toContain('href="/"')
    expect(main).toContain('mailto:contact@sparra.fr')
    expect(main).toContain('href="https://developers.google.com/terms/api-services-user-data-policy"')
    expect(html).not.toMatch(/session_token|AUTH_SECRET|DATABASE_URL|REDIS_URL|public-http-fixture-only/)
  }
  const landing = await fetch(base + '/', { signal: AbortSignal.timeout(3000) })
  expect(await landing.text()).toContain('href="/confidentialite"')
})

test('public SSR exposes the canonical text social metadata', async () => {
  const base = await launch()
  const response = await fetch(base, { signal: AbortSignal.timeout(3000) })
  expect(response.status).toBe(200)
  security(response, true)
  const html = await response.text()
  const head = /<head\b[^>]*>([\s\S]*?)<\/head>/.exec(html)?.[1]
  expect(head).toBeDefined()
  const title = 'Sparra — votre assistant téléphonique IA'
  const description = 'Sparra est un assistant téléphonique IA pour les professionnels locaux. Découvrez sa démo et son pilote : répondre aux appels et transmettre les demandes à votre équipe.'
  expect(head).toContain(`<title>${title}</title>`)
  expect(head).toContain(`<meta name="description" content="${description}"`)
  expect(head).toContain('<link rel="canonical" href="https://sparra.fr/"')
  for (const [property, content] of [
    ['og:type', 'website'], ['og:title', title], ['og:description', description],
    ['og:url', 'https://sparra.fr/'], ['og:site_name', 'Sparra'], ['og:locale', 'fr_FR'],
  ]) expect(head).toContain(`<meta property="${property}" content="${content}"`)
  for (const [name, content] of [
    ['twitter:card', 'summary'], ['twitter:title', title], ['twitter:description', description],
  ]) expect(head).toContain(`<meta name="${name}" content="${content}"`)
  expect(head).not.toMatch(/(?:og|twitter):image/)
})

test.each([
  { path: '/robots.txt', contentType: /^text\/plain(?:;|$)/,
    document: /^User-agent: \*\s+Allow: \/\s+Sitemap: https:\/\/sparra\.fr\/sitemap\.xml\s*$/ },
  { path: '/sitemap.xml', contentType: /^(?:application|text)\/xml(?:;|$)/,
    document: /^<\?xml version="1\.0" encoding="UTF-8"\?>\s*<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">\s*<url>\s*<loc>https:\/\/sparra\.fr\/<\/loc>\s*<\/url>\s*<\/urlset>\s*$/ },
])('GET and HEAD $path expose the public discovery resource', async ({ path, contentType, document }) => {
  const base = await launch()
  for (const method of ['GET', 'HEAD']) {
    const response = await fetch(`${base}${path}`, { method, redirect: 'manual', signal: AbortSignal.timeout(3000) })
    expect(response.status, `${method} ${path}`).toBe(200)
    expect(response.headers.get('content-type')).toMatch(contentType)
    expect(response.headers.get('x-robots-tag')).toBeNull()
    const body = await response.text()
    if (method === 'HEAD') expect(body).toBe('')
    else expect(body).toMatch(document)
  }
})

test('public header and footer expose the existing private entry in French', async () => {
  const base = await launch()
  const response = await fetch(base, { signal: AbortSignal.timeout(3000) })
  expect(response.status).toBe(200)
  const html = await response.text()
  for (const landmark of ['header', 'footer']) {
    const section = new RegExp(`<${landmark}\\b[^>]*>([\\s\\S]*?)</${landmark}>`).exec(html)?.[1]
    expect(section).toMatch(/<a href="\/app\?lang=fr">Mon espace<\/a>/)
  }
  expect(html).toMatch(/<a\b[^>]*href="\/app\/entreprise\?lang=fr"[^>]*>[\s\S]*?Configurer mon entreprise/)
  expect(html).toContain('href="#demo"')
  expect(html).toContain('Préparer un pilote ensemble')
  const entry=await fetch(base+'/app/entreprise?lang=fr',{signal:AbortSignal.timeout(3000)})
  expect(entry.status).toBe(200)
  expect(new URL(entry.url).pathname).toBe('/login')
  expect(await entry.text()).toContain('<html lang="fr"')
})

test('public pilot and demo copy preserve the illustrative and unqualified limits', async () => {
  const base = await launch()
  const response = await fetch(base, { signal: AbortSignal.timeout(3000) })
  expect(response.status).toBe(200)
  const html = await response.text()
  expect(html).toContain('<meta name="description" content="Sparra est un assistant téléphonique IA pour les professionnels locaux. Découvrez sa démo et son pilote : répondre aux appels et transmettre les demandes à votre équipe."')
  expect(html).toContain('Sparra est disponible en pilote accompagné. Le renvoi depuis votre ligne et le transfert à une personne restent à configurer et vérifier.')
  expect(html).toContain('Le parcours du pilote, de votre configuration aux appels reçus.')
  expect(html).toContain('Exemple illustratif : écoutez la conversation et découvrez la fiche que l’entreprise peut recevoir.')
  expect(html).toContain('Exemple enregistré — scénario fictif')
  expect(html).toContain('Fiche illustrative — aucune demande réelle envoyée.')
  expect(html).toContain('Exemple fictif de connaissances. Lecture seule.')
  expect(html).toContain('Aucun rendez-vous confirmé sans agenda relié.')
  expect(html).toContain('il sera qualifié dans le pilote')
  expect(html).toContain('Sans transfert qualifié vers votre équipe, Sparra recueille un message à vous transmettre.')
  expect(html).toContain('Les conditions et le tarif seront précisés avant tout engagement.')
})

test('anonymous raw audio route rejects before owner data access', async () => {
  const base = await launch()
  const response = await fetch(
    `${base}/api/sparra/audio/11111111-1111-4111-8111-111111111111`,
    { redirect: 'manual', signal: AbortSignal.timeout(3000) },
  )
  expect(response.status).toBe(401)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  expect(response.headers.get('location')).toBeNull()
  expect(response.headers.get('access-control-allow-origin')).toBeNull()
  expect(response.headers.get('content-type')).not.toBe('audio/wav')
  expect(await response.text()).not.toContain('RIFF')
})

test.each([
  { fixture: 'error', status: 500 },
  { fixture: 'json', status: 200 },
  { fixture: 'redirect', status: 302 },
])('a controlled $fixture root response keeps the private policy', async ({ fixture, status }) => {
  const base = await launch({ FIXTURE_ROOT_RESPONSE: fixture })
  for (const method of ['GET', 'HEAD']) {
    const response = await fetch(`${base}/`, { method, redirect: 'manual', signal: AbortSignal.timeout(3000) })
    expect(response.status).toBe(status)
    security(response, false)
  }
})

test('diagnostic public documents have canonical French SSR and bounded read-only links', async () => {
  const base = await launch()
  for (const path of ['/metiers/diagnostic-immobilier', '/metiers/diagnostic-immobilier?lang=en']) {
    for (const method of ['GET', 'HEAD']) {
      const response = await fetch(base + path, { method, redirect: 'manual', signal: AbortSignal.timeout(3000) })
      expect(response.status).toBe(200)
      security(response, true)
      const html = await response.text()
      if (method === 'HEAD') { expect(html).toBe(''); continue }
      expect(html).toContain('<html lang="fr"')
      expect(html).not.toContain('auth-language')
      expect(html).toContain('Vos appels accueillis pendant vos diagnostics.')
      expect(html).toContain('<link rel="canonical" href="https://sparra.fr/metiers/diagnostic-immobilier"')
      expect(html).toContain('<meta property="og:url" content="https://sparra.fr/metiers/diagnostic-immobilier"')
      expect(html).toContain('<meta name="twitter:card" content="summary"')
      expect(html).toMatch(/<meta name="description" content="[^\"]*diagnostiqueurs[^\"]*"/)
      expect(html).toContain('mailto:contact@sparra.fr')
      expect([...html.matchAll(/<a\b[^>]*href="([^\"]*\/app[^\"]*)"/g)].map(match => match[1])).toEqual(['https://sparra.fr/app?lang=fr', 'https://sparra.fr/app?lang=fr'])
      expect(html).toContain('Exemple illustratif')
      expect(html).toContain('capacité et un budget explicites')
      expect(html).not.toMatch(/<audio|<form|recoveryGeneration|session_token|DATABASE_URL|public-http-fixture-only/)
    }
  }
  for (const path of ['/metiers/inconnu', '/metiers/diagnostic-immobilier/inconnu']) {
    const response = await fetch(base + path, { signal: AbortSignal.timeout(3000) })
    expect(response.status).toBe(404)
    security(response, false)
  }
  const post = await fetch(base + '/metiers/diagnostic-immobilier', { method: 'POST', signal: AbortSignal.timeout(3000) })
  security(post, false)
})
