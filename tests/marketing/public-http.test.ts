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

test('public header and footer expose the existing private entry in French', async () => {
  const base = await launch()
  const response = await fetch(base, { signal: AbortSignal.timeout(3000) })
  expect(response.status).toBe(200)
  const html = await response.text()
  for (const landmark of ['header', 'footer']) {
    const section = new RegExp(`<${landmark}\\b[^>]*>([\\s\\S]*?)</${landmark}>`).exec(html)?.[1]
    expect(section).toMatch(/<a href="\/app\?lang=fr">Mon espace<\/a>/)
  }
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
