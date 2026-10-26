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
