# Correction accompagnée depuis une fiche d'appel

Autorisation : demande explicite du 26 octobre d'implémenter la recommandation, simplement, sans campagne de tests disproportionnée. Référence : synthèse du sujet 03 et amendements Oracle des 22–23 octobre. Pas de nouvelle validation de principe.

## Tranche utile

Dans la fiche existante, ouvrir « Examiner un problème », choisir le symptôme. Pour un fait ou une consigne, lire la configuration courante via getActivity, sélectionner un des cinq champs natifs, éditer un candidat local et comparer avant/après. Montrer séparément la version de l'appel et la base actuelle. Confirmation explicite « Enregistrer pour les prochains appels », via saveActivity existant et expectedRevision. Aucun effet pendant préparation/relecture.

Un retour ciblé peut reprendre la valeur de ce champ dans l'instantané d'appel sans rétablir les autres champs. Pas de restauration globale. Erreur de transcription/prononciation/résumé/action ou cause inconnue : aide courte qui distingue correction d'information et diagnostic technique ; aucune promesse de correction du moteur vocal. Le candidat est local, non persistant jusqu'à sauvegarde. Aucune annotation persistante, classification automatique, table, migration, lexique fournisseur ou moteur de retest ajouté. Aucun bouton de test fictif : afficher que la relecture n'est pas un test de conversation/audio.

## Contrats

Réutiliser auth/Workspace/transactions/validation de saveActivity. Conserver tous les autres champs à partir de la base courante lue. Pas de modification de l'appel, de traité ou de l'agenda. Conflit 409 : conserver la proposition sans réessayer automatiquement, relire puis comparer de nouveau. Retour réseau ambigu/abandon après écriture possible : résultat incertain, aucune nouvelle sauvegarde avant relecture ; ne confirmer que la correspondance exacte et révision appropriée. Invalidation de session : masquer les données privées et réutiliser le renvoi login existant. Hydratation, doubles clics, réponses tardives et démontage protégés avec le mécanisme d'essai existant. Coordonner les actions de fiche pendant sauvegarde.

## Tâche unique, implémenteur frais

- Ajouter un composant ciblé sous src/ui/sparra et ses textes FR/EN (pas de nouvelle dépendance).
- Si utile, extraire seulement les opérations pures réellement consommées pour construire/comparer le candidat ; pas de contrôleur générique.
- Intégrer dans request-panel.tsx et la route app.demandes.$requestId.tsx, avec getActivity/saveActivity existants.
- Tests comportementaux ciblés avant code : préservation des champs, préparation sans écriture, conflit/ambiguïté et récupération, absence de faux test ; réutiliser les fixtures existantes.
- Vérifier tests ciblés, un typecheck, lint sur fichiers touchés, build ; une vérification navigateur synthétique si le dispositif existant le permet sans modifier de service partagé. Aucun appel réel.
- Revue indépendante spec/qualité puis Oracle standard sur diff minimal ; corriger seulement les problèmes établis. Aucune répétition de la matrice documentaire de 35 cas.

## Isolation et actualité

Base origin/main 45a5061, worktree z/sparra-correction-oct26. Les autres branches import/inbox restent intactes. L'outil natif de création vise le dépôt infra de cette conversation et ne sait pas cibler Sparra : worktree Git créé explicitement dans le dépôt produit. Les décisions d'API suivent les sources installées ; documentation TanStack officielle revalidée via Context7 le 26 octobre. Pas de mise à niveau de dépendances, push ou déploiement implicite.

## Revue focalisée

Vérifier que l'édition d'un champ préserve les autres ; qu'une révision recomposée ne reprend aucune ancienne validation ; qu'un échec réseau ne permet pas une double écriture ; qu'un retour ciblé ne rétablit pas une ancienne configuration globale ; qu'aucun état ne laisse croire à un test audio ou à un rendez-vous réel.

## Amendement Oracle du 26 octobre

Le premier avis de code établit un P2 : après changement de session, une révision identique dans un autre Workspace pouvait satisfaire expectedRevision. Étendre la commande existante avec expectedWorkspaceId (précondition optionnelle pour les clients historiques, toujours transmise par la correction). Le serveur conserve l'autorité native, compare cet ID au lease autorisé avant tout accès de configuration et refuse sans écriture si différent. Mapper ce refus avec un marqueur spécifique ; le panneau masque alors le contexte périmé au lieu de proposer un rebase sur le nouvel espace. Aucun endpoint, table ou migration ajouté. Tester le refus natif avant accès DB, le mapping et le consommateur ; une relecture cliente seule ne fermerait pas la course.

## Finalisation locale

Après la demande de continuation, conserver le diff qualifié dans un commit local de la branche dédiée. Vérifier l'identité des sources avec le manifeste et les preuves avant commit. Aucun changement de code ne justifie de rejouer la campagne déjà passée. L'intégration à une autre branche, le push et le déploiement restent distincts.
