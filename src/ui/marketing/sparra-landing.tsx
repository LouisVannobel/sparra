import { Button } from '@astryxdesign/core/Button'
import { SparraDemo } from './sparra-demo'

export function SparraLanding(): React.JSX.Element {
  return <div className="sparra">
    <a className="sparra-skip" href="#contenu">Aller au contenu</a>
    <header className="sparra-header sparra-width">
      <a className="sparra-wordmark" href="/" aria-label="Sparra, accueil">sparra<span aria-hidden="true">.</span></a>
      <nav aria-label="Navigation principale">
        <a href="#demo">Écouter un exemple</a>
        <a href="#fonctionnement">Comment ça fonctionne</a>
        <a href="#controle">Vous gardez la main</a>
        <a href="#offre">L’offre</a>
        <a href="/app?lang=fr">Mon espace</a>
      </nav>
      <Button className="sparra-contact" href="mailto:contact@sparra.fr" label="Parlons de votre activité" variant="primary" size="lg" />
    </header>
    <main id="contenu">
      <section className="sparra-hero sparra-width" aria-labelledby="sparra-title">
        <div>
          <h1 id="sparra-title">Votre assistant téléphonique.<br /><span className="sparra-highlight">Vous faites votre métier.</span></h1>
          <p className="sparra-intro">Un client appelle. Vous êtes à l’atelier, avec un client ou déjà en ligne. Sparra est conçu pour accueillir sa demande et vous transmettre l’essentiel.</p>
          <div className="sparra-hero-actions">
            <Button className="sparra-contact" href="#demo" label="Écouter un exemple" variant="primary" size="lg" />
            <a href="mailto:contact@sparra.fr">Préparer un pilote ensemble</a>
          </div>
          <p className="sparra-pilot">Sparra est disponible en pilote accompagné. Le renvoi depuis votre ligne et le transfert à une personne restent à configurer et vérifier.</p>
        </div>
      </section>
      <SparraDemo />
      <div className="sparra-reassurance sparra-width" aria-label="Conditions du parcours prévu">
        <p>Votre numéro, si le renvoi est compatible</p><p>Aucun matériel spécifique au parcours retenu</p><p>Configuration accompagnée</p><p>Vos règles, votre contrôle</p>
      </div>
      <section id="fonctionnement" className="sparra-section sparra-width" aria-labelledby="sparra-how">
        <div className="sparra-section-heading"><h2 id="sparra-how">Un appel reçu.<br />Une demande claire.</h2><p>Le parcours du pilote, de votre configuration aux appels reçus.</p></div>
        <ol className="sparra-steps">
          <li><h3>Vous nous expliquez votre activité</h3><p>Horaires, prestations, tarifs, questions fréquentes, consignes.</p></li>
          <li><h3>Vous connectez votre ligne</h3><p>Vous gardez votre numéro existant lorsque le renvoi de votre ligne le permet. Sparra peut intervenir selon vos règles.</p></li>
          <li><h3>Sparra répond</h3><p>Il comprend la demande, renseigne le client, qualifie une demande de rendez-vous ou recueille un message pour l’équipe. Le relais humain est prévu selon vos consignes ; il sera qualifié dans le pilote. Aucun rendez-vous confirmé sans agenda relié.</p></li>
          <li><h3>Vous récupérez l'essentiel</h3><p>Résumé, coordonnées, transcription et action à effectuer.</p></li>
        </ol>
      </section>
      <section id="controle" className="sparra-section sparra-width sparra-knowledge" aria-labelledby="sparra-control">
        <div><h2 id="sparra-control">Il connaît votre activité. Vous fixez les limites.</h2><p>Les réponses prévues s’appuient sur les informations que vous confiez à Sparra. Vous définissez ce qu’il peut expliquer et quand votre équipe doit reprendre la conversation.</p><p>Une question sans réponse, une demande particulière ou un appelant qui veut parler à une personne : le relais suit vos consignes. Sa disponibilité et le repli si personne ne répond restent à vérifier dans le pilote.</p></div>
        <aside className="sparra-knowledge-note" aria-labelledby="sparra-example">
          <h3 id="sparra-example">Garage Horizon</h3><p className="sparra-example-label">Exemple fictif de connaissances. Lecture seule.</p>
          <dl><div><dt>Horaires</dt><dd>Du lundi au vendredi, de 8 h à 18 h.</dd></div><div><dt>Prestations</dt><dd>Révision et entretien courant.</dd></div><div><dt>Tarifs</dt><dd>À confirmer avec l’équipe selon le véhicule.</dd></div><div><dt>Consigne</dt><dd>Recueillir la demande et une préférence de rappel. Tout rendez-vous reste à confirmer.</dd></div></dl>
        </aside>
      </section>
      <section id="offre" className="sparra-section sparra-width sparra-offer" aria-labelledby="sparra-offer-title">
        <div><h2 id="sparra-offer-title">Une offre mensuelle.<br />Un démarrage accompagné.</h2><p>Nous partons de votre activité, de votre ligne et de vos consignes pour préparer un premier pilote. Les conditions et le tarif seront précisés avant tout engagement.</p></div>
        <div><Button className="sparra-contact" href="mailto:contact@sparra.fr" label="Échanger sur votre besoin" variant="primary" size="lg" /><p>Ouvre un e-mail à contact@sparra.fr.</p></div>
      </section>
    </main>
    <footer className="sparra-footer sparra-width"><a className="sparra-wordmark" href="/">sparra<span aria-hidden="true">.</span></a><p>Assistant téléphonique IA pour les professionnels locaux.</p><a href="/app?lang=fr">Mon espace</a><a href="mailto:contact@sparra.fr">contact@sparra.fr</a></footer>
  </div>
}
