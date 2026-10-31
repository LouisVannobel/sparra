import { expect, test } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5'
import { RequestPanel } from '../../src/ui/sparra/request-panel'
import { InboxPanel } from '../../src/ui/sparra/inbox-panel'
import type { RequestDetailDto } from '../../src/modules/sparra/sparra.functions'
import { calendarBookingOutcome } from '../../src/modules/calendar/booking'
const unavailable = async (): Promise<never> => {
  throw new Error('No mutation')
}

function extractionText(html: string) {
  const history: string[] = []
  function read(node: DefaultTreeAdapterTypes.Node, collapsed = true): string {
    if ('value' in node) return node.value
    if (!('childNodes' in node)) return ''
    if (collapsed && 'tagName' in node && node.tagName === 'details' && !node.attrs.some(attribute => attribute.name === 'open')) {
      history.push(read(node, false))
      return node.childNodes.filter(child => 'tagName' in child && child.tagName === 'summary').map(child => read(child)).join(' ')
    }
    return node.childNodes.map(child => read(child, collapsed)).join(' ')
  }
  return { visible: read(parseFragment(html)), history }
}
test('verified appointment remains visible independently from absent or partial model summary', () => {
  const detail = {workspaceId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    admittedAt: '2026-10-01T10:00:00.000Z',
    endedAt: null,
    status: 'closed' as const,
    configurationRevision: null,
    treatedAt:null,followUp:{publicationRevision:1,decisionToken:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',reviewedRevision:0,declarationActive:false,collectionClosed:true,contentReadable:true,firstDeclaredAt:null},
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
    erasureState:null,evidence:[],callerPhone:null,collectionGaps:[],audioCoverage:'unknown' as const,
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

const appointment: RequestDetailDto = {workspaceId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', admittedAt: '2026-10-01T10:00:00.000Z', endedAt: '2026-10-01T10:03:00.000Z',
  status: 'closed', configurationRevision: null, treatedAt:null,followUp:{publicationRevision:1,decisionToken:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',reviewedRevision:0,declarationActive:false,collectionClosed:true,contentReadable:true,firstDeclaredAt:null}, resultAvailability: 'available', resultQuality: 'partial',
  category: 'appointment_to_confirm', summary: 'Vidange demandée', conversationExcerpt: null,
  contact: { name: 'Camille', callback_e164: '+33123456789', preference: null, callback_source: 'caller', callback_confirmed: false },
  nextAction: 'Appeler Camille pour le devis', configuration: null, transcript: [], transcriptAvailability: 'unavailable',
  unavailableTurnCount: 0, moreTurns: false, transcriptLossCount: 0, erasureState:null,evidence:[],callerPhone:null,collectionGaps:[],audioCoverage:'unknown' as const,
  bookings: [{ state: 'confirmed', serviceName: 'Vidange', start: '2026-10-26T08:00:00.000Z', end: '2026-10-26T08:30:00.000Z', timezone: 'Europe/Paris', providerReference: 'sparra123', observedState: 'confirmed' }],
}

test.each(['fr', 'en'] as const)('confirmed appointment in %s reconciles Inbox and detail while retaining human follow-up', locale => {
  const detail = { ...appointment, bookingOutcome: 'confirmed' as const }
  const request = renderToStaticMarkup(<RequestPanel locale={locale} loaded={{ detail, receipt: null }} onTreat={unavailable} onErase={unavailable} onRefused={unavailable} />)
  const inbox = renderToStaticMarkup(<InboxPanel locale={locale} state={{ workspace: null, configuration: null, localAudioAvailable: false }} page={{ requests: [detail], nextCursor: null }} onMore={unavailable} onTreat={unavailable} onRefused={unavailable} />)
  for (const html of [request, inbox]) {
    expect(html).toContain(locale === 'fr' ? 'Rendez-vous confirmé' : 'Confirmed appointment')
    expect(html).not.toContain(locale === 'fr' ? 'Rendez-vous à confirmer' : 'Appointment to confirm')
    expect(html).toContain('Appeler Camille pour le devis')
    expect(html).toContain(locale === 'fr' ? 'Résumé partiel' : 'Partial summary')
    expect(html).toContain('+33123456789')
    expect(html).not.toContain(locale === 'fr' ? 'Demande et numéro non confirmés.' : 'Request and number are unconfirmed.')
    expect(html).toContain(locale === 'fr' ? 'Suivi extrait de l’appel (à vérifier avec l’agenda)' : 'Follow-up extracted from the call (check against the calendar)')
    const extraction = extractionText(html)
    expect(extraction.visible).not.toContain('Appeler Camille pour le devis')
    expect(extraction.visible).toContain(locale === 'fr' ? 'Demande extraite lors de l’appel' : 'Request extracted during the call')
    expect(extraction.history).toHaveLength(1)
    expect(extraction.history[0]).toContain('Appeler Camille pour le devis')
  }
  expect(extractionText(request).history[0]).toContain('Vidange demandée')
  expect(inbox).toContain(locale === 'fr' ? 'À traiter' : 'To treat')
  expect(request).toContain('sparra123')
})

test.each(['fr', 'en'] as const)('a contradictory extracted action in %s is preserved as history after canonical confirmation', locale => {
  const nextAction = locale === 'fr' ? 'Ne pas considérer le rendez-vous comme confirmé tant que le créneau n’a pas été vérifié.' : 'Do not consider the appointment confirmed until the slot has been checked.'
  const detail = { ...appointment, bookingOutcome: 'confirmed' as const, nextAction }
  const request = renderToStaticMarkup(<RequestPanel locale={locale} loaded={{ detail, receipt: null }} onTreat={unavailable} onErase={unavailable} onRefused={unavailable} />)
  const inbox = renderToStaticMarkup(<InboxPanel locale={locale} state={{ workspace: null, configuration: null, localAudioAvailable: false }} page={{ requests: [detail], nextCursor: null }} onMore={unavailable} onTreat={unavailable} onRefused={unavailable} />)
  for (const html of [request, inbox]) {
    const extraction = extractionText(html)
    expect(extraction.visible).toContain(locale === 'fr' ? 'Rendez-vous confirmé' : 'Confirmed appointment')
    expect.soft(extraction.visible).not.toContain(nextAction)
    expect.soft(extraction.history).toHaveLength(1)
    expect.soft(extraction.history[0] ?? '').toContain(nextAction)
  }
})

test('a terminal appointment keeps its extracted action in history even without a summary', () => {
  const detail = { ...appointment, bookingOutcome: 'confirmed' as const, summary: null }
  const request = renderToStaticMarkup(<RequestPanel locale="en" loaded={{ detail, receipt: null }} onTreat={unavailable} onErase={unavailable} onRefused={unavailable} />)
  const inbox = renderToStaticMarkup(<InboxPanel locale="en" state={{ workspace: null, configuration: null, localAudioAvailable: false }} page={{ requests: [detail], nextCursor: null }} onMore={unavailable} onTreat={unavailable} onRefused={unavailable} />)
  for (const html of [request, inbox]) {
    const extraction = extractionText(html)
    expect(extraction.visible).toContain('Request extracted during the call')
    expect(extraction.visible).not.toContain('Appeler Camille pour le devis')
    expect(extraction.history).toHaveLength(1)
    expect(extraction.history[0]).toContain('Appeler Camille pour le devis')
  }
})

test.each(['fr', 'en'] as const)('old extracted confirmation wording in %s remains available as history, not the Inbox headline', locale => {
  const detail = { ...appointment, summary: 'Rendez-vous à confirmer pour la vidange', bookingOutcome: 'confirmed' as const }
  const request = renderToStaticMarkup(<RequestPanel locale={locale} loaded={{ detail, receipt: null }} onTreat={unavailable} onErase={unavailable} onRefused={unavailable} />)
  const inbox = renderToStaticMarkup(<InboxPanel locale={locale} state={{ workspace: null, configuration: null, localAudioAvailable: false }} page={{ requests: [detail], nextCursor: null }} onMore={unavailable} onTreat={unavailable} onRefused={unavailable} />)
  expect(request).toContain('<details><summary>')
  expect(extractionText(request).history[0]).toContain('Rendez-vous à confirmer pour la vidange')
  expect(extractionText(request).visible).not.toContain('Rendez-vous à confirmer pour la vidange')
  expect(inbox).not.toContain('Rendez-vous à confirmer pour la vidange')
  expect(inbox).toContain(locale === 'fr' ? 'Rendez-vous confirmé' : 'Confirmed appointment')
})

test.each(['fr', 'en'] as const)('observed cancellation in %s never presents a live confirmation in Inbox or detail', locale => {
  const detail = { ...appointment, bookingOutcome: 'cancelled' as const, bookings: [{ ...appointment.bookings![0]!, observedState: 'cancelled' }] }
  const request = renderToStaticMarkup(<RequestPanel locale={locale} loaded={{ detail, receipt: null }} onTreat={unavailable} onErase={unavailable} onRefused={unavailable} />)
  const inbox = renderToStaticMarkup(<InboxPanel locale={locale} state={{ workspace: null, configuration: null, localAudioAvailable: false }} page={{ requests: [detail], nextCursor: null }} onMore={unavailable} onTreat={unavailable} onRefused={unavailable} />)
  for (const html of [request, inbox]) {
    expect(html).toContain(locale === 'fr' ? 'Rendez-vous annulé' : 'Cancelled appointment')
    expect(html).not.toContain(locale === 'fr' ? 'Rendez-vous confirmé' : 'Confirmed appointment')
    const extraction = extractionText(html)
    expect(extraction.visible).not.toContain('Appeler Camille pour le devis')
    expect(extraction.history).toHaveLength(1)
    expect(extraction.history[0]).toContain('Appeler Camille pour le devis')
  }
})

test('a tentative provider observation does not present the booking card as confirmed', () => {
  const detail = { ...appointment, bookings: [{ ...appointment.bookings![0]!, observedState: 'tentative' }] }
  const html = renderToStaticMarkup(<RequestPanel locale="en" loaded={{ detail, receipt: null }} onTreat={unavailable} onErase={unavailable} onRefused={unavailable} />)
  expect(html).toContain('Appointment to confirm')
  expect(html).not.toContain('Confirmed appointment')
})

test.each([
  [{ total: 0, confirmed: 0, cancelled: 0 }, null],
  [{ total: 1, confirmed: 0, cancelled: 0 }, null],
  [{ total: 1, confirmed: 1, cancelled: 0 }, 'confirmed'],
  [{ total: 1, confirmed: 0, cancelled: 1 }, 'cancelled'],
  [{ total: 2, confirmed: 1, cancelled: 0 }, null],
  [{ total: 2, confirmed: 2, cancelled: 0 }, null],
  [{ total: 2, confirmed: 1, cancelled: 1 }, null],
] as const)('only a single unambiguous booking command has an outcome: %j', (counts, expected) => {
  expect(calendarBookingOutcome(counts)).toBe(expected)
})

test.each(['fr', 'en'] as const)('model-only confirmation and mixed booking evidence in %s remain unconfirmed', locale => {
  for (const detail of [
    { ...appointment, category: 'appointment_to_confirm' as const, summary: 'Booking confirmed, says the model', bookings: [], bookingOutcome: undefined },
    ...(['pending', 'unknown', 'refused'] as const).map(state => ({ ...appointment, bookingOutcome: undefined, bookings: [{ ...appointment.bookings![0]!, state, providerReference: null }] })),
    { ...appointment, bookingOutcome: undefined, bookings: [...appointment.bookings!, { ...appointment.bookings![0]!, state: 'unknown' as const, providerReference: null }] },
  ]) {
    const request = renderToStaticMarkup(<RequestPanel locale={locale} loaded={{ detail, receipt: null }} onTreat={unavailable} onErase={unavailable} onRefused={unavailable} />)
    const inbox = renderToStaticMarkup(<InboxPanel locale={locale} state={{ workspace: null, configuration: null, localAudioAvailable: false }} page={{ requests: [detail], nextCursor: null }} onMore={unavailable} onTreat={unavailable} onRefused={unavailable} />)
    for (const html of [request, inbox]) {
      expect(html).toContain(locale === 'fr' ? 'Rendez-vous à confirmer' : 'Appointment to confirm')
      expect(html).toContain(locale === 'fr' ? 'Demande et numéro non confirmés.' : 'Request and number are unconfirmed.')
      expect(extractionText(html).visible).toContain('Appeler Camille pour le devis')
      expect(extractionText(html).visible).toContain(locale === 'fr' ? 'À faire' : 'Next action')
    }
  }
})

test.each(['callback', 'information', 'declared_urgent', null] as const)('a %s request keeps its ordinary extracted action visible despite a booking outcome', category => {
  const detail = { ...appointment, category, bookingOutcome: 'confirmed' as const }
  const request = renderToStaticMarkup(<RequestPanel locale="en" loaded={{ detail, receipt: null }} onTreat={unavailable} onErase={unavailable} onRefused={unavailable} />)
  const inbox = renderToStaticMarkup(<InboxPanel locale="en" state={{ workspace: null, configuration: null, localAudioAvailable: false }} page={{ requests: [detail], nextCursor: null }} onMore={unavailable} onTreat={unavailable} onRefused={unavailable} />)
  for (const html of [request, inbox]) {
    const extraction = extractionText(html)
    expect(extraction.visible).toContain('Appeler Camille pour le devis')
    expect(extraction.visible).toContain('Next action')
    expect(extraction.history).toHaveLength(0)
  }
})

test('confirmed booking does not mark the request treated or remove a prior treatment', () => {
  const open = { ...appointment, bookingOutcome: 'confirmed' as const }
  const treated = { ...open, treatedAt: '2026-10-01T11:00:00.000Z',followUp:{...open.followUp,reviewedRevision:1,declarationActive:true,firstDeclaredAt:'2026-10-01T11:00:00.000Z'} }
  const render = (detail: typeof open) => renderToStaticMarkup(<InboxPanel locale="en" state={{ workspace: null, configuration: null, localAudioAvailable: false }} page={{ requests: [detail], nextCursor: null }} onMore={unavailable} onTreat={unavailable} onRefused={unavailable} />)
  expect(render(open)).toContain('To treat')
  expect(render(treated)).toContain('Treated')
  expect(render(treated)).not.toContain('Mark as treated')
})
