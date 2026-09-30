# Recette locale du site et des exemples audio

Date : 30 septembre 2026. Périmètre : page publique Sparra, deux MP3 illustratifs, transcription/fiche appariées et frontières HTTP partagées. Cette recette ne qualifie ni un appel fournisseur, ni un pilote vocal, ni une livraison de demande réelle.

## Commandes et preuves observées

Les résultats techniques ci-dessous ont été observés au commit `950a9f63e9c6bf05355baf5bc254352464bb633c`. La revue indépendante conserve ses constats historiques et ses limites à ce même commit ; le complément natif ultérieur ne transforme pas ses exigences encore ouvertes en résultats passés.

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

## Complément natif du contrôleur — 30 septembre 2026

Le contrôleur a observé Microsoft Edge **154.0.4258.37**, dans une fenêtre dédiée maximisée de **1920 × 1032 px**, sur la preview publique compilée au commit `950a9f63e9c6bf05355baf5bc254352464bb633c`. Les valeurs du menu natif **200 % et 400 %** ont été constatées directement. Cette preview loopback utilisait les pairs wire PostgreSQL/Redis contrôlés R1, avec authentification désactivée ; elle ne qualifie aucun utilisateur privé ni service fournisseur.

À 200 %, les commandes et les deux colonnes de la démonstration étaient visibles, la progression native avançait et Entrée mettait la lecture en pause avec focus visible ; transcription et fiche restaient lisibles par défilement vertical. À 400 %, les commandes/textes se repliaient, la fiche passait sous la transcription et Tab/Entrée sur Recommencer remettait la progression à zéro en restant en pause. Le focus était visible et aucun défilement horizontal imposé n'a été observé dans les zones inspectées : hero, démonstration, transcription et fiche. Le zoom a été restauré à 100 %. La capture locale ignorée `.output/test-evidence/native/edge-400-receipt.png` appartient à cette observation du contrôleur.

**Zoom natif observé, dans ce périmètre uniquement** : ce résultat concerne cette fenêtre et ces sections au commit cité, pas toute page, résolution, combinaison de navigateur ou la correction d'icône ultérieure. Il complète les approximations de viewport ci-dessus sans les confondre avec le zoom natif.

## Recettes humaines encore non vérifiées

Lecteur d'écran : **non vérifié**. Le contrôleur a lancé Narrateur Windows **10.0.26100.8972**, mais son interface possède une intégrité supérieure à celle de l'outil de contrôle ; l'accès au récapitulatif vocal et au focus n'a pas permis d'observer fiablement les commandes, annonces et erreurs. Le Narrateur lancé pour cette recette a été fermé, sans installation ni changement de privilèges/réglages. Aucune sortie vocale partielle ne constitue une recette complète. Aucun résultat axe ou arbre d'accessibilité n'est présenté comme un test de lecteur d'écran. Sur la preview compilée, relever navigateur/version, lecteur/version et observations pour chaque point :

1. Le groupe « Métier de l'exemple » expose le métier sélectionné ; changer de métier reste compréhensible et le focus suit le contrôle.
2. Les commandes annoncent « Écouter l'exemple », « Pause » et « Recommencer » au moment approprié.
3. « Progression de l'exemple » expose une progression compréhensible ; compteur et transcription ne sont pas récités en continu.
4. Bloquer le média puis lancer la lecture : l'erreur est annoncée sans déplacement du focus. La transcription et la fiche restent consultables.
5. Parcourir la transcription puis « Ce que vous recevez » ; comprendre leur caractère fictif, la demande et l'action restant à confirmer.

Écoute humaine intégrale des deux MP3 actuels Grok ara/sal, intelligibilité, qualité des voix et concordance audio/texte : **reportée explicitement par l'utilisateur, non vérifiée**. Les assets Windows du jalon précédent restent dans l'historique Git. Les tests de métadonnées, cues et currentTime ne remplacent pas l'écoute.

Les comparaisons initiales A/B restent hors dépôt. Le choix Grok est provisoire ; la génération des deux illustrations ci-dessous ne vaut pas acceptation de leur qualité par écoute humaine ou publication.

Revue indépendante et Oracle du jalon : pilotées par le contrôleur, pas attestées par ce document d'implémentation. Publication, CI distante, hébergement France et conformité : aucune nouvelle preuve dans ce lot local. Le traitement IA externe observé pour la révision suivante se limite à la synthèse de dix textes fictifs ; il ne qualifie aucun appel réel.

## Révision des voix enregistrées — 30 septembre 2026

Base de la révision : `f3d0a0142b6a7ab756b92613ccc79e8a65567063`. Le contrôleur a exécuté une fois le producteur PowerShell hors ligne avec une clé de processus transitoire, puis l'a effacée. Les dix répliques françaises existantes ont été synthétisées par `x-ai/grok-voice-tts-1.0` via OpenRouter, voix `ara` pour Sparra et `sal` pour le client, format MP3 et vitesse fournisseur par défaut. Aucun texte, fiche, export TypeScript, lecteur, pin ou frontière privée ne change.

Chaque segment reçu a été validé et décodé avant mise en cache. ffmpeg le convertit en PCM mono 24 kHz, insère les pauses mesurées de 0,35 s et encode les deux actifs en MP3 mono 24 kHz / 64 kbit/s sans métadonnées. Les cues proviennent des durées réellement mesurées des segments normalisés. [La provenance actuelle](../demos/audio-provenance.json) conserve dates, modèle, voix et empreintes des segments et actifs, et indique explicitement les qualifications humaines et téléphoniques non vérifiées.

| Contrôle de cette révision | Résultat local observé |
| --- | --- |
| Aperçu `generate-demo-audio.ps1 -DryRun` final | 10 succès déjà livrés nécessitent une reprise manuelle car leur cache brut a été perdu ; zéro nouvel appel prévu et aucun appel de régénération exécuté |
| Tests actifs/cues, HTTP compilé et canaris après correction du cache | 28 tests / 4 fichiers passés : décodage réel, empreintes, texte/fiche, pauses, refus d'entrée, blocage d'une tentative incertaine et absence de nouvelle facturation prévue |
| `pnpm lint`, `pnpm typecheck` | Passés séquentiellement |
| `pnpm build` | Web et worker compilés ; avertissement de chunk client de 538,59 kB conservé |
| HTTP public compilé et canaris qualité | 8 tests / 2 fichiers passés |
| `pnpm test:a11y` | 13 cas passés sur les nouveaux MP3 : commandes natives, pairing, erreurs/reprise, clavier, CSP, axe, aucun appel externe |

Pour cette recette navigateur, Docker Desktop `desktop-linux` 29.6.1/Linux amd64 ; ressources libres avant lancement : 5,74 GiB physiques et 15,10 GiB virtuels. Les fixtures jetables existantes ont terminé sans erreur de nettoyage. Les régressions auth/Workspace et la suite historique de 707 tests ne sont pas rejouées dans ce périmètre sans modification privée.

Le premier cache était placé sous `.output` : la préparation du build Nitro efface ce répertoire. Ce défaut a fait perdre les dix segments bruts et leurs identifiants de génération après leur livraison réussie. Le cache durable et son verrou sont désormais dans `.demo-audio-cache/`, ignoré par Git et extérieur aux sorties de build et médias publics. Une trace de vérification possédée a survécu inchangée au build normal et aux tests ciblés, puis a été retirée seule. Le producteur refuse les demandes connues de la provenance quand leur cache brut manque, avant accès à la clé ou appel réseau. Les identifiants perdus ne sont pas reconstruits ; le coût exact de ces dix appels reste **non vérifié**.

Garage : **30,344 s**, SHA256 `5f4bae1632493c8aaf9cffbc4a16de8ca9cf9a780d2cb506a28f1ab8555c1366`. Contrôle technique : **33,224 s**, SHA256 `2c63695364859f5d633800cce7031dc280b548ff47cf331628605bb2f2e4f150`. La source éditoriale conserve SHA256 `26c28bb683e29591704954ed7869fe965361e9ef7b3c213adc1628e112c136eb`.

Ces résultats attestent le producteur d'illustrations et leur lecteur local. Ils ne prouvent pas une qualité proche de l'humain, un test de lecteur d'écran, ni une qualification de téléphone PCMU 8 kHz, de latence, d'interruption ou de politique fournisseur.
