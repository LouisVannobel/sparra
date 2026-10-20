import { expect, test } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { RequestPanel } from '../../src/ui/sparra/request-panel'
const unavailable = async (): Promise<never> => {
  throw new Error('No mutation')
}
test('verified appointment remains visible independently from absent or partial model summary', () => {
  const detail = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    admittedAt: '2026-10-01T10:00:00.000Z',
    endedAt: null,
    status: 'closed' as const,
    configurationRevision: null,
    treatedAt: null,
    resultAvailability: 'unavailable' as const,
    resultQuality: null,
    category: null,
    summary: null,
    conversationExcerpt: null,
    contact: null,
    nextAction: null,
    configuration: null,
    transcript: [],
    transcriptAvailability: 'unavailable' as const,
    unavailableTurnCount: 0,
    moreTurns: false,
    transcriptLossCount: 0,
    erasureState: null,
    bookings: [
      {
        state: 'confirmed' as const,
        serviceName: 'Vidange',
        start: '2026-10-26T08:00:00.000Z',
        end: '2026-10-26T08:30:00.000Z',
        timezone: 'Europe/Paris',
        providerReference: 'sparra123',
        observedState: 'confirmed',
      },
    ],
  }
  const html = renderToStaticMarkup(
    <RequestPanel
      locale="fr"
      loaded={{ detail, receipt: null }}
      onTreat={unavailable}
      onErase={unavailable}
      onRefused={unavailable}
    />,
  )
  expect(html).toContain('Rendez-vous confirmé')
  expect(html).toContain('Vidange')
  expect(html).toContain('sparra123')
  expect(html).toContain('Résumé indisponible')
  const changed = renderToStaticMarkup(
    <RequestPanel
      locale="fr"
      loaded={{
        detail: { ...detail, bookings: [{ ...detail.bookings[0]!, observedState: 'cancelled' }] },
        receipt: null,
      }}
      onTreat={unavailable}
      onErase={unavailable}
      onRefused={unavailable}
    />,
  )
  expect(changed).toContain('Rendez-vous annulé')
  expect(changed).not.toContain('Rendez-vous confirmé')
})
