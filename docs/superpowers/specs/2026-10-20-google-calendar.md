# Sparra — premier connecteur Google Agenda

## Mandat et résultat attendu

Le propriétaire a choisi Google Agenda et autorisé l'implémentation complète sans nouvelle approbation. Un appel réel doit pouvoir créer un rendez-vous dans l'agenda de l'entreprise et conserver la référence vérifiée dans l'Inbox. Le budget téléphonique actuel et ses compteurs restent inchangés. Le rapport Oracle du 20 octobre et deux audits des sources établissent le point de départ ; ils ne prouvent pas un connecteur déjà fonctionnel.

## Périmètre produit

Une connexion Google, un agenda de destination et une ressource à capacité unitaire par Workspace personnel. Le professionnel conserve son agenda. Dans Entreprise : connecter Google, sélectionner un agenda accessible en écriture, renseigner les prestations réellement réservables, leurs durées et les plages de réservation, puis activer. Connexion, état, compte et déconnexion restent visibles. Aucun identifiant technique à copier dans le parcours courant.

Un agenda représente la ressource réellement promise. Pour un garage, un dépôt de véhicule n'est pas une réservation d'un mécanicien ou d'un pont. Aucun horaire, durée, tarif, service ou disponibilité métier n'est activé automatiquement. Les horaires libres du module de connaissances ne deviennent pas implicitement des règles de réservation.

Les réglages structurés contiennent le fuseau IANA, les services (identifiant stable, nom, durée), jusqu'à deux plages par jour, une marge après rendez-vous et un préavis. Limites de la première version : durée 5–480 minutes par pas de 5, marge 0–120 minutes, préavis 0–10080 minutes, horizon 30 jours, propositions par pas de 15 minutes, trois offres maximum, validité d'offre 5 minutes. Ces valeurs sont des choix d'implémentation, pas des données réelles d'un client. Une heure locale ambiguë ou inexistante n'est pas proposée silencieusement.

Au téléphone : service demandé → créneaux disponibles → choix et coordonnées minimales → récapitulatif exact → confirmation explicite d'un nouveau tour utilisateur → création vérifiée → confirmation prononcée. Aucun email obligatoire et aucun invité artificiel. En cas de conflit, erreur ou résultat incertain, la demande reste à confirmer. Un statut de réservation distinct du résumé partiel est visible dans l'Inbox.

Déplacement, annulation par téléphone, plusieurs ressources, plusieurs fournisseurs, nouvel agenda visuel et moteur générique de connecteurs restent hors de ce lot. Le professionnel peut continuer à modifier son agenda directement.

## Propriétaires et transport

Le backend Effect possède la connexion Google, les règles, les offres et les opérations de réservation. Le runtime Python conserve Pipecat 1.12.0, ses modèles et son pipeline Telnyx. Deux outils natifs : `find_slots` et `book_appointment`. Aucun secret, Workspace, calendarId ou URL arbitraire n'est un argument du modèle.

Réutiliser le pont PostgreSQL existant : `voice.calendar_submit_v1(call_id uuid, operation_id uuid, request jsonb)` et `voice.calendar_result_v1(call_id uuid, operation_id uuid)`. Le binding immuable session_user/OID déduit le Workspace et le déploiement. Les droits Voice restent EXECUTE seulement. Les commandes persistées sont traitées par une petite boucle Effect indépendante dans le worker existant, concurrence un, attente inactive 250 ms ; aucun Hatchet pour cette interaction et aucun nouveau serveur HTTP d'authentification machine.

Un troisième accès en lecture, `voice.calendar_catalog_v1(call_id uuid)`, fournit le catalogue réellement activé après admission : version, call_id, révision de politique, fuseau et services (ID, nom, durée). Ne pas modifier le snapshot d'admission strict existant pour ce catalogue. Une lecture indisponible conserve la prise de message et désactive seulement les outils Calendar. La révision est incluse dans les recherches de créneaux et contrôlée côté serveur.

Un login `calendar_worker` sans appartenance de rôle et un definer NOLOGIN étroit accèdent seulement aux fonctions Calendar. Réutiliser les pools, transactions courtes et durées de vie natives ; ne pas donner une autorité arbitraire de tenant au runtime d'auth. Ne jamais conserver de transaction ou de verrou pendant un appel Google. Le worker rejoint toutes ses opérations à l'arrêt et ferme le transport avant son pool.

## Connexion Google

La connexion Agenda est distincte du login Google existant, dont les tables imposent l'absence de tokens. Flux serveur avec state à usage unique, PKCE, liaison au propriétaire/session/Workspace et validation d'identité. Jetons chiffrés avec une clé Calendar dédiée et AAD liée à la connexion et au Workspace ; jamais de secret dans les DTO, connaissances Voice, logs ou rapports. Renouvellement sérialisé, perte d'autorisation explicite et déconnexion contrôlée.

Scopes ciblés : `calendar.calendarlist.readonly`, `calendar.events.freebusy` et `calendar.events` pour supporter un agenda partagé en écriture ; pas de scope global `calendar`. Les permissions effectivement accordées et ACL du calendrier sont vérifiées. Le droit Google couvre davantage que l'agenda sélectionné : ne pas annoncer un accès « ajout uniquement dans cet agenda ».

Utiliser un projet OAuth Calendar distinct du projet de login : la révocation Google affecte tous les clients du même projet, un simple second client ne suffit pas. Un projet External/Testing délivre ici des refresh tokens valables sept jours ; publication et vérification OAuth applicables sont des conditions de disponibilité durable. L'usage API standard n'a actuellement pas de coût supplémentaire, sous quotas, sans promesse de gratuité illimitée.

Configuration dédiée : `SPARRA_GOOGLE_CALENDAR_CLIENT_ID`, `SPARRA_GOOGLE_CALENDAR_CLIENT_SECRET`, `SPARRA_CALENDAR_TOKEN_KEY` (32 octets base64url canoniques), `APP_ORIGIN`. En leur absence, Calendar est indisponible et le reste de Sparra fonctionne. Le worker reçoit en plus un DSN dédié `SPARRA_CALENDAR_DATABASE_URL`. Aucun changement des pins n'est requis pour ce lot.

## Réservation et reprise

Chaque offre est opaque, liée à l'appel, au service, à la connexion/politique et à son expiration. La confirmation prouve le récapitulatif réellement émis et le nouveau tour utilisateur qui l'accepte. Relier le scope natif de tour au UUID de transcription persistant ; un booléen libre `confirmed:true` ne donne aucun droit.

Réutiliser le mécanisme Telnyx de marque de lecture déjà utilisé pour la dernière phrase de l'appel : le récapitulatif doit être réellement acquitté, sans interruption, avant d'accepter le nouveau tour. Le handler natif fournit les identités des tours de récapitulatif et de confirmation ainsi que la marque acquittée ; ces champs ne sont pas des arguments du modèle. Les tentatives de fin d'appel et de récapitulatif ont des noms de marque distincts.

Avant POST Google : enregistrer une opération stable, un ID d'événement Google dérivé de cette opération et l'intervalle ; dédupliquer l'intention même avec un nouveau tool_call_id ; verrouiller brièvement la ressource, refuser tout chevauchement local et relire les disponibilités. Une erreur par agenda dans un HTTP 200 freeBusy n'est jamais interprétée comme libre.

États : en attente, en cours, confirmé, refusé, résultat à vérifier. Après timeout/crash/interruption, relire le même ID Google et vérifier le contenu ; aucun nouvel ID ou retry aveugle de création. Une opération incertaine continue à bloquer son intervalle après expiration de l'offre. L'arrêt d'un appel n'annule pas une écriture déjà envoyée. Une reprise clôt l'opération même sans appel encore actif. Une saisie humaine simultanée dans Google échappe au verrou local : aucune garantie absolue d'absence de chevauchement externe.

## Données et validation

L'événement contient seulement service, nom/numéro utiles, date et référence de demande. Aucune transcription complète n'est envoyée. L'application et sa base restent sur les serveurs français existants ; les données d'agenda sont aussi transmises à Google. La rétention Inbox de 30 jours n'efface pas implicitement le rendez-vous métier chez Google.

Avant activation : tests d'isolation, consentement/renouvellement/révocation, permissions partielles, conflits, résultat perdu, rejeu, interruption avant/après envoi, changement d'heure et fin d'appel. Puis une vraie réservation contrôlée : voix audible, date/service corrects, événement dans le bon agenda et statut/référence concordants dans l'Inbox. Aucun double de test ne prouve ce dernier critère.

## Références officielles

- https://developers.google.com/workspace/calendar/api/auth
- https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/list
- https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query
- https://developers.google.com/workspace/calendar/api/v3/reference/events/insert
- https://developers.google.com/workspace/calendar/api/v3/reference/events/get
- https://developers.google.com/identity/protocols/oauth2/web-server
- https://developers.google.com/identity/protocols/oauth2#expiration

