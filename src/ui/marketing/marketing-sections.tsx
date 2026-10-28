export function MarketingHeader({ children, action }: { children: React.ReactNode; action?: React.ReactNode }): React.JSX.Element {
  return <>
    <a className="sparra-skip" href="#contenu">Aller au contenu</a>
    <header className="sparra-header sparra-width">
      <a className="sparra-wordmark" href="/" aria-label="Sparra, accueil">sparra<span aria-hidden="true">.</span></a>
      <nav aria-label="Navigation principale">{children}</nav>
      {action}
    </header>
  </>
}

export function MarketingSteps({ steps }: { steps: readonly { title: string; description: string }[] }): React.JSX.Element {
  return <ol className="sparra-steps">
    {steps.map(step => <li key={step.title}><h3>{step.title}</h3><p>{step.description}</p></li>)}
  </ol>
}
