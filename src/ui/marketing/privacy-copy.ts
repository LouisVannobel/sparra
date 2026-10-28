export const privacyCopy = {
  fr: {
    title: 'Confidentialité', home: 'Sparra — accueil', app: 'Mon espace', updated: 'Dernière mise à jour : 29 octobre 2026.',
    intro: 'Sparra répond aux appels et transmet les demandes au professionnel. Sparra Agenda est une intégration facultative : le propriétaire peut relier un compte Google pour proposer et réserver des rendez-vous. Cette connexion est distincte de la connexion à Sparra.',
    sections: [
      { title: 'Données Google consultées et conservées', paragraphs: [
        'La connexion reçoit l’identifiant du compte Google et son adresse email, ainsi que les identifiants, noms, fuseaux horaires et rôles d’accès des agendas. Sparra consulte les périodes occupées pour rechercher des créneaux et les identifiants, états, dates, heures et références de corrélation des rendez-vous Sparra pour en vérifier le résultat. Les réponses Google peuvent contenir d’autres champs ; tous les champs reçus ne sont pas enregistrés.',
        'Sparra conserve les données de connexion et les jetons OAuth, l’agenda sélectionné, les règles de réservation, les offres de créneaux et le suivi des commandes de réservation. Les périodes occupées sont utilisées pour calculer les offres sans être conservées dans les tables Agenda de Sparra.',
      ] },
      { title: 'Utilisation des données Google', paragraphs: [
        'Le propriétaire choisit un agenda accessible en écriture et configure les prestations, durées et horaires avant d’activer la réservation. Les données Google servent à connecter le compte, choisir l’agenda, rechercher les disponibilités, proposer des créneaux, réserver après confirmation explicite et vérifier le résultat affiché dans la boîte de réception privée.',
        'Les permissions Google sur les événements (calendar.events) sont plus larges que le seul agenda sélectionné ; Sparra utilise l’agenda choisi pour ses rendez-vous. Un événement créé contient la prestation, les dates et heures, et une référence privée Sparra avec un lien vers la demande. Il ne contient ni coordonnées de l’appelant, ni transcription complète, ni invité ajouté artificiellement.',
      ] },
      { title: 'Destinataires et traitements externes', paragraphs: [
        'Les échanges d’agenda et d’autorisation font intervenir Google. La téléphonie et l’audio font intervenir Telnyx ; les traitements IA externes nécessaires à la transcription, au dialogue et à la synthèse vocale font intervenir OpenRouter et les fournisseurs des modèles sélectionnés pour ces traitements. Les informations de prestation et de créneau nécessaires, y compris celles dérivées des disponibilités Google, peuvent entrer dans le dialogue et l’audio prononcé et être transmises à ces prestataires. Les jetons OAuth et les identifiants de compte ou d’agenda Google ne sont pas automatiquement transmis aux modèles vocaux.',
        'Sparra n’utilise pas les données reçues des API Google pour la publicité ni pour entraîner ou améliorer des modèles d’IA généraux. Les transmissions aux prestataires servent aux traitements nécessaires au service ; elles ne constituent pas une garantie générale sur leurs propres politiques d’entraînement, de journalisation ou de conservation.',
        'L’application et sa base principale sont hébergées en France. Les traitements des prestataires externes ne sont pas annoncés comme exclusivement réalisés en France.',
      ] },
      { title: 'Protection des données', paragraphs: [
        'Les échanges publics avec Sparra et les échanges avec Google utilisent HTTPS. Les jetons OAuth sont chiffrés côté serveur avec AES-256-GCM, en les liant à l’espace professionnel et à la connexion concernés. L’accès aux données privées exige un propriétaire authentifié et respecte l’isolation entre espaces professionnels. Ce chiffrement des jetons ne signifie pas que toutes les métadonnées ordinaires sont chiffrées par l’application.',
      ] },
      { title: 'Conservation et suppression', paragraphs: [
        'Le contenu des appels, notamment la transcription et, lorsqu’il est activé avec le parcours d’information et de choix prévu, l’enregistrement audio, est accessible pendant 30 jours et fait ensuite l’objet d’une suppression par les opérations de nettoyage. Le professionnel peut aussi effacer une demande depuis son espace. Cette durée est distincte de la conservation des données Google. Une offre de créneau est valable cinq minutes ; ce délai de validité n’est pas un délai de suppression.',
        'Une déconnexion menée à son terme désactive les réservations, révoque l’autorisation et efface les jetons ainsi que l’identifiant et l’email Google. L’agenda sélectionné, les règles et les traces de suivi restent conservés. Pendant une révocation encore en cours ou incertaine, cet effacement n’est pas garanti. Si Sparra détecte un retrait d’accès effectué dans Google, la réservation est désactivée et une reconnexion peut être nécessaire, sans effacement local immédiat.',
        'L’effacement d’un appel supprime ses offres de créneaux et les commandes terminées ou jamais envoyées. Pour les opérations incertaines qui ont pu être envoyées à Google, des identifiants Google et des dates et heures minimaux sont conservés pour rapprocher et résoudre le résultat. Aucun délai maximal général de suppression de toutes les données Google n’est annoncé.',
        'La déconnexion ne supprime pas les événements déjà créés dans Google Agenda. Leur conservation est indépendante des 30 jours du contenu des appels ; le propriétaire les gère directement dans Google Agenda. Pour demander la suppression des données Google restant dans Sparra, utilisez le contact ci-dessous. Cette demande ne correspond pas à une suppression instantanée du compte ou de toutes les sauvegardes.',
      ] },
    ],
    policy: 'L’utilisation et le transfert à d’autres applications des informations reçues des API Google respectent la ',
    policyEnd: ', y compris ses exigences Limited Use.', contactTitle: 'Contact et demandes',
    contact: 'Pour une question sur vos données, leur accès, leur rectification ou leur suppression : ',
    contactEnd: 'Si votre appel concerne un professionnel utilisant Sparra, indiquez le professionnel concerné afin que votre demande puisse être orientée.',
  },
  en: {
    title: 'Privacy', home: 'Sparra — home', app: 'My workspace', updated: 'Last updated: 29 October 2026.',
    intro: 'Sparra answers calls and forwards requests to the business. Sparra Agenda is an optional integration: the owner can connect a Google account to offer and book appointments. This connection is separate from signing in to Sparra.',
    sections: [
      { title: 'Google data accessed and stored', paragraphs: [
        'The connection receives the Google account identifier and email address, together with calendar identifiers, names, time zones and access roles. Sparra accesses busy intervals to find slots and the identifiers, states, dates, times and correlation references of Sparra appointments to verify their outcome. Google responses may contain other fields; not every received field is stored.',
        'Sparra stores connection data and OAuth tokens, the selected calendar, booking rules, slot offers and booking command follow-up records. Busy intervals are used to calculate offers without being stored in Sparra’s Calendar tables.',
      ] },
      { title: 'How Google data is used', paragraphs: [
        'The owner selects a writable calendar and configures services, durations and working hours before enabling booking. Google data is used to connect the account, select the calendar, check availability, offer slots, book after explicit confirmation and verify the outcome shown in the private inbox.',
        'Google event permissions (calendar.events) are broader than the selected calendar; Sparra uses the chosen calendar for its appointments. A created event contains the service, dates and times, and a private Sparra reference with a link to the request. It contains no caller contact details, full transcript or artificially added guest.',
      ] },
      { title: 'Recipients and external processing', paragraphs: [
        'Calendar and authorization exchanges involve Google. Telephony and audio involve Telnyx; external AI processing needed for transcription, dialogue and speech synthesis involves OpenRouter and the providers of the models selected for those tasks. Necessary service and slot information, including information derived from Google availability, may enter the dialogue and spoken audio and be sent to these providers. OAuth tokens and Google account or calendar identifiers are not automatically sent to voice models.',
        'Sparra does not use data received from Google APIs for advertising or to train or improve general AI models. Transfers to providers serve the processing necessary for the service; they are not a general guarantee about those providers’ own training, logging or retention policies.',
        'The application and its main database are hosted in France. External providers’ processing is not represented as taking place exclusively in France.',
      ] },
      { title: 'Data protection', paragraphs: [
        'Public exchanges with Sparra and exchanges with Google use HTTPS. OAuth tokens are encrypted server-side with AES-256-GCM, bound to the relevant workspace and connection. Private data access requires an authenticated owner and respects isolation between workspaces. This token encryption does not mean that all ordinary metadata is encrypted by the application.',
      ] },
      { title: 'Retention and deletion', paragraphs: [
        'Call content, including the transcript and, when enabled through the intended information and choice process, the audio recording, is accessible for 30 days and is then deleted through cleanup operations. The business can also erase a request from its workspace. This period is separate from Google data retention. A slot offer is valid for five minutes; this validity period is not a deletion deadline.',
        'A successfully completed disconnection disables booking, revokes authorization and clears tokens and the Google account identifier and email. The selected calendar, rules and follow-up records remain stored. While revocation is still pending or uncertain, this erasure is not guaranteed. If Sparra detects access withdrawn within Google, booking is disabled and reconnection may be needed, without immediate local erasure.',
        'Erasing a call deletes its slot offers and completed or never-sent commands. For uncertain operations that may have been sent to Google, minimal Google identifiers, dates and times are retained to reconcile and resolve the outcome. No general maximum deadline for deleting all Google data is stated.',
        'Disconnection does not delete events already created in Google Calendar. Their retention is independent of the 30 days for call content; the owner manages them directly in Google Calendar. To request deletion of Google data remaining in Sparra, use the contact below. Such a request does not mean instant deletion of the account or all backups.',
      ] },
    ],
    policy: 'The use and transfer to other applications of information received from Google APIs comply with the ',
    policyEnd: ', including its Limited Use requirements.', contactTitle: 'Contact and requests',
    contact: 'For questions about your data, access, correction or deletion: ',
    contactEnd: 'If your call concerns a business using Sparra, identify that business so your request can be directed appropriately.',
  },
}
