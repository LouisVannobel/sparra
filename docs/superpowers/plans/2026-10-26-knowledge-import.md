# Sparra — connaissances confirmées et copie ponctuelle d’une page

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permettre au gérant de préparer ses connaissances manuellement ou depuis une page publique, relire les cinq textes exacts et les confirmer dans les révisions existantes avec provenance et récupération d’un accusé perdu.

**Architecture:** Réutiliser le module activité, son bail Workspace, son éditeur mémoire et sa navigation protégée. Une acquisition HTML bornée produit des passages sans LLM ; un stockage source court côté serveur protège leur provenance. Une confirmation native atomique conserve un reçu indépendant de la purge des anciennes révisions. Aucun constructeur documentaire ni nouveau worker.

**Tech Stack:** Pins actuels de main : Node 24.22.1, pnpm 10.32.1, TanStack Start, Effect 4, Drizzle/PostgreSQL, React/Astryx ; parse5 et ipaddr.js sont les seuls ajouts envisageables, chacun pour un consommateur précis.

**Spec:** C:/Users/louis/.codex/artifacts/sparra/2026-10-22/recherches-thematiques/01-import-site/SYNTHESE.md et ORACLE_REVIEW.md ; autorisation directe d’implémenter du 26 octobre. Les contraintes lecture seule de l’enquête sont remplacées par cette autorisation pour ce lot produit local. Aucun appel réel, achat, déploiement ou mutation de configuration partagée.

## Global Constraints

- Worktree exclusif C:/Users/louis/Documents/ChatGPT/.worktrees/sparra-knowledge-import-oct26, branche z/sparra-knowledge-import-oct26, base origin/main 45a5061. Le natif de cette conversation est lié à infra et ne peut cibler Sparra ; fallback Git local, tentative attach_worktree refusée car non géré. Toujours utiliser ce chemin explicitement.
- Ni secrets/.env/goal-objective, ni fournisseur IA ou téléphonie ; pas de push ou mise en production. Préserver les autres worktrees.
- Français pour ce parcours, conserver les parcours FR/EN existants ; Astryx et transactions natives seulement. Ne pas remettre transfert/audio/calendrier à zéro.
- Une page HTML HTTPS publique sur 443, sans cookie/auth/script/média/crawl, trois redirections au maximum de même origine. IP effectivement connectée publique après contrôle DNS ; destinations internes et hôte applicatif refusés.
- Acquisition au plus 15 s dans une tentative totale de 30 s, 2 097 152 octets décompressés et 50 000 unités UTF-16. Pour rester simple, demander identity et refuser une compression non sollicitée plutôt qu’ajouter un décompresseur. Dépassement/interruption : aucun fragment applicable.
- Passage intégral sourcé, jamais montant ou horaire inféré ; prix absent reste inconnu. Aucun préremplissage de instructions/destination/capacités. Les textes approuvés n’accordent aucun pouvoir au modèle.
- Cinq textes normalisés et bornés AVANT aperçu intégral puis confirmation ; aucun changement après confirmation. Attestation explicite de portée, conditions et exclusion des faits temporaires dans les cinq textes ; pas de faux classificateur universel de dates. Le gérant résout maintien/remplacement/retrait, pas le web.
- expectedRevision et identité/version de brouillon ; une seule confirmation sur même base réussit. Réponse perdue : reçu exact retrouvable pendant sept jours fixes après enregistrement, même après une version plus récente, aucune réécriture sur base rafraîchie automatiquement. Reçu absent/expiré = résultat historique non vérifiable, jamais preuve d’absence d’enregistrement.
- Peu de tests utiles : budget initial ~6 tests acquisition, ~4 contrats natifs, ~2 parcours UI. Réutiliser les fixtures ; aucune campagne des 40 scénarios. Suite ordinaire finale une fois, plus typecheck/build/lint et intégration directement touchée ; élargir uniquement en cas d’échec justifié.

## Review Focus

1. Ancien prix dans FAQ/consignes : le retrait doit se relire dans les cinq textes, sans prétendre arrêter les appels déjà admis — tâche 3.
2. Réponse perdue puis K9 et purge de K8 : retrouver le reçu sans nouvelle sauvegarde ni FK qui bloque Voice — tâche 2.
3. Page publique redirigée/DNS privé ou flux trop gros : aucune connexion interdite ni fragment salvagé — tâche 1.
4. Édition après aperçu et résultat d’import tardif : aucune confirmation ancienne ni écrasement récent — tâche 3.
5. Réglages audio/transfert déjà présents : confirmation conserve les valeurs exactes et les données d’un autre propriétaire restent inaccessibles — tâche 2.

### Task 1: Acquisition d’une page et passages vérifiables

**Files:** créer src/modules/sparra/website-capture.server.ts, src/modules/sparra/website-text.server.ts, tests/sparra/website-capture.test.ts ; modifier package.json/pnpm-lock.yaml seulement pour les deux consommateurs parser/IP si nécessaires.

**Interfaces:** export `WebsiteCapture = Readonly<{url:string;capturedAt:string;title:string;sha256:string;passages:ReadonlyArray<Readonly<{id:string;text:string}>>}>` ; export `captureWebsite(input:string,options:{signal?:AbortSignal;blockedHosts?:readonly string[]}):Promise<WebsiteCapture>`. Pas de DB, RPC, secrets ni catégorisation générative. Les tests peuvent injecter une frontière transport/DNS étroite réellement utilisée par la composition native ; aucun adaptateur factice dans le runtime.

- [ ] Écrire et observer RED pour URL/IP/refus redirection, pin de destination publique, HTML inerte avec horaires/services et conditions conservées, dépassement de taille/temps/annulation sans résultat.
- [ ] Implémenter acquisition et parsing sans exécution ; vérifier les extraits dans la capture. Délais/flux détruits proprement, erreurs stables sans corps ni secrets. Les passages ne sont ni une connaissance validée ni une consigne.
- [ ] Exécuter les seuls tests ciblés de tâche, typecheck du consommateur puis self-review ; commit local et rapport SDD.

### Task 2: Capture propriétaire et confirmation native avec reçu

**Files:** créer src/modules/sparra/knowledge-confirmation.server.ts et une migration forward 0027_sparra_knowledge_confirmation.sql + journal, déclarations Drizzle ; modifier activity.server.ts / sparra.functions.ts et maintenance ciblée si nécessaire ; tests/integration/sparra-knowledge-confirmation.test.ts.

**Interfaces:** RPC authentifiées `importKnowledgePage({url},signal)` retournant `{captureId,source:WebsiteCapture}` ; `confirmActivity({draftId,draftVersion,activity:SaveActivityInput,captureId?:string,decisions,confirmed:true},signal)` ; `getActivityConfirmation({draftId,draftVersion},signal)`. Le résultat de confirmation donne `{revision,savedAt}` et la connaissance du résultat exact ; recharger séparément l’état courant via getActivity. Le résultat historique n’est jamais présenté comme la tête actuelle.

- [ ] Vérifier la composition native existante, lire les guides locaux des pins. Les sources sont stockées côté serveur sous autorité Workspace (une capture récente par Workspace, expiration une heure). Édition du brouillon reste en mémoire client, navigation protégée et perte après fermeture forcée honnêtement annoncée.
- [ ] Reçu immutable propre au Workspace, clé `(workspaceId,draftId,draftVersion)`, révision numérique, empreinte de l’entrée normalisée, source/décisions bornées et date ; sept jours de récupération. Pas de FK restrictive vers révision : maintenance ne tolère QUE la FK native appel, et l’ancienne révision peut être purgée. Aucun doublon intégral des cinq textes nécessaire. Provenance d’une capture chargée côté serveur, jamais une citation client déclarée vérifiée par Sparra.
- [ ] Après autorité et verrou Workspace, chercher D’ABORD le reçu non expiré ; calculer l’empreinte côté serveur sur la soumission normalisée exacte, sans dépendre de la capture. Même identité/même contenu retrouve le reçu ; identité identique/contenu différent refuse. Seulement sans reçu valide, vérifier capture, passages et expectedRevision, puis créer révision/reçu dans le même bail natif. Aucun réseau sous verrou SQL. Préserver tous les réglages activité actuels. Lecture/recherche propriétaire refuse les autres Workspaces.
- [ ] Reçu sans FK vers capture ET révision ; provenance nécessaire copiée dans le reçu borné. Capture remplacée/expirée interdit une première confirmation, jamais une reprise déjà acquise. Sept jours fixes depuis savedAt, non prolongés par lecture/reprise. Absence de preuve donne « résultat historique non vérifiable » et interdit un retry automatique.
- [ ] Cleanup borné des captures/reçus expirés sous autorité native ; raccorder au consommateur de maintenance existant sans nouveau worker, nouvelle identité provider ou modification des migrations historiques. Nettoyage d’un Workspace conserve son contrat. La rétention des révisions liées aux appels reste native.
- [ ] Observer RED puis GREEN sur ~4 tests natifs regroupant atomicité/rollback, concurrence et isolation, reçu après K9+purge de K8, expiration/cleanup et conservation audio/transfert. Actualiser seulement les assertions de journal de migration directement touchées.
- [ ] Commit local, rapport et revue tâche. Ne pas revendiquer une injection LLM nouvelle : les cinq textes passent par le snapshot existant.

### Task 3: Parcours visible, aperçu exact et reprise

**Files:** modifier src/ui/sparra/activity-panel.tsx, messages.ts, routes/app.entreprise.tsx ; créer composant ciblé knowledge-import-panel.tsx si nécessaire ; tests UI/browser existants de navigation et Sparra.

**Interfaces:** consommer les RPC tâche 2 et WebsiteCapture tâche 1, injecter callbacks au panneau comme les opérations actuelles. Pas de seconde route d’administration, formulaire générique ou second versioner.

- [ ] Observer RED sur deux parcours : import/choix d’un passage/correction/aperçu intégral/confirmation ; résultat tardif annulé ou accusé perdu puis relecture du reçu exact sans rejouer.
- [ ] Boutons « Lire cette page », « Renseigner moi-même », « Annuler », texte copie ponctuelle/date/source, limites et erreurs françaises. Aucun chargement HTML brut ; source consultable avec lien sûr. Les passages choisis préparent les rubriques factuelles ; consignes restent manuelles. Absence de tarif/exclusion lisibles, aucune promesse de fraîcheur automatique.
- [ ] Aperçu de tous les cinq textes après normalisation et bornes, confirmation unique explicite, réinitialisée après édition. Attestation : « Je confirme avoir relu les cinq textes affichés. Les informations décrites sont applicables dès maintenant et restent utilisées jusqu’à ma prochaine modification. J’ai retiré toute prise d’effet future, expiration ou exception datée, y compris dans la FAQ, les consignes et les ajouts manuels. Sparra ne détecte ni n’actualise automatiquement ces informations. » Engagement humain, pas garantie automatique. Un passage corrigé devient une adaptation du gérant, pas une citation de source. Indiquer que l’ancien prix reste utilisable avant confirmation et par les appels déjà admis.
- [ ] Associer dirty/pending/reconcile à la navigation existante ; capture avant confirmation ne change aucune révision. Conserver le brouillon après échec et distinguer reçu historique/état courant. Clavier/focus et lecture mobile dans la vérification ciblée, pas de campagne visuelle exhaustive.
- [ ] Commit et rapport tâche ; une revue indépendante de branche et Oracle final sur diff + résultats minimaux. Corriger les écarts concrets puis lancer une fois les checks finaux appropriés. Aucune publication implicite.

## Décisions de méthode

L’utilisateur a déjà autorisé l’implémentation ; AGENTS impose la poursuite autonome et les sous-agents par tâche. Pas de nouvelle validation de principe du plan. La revue Oracle préliminaire challenge seulement les choix nouveaux de persistance et de contrôle humain ; la tâche 1 indépendante peut progresser. Les décisions concrètes sont consignées dans le ledger de ce plan.
