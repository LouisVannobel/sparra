# Intégration coordonnée et production — 27 octobre

Autorisation explicite : regrouper import, inbox et correction, vérifier les autres travaux, puis produire la livraison. Worktree z/sparra-integration-oct27 depuis main45a5061 ; branches originales préservées. Sources import3a8369d, inboxWeb9f078d5, correction e793246, VoicePR67f801bc4.

## Intégration minimale

1. Combiner les erreurs HTTP et conserver tous les endpoints/contrats de l'inbox et de l'import. Adapter la correction au circuit confirmActivity existant, pas à saveActivity direct. Garder la précondition expectedWorkspaceId dans l'intention canonique/hash, et la vérifier contre l'autorité native avant lecture du reçu ou nettoyage SQL. La garder aussi dans saveActivityInLease avant toute lecture de configuration.
2. Conserver le RequestPanel inbox (publication, jeton, classement/révocation, actualisation). Insérer la correction et partager le verrou existant ; invalider la correction quand le contexte chargé change. Le candidat comparé doit être exactement confirmé ; après ambiguïté, retrouver la même draftId/version puis relire le courant. Pas d'héritage après changement de champ/base.
3. Conserver0027 inbox et produire0028 knowledge avec horodatage strictement croissant et snapshot cumulatif correct. Aucun ancien SQL déployé modifié. Le migrateur applique le suffixe manquant atomiquement ; préflight de journal complet obligatoire.
4. Unir les styles et les tests, sans supprimer les cas adverses. Mettre à jour seulement les cardinalités réellement changées (Calendar98/19 Business au lieu de96/17), et faire relire les callbacks/canaries dont le contexte change.

## Qualification et publication

Tests ciblés des chemins combinés, typecheck/lint/build, revue indépendante et Oracle ciblé d'intégration. CI GitHub complète sur commits exacts puis Main ; release immuable des images/services nécessaires via workflows existants. Pas de framework, broker, CI nouvelle ou dépendance supplémentaire à celles du lot import.

Les migrations précèdent le nouveau Voice ; elles acceptent l'ancien producteur sans attestation. Inbox révoque le grant UPDATE(treated_at) utilisé par l'ancien Web : prévoir une fenêtre de bascule qui retire les anciennes mutations avant migration et le nouveau Web avant réouverture. Root seul opérateur ; lectures fraîches de manager/queue/services/journal, binding et observation après toute issue ambiguë. Préserver appels, agenda, quotas, autres services et configuration non nécessaire. Aucun appel réel ni réanalyse fournisseur.

## Responsabilités

Root : Git, erreurs serveur, préconditions, journal/snapshots, tests natifs et canaries, CI/release/mutations de production. Implémenteur UI : fichiers correction et leur intégration RequestPanel/route/fixture uniquement, sans index Git. Experts : audit lecture seule des contrats, DDL et protocole de livraison. Toute divergence substantielle revient à la source réellement consommée, sans accepter un vert documentaire comme qualification.

### Complément nécessaire pour la release Voice

La CLI constatée sur f801 ne propose pas de succession15→15; `enable-budgeted-calls` est exclusivement14/N7→15/null. Ajouter une seule action explicite de remplacement release dans le writer natif, avec CAS du hash et validation native des deux profils. Seuls image_digest et qualified_profile_sha256 peuvent changer dans la politique canonique; conserver schéma15, total_calls=null, compteurs, floors, historique, identité, plafonds et échéance. Aucun nouvel appel ni financement. Après l'opération, l'admission reste fermée sans nouvelle observation. Cette source, sa revue et sa qualification sont des gates avant tout arrêt du propriétaire réel.

Au dernier gelUI, les sept scénarios adverses ajoutés portent Business à26 et Calendar à105; les noms sont collectés de Vitest et les deux listes canoniques/gardes comparées. Les préfixes96 et98 sont explicitement refusés, sans ajuster les délais ni supprimer de cas.

### Amendement de l'intégration relevé par Oracle

Le détail de demande porte désormais `workspaceId` issu du même lease natif que la lecture, indépendamment du snapshot de configuration. Le correcteur garde ce pin pour les lectures, l'intention et le reçu ; il ne choisit pas son espace depuis la première lecture d'activité. Le cas sans snapshot A→sessionB est refusé, tandis que le même cas sous A fonctionne. Les quatre fixtures SSR enrichies ont été relues intégralement avant le réancrage borné de A et du contexte global. Les plans du26octobre restent les documents du lot isolé ; ce plan du27fait autorité pour la livraison regroupée.
