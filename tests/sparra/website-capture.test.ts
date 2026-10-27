import { expect, test, vi } from 'vitest'
import { captureWebsiteWithBoundaries, type CaptureBoundaries } from '../../src/modules/sparra/website-capture.server'

const html = '<html><head><title>Garage Martin</title></head><body><main><h1>Horaires</h1><p>Lundi à vendredi : 9h–18h, sauf jours fériés.</p><h2>Services</h2><p>Diagnostic : uniquement sur rendez-vous.</p></main><script>window.hacked = true</script><style>.x{color:red}</style></body></html>'

function fixture(response: { body?: AsyncIterable<Uint8Array>; status?: number; headers?: Record<string, string>; addresses?: string[] } = {}) {
  const seen: Array<{ hostname: string; address: string }> = []
  let closed = 0
  const encoder = new TextEncoder()
  const body = response.body ?? (async function* () { yield encoder.encode(html) })()
  const boundaries: CaptureBoundaries = {
    resolve: async () => (response.addresses ?? ['93.184.215.14']).map(address => ({ address, family: address.includes(':') ? 6 : 4 })),
    open: async (url, address, signal) => {
      seen.push({ hostname: url.hostname, address })
      if (signal.aborted) throw signal.reason
      return { status: response.status ?? 200, headers: response.headers ?? { 'content-type': 'text/html; charset=utf-8' }, body, close: () => { closed++ } }
    },
  }
  return { boundaries, seen, get closed() { return closed } }
}

test.each(['http://example.com', 'https://example.com:444/', 'https://user:pass@example.com/', 'https://127.0.0.1/', 'https://[::ffff:127.0.0.1]/', 'https://example.com/?token=private'])('rejects unsafe URL %s before transport', async url => {
  const f = fixture()
  await expect(captureWebsiteWithBoundaries(url, {}, f.boundaries)).rejects.toThrow()
  expect(f.seen).toHaveLength(0)
})

test.each(['127.0.0.1', '10.0.0.1', '169.254.1.1', '192.0.2.1', '224.0.0.1', '::1', 'fc00::1', 'fe80::1', '2001:db8::1', '4000::1', '::ffff:10.1.1.1'])('rejects resolved nonpublic destination %s', async address => {
  const f = fixture({ addresses: [address] })
  await expect(captureWebsiteWithBoundaries('https://example.com/', {}, f.boundaries)).rejects.toThrow()
  expect(f.seen).toHaveLength(0)
})

test('rejects a mixed DNS answer rather than selecting its public address', async () => {
  const f = fixture({ addresses: ['93.184.215.14', '127.0.0.1'] })
  await expect(captureWebsiteWithBoundaries('https://example.com/', {}, f.boundaries)).rejects.toThrow()
  expect(f.seen).toHaveLength(0)
})

test('pins a public resolved address while retaining the URL host and preserves complete conditional passages', async () => {
  const f = fixture()
  const result = await captureWebsiteWithBoundaries('https://example.com/hours', {}, f.boundaries)
  expect(f.seen).toEqual([{ hostname: 'example.com', address: '93.184.215.14' }])
  expect(result.url).toBe('https://example.com/hours')
  expect(result.title).toBe('Garage Martin')
  expect(result.sha256).toMatch(/^[a-f0-9]{64}$/)
  expect(result.capturedAt).toMatch(/^\d{4}-\d\d-\d\dT/)
  expect(result.passages.map(p => p.text)).toContain('Lundi à vendredi : 9h–18h, sauf jours fériés.')
  expect(result.passages.map(p => p.text)).toContain('Diagnostic : uniquement sur rendez-vous.')
  expect(JSON.stringify(result.passages)).not.toContain('window.hacked')
  expect(JSON.stringify(result.passages)).not.toContain('color:red')
  expect(f.closed).toBe(1)
})

test('keeps a direct parent condition with its nested passage', async () => {
  const f = fixture({ body: (async function* () { yield new TextEncoder().encode('<div>Uniquement sur rendez-vous <p>Diagnostic</p></div>') })() })
  const result = await captureWebsiteWithBoundaries('https://example.com/', {}, f.boundaries)
  expect(result.passages.map(passage => passage.text)).toContain('Uniquement sur rendez-vous Diagnostic')
})

test('preserves inline characters and spaces while separating blocks and line breaks', async () => {
  const f = fixture({ body: (async function* () {
    yield new TextEncoder().encode('<p>1<span>00</span> euros</p><p><span>Sur</span> <em>rendez-vous</em>.</p><div>Avant<p>Diagnostic<br>sur rendez-vous</p><section>Après</section>Fin</div>')
  })() })
  const result = await captureWebsiteWithBoundaries('https://example.com/', {}, f.boundaries)
  expect(result.passages.map(passage => passage.text)).toEqual([
    '100 euros',
    'Sur rendez-vous.',
    'Avant Diagnostic sur rendez-vous Après Fin',
  ])
})

test('accepts all 200 passages without truncation', async () => {
  const f = fixture({ body: (async function* () { yield new TextEncoder().encode('<p>x</p>'.repeat(199) + '<p>Dernier passage</p>') })() })
  const result = await captureWebsiteWithBoundaries('https://example.com/', {}, f.boundaries)
  expect(result.passages).toHaveLength(200)
  expect(result.passages[199]).toEqual({ id: 'p200', text: 'Dernier passage' })
  expect(f.closed).toBe(1)
})

test('rejects 201 passages with no applicable capture', async () => {
  const f = fixture({ body: (async function* () { yield new TextEncoder().encode('<p>x</p>'.repeat(201)) })() })
  await expect(captureWebsiteWithBoundaries('https://example.com/', {}, f.boundaries)).rejects.toMatchObject({
    name: 'WebsiteCaptureError', code: 'TOO_MANY_PASSAGES',
  })
  expect(f.closed).toBe(1)
})

test.each([
  '<div><span>Uniquement sur rendez-vous</span><p>Diagnostic</p></div>',
  '<div><span><em>Uniquement sur rendez-vous</em></span><p>Diagnostic</p></div>',
])('keeps inline parent context with a nested passage: %s', async html => {
  const f = fixture({ body: (async function* () { yield new TextEncoder().encode(html) })() })
  const result = await captureWebsiteWithBoundaries('https://example.com/', {}, f.boundaries)
  expect(result.passages.map(passage => passage.text)).toContain('Uniquement sur rendez-vous Diagnostic')
})

test('drops a fragment from the captured URL', async () => {
  const f = fixture()
  const result = await captureWebsiteWithBoundaries('https://example.com/hours#opening', {}, f.boundaries)
  expect(result.url).toBe('https://example.com/hours')
})

test('refuses an application host before DNS or transport', async () => {
  const f = fixture()
  const resolve = vi.spyOn(f.boundaries, 'resolve')
  await expect(captureWebsiteWithBoundaries('https://sparra.example../', { blockedHosts: ['sparra.example'] }, f.boundaries)).rejects.toThrow('BLOCKED_HOST')
  expect(resolve).not.toHaveBeenCalled()
})

test('rejects a cross-origin redirect and closes the response', async () => {
  const f = fixture({ status: 302, headers: { location: 'https://other.example/' } })
  await expect(captureWebsiteWithBoundaries('https://example.com/', {}, f.boundaries)).rejects.toThrow()
  expect(f.seen).toHaveLength(1)
  expect(f.closed).toBe(1)
})

test('follows no more than three same-origin redirects', async () => {
  let opens = 0
  const f = fixture({ status: 302, headers: { location: '/next' } })
  const original = f.boundaries.open
  f.boundaries.open = async (...args) => { opens++; return original(...args) }
  await expect(captureWebsiteWithBoundaries('https://example.com/', {}, f.boundaries)).rejects.toThrow()
  expect(opens).toBe(4)
  expect(f.closed).toBe(4)
})

test('refuses unsolicited compression and closes the stream', async () => {
  const f = fixture({ headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' } })
  await expect(captureWebsiteWithBoundaries('https://example.com/', {}, f.boundaries)).rejects.toThrow()
  expect(f.closed).toBe(1)
})

test.each(['application/pdf', 'application/json', 'text/html; charset=iso-8859-1'])('rejects unsupported content type %s', async contentType => {
  const f = fixture({ headers: { 'content-type': contentType } })
  await expect(captureWebsiteWithBoundaries('https://example.com/', {}, f.boundaries)).rejects.toThrow()
  expect(f.closed).toBe(1)
})

test('rejects contradictory charset declarations', async () => {
  const f = fixture({ headers: { 'content-type': 'text/html; charset=iso-8859-1; charset=utf-8' } })
  await expect(captureWebsiteWithBoundaries('https://example.com/', {}, f.boundaries)).rejects.toThrow('CONTENT_TYPE')
  expect(f.closed).toBe(1)
})

test('rejects excessive response bytes with no partial capture', async () => {
  const f = fixture({ body: (async function* () { yield new Uint8Array(2_097_153) })() })
  await expect(captureWebsiteWithBoundaries('https://example.com/', {}, f.boundaries)).rejects.toThrow()
  expect(f.closed).toBe(1)
})

test('rejects excessive decoded UTF16 text with no partial capture', async () => {
  const f = fixture({ body: (async function* () { yield new TextEncoder().encode(`<p>${'a'.repeat(50_001)}</p>`) })() })
  await expect(captureWebsiteWithBoundaries('https://example.com/', {}, f.boundaries)).rejects.toThrow()
  expect(f.closed).toBe(1)
})

test('aborts a hanging response without returning a fragment', async () => {
  const controller = new AbortController()
  let started!: () => void
  const firstChunk = new Promise<void>(resolve => { started = resolve })
  const f = fixture({ body: (async function* () { yield new TextEncoder().encode('<p>partial'); started(); await new Promise<void>(() => {}) })() })
  const pending = captureWebsiteWithBoundaries('https://example.com/', { signal: controller.signal }, f.boundaries)
  await firstChunk
  controller.abort()
  await expect(pending).rejects.toThrow()
  expect(f.closed).toBe(1)
})

test('acquisition deadline includes DNS and does not open transport after expiry', async () => {
  vi.useFakeTimers()
  try {
    const f = fixture()
    f.boundaries.resolve = async () => new Promise(() => {})
    const pending = captureWebsiteWithBoundaries('https://example.com/', {}, f.boundaries)
    const rejected = expect(pending).rejects.toThrow('ABORTED')
    await vi.advanceTimersByTimeAsync(15_001)
    await rejected
    expect(f.seen).toHaveLength(0)
  } finally { vi.useRealTimers() }
})

test('native pinned lookup returns the shape requested by Node for both address families', async () => {
  const { pinnedAddressLookup } = await import('../../src/modules/sparra/website-capture.server')
  for (const [address, family] of [['93.184.215.14', 4], ['2606:4700:4700::1111', 6]] as const) {
    const pinned = pinnedAddressLookup(address)
    for (const all of [false, true]) {
      let result: { error: unknown; address: unknown; family: unknown } | undefined
      pinned('example.com', { all }, (error, resolved, resolvedFamily) => {
        result = { error, address: resolved, family: resolvedFamily }
      })
      expect(result).toEqual({ error: null, address: all ? [{ address, family }] : address, family: all ? undefined : family })
    }
  }
})
