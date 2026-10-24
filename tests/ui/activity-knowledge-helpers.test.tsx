import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'
import { ActivityFaqHelper, ActivityIntakeHelper, appendFaqAnswer, appendIntakeQuestion } from '../../src/ui/sparra/activity-knowledge-helpers'

test('FAQ requires a nonblank owner answer and preserves the exact existing free text',()=>{
  expect(appendFaqAnswer('Texte libre\r\n conservé','Documents ?',' \n ')).toBeNull()
  expect(appendFaqAnswer('Texte libre\r\n conservé','Documents ?','La carte grise.')).toBe('Texte libre\r\n conservé\n\nDocuments ?\nLa carte grise.')
})
test('FAQ bounds count normalized CRLF and UTF16 without truncating existing text',()=>{
  expect(appendFaqAnswer('x'.repeat(2994),'Q','😀')).toHaveLength(3000)
  expect(appendFaqAnswer('x'.repeat(2995),'Q','😀')).toBeNull()
  expect(appendFaqAnswer('x'.repeat(2993)+'\r\n','Q','A')).not.toBeNull()
  expect(appendFaqAnswer('x'.repeat(3001),'Q','A')).toBeNull()
})
test('intake choice appends the requested caller question within 2000 normalized UTF16 units',()=>{
  expect(appendIntakeQuestion('Consigne libre\r\n conservée','Quel véhicule ?')).toBe('Consigne libre\r\n conservée\n\nQuel véhicule ?')
  expect(appendIntakeQuestion('x'.repeat(1996),'😀')).toHaveLength(2000)
  expect(appendIntakeQuestion('x'.repeat(1997),'😀')).toBeNull()
  expect(appendIntakeQuestion('x'.repeat(1995)+'\r\n','Q')).not.toBeNull()
  expect(appendIntakeQuestion('x'.repeat(2001),'Q')).toBeNull()
  expect(appendIntakeQuestion('Existing',' ')).toBeNull()
})
test.each(['fr','en'] as const)('helpers in %s are passive until explicit choices, with button actions and no nested forms',locale=>{
  const change=vi.fn(),fetch=vi.spyOn(globalThis,'fetch')
  try{
    const faq=renderToStaticMarkup(<ActivityFaqHelper locale={locale} faq="Existing FAQ" questions={['Owner question?']} disabled={false} onChange={change}/>)
    const intake=renderToStaticMarkup(<ActivityIntakeHelper locale={locale} instructions="Existing instructions" questions={['Caller question?']} disabled={false} onChange={change}/>)
    expect(faq).toContain('<h2>'+(locale==='fr'?'Vos réponses aux questions fréquentes':'Your answers to frequently asked questions')+'</h2>')
    expect(intake).toContain('<h2>'+(locale==='fr'?'Informations à demander à l’appelant':'Information to ask the caller')+'</h2>')
    for(const html of [faq,intake])expect(html).toMatch(/<p[^>]*role="status"[^>]*aria-atomic="true"[^>]*><\/p>/)
    for(const html of [faq,intake]){expect(html).not.toContain('<form');for(const button of html.matchAll(/<button\b([^>]*)>/g))expect(button[1]).toContain('type="button"')}
    expect(change).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled()
  }finally{fetch.mockRestore()}
})
