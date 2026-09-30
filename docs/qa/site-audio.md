# Recette locale du site et des exemples audio

Date : 30 septembre 2026. Périmètre : page publique Sparra, deux MP3 illustratifs, transcription/fiche appariées et frontières HTTP partagées. Cette recette ne qualifie ni un appel fournisseur, ni un pilote vocal, ni une livraison de demande réelle.

## Commandes et preuves observées

Environnement : Windows, Node 24.14.0, pnpm 10.32.1, TypeScript 7.0.2, Playwright 1.62.1 / Chromium headless. Intégrations ciblées avec un worker, PostgreSQL/PgBouncer/Redis jetables sur Docker Desktop `desktop-linux` Linux amd64 et images SHA-pinnées de la fixture existante. Secrets de fixture générés à chaque lancement ; aucun `.env` lu. Seuil avant exécution : au moins 2 GiB physiques et 6 GiB virtuels libres. Le nettoyage vérifie la propriété des ressources et l'inventaire étranger inchangé.

| Contrôle | Résultat local |
| --- | --- |
| `pnpm typecheck` | Passé ; une seule commande TypeScript normative |
| `pnpm build` | Web et worker compilés ; avertissement Vite sur un chunk client de 536,96 kB |
| `pnpm test` | 707 tests / 57 fichiers passés ; auth privée, CSP, timeout/shutdown et tests HTTP conservés |
| `pnpm lint` | Passé sur les chemins marketing et frontières root/server explicitement sélectionnés |
| `pnpm exec vitest run tests/quality-policy.test.ts --maxWorkers=1` | 3 canaris passés ; avant activation, les 2 canaris invalides échouaient car Oxlint les acceptait |
| `pnpm test:a11y` | 13 cas passés sur la page réellement compilée |
| Régression native `workspace-browser.test.ts` | Passée (1 cas natif) : création/lecture/renommage persistants après reload/redémarrage, FR/EN, clavier et refus privés |

La régression Workspace a révélé trois écarts de sa fixture conservée : `getAccount` lisait la table passkey sans droit de lecture de test (500), le focus clavier précédait l’hydratation du bouton SSR désactivé, et le test attendait `?lang=fr` alors que le routeur retire cette langue par défaut. Corrections limitées au test : `GRANT SELECT ON public.passkey`, attente du bouton réellement activé, URL canonique `/login` avec document français explicitement vérifié. Les assertions de persistance, clavier, rollback, 401 et absence de données privées restent actives ; aucune permission applicative ou migration n’a changé.

Les contrôles anti-slop proviennent du starter au SHA `c7a5443333f25d990d80dcdfe3a31a29dfa0ee7b`, licence MIT conservée et sources originales inchangées : [provenance](../../tools/oxlint/anti-slop/PROVENANCE.md). Les seuls nouveaux dev pins sont `oxlint:1.78.0` et `@oxlint/plugins:1.78.0`. Le lint ne revendique pas de qualification globale du code R1 retenu.

## Page compilée et contrôles navigateur

La recette marketing observe la lecture native (progression du currentTime), pause/reprise, recommencement, absence d'autoplay, changement de métier pendant lecture et arrêt à la sortie du composant. Une erreur réseau MP3 réelle conserve les textes ; le bouton réessaie le téléchargement après retour de la ressource. Une lecture en attente annulée ne produit pas de fausse erreur ; une interruption native non annulée est annoncée.

Axe (WCAG 2 A/AA et 2.1 A/AA) ne trouve aucune violation à 1280, 640 et 320 px. Le clavier sélectionne le métier par flèche, garde le focus visible et atteint lecture/pause/recommencement par Tab/Entrée. Les commandes portent le nom de leur action ; la progression possède un nom et des valeurs positives. L'erreur garde le focus sur la commande qui l'a déclenchée. La transcription et la fiche restent consultables. Ni compteur ni transcription ne sont dans une région aria-live ; les régions de chargement Astryx des boutons restent vides pendant ces interactions.

Le navigateur observe les styles locaux, le nonce des scripts correspondant à la CSP, aucune violation CSP et aucune erreur de page dans le cas nominal ; zéro requête externe est tentée. Les interceptions de panne MP3 sont réservées aux tests. Les captures `.output/test-evidence/marketing/compiled-1280.png`, `compiled-640.png` et `compiled-320.png` proviennent du build web exécuté sur loopback, pas d'un mockup. Les captures desktop/mobile ont été inspectées visuellement pour l'agencement et l'absence de débordement ; elles restent des preuves locales ignorées par Git.

640/320 px représentent seulement une approximation de reflow pour une fenêtre de 1280 px à 200 %/400 %. Elles ne prouvent pas le zoom natif du navigateur.

## Recettes humaines encore non vérifiées

Lecteur d'écran : **non vérifié**. Aucun résultat axe ou arbre d'accessibilité n'est présenté comme un test de lecteur d'écran. Sur la preview compilée, relever navigateur/version, lecteur/version et observations pour chaque point :

1. Le groupe « Métier de l'exemple » expose le métier sélectionné ; changer de métier reste compréhensible et le focus suit le contrôle.
2. Les commandes annoncent « Écouter l'exemple », « Pause » et « Recommencer » au moment approprié.
3. « Progression de l'exemple » expose une progression compréhensible ; compteur et transcription ne sont pas récités en continu.
4. Bloquer le média puis lancer la lecture : l'erreur est annoncée sans déplacement du focus. La transcription et la fiche restent consultables.
5. Parcourir la transcription puis « Ce que vous recevez » ; comprendre leur caractère fictif, la demande et l'action restant à confirmer.

Zoom natif à 200 % et 400 % : **non vérifié**. Relever navigateur/version et vérifier lecture, commandes accessibles, textes/fiche consultables, focus visible et absence de perte d'information ou de défilement horizontal imposé.

Écoute humaine intégrale des deux MP3, intelligibilité, qualité des voix et concordance audio/texte : **reportée explicitement par l'utilisateur, non vérifiée**. Les tests de métadonnées, cues et currentTime ne remplacent pas l'écoute.

Revue indépendante et Oracle du jalon : pilotées par le contrôleur, pas attestées par ce document d'implémentation. Publication, CI distante, hébergement France, conformité et traitement IA externe : aucune nouvelle preuve dans ce lot local.
