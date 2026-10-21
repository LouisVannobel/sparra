import { createFileRoute } from '@tanstack/react-router'
import stylesheet from '../ui/marketing/marketing.css?url'

export const Route = createFileRoute('/confidentialite')({
  head: () => ({ meta: [{ title: 'Confidentialité — Sparra' }], links: [{ rel: 'stylesheet', href: stylesheet }] }),
  component: Privacy,
})

function Privacy() {
  return <div className="sparra"><main className="sparra-width" style={{ maxWidth: 800, paddingBlock: 48 }}>
    <a href="/">Sparra — accueil</a>
    <h1>Confidentialité</h1>
    <p>Dernière mise à jour : 21 octobre 2026.</p>
    <h2>Appels et demandes</h2>
    <p>Sparra répond aux appels et transmet les demandes au professionnel. Les coordonnées et la transcription sont conservées chiffrées dans sa boîte de réception privée pendant 30 jours. L’enregistrement audio, lorsqu’il est activé avec le parcours d’information et de choix prévu, suit également une conservation de 30 jours. Le professionnel peut effacer une demande depuis son espace.</p>
    <h2>Connexion à Google Agenda</h2>
    <p>Le propriétaire choisit de connecter son compte Google, sélectionne un agenda accessible en écriture et renseigne ses prestations, durées et horaires avant d’activer la réservation. La connexion Agenda est distincte de la connexion à Sparra.</p>
    <p>Le consentement permet d’identifier le compte (identifiant Google et adresse email), de lister ses agendas, de lire les disponibilités et de consulter ou créer des événements. Les permissions Google sur les événements sont plus larges que le seul agenda sélectionné ; Sparra utilise celui que le propriétaire choisit pour les rendez-vous. Les jetons d’accès et de renouvellement sont protégés par chiffrement côté serveur et ne sont pas transmis à l’assistant vocal.</p>
    <p>Sparra utilise les données Google uniquement pour cette connexion, la recherche de disponibilités, la réservation et la vérification de son résultat. L’événement créé contient la prestation, les dates et une référence avec un lien vers la demande privée Sparra. Il ne contient ni coordonnées de l’appelant, ni transcription complète, ni invité ajouté artificiellement.</p>
    <p>La déconnexion désactive les nouvelles réservations et révoque l’autorisation Google ; elle ne supprime pas les événements déjà créés. Leur conservation dans Google Agenda est indépendante des 30 jours de la boîte de réception Sparra. Le propriétaire gère ces événements directement dans Google Agenda et peut aussi retirer l’accès depuis son compte Google.</p>
    <h2>Hébergement et traitements externes</h2>
    <p>L’application et sa base principale sont hébergées en France. Les données d’agenda nécessaires sont transmises à Google. La téléphonie et les traitements IA externes nécessaires à la transcription, au dialogue et à la synthèse vocale font intervenir des prestataires ; les informations de prestation et de créneau nécessaires au dialogue peuvent leur être transmises. Ces traitements ne sont pas annoncés comme exclusivement réalisés en France.</p>
    <p>Les données reçues des API Google ne servent ni à la publicité, ni à entraîner ou améliorer des modèles d’IA généraux. L’utilisation et le transfert à d’autres applications des informations reçues des API Google respectent la <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, y compris ses exigences Limited Use.</p>
    <h2>Contact et demandes</h2>
    <p>Pour une question sur vos données, leur accès, leur rectification ou leur suppression : <a href="mailto:contact@sparra.fr">contact@sparra.fr</a>. Si votre appel concerne un professionnel utilisant Sparra, indiquez le professionnel concerné afin que votre demande puisse être orientée.</p>
  </main></div>
}
