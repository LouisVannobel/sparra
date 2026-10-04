# Sparra site et audio — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Livrer une première version locale vérifiée du site Sparra, avec deux exemples audio Garage/Contrôle technique, transcription et fiche professionnelle cohérentes.

**Architecture:** Une dérivation séparée du R1 imposé, sans changement d'auth/tenancy. La page publique est rendue par TanStack ; son lecteur React/Astryx consomme des actifs locaux fictifs. Le pilote configuration→appel→inbox reste la tranche suivante du produit global.

**Tech Stack:** TanStack Start/Router, React/Astryx, TypeScript/Effect R1 ; HTMLAudioElement ; Vitest/Playwright/axe existants. SpeechSynthesizer Windows et ffmpeg servent seulement à produire des illustrations audio locales.

**Spec:** [Spécification adoptée](../specs/2026-09-30-sparra-first-delivery-design.md).

**Statut:** Plan validé par l’utilisateur le30septembre, méthode « sous-agents par tâche ». Implémenteur distinct par tâche, revue indépendante de spec/qualité après chaque tâche, puis revue globale et Oracle à la fermeture. Exécution autorisée dans le nouveau dépôt Sparra.

## Global Constraints

- Nouveau dossier `C:/Users/louis/Documents/ChatGPT/sparra` ; préserver producteur, infra dirty, anciens checkouts et sparraprivate.
- Base `f932b25356c82d9a5c89d0849409f043b05f95cb2206b1d7870878c00cc4e4c6`, source ZIP SHA256 `58F5F513D99EDCAD628E5FC214E7B989349E1BA4133AA0E91CB4F5E5B58B010A` ; conserver DELIVERY.json et provenance.
- Node `24.14.0`, pnpm `10.32.1`, TypeScript `7.0.2`, Effect `4.0.0-rc.111`, Astryx `0.5.4` ; pins/patch nice-grpc R1 inchangés.
- Auth et autorité Workspace R1 conservées ; aucune route privée, table/migration métier ou capacité de récupération ajoutée dans ce lot.
- Application et données en France, traitements IA externes explicitement déclarés. Aucune affirmation publique de localisation/conformité avant preuve.
- Aucun secret du fichier objectif utilisé ; aucun provider live, achat, DNS, migration partagée, push ou déploiement dans ce lot local.
- Exemples fictifs, audio illustratif déclaré, RDV à confirmer ; pas de fausse livraison de message, témoignage, tarif ou réservation.
- Le thème/CSS précompilé Astryx déjà présents restent l'autorité UI ; pas de second design system, tracker, CDN, graphe de fontes ou compilateur StyleX.
- La palette adoptée est papier `#f7f6f5`, blanc, noir, surligneur `#edfc47` en accent. Typographie locale `system-ui`, titres de poids500 et échelle responsive ; les styles marketing ne changent pas la typographie des parcours privés.
- Les sorties générées du routeur suivent son générateur. Effet interdit côté client ; aucune abstraction de service marketing.
- Vérification séquentielle, un worker ; intégrations sélectionnées sur fixtures jetables après vérification de leur périmètre/ressources. Aucun cleanup étranger.

## Review Focus

1. `/ ?lang=en` reste un document français ; les pages privées FR/EN gardent langue/provider et navigation corrects — tests tâche1.
2. Une erreur, un POST ou une route voisine ne deviennent pas indexables par l'exception marketing — tests tâche1.
3. Les flèches du SegmentedControl changent le métier : le son précédent s'arrête et aucune lecture automatique ne commence — tests tâche2.
4. Une annulation volontaire ou un résultat tardif d'un ancien média ne signale pas une fausse erreur ; une vraie panne courante garde le contenu avec erreur annoncée — tests tâche2.
5. Sur320px/zoom, commandes et fiche restent accessibles, sans overflow ni focus perdu — tests tâche3.

---

## Task 1 — Dérivation R1 et vraie page publique

**Files:**
- Reprendre les262 fichiers ZIP dans le nouveau dossier, sans extraction par-dessus un dépôt existant.
- Create: `docs/handoff/SPARRA_PROVENANCE.md`, `src/routes/index.tsx`, `src/ui/marketing/sparra-landing.tsx`, `src/ui/marketing/marketing.css`, `tests/marketing/public-http.test.ts`.
- Modify: `AGENTS.md` pour contextualiser le mandat produit ; `src/server.ts`, `src/routes/__root.tsx` ; README/package name seulement si nécessaire pour identifier la dérivation.
- Reference: `tests/helpers/web-process.ts`, fixtures pg-wire/redis-wire, `tests/platform/web.test.ts` ; ne pas créer un deuxième lanceur applicatif.

**Interfaces:**
- Consumes: root `Theme`/`InternationalizationProvider`, `Route.useSearch()`, hook `useRouterState({select: state => state.location.pathname})` compatible SSR.
- Produces: `SparraLanding(): React.JSX.Element` dans `src/ui/marketing/sparra-landing.tsx`, route `/`, ancres `#fonctionnement`, `#offre`, `#controle` et vrai `mailto:contact@sparra.fr`. Le lecteur et son ancre seront ajoutés par tâche2 lorsqu'ils ont leurs actifs.
- Root utilise `documentLang = pathname === '/' ? 'fr' : lang` et conserve la navigation de langue privée. CSS marketing uniquement sous `.sparra`.

- [ ] **1. Reprendre et qualifier la base.** Vérifier empreinte et tous chemins ZIP, leur confinement et l'absence d'overwrite. Lire guide/README/AGENTS extraits. Initialiser un historique Git SHA-1 local, conserver l'import original comme commit de référence, puis branche `z/sparra-site-audio`. Installer avec lock figé et exécuter `pnpm typecheck`, `pnpm build`, `pnpm test`. Noter commandes/résultats réels ; aucune base existante migrée.
- [ ] **2. Écrire les tests HTTP du consommateur avant le code.** Réutiliser pg-wire/redis-wire et `startWeb` seulement dans les tests ; le runtime de production reste R1. Sur application compilée, fixer ces assertions :

```ts
expect(response.status).toBe(200) // GET / et HEAD /
expect(response.headers.get('x-robots-tag')).toBeNull()
expect(html).toContain('<html lang="fr"') // aussi /?lang=en
expect(html).toContain('Sparra')
expect(html).toContain('mailto:contact@sparra.fr')
expect(csp).toContain("media-src 'self'")
expect(csp).not.toMatch(/script-src[^;]*(unsafe-inline|unsafe-eval)/)
```

Ajouter tests nommés `only successful root documents are indexable` et `private and missing routes keep their protected headers` : `/login?lang=en`, `/workspace`, `/inconnu`, `/?lang=en`, méthode POST et réponse contrôlée500. L'exception dépend de pathname `/`, GET/HEAD, réponse2xx et document HTML ; elle seule autorise `media-src 'self'`. Les autres réponses conservent noindex/no-store, nonce et CSP privée antérieure sans ouverture média. Le corps public exclut session/token/config privée.

- [ ] **3. Observer RED.** Avec le build R1 intact : `pnpm exec vitest run tests/marketing/public-http.test.ts --maxWorkers=1`. La nouvelle route est404 ; conserver la sortie de cet échec, pas seulement une prédiction.
- [ ] **4. Implémenter la page et l'exception précise.** Ajouter la route de fichiers et `SparraLanding`. Navigation/hero, les quatre étapes exactes du brief, bande de réassurance conditionnelle, exemple de connaissances clairement fictif, règle de relais humain et unique offre mensuelle sans prix inventé. Contact ouvre un e-mail ; aucune confirmation d'envoi. Métadonnées SSR : titre « Sparra — votre assistant téléphonique IA », description métier factuelle et canonical propre `https://sparra.fr/`, sans paramètres. Ajouter leurs assertions au test HTTP. Les adaptations HTTP/locale sont limitées à leurs vrais consommateurs. Aucun lien « écouter » vers un panneau vide.
- [ ] **5. Vérifier et committer.** `pnpm build` génère les nouveaux types de route, puis `pnpm typecheck`, test HTTP ciblé et `pnpm test`. Lire les résultats et `git diff --check`, puis commit local `feat: introduce Sparra public landing on R1`. Conserver le SHA d'import et tous fichiers amont dans l'historique ; ne pas committer node_modules/.output ou secrets.

## Task 2 — Deux véritables actifs audio et démonstration cohérente

**Files:**
- Create: `docs/demos/scenarios.fr.json`, `scripts/generate-demo-audio.ps1`, `src/modules/marketing/demo-scenarios.generated.ts`, `src/modules/marketing/demo-cue.ts`, `src/ui/marketing/sparra-demo.tsx`, `public/demos/garage-revision.mp3`, `public/demos/controle-technique.mp3`, `docs/demos/audio-provenance.json`.
- Create tests: `tests/marketing/demo-cue.test.ts`, `tests/marketing/demo-assets.test.ts`, `tests/integration/marketing-browser.test.ts`.
- Modify: landing/CSS de tâche1 pour insérer le vrai panneau `#demo` et ses liens.

**Interfaces:**
- `scenarios.fr.json` est la source éditoriale des deux dialogues et fiches fictifs. Le générateur produit audio et module TS ; aucune édition manuelle du module généré.
- Generated exports: `demoScenarios`, `DemoScenario`, `DemoSectorId`. Chaque scénario : `id`, `label`, `audioSrc`, `durationSeconds`, `cues[{speaker:'sparra'|'client',text,startSeconds,endSeconds}]`, `receipt{status,contact,phone,summary,nextAction}`. IDs exacts : `garage`, `controle-technique` ; seuls ces scénarios complets sont activés.
- `currentCueIndex(scenario: DemoScenario, seconds: number): number | null` : intervalle `[start,end)`, null dans le silence, hors bornes ou entrée non finie. Vrai consommateur : repérage de la réplique courante.
- `SparraDemo(): React.JSX.Element` consomme ce catalogue et HTMLAudioElement. Imports publiés `Button` de `core/Button`, `SegmentedControl`/`SegmentedControlItem` de `core/SegmentedControl`. Props Button `label`/`onClick` ; groupe `label`, `value`, `onChange`, `layout="fill"`. Aucun `onPress` ou `disabled` inventé.

- [ ] **1. Écrire les tests du lecteur et des actifs.** Tester bornes exactes/NaN/silence du repérage. Tests assets : MP3 effectivement décodables via ffprobe, durée conforme à0.3s près, intervalles triés/non chevauchants dans la durée, premier message annonçant « agent IA », audio et fiche du même métier, aucune vraie coordonnée. Le générateur refuse ID hors des deux valeurs/dupliqué et cible sortant de ses dossiers avant toute écriture/cleanup. Browser : zéro autoplay ; lire→pause→recommencer ; flèche du radiogroup change audio/transcript/fiche ensemble ; vraie panne audio annoncée avec contenu conservé. Test `late canceled play cannot affect the next sector` : retarder le chargement Garage, demander lecture, sélectionner Contrôle technique, laisser rejeter l'ancienne promesse ; nouveau média en pause/curseur0, sans fausse erreur ni état Garage. Test `leaving the demo stops its media` : navigation vers une autre page arrête l'élément précédent. Ne pas simuler un fournisseur vocal dans le runtime.
- [ ] **2. Observer RED.** Lancer tests marketing ciblés ; le catalogue/lecteur est absent. Pour le test browser, employer application compilée et les fixtures jetables R1 existantes, avec1worker ; nommer le résultat absent, sans transformer une erreur de fixture en preuve fonctionnelle.
- [ ] **3. Produire les deux illustrations audio locales.** SpeechSynthesizer avec voix françaises effectivement disponibles : Julie pour Sparra, Paul pour l'appelant, rate0. Première phrase explicite IA. Garage : demande de révision/préférence de rappel ; contrôle technique : demande de visite/préférence à confirmer. Aucun diagnostic, tarif/créneau inventé ou transfert prétendu réussi. Exporter chaque réplique, pause0.35s entre tours, concaténer avec ffmpeg en MP3 mono24kHz/64kbps, calculer les cues à partir des segments effectivement exportés. Les temporaires appartiennent à `.output/demo-generation/` ; contrôler les cibles absolues avant cleanup. Aucun dépendant runtime ajouté pour ces outils.
- [ ] **4. Écouter et qualifier les actifs.** Écouter les deux fichiers complets ; vérifier intelligibilité française, alternance et accord texte/son. Produire provenance avec outil/voix/scénario/empreintes, sans identité de machine ou clé. Si la qualité n'est pas acceptable, ne pas montrer un média trompeur : corriger la génération, ou obtenir un enregistrement réel autorisé avant fermeture de tâche. Ces actifs restent des illustrations de prévisualisation locale ; leur publication attend les droits applicables ou leur remplacement par les captures runtime qualifiées.
- [ ] **5. Implémenter le panneau.** Label visible « Exemple enregistré — scénario fictif » et fiche illustrative. Bouton écouter/pause, bouton « Recommencer » qui remet à0 et reste en pause, progression/temps et transcription toujours lisible. Changement de métier pause l'ancien élément, remet le curseur à0 et remplace les deux côtés, y compris aux flèches. Rattacher les résultats de `play()` à la tentative et au média courants ; pause/recommencement/changement/démontage invalident la tentative avant de l'interrompre, et le démontage arrête explicitement le média capturé. Ignorer les résultats périmés/annulés, mais annoncer les véritables rejets et erreurs du média courant. Ne pas ignorer globalement toutes les AbortError. Pas de focus déplacé, autoplay, waveform ou service générique.
- [ ] **6. Vérifier et committer.** Rebuild puis tests actifs/curseur/browser ciblés, typecheck et écoute humaine. Commit local `feat: add paired profession audio demonstrations`. Aucun succès de chaîne téléphonique ne découle de ce commit.

## Task 3 — Contrôles anti-slop et recette compilée du lot

**Files:**
- Copy/adapt: `tools/oxlint/anti-slop/**` avec LICENSE/provenance depuis le starter au SHA `c7a5443333f25d990d80dcdfe3a31a29dfa0ee7b`.
- Create: `.oxlintrc.json`, `tests/quality-policy.test.ts`, `docs/qa/site-audio.md`.
- Modify: `package.json`, `pnpm-lock.yaml`, tests browser marketing et test HTTP seulement pour les régressions trouvées.
- Reference regression: `tests/platform/web.test.ts`, `tests/integration/workspace-browser.test.ts`.

**Interfaces:**
- Ajouter uniquement devDependencies `oxlint:1.78.0`, `@oxlint/plugins:1.78.0`. Garder une unique commande tsc normative.
- `lint` exécute le contrôle sur les chemins produit de ce lot et les frontières partagées modifiées : modules/UI marketing, index, root, server et tests marketing. Le périmètre est explicite ; aucune revendication de lint global R1, aucune suppression générale de diagnostics.
- `test:a11y` exécute le browser marketing via Vitest integration existant. Aucun second runner Playwright, doctor/fallow ou workflow copié pour satisfaire artificiellement une future CI.

- [ ] **1. Écrire les canaries avant adaptation.** Adapter au dossier `src` et aux consommateurs actuels les fixtures du contrôle publié : code sain accepté, double assertion et import de constructeur de service rejetés. Les fixtures sont temporaires et possédées par le test ; ne pas garder `next/navigation`, contraintes Doctor ou scripts Next dans les assertions Sparra. Observer l'échec avant l'activation effective du contrôle.
- [ ] **2. Activer et vérifier le contrôle réel.** Ajouter les deux pins dev, plugins/config publiés et canaries adaptés. Conserver les sources/licence originales ; les sélections de règles restent explicites. `pnpm lint` et `pnpm exec vitest run tests/quality-policy.test.ts --maxWorkers=1` doivent passer. Si un conflit réel avec R1 apparaît, documenter son consommateur et corriger précisément ; ne pas changer les pins applicatifs ni mettre un bypass.
- [ ] **3. Compléter la recette utile.** Dans marketing-browser : axe, clavier/focus,320px et1280px, zoom simulé par viewport/layout + contrôle manuel200%/400%, erreur réseau média, source changée pendant lecture, import CSS/nonce et zéro requête externe. Ajouter la recette au lecteur d'écran prévue par la spec : métier sélectionné identifiable, commandes nommées selon leur action, progression compréhensible, erreur annoncée sans déplacement de focus et transcription/fiche consultables. Aucun aria-live ne doit réciter continuellement compteur/transcription. Consigner navigateur, lecteur et résultats réellement observés ; axe vert ne remplace pas cette recette. Si elle n'est pas réalisée, conserver « non vérifié » et ne pas déclarer cette exigence passée. Le screenshot montre une page réellement compilée, pas un mockup.
- [ ] **4. Exécuter les preuves de fermeture.** `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm test:a11y`, puis regression native `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/workspace-browser.test.ts --maxWorkers=1` après vérification des fixtures/ressources. Tests plateforme vérifient toujours auth privé, CSP, timeout/shutdown. Documenter résultats et limites ; aucun suite entière de services partagés.
- [ ] **5. Revue et commit.** Un reviewer indépendant vérifie spec/qualité/design/accessibilité et absence de faux flux ; Oracle reçoit le diff et les preuves minimales du jalon. Résoudre P0/P1 puis vérifier les consommateurs touchés. Commit local de fermeture ; afficher la preview locale et les résultats. Publier une branche/CI/déploiement n'appartient pas à ce lot local.

## Suite du produit global — conservée, non exécutée par ce plan

1. **Connaissances/inbox réelles :** Workspace personnel propriétaire unique, sauvegarde/version de configuration, fiches/état traité, migrations forward/grants/RLS, rétention/suppression explicites ; auth R1 conservée.
2. **Pilote vocal :** reprise du Voice livré, injection effective du prompt/connaissances, capture des coordonnées, SQL ingest/lease/ack, fiche structurée, action de transfert humain limitée, événements dédupliqués/désordonnés et repli. Qualifier configuration→appel réel→fiche dans le bon Workspace. Remplacer les illustrations par des captures de ce runtime avant de clore l'objectif de vraie démonstration Sparra.
3. **Infrastructure/publication :** paquet R1/worker adapté, santé revision et workflows partagés SHA-pinnés, ressources isolées sur les hosts, preuve d'hébergement France, fournisseurs IA/flux déclarés, backup/restore et ingress. Préparer la bascule réversible de l'ancien site avant mutation.
4. **Téléphonie/commerce :** clés exposées remplacées, compte/justificatifs/numéro français et coûts exacts vérifiés dans le plafond autorisé ; recette réelle. Prix mensuel unique à décider sur données de coût. Commerce et lifecycle amont reçus/recettés avant clients payants, sans implémentation parallèle.

Le lot site/audio fermé n'achève pas l'objectif Sparra. Son acceptation exige ses vrais médias/consommateurs vérifiés ; le produit final exige aussi les preuves de ces tranches restantes.
