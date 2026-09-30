import { createRootRoute, HeadContent, Link, Outlet, Scripts, stripSearchParams, useRouterState } from '@tanstack/react-router'
import { Theme } from '@astryxdesign/core/theme'
import { neutralTheme } from '@astryxdesign/theme-neutral/built'
import { InternationalizationProvider } from '@astryxdesign/core/i18n'
import fr from '@astryxdesign/core/locales/fr-FR.json'
import { messages, resolveLocale, type Locale } from '../ui/auth/messages'
import stylesheet from '../ui/auth/auth.css?url'

export const Route = createRootRoute({
  validateSearch: (search: { lang?: unknown }) => ({ lang: resolveLocale(search.lang) }),
  search: { middlewares: [stripSearchParams<{ lang: Locale }>({ lang: 'fr' })] },
  head: () => ({ meta: [{ charSet: 'utf-8' }, { name: 'viewport', content: 'width=device-width, initial-scale=1' }], links: [{ rel: 'stylesheet', href: stylesheet }] }),
  component: () => <Outlet />,
  notFoundComponent: () => { const { lang } = Route.useSearch(); return <main className="auth-content"><h1>{messages[lang].notFound}</h1><a href={`/login?lang=${lang}`}>{messages[lang].back}</a></main> },
  shellComponent: Shell,
})
function Shell({ children }: { children: React.ReactNode }) {
  const { lang } = Route.useSearch()
  const pathname = useRouterState({ select: state => state.location.pathname })
  const documentLang = pathname === '/' ? 'fr' : lang
  return <html lang={documentLang} data-theme="light" data-astryx-theme="neutral"><head><HeadContent /></head><body>
    <Theme theme={neutralTheme} mode="light"><InternationalizationProvider locale={documentLang} messages={{ fr }}>
      {pathname !== '/' && <nav className="auth-language" aria-label={messages[lang].language}><Link to="." search={previous => ({ ...previous, lang: 'fr' })} lang="fr" aria-current={lang === 'fr' ? 'true' : undefined}>Français</Link><Link to="." search={previous => ({ ...previous, lang: 'en' })} lang="en" aria-current={lang === 'en' ? 'true' : undefined}>English</Link></nav>}
      {children}</InternationalizationProvider></Theme><Scripts /></body></html>
}
