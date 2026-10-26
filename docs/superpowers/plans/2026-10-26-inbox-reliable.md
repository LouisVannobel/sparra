# Inbox fiable — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Livrer une inbox simple dont le classement se rapporte à une fiche réellement publiée et résiste aux résultats tardifs et aux anciens clics.

**Architecture:** Étendre le freeze Voice et la persistance sous l'appel ; un instantané courant, une transaction native R1 et les contrôles existants. Aucun nouveau service ou historique exhaustif.

**Tech Stack:** Stack/pins actuels de main, Node24.22.1, pnpm10.32.1, TanStack Start/Effect/Better Auth/Drizzle/PostgreSQL/Astryx ; Python/uv épinglés dans Voice.

**Spec:** docs/superpowers/specs/2026-10-26-inbox-reliable-design.md ; synthèse/matrice validées du dossier02 du22–23octobre.

## Global Constraints

- Worktree web C:/Users/louis/Documents/ChatGPT/.worktrees/sparra-inbox-reliable-oct26 ; Voice C:/Users/louis/Documents/ChatGPT/.worktrees/sparra-voice-inbox-reliable-oct26. Conserver les autres checkouts.
- Aucun .env/secret/donnée client, service live, push ou déploiement. Migrations forward sur stores jetables possédés seulement. Pas d'édition d'anciennes migrations.
- Un package/lockfile inchangé ; dépendances natives existantes ; auth/tenant/lease/CSRF/no-store/effacement préservés.
- Implémenter les trois tâches sans redemander le principe déjà autorisé. Un implémenteur neuf et revue indépendante par tâche, puis Oracle sur le contrat/diff final.
- Tests ciblés et preuve RED/GREEN ; pas suite native globale, coverage marathon ou rejeux répétés sans besoin. Tout test non exécuté reste nommé tel quel.

## Review Focus

1. Marqueur final avant ses tours/audio : ne pas rendre classable jusqu'à concordance ; tâche1.
2. Résultat agenda qui change hors sparra_call : même instantané/version, aucune lecture vivante avec jeton ancien ; tâche1/2.
3. Traiter→remettre→vieux clic/reçu, même publication : jeton de décision empêche réactivation ; tâche2/3.
4. Même ID mais données rafraîchies : état et commande portent exactement la même publication ; tâche3.
5. Ancien appel sans collection et effacement/replay : lisible/provisoire, pas backfill de clôture ou résurrection ; tâche1/2.

### Task 1: Publication persistée et clôture authentique

**Files:**
- Voice Modify: src/projetv0_voice/models.py, session.py, persistence/writer.py ; autres appels freeze seulement si nécessaires au contrat.
- Voice Test: tests/unit/test_sparra_result.py, tests/integration/test_v2_final_call_freeze.py ou test_capture_terminal_publication.py, ciblage des seuls cas utiles.
- Web Create: drizzle/0027_sparra_inbox_publication.sql et snapshot/journal Drizzle correspondants.
- Web Modify: src/modules/sparra/schema.server.ts, définitions SQL nécessaires remplacées dans nouvelle migration ; droits/grants bornés.
- Web Test: un test d'intégration ciblé de publication/collecte réutilisant les stores/ingestion existants ; aucun nouveau runner.

**Interfaces:**
- Consumes: call.upsert V1/V2 et freeze_call_publication_v2, enveloppes/tours/audio/quota/fences existants ; calendar_command existante.
- Produces: extension collection optionnelle stricte, persistée dans freeze/outbox ; marqueur reçu et instantané décisionnel courant, C/A/déclaration/T/première date, clôture explicite ; fonction SQL interne de publication transactionnelle à nommer clairement dans le rapport pour tâche2. Aucun port public nouveau si existants suffisants.

- [ ] Écrire puis observer RED sur le nouveau champ/omission ancienne et clôture avant fragments, replay, résultat agenda tardif.
- [ ] Implémenter le minimum de la spec : marker après preuve de quiescence, manifest vérifiable, instantané chiffré courant et verrou commun. Pas closed→close et pas trigger comptabilité→nouvelle revue.
- [ ] Vérifier les mêmes cas GREEN, guards tenant/effacement utiles, Python ruff/mypy ciblés si fichiers changés ; pas intégration provider.
- [ ] Mettre à jour la fixture Voice par le script existant depuis commit qualifié, ou documenter le consumer explicitRoot utilisé et préparer la mise à jour avant fermeture globale ; ne pas appeler fixture ancienne une preuve nouvelle.
- [ ] Commit(s) locaux explicites dans les deux repos ; rapport interfaces réelles, tests, limites. Revue indépendante spec/qualité.

### Task 2: DTO, filtre et décisions conditionnelles

**Files:**
- Modify: src/modules/sparra/requests.server.ts, sparra.functions.ts, migration0027 si correction d'interface nécessaire ; tests/sparra/requests.test.ts et tests/integration/sparra-requests.test.ts ou consumer ciblé tâche1.
- Create petit module local de types de suivi seulement si nécessaire pour éviter imports serveur en UI.

**Interfaces:**
- Consumes: publication atomique tâche1, transactions R1 et marqueur/clôture.
- Produces: list input view='pending'|'all' (pending par défaut), pagination50 filtrée avant limite ; followUp DTO {publicationRevision,decisionToken,reviewedRevision,declarationActive,collectionClosed,firstDeclaredAt} avec types exacts choisis tâche1 ; evidence au détail ; updateRequestFollowUp input {requestId,expectedPublicationRevision,expectedDecisionToken,treated:boolean}, réponse instantané/état courant cohérent ; erreurs métier de conflit409 et provisoire409 bornées.

- [ ] Tests RED : payload strict/cross-tenant ; déclaration valide puis remise et vieux jeton refusé ; nouvelle publication avant/après déclaration ; accusé perdu suivi d'un conflit sans histoire inventée ; filtre ancien appel à revoir et pagination.
- [ ] Implémenter dans les opérations verticales existantes sans repository/service ; consommer le bundle, pas les tables vives pour contenu décisionnel. Runtime n'obtient pas d'écriture libre sur preuves/publication.
- [ ] GREEN ciblé, adaptations de fixtures exigées par vrais types ; aucun test miroir ni simulation de réservation présentée comme réelle.
- [ ] Commit local et revue indépendante ; interfaces et erreurs exactes transmises tâche3.

### Task 3: Fiche courte, deux vues et commandes cohérentes

**Files:**
- Modify: src/ui/sparra/inbox-panel.tsx, request-panel.tsx, messages.ts, sparra.css et petits helpers existants de lecture/décision ; src/routes/app.index.tsx et app.demandes.$requestId.tsx.
- Test: tests/ui/inbox-refresh.test.ts, request-actions.test.ts et fixture UI existante ; un parcours compilé ciblé si setup actuel le permet sans nouveau framework.

**Interfaces:**
- Consumes: DTO/suivi/erreurs tâche2 ; Astryx et useRequestAttempt existants.
- Produces: navigation À traiter/Tous ; actualisation explicite indivisible ; contact/provenance/demandes/suite/action avant transcription ; liens vers tours ; traiter aprèsclôture, remettre àtraiter secondaire, effacement distinct, première date exacte ; conflit ou résultat réseau inconnu expliqué et relecture.

- [ ] RED sur même ID/nouvellepublication, clic avec contenu/jeton de la même réponse, filtre resetcurseur, remise suivie réponse ancienne, preuves et classement provisoire indisponible.
- [ ] Implémenter sans nouveau design system ni diffusion tempsréel, sans réordonner sousle doigt ; conserver statuts/résultatsagendaexistants, aucun succès déduit d'un résumé.
- [ ] GREEN UI ciblé ; une vérification compilée clavier/320px avec fixtures existantes si possible. Rapporter ce qui est réellement observé.
- [ ] Une fois lot assemblé : typecheck normatif, lint, build web/worker, suites ciblées pertinentes ; Oracle revue standard du diff/résultats et avis indépendant global. Corriger les constats concrets puis revérifier seulement leurs consommateurs.
- [ ] Commits locaux et remise du travail avec chemins, résultats et limites ; aucun push/déploiement.
