# Inbox fiable — conception d'implémentation adoptée

26 octobre 2026. L'utilisateur approuve la synthèse du 23 octobre et demande son implémentation simple, avec Oracle et tests bornés. Référence normative : C:/Users/louis/.codex/artifacts/sparra/2026-10-22/recherches-thematiques/02-inbox-actions/SYNTHESE.md et ETATS_ET_TRANSITIONS.md, amendés par Oracle. Ce document raccorde ce contrat aux sources actuelles ; il n'ouvre pas une nouvelle discussion de produit.

## Base actuelle et périmètre

Application : origin/main 45a5061ea605e79a152b952c0b477880d33f22bf ; Voice : origin/main 565d434cb1779ac20a342bce22d24a4bd6842b7e. Deux worktrees propres dédiés. Le rafraîchissement et les résultats agenda existent désormais : les conserver, inclure les changements agenda dans la publication. Aucun nouveau raccord agenda/CRM/SMS, fournisseur, worker, bus, recherche, équipe ou dépendance. Aucun push, merge partagé, déploiement ou migration de service existant.

## Approche retenue et alternatives écartées

Étendre les propriétaires existants : marqueur explicite de collecte au freeze Voice, puis instantané courant chiffré/metadata sous l'appel et commandes conditionnelles dans la transaction R1. Réutiliser outbox, identité d'opération, fences, RLS et preuves agenda.

Un hash des seules sources n'identifie pas la fiche affichée ; une relecture vivante de l'agenda avec une ancienne version est incohérente. Un trigger call seul ne prouve pas la fin de collecte ni ne voit l'agenda. Un journal général d'événements ou une nouvelle projection asynchrone ajouterait de la coordination sans consommateur supplémentaire : écartés.

## Contrat minimal

- Voice émet une extension optionnelle `collection` du call.upsert final seulement après arrêt effectif des producteurs concernés : tours retenus attendus, issue du résultat, audio attendu/non collecté/terminal avec lacunes établies. Omission pour les anciens payloads et les récupérations qui ne prouvent pas cette fin ; jamais collection:null. Aucun nouveau schéma SQLite si le blob frozen suffit.
- PostgreSQL conserve le marqueur et attend ses pièces ; arrivée du terminal avant fragments n'est pas une clôture. Audio off n'attend rien ; audio pending n'est pas une pièce abandonnée. Aucune migration ne transforme les anciens appels closed en collectes closes.
- Une publication courante fige enveloppes et métadonnées décisionnelles : demandes/résultat/conversation/provenances/limites et véritables résultats agenda. Pas de copie plaintext des conversations ; pas d'historique exhaustif. Tout remplacement publié différent avance C et T, même à sources constantes ; doublon prouvé ou comptabilité technique ne l'avance pas. Les écritures agenda pertinentes utilisent le même verrou d'appel et une cohérence transactionnelle explicite.
- C = publication courante ; A = dernière publication déclarée ; déclaration active/révoquée ; première date ; jeton serveur T non réutilisé. Traiter/remettre comparent C/T réellement affichés, tenant, rétention et effacement dans la même validation atomique. Seule la déclaration finale exige la clôture ; la révocation reste possible sur une publication provisoire. Les appels sans marqueur restent lisibles et explicitement provisoires, sans fausse clôture.
- Le DTO contient un instantané indivisible avec C/T/clôture/limites/références. Les commandes ne lisent pas un jeton séparé plus récent. Première date affichée comme Première déclaration ; aucune dernière date supposée. Conflit au renvoi n'invente pas l'échec d'un premier commit à réponse perdue.
- Deux vues : À traiter (déclaration inactive OU A<C) / Tous les appels. Filtre serveur avant limite, curseur réinitialisé au changement. Rafraîchissement explicite existant conservé, aucune ligne déplacée sous le doigt.
- Contact, provenance, demandes repérées, suite à donner et preuves avant contenu long. Classement final après clôture explicite, même partielle. Un geste principal, Remettre à traiter secondaire, effacement séparé. Liens de preuve vers tours validés ; demande ≠ tentative ≠ réussite. Préserver les reçus agenda existants et l'inconnu, aucun réessai externe.
- Couverture audio inconnue reste inconnue, duplication uniquement si prouvée. Même incertitude ne rouvre pas à chaque GET. Français de bout en bout, labels/a11y et responsive existants, Astryx uniquement.

## Validation proportionnée

Priorité aux consommateurs réels : quelques cas regroupés producteur/SQL de clôture, terminal avant fragments, replay, événement agenda tardif, deux ordres CAS et remise→vieux clic ; UI à même ID/nouveau contenu, deux vues, preuves et conflit. Garder les suites ciblées existantes plutôt que créer 35 tests qui reproduisent le document. Typecheck, lint et build une fois pour le lot final ; rechecks supplémentaires seulement après correction pertinente. Les fixtures locales ne prouvent pas les fournisseurs live.
