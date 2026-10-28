import { createFileRoute } from '@tanstack/react-router'
import { privacyCopy } from '../ui/marketing/privacy-copy'
import stylesheet from '../ui/marketing/marketing.css?url'

export const Route = createFileRoute('/confidentialite')({
  head: ({ match }) => ({ meta: [{ title: `${privacyCopy[match.search.lang].title} — Sparra` }], links: [{ rel: 'stylesheet', href: stylesheet }] }),
  component: Privacy,
})

function Privacy() {
  const { lang } = Route.useSearch()
  const copy = privacyCopy[lang]
  return <div className="sparra"><main className="sparra-width" style={{ maxWidth: 800, paddingBlock: 48 }}>
    <a href="/">{copy.home}</a>
    <h1>{copy.title}</h1>
    <p>{copy.updated}</p>
    <p>{copy.intro}</p>
    {copy.sections.map(section => <section key={section.title}>
      <h2>{section.title}</h2>
      {section.paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}
    </section>)}
    <p>{copy.policy}<a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>{copy.policyEnd}</p>
    <h2>{copy.contactTitle}</h2>
    <p>{copy.contact}<a href="mailto:contact@sparra.fr">contact@sparra.fr</a>. {copy.contactEnd}</p>
    <a href={`/app?lang=${lang}`}>{copy.app}</a>
  </main></div>
}
