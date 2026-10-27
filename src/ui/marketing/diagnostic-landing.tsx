import { Button } from '@astryxdesign/core/Button'

export function DiagnosticLanding(): React.JSX.Element {
  return <div className="sparra">
    <a className="sparra-skip" href="#contenu">Aller au contenu</a>
    <header className="sparra-header sparra-width">
      <a className="sparra-wordmark" href="/" aria-label="Sparra, accueil">sparra<span aria-hidden="true">.</span></a>
      <nav aria-label="Navigation principale"><a href="#fonctionnement">Comment ça fonctionne</a><a href="#exemple">Voir un exemple</a><a href="https://sparra.fr/app?lang=fr">Mon espace</a></nav>
    </header>
    <main id="contenu">
      <section className="sparra-hero sparra-width" aria-labelledby="diagnostic-title">
        <div>
          <h1 id="diagnostic-title">Vos appels accueillis pendant vos diagnostics.</h1>
          <p className="sparra-intro">Vous êtes en intervention ou déjà au téléphone. Votre assistant peut accueillir les appels renvoyés, recueillir une demande et préparer les informations utiles pour votre rappel ou votre devis.</p>
          <div className="sparra-hero-actions"><Button className="sparra-contact" href="mailto:contact@sparra.fr" label="Préparer un pilote accompagné" variant="primary" size="lg" /></div>
          <p className="sparra-pilot">Nous préparons et vérifions le pilote avec vous avant ouverture.</p>
        </div>
      </section>
      <section id="fonctionnement" className="sparra-section sparra-width" aria-labelledby="diagnostic-how">
        <div className="sparra-section-heading"><h2 id="diagnostic-how">Une demande recueillie. Vous gardez la décision.</h2></div>
        <ol className="sparra-steps">
          <li><h3>Vos informations validées</h3><p>Vous validez les informations de votre cabinet.</p></li>
          <li><h3>Un pilote vérifié ensemble</h3><p>Nous vérifions avec vous le renvoi et les conditions du pilote.</p></li>
          <li><h3>La demande accueillie</h3><p>L’assistant accueille la demande dans ce périmètre.</p></li>
          <li><h3>Votre rappel ou votre devis</h3><p>Vous retrouvez son résumé et les coordonnées confirmées dans votre espace client commun.</p></li>
        </ol>
      </section>
      <section id="exemple" className="sparra-section sparra-width sparra-knowledge" aria-labelledby="diagnostic-example">
        <div><h2 id="diagnostic-example">Avant le devis, les informations utiles.</h2><p>Une demande pour la vente d’un appartement, sa commune, sa surface approximative et l’échéance souhaitée, avec une prochaine action de rappel. Exemple illustratif ; la prestation, son prix et sa date restent confirmés par le professionnel.</p><p>Il s’agit d’un scénario textuel fictif, pas d’un appel exécuté ni d’un enregistrement audio.</p></div>
        <aside className="sparra-receipt" aria-labelledby="diagnostic-request">
          <h3 id="diagnostic-request">Demande de devis avant vente</h3><p className="sparra-example-label">Exemple illustratif — aucune demande réelle envoyée.</p>
          <dl><div><dt>Résumé</dt><dd>Vente d’un appartement à Tours, environ 65 m², échéance souhaitée dans trois semaines.</dd></div><div><dt>Contact</dt><dd>Coordonnées à recueillir et à confirmer. Préférence de rappel à préciser.</dd></div><div><dt>Prochaine action</dt><dd>Rappeler pour préciser le besoin et établir le devis.</dd></div></dl>
        </aside>
      </section>
      <section className="sparra-section sparra-width sparra-offer" aria-labelledby="diagnostic-pilot">
        <div><h2 id="diagnostic-pilot">Un démarrage accompagné.</h2><p>Le professionnel consulte l’Inbox selon le rythme convenu et effectue lui-même les rappels et devis. Le pilote conserve une capacité et un budget explicites.</p><p>Le prix, la durée, les limites de consommation, le support et les conditions de fin sont convenus avant engagement.</p><p>La réservation automatique, le transfert, les notifications email/SMS, la création dans un logiciel métier et la génération de devis ne font pas partie de la promesse de base.</p><p>La détermination des diagnostics requis reste au professionnel. L’assistant ne garantit pas de classement DPE.</p></div>
        <div><Button className="sparra-contact" href="mailto:contact@sparra.fr" label="Préparer un pilote accompagné" variant="primary" size="lg" /><p>Ouvre un e-mail à contact@sparra.fr.</p></div>
      </section>
    </main>
    <footer className="sparra-footer sparra-width"><a className="sparra-wordmark" href="/">sparra<span aria-hidden="true">.</span></a><p>Réception téléphonique pour diagnostiqueurs immobiliers.</p><a href="https://sparra.fr/app?lang=fr">Mon espace</a><a href="/confidentialite">Confidentialité</a><a href="mailto:contact@sparra.fr">contact@sparra.fr</a></footer>
  </div>
}
