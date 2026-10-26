# Task 1 — acquisition d'une page Sparra

## Livraison

- `website-capture.server.ts` expose `WebsiteCapture` et `captureWebsite`. URL publique HTTPS port 443 uniquement ; credentials et query refusés (`UNSUPPORTED_URL`), fragment retiré, `blockedHosts` refusé avant DNS. Toutes les réponses DNS sont contrôlées ; la requête HTTPS emploie un `lookup` épinglé sur l'IP validée avec hostname/SNI et validation de certificat natifs.
- Trois redirections relatives ou absolues de même origine au maximum, avec résolution et validation DNS renouvelées. `Accept-Encoding: identity` est envoyé ; une compression reçue est refusée. `Content-Type` HTML UTF-8 requis ; PDF, JSON et autres charset refusés. Aucun cookie, authentification, JavaScript, média ou crawl.
- Acquisition limitée à 15 s (DNS et flux inclus), à 2 097 152 octets et à 50 000 unités UTF-16. Flux détruit en `finally` ; annulation, délai ou dépassement échouent sans capture partielle. Les erreurs exposent un code stable sans URL ni corps.
- `website-text.server.ts` utilise parse5 sur HTML inerte et émet des passages de texte complets, dont les conditions au sein d'un paragraphe sont conservées. Ces passages restent du texte source non validé, sans catégorisation ni instruction automatique.
- Dépendances exactes `parse5@8.0.1` et `ipaddr.js@2.5.0`, avec imports statiques consommateurs. Source/types installés inspectés. `ipaddr.js` 2.5.0 ne livre pas de déclaration TypeScript ; `ipaddr.d.ts` décrit étroitement les seules méthodes employées. Cette version publiée a été vérifiée auprès de npm et de son dépôt officiel.

## RED / GREEN et vérification

- RED initial : `pnpm exec vitest run tests/sparra/website-capture.test.ts --maxWorkers=1` a échoué car le module d'acquisition n'existait pas. Les cas étaient écrits avant le code. Un RED comportemental a ensuite été observé sur la fermeture du flux en cas d'annulation ; le test a été corrigé pour attendre que le flux soit réellement ouvert avant d'annuler.
- GREEN final : 31 cas ciblés réussis. `pnpm run typecheck` réussi. `git diff --check` réussi. Pas de campagne ordinaire lancée, réservée à l'intégration finale du parent.

## Self-review / limites

- Relecture des bornes : IP locales, privées, réservées, IPv4 mappées, mélange DNS et préfixes IPv6 hors 2000::/3 refusés ; aucune connexion avant validation. La frontière de test est la même composition appelée par l'export public avec résolution/requête natives par défaut. Aucun adaptateur factice n'est livré en production.
- La suite ciblée utilise une frontière réseau instrumentée et ne constitue pas une preuve d'un serveur HTTPS public réel. Le futur appelant devra fournir ses propres hôtes applicatifs dans `blockedHosts` et décider lui-même de la validation des passages avant usage. Aucun accès fournisseur, DB, déploiement ou push effectué.

## Correctif de revue 1/5

- Deux tests comportementaux ajoutés avant les changements : un conteneur `<div>Uniquement sur rendez-vous <p>Diagnostic</p></div>` doit garder condition et fait dans le même passage ; un `Content-Type` avec `charset=iso-8859-1; charset=utf-8` doit être refusé. RED observé sur les deux : `33 tests | 2 failed`, avec sortie `['Diagnostic']` et capture résolue malgré l'en-tête contradictoire.
- Correctifs limités à l'extracteur et au contrôle `Content-Type` : lorsque du texte direct entoure un passage enfant, le conteneur fournit le passage complet ; les paramètres d'en-tête sont analysés et tout charset non UTF-8, répété ou ambigu est refusé.
- GREEN : `pnpm exec vitest run tests/sparra/website-capture.test.ts --maxWorkers=1` → `33 passed`; `pnpm run typecheck` → code 0. Aucune suite globale ni nouveau contrôle de transport natif exécuté.

## Correctif de relecture 2/5

- RED : deux variantes d'une seule structure ont été ajoutées avant correction : `<span>condition</span><p>Diagnostic</p>` et `<span><em>condition</em></span><p>Diagnostic</p>` dans un même `div`. `pnpm exec vitest run tests/sparra/website-capture.test.ts --maxWorkers=1` → `35 tests | 2 failed` ; dans les deux cas seul `Diagnostic` ressortait.
- L'extracteur reconnaît désormais comme contexte le texte visible des enfants non blocs, y compris les éléments inline imbriqués, et le garde avec le bloc associé. Le contrôle `Content-Type` reste inchangé.
- GREEN : même commande ciblée → `35 passed`; `pnpm run typecheck` → code 0. Aucune suite globale exécutée.

## Correctif d'intégration 3/5 — transport HTTPS natif

- Le contrôle HTTPS public initial exécuté par le parent échouait en `TRANSPORT` sous Node 24.22.1. Le `https.request` natif demande `lookup` avec `options.all=true`, mais le callback épinglé retournait une chaîne IP et une famille. Node attend alors un tableau `LookupAddress[]` ; l'erreur interne constatée était `ERR_INVALID_IP_ADDRESS`, adresse `undefined`.
- RED déterministe ajouté au contrat réellement utilisé par `nativeBoundaries` : `pnpm exec vitest run tests/sparra/website-capture.test.ts --maxWorkers=1 -t 'native pinned lookup'` → `1 failed`, `pinnedAddressLookup is not a function`. Le correctif retourne la forme tableau lorsque `all=true`, la forme scalaire sinon, pour IPv4 et IPv6 ; TLS/SNI, validation IP et politique de redirection restent identiques.
- GREEN : `pnpm exec vitest run tests/sparra/website-capture.test.ts --maxWorkers=1` → `36 passed` ; `pnpm run typecheck` → code 0.
- Smoke natif temporaire `pnpm exec vitest run --config .superpowers/sdd/2026-10-26-knowledge-import/native-smoke.config.mjs` : la première relance a traversé `captureWebsite` puis échoué sur une attente de contenu périmée (`Example Domain` dans un passage). Le HTML public observé place cette expression dans le titre ; le scratch ignoré a été ajusté pour vérifier le titre et un passage non vide. Nouvelle relance → `1 passed`, avec assertions de SHA-256, socket TLS autorisée, `remoteAddress` présent et SNI `example.com`. Ce smoke ne prouve pas à lui seul l'égalité entre le peer observé et l'adresse DNS validée ; aucun test réseau permanent n'a été ajouté.
