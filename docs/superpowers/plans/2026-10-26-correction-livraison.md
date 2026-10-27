# Correction accompagnée — livraison locale du 26 octobre

Worktree : C:/Users/louis/Documents/ChatGPT/.worktrees/sparra-correction-oct26 ; branche z/sparra-correction-oct26, base45a5061. Livraison conservée sur la branche locale dédiée. Aucune publication, migration, connexion fournisseur ou modification des autres checkouts.

## Parcours disponible

La fiche d'appel contient « Examiner un problème ». Le choix information/consigne lit la configuration courante, permet d'éditer un seul des cinq champs natifs, affiche la valeur historique et le comparatif actuel/proposé, puis exige une confirmation d'enregistrement pour les prochains appels. Reprendre la valeur historique ne remplace que ce champ ; les autres réglages viennent de la base courante.

Le candidat reste dans le composant jusqu'à confirmation. Il n'est pas conservé après départ de la page. Les autres symptômes (transcription, prononciation, résumé, action, cause inconnue) donnent une orientation sans promettre une réparation du moteur vocal, une annotation persistante ou un retest exécuté. Aucun nouvel espace autonome de correction n'est ajouté.

## Garanties et limites

- Réutilisation de getActivity/saveActivity et de l'autorité native ; nouvelle précondition expectedWorkspaceId toujours fournie par ce parcours. Elle est validée puis comparée au lease autorisé avant toute lecture/écriture de configuration. Le serveur ne choisit jamais le Workspace à partir de cette donnée.
- Révision courante, préservation des autres champs et confirmation explicite ; un conflit impose relecture et nouvelle comparaison. Aucune sauvegarde automatique.
- Résultat de sauvegarde ambigu : relecture obligatoire. Une correspondance exacte à la révision suivante permet de constater que le contenu courant contient la proposition ; pas d'attribution certaine à la requête interrompue.
- Refus d'identité ou de session : contexte privé masqué. Doubles clics, réponses remplacées et démontage protégés ; traitement/effacement de fiche verrouillés pendant l'opération.
- Aucun effet sur l'appel passé, son résumé, son état traité ou l'agenda. La sauvegarde native crée une révision sélectionnable, pas un brouillon inactif. Aucune réussite audio, rendez-vous ou activation globale déduite.

## Vérifications effectuées

74 tests ciblés sur3 fichiers passent après l'amendement : UI réelle dans Chromium avec RPC contrôlés, validation/save avec lease contrôlé, middleware Start enregistré et validation historique. Le test RPC natif unique, sur PostgreSQL jetable et vrai chemin d'authentification/CSRF/R1, passe également (1 sélectionné,11 ignorés). Il vérifie le refus A→B à révision égale et l'absence de version supplémentaire dans les deux espaces.

Typecheck normatif, lint ciblé, build web/SSR/worker et git diff --check passent. Contrôle mobile en français390px : pas de débordement et aucune violation axe détectée dans le panneau. Ce contrôle local n'est pas une qualification complète lecteur d'écran, fournisseur ou production. Dépendances, lockfile et schéma SQL inchangés.

Revue indépendante finale : aucun autre P1/P2 établi. Oracle a trouvé le P2 de changement de session ; il a été corrigé et vérifié. La revue Oracle ciblée a rendu APPROVE_SCOPED sur l'amendement. Ce verdict ne vaut pas approbation de production ; les deux avis et leurs limites sont conservés dans les preuves de livraison.

Preuves : C:/Users/louis/.codex/artifacts/sparra/2026-10-22/recherches-thematiques/03-correction-retest/IMPLEMENTATION_2026-10-26 (logs, manifeste, rapports et capture synthétique). Aucune campagne documentaire des35 cas n'a été exécutée.
