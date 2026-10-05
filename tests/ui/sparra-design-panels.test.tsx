import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import type { RequestDetailDto } from '../../src/modules/sparra/sparra.functions'
import { PrivateUnavailable } from '../../src/ui/sparra/app-shell'
import { appMessages } from '../../src/modules/sparra/messages'

test.each(['fr', 'en'] as const)('private failure retains its announcement and recovery below a localized title in %s', locale => {
  const html = renderToStaticMarkup(<PrivateUnavailable locale={locale} />)
  expect(html).toMatch(new RegExp(`<h1[^>]*>${appMessages[locale].inbox}</h1>`))
  expect(html).toContain('role="alert"')
  expect(html).toContain(appMessages[locale].unavailable)
  expect(html).toContain(`href="/login?lang=${locale}"`)
})

const unavailable=async():Promise<never>=>{throw new Error('SSR must not mutate')}

test.each(['fr', 'en'] as const)('plain contact and end labels retain uncertainty and source information in %s', async locale => {
  const { RequestPanel } = await import('../../src/ui/sparra/request-panel')
  const detail: RequestDetailDto = { id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', admittedAt:'2026-10-01T10:00:00.000Z', endedAt:'2026-10-01T10:01:00.000Z', status:'closed', configurationRevision:null, treatedAt:null, resultAvailability:'available', resultQuality:'partial', category:null, summary:'Test-only partial summary', contact:{name:null,callback_e164:'+33123456789',preference:null,callback_source:'caller',callback_confirmed:false}, nextAction:null, configuration:null, transcript:[], transcriptAvailability:'unavailable', unavailableTurnCount:0, moreTurns:false, transcriptLossCount:0, erasureState:null }
  const html = renderToStaticMarkup(<RequestPanel locale={locale} loaded={{detail,receipt:null}} onTreat={unavailable} onErase={unavailable} onRefused={unavailable} />)
  expect(html).toContain('<h3>Contact</h3>')
  expect(html).toContain(locale === 'fr' ? 'Fin détectée:' : 'End detected:')
  expect(html).toContain(appMessages[locale].unconfirmed)
  expect(html).toContain(locale === 'fr' ? 'Numéro déclaré par l’appelant' : 'Number stated by the caller')
  expect(html).toContain(appMessages[locale].partial)
  expect(html).not.toContain(locale === 'fr' ? 'Appel terminé' : 'Call completed')
  const unknown = renderToStaticMarkup(<RequestPanel locale={locale} loaded={{detail:{...detail,endedAt:null},receipt:null}} onTreat={unavailable} onErase={unavailable} onRefused={unavailable} />)
  expect(unknown).toContain(appMessages[locale].noEnd)
  expect(unknown).not.toContain(locale === 'fr' ? 'Fin détectée:' : 'End detected:')
})
