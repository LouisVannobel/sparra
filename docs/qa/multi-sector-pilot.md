# Qualification locale multi-secteur — lot 1

Le troisième secteur est `diagnostic-immobilier`. Les snapshots conservent leur version et leur forme : aucune identité de Workspace, de routage, de client ou de budget n'est dérivée du secteur. Une extension de valeur exige des lecteurs compatibles ; les anciens lecteurs Voice qui n'acceptent que deux valeurs ne sont pas compatibles avec les nouvelles lignes.

## Sources et preuves

- App candidat : branche locale `z/sparra-diagnostic-lot1-app`, base `ec40471e33095e30eae216e3353f8eaafc89b29b`. Commit source `b2b21451fe86f14b6491fdbf69486687b67e8d76` ; les résultats natifs sont consignés dans le rapport de tâche et la recette du contrôleur.
- Voice candidat : branche locale `z/sparra-diagnostic-lot1-voice`, base `88dc1db2a4f2a447b98f2abec56abb5800e1e05e`, commit `3453abb460a5d70dfc6027ba47146460c9ecda5f`, source explicite `C:/Users/louis/Documents/ChatGPT/.worktrees/sparra-diagnostic-lot1-voice/src`, Python figé `3.13.15` dans son `.venv`.
- `resolveVoiceProducer(SPARRA_VOICE_TEST_ROOT)` fournit le descripteur local. La nouvelle preuve bridge exige cette variable explicite ; le driver vérifie l'import des vrais `models.py` et `pipeline.py` de cette source. Les anciennes recettes gardent leur provenance propre.
- Fixture officielle conservée sans modification : Voice `990c2ad7b83da72b535772991b23602afc6a7567`, tree `54ada63dee46192371f76a1b1567e30c69908ad5`, archive SHA-256 `2f5ca2c313584d290512f36881cf1373c845af189a12fb0494ec03adf5736813`, `refs/heads/main`. Elle n'est pas une preuve de compatibilité diagnostic.
- Migration additive : `0026_sparra_diagnostic_sector.sql`, générée par Drizzle à partir de la contrainte déclarative. SHA-256 `865b867a173aa0c98dbce132c1c1f841c5b7b922ce80e815a506efbf62e23280`. Seul le CHECK `sparra_revision_sector` est remplacé. Les anciennes migrations restent inchangées.

L'exporteur existant `scripts/export_runtime_contract.py` produit les six pré-images dans `dist/lot1-candidate` (ignoré). Le modèle métier voyage dans le code de l'image, pas dans un nouveau format de schéma exporté. L'exporteur, les sources agent-a et les autorités de profils sont inchangés par rapport à la base ; ces six fichiers restent byte-identiques. SHA-256 :

| Fichier | SHA-256 |
| --- | --- |
| runtime-contract.json | `549f8b79f50c7e501d3df4655c40ea593f4973da8e88fd86a97c938caae1db9f` |
| agent-a-bundle.tar.gz | `66ea0ea8016812d92d410e4a0cbce892aeb12235b3a53570254ccbb990fd3537` |
| agent-a-bundle-v1.manifest.json | `751e9327bceb7a739e4dd04aea705c24048160e8793a47dd7a353c4a163f693a` |
| qualification-candidate-profile-v1.schema.json | `1aafd2a47591405c0b13fe5900efc12a0c0918e756ffff4565de960ecc48bfce` |
| qualification-override-v1.schema.json | `5ca4ced638abc489319105c4e3e7421412f89b6359fdc74941901af85ff89030` |
| qualified-deployment-profile-v1.schema.json | `97e33500bd026042dedf0f6e52418ac85e40001568333fd24ab29c7f07a6e47a` |

## Ce que vérifient les scénarios

- Catalogue FR/EN : libellés des trois secteurs, questions pour les réponses du propriétaire et questions possibles pour l'appelant. Aucun prix, horaire, certification ou disponibilité présenté comme fait.
- Formulaire existant : vrai choix du secteur, aides passives, aucune insertion automatique dans les connaissances. Une question retenue est copiée explicitement dans `knowledge.instructions` avant sauvegarde ; les autres suggestions ne rejoignent pas le contexte.
- Migration sur schéma peuplé jusqu'à 0025 : lignes garage/contrôle identiques ; échec injecté après ajout du CHECK annulant DDL et journal ; après succès, diagnostic lisible, secteur inconnu refusé, propriétaire/RLS/grants/politiques identiques.
- Bridge natif : snapshot décodé par les modèles candidat, contexte natif contenant la question retenue, prompt sans métier automobile imposé, consignes non fiables incapables de créer un outil ou sa destination. Un ancien appel conserve sa configuration ; le nouvel appel conserve sa révision pendant une sauvegarde concurrente. Sa transcription reste dans l'Inbox de son propriétaire ; un autre principal ne peut ni lire ni traiter l'appel.
- Les captures UI utilisent l'infrastructure existante : `.output/test-evidence/sparra/diagnostic-business-en-320.png`. Leur présence dépend de l'exécution réussie du scénario navigateur.

Les tests source, les assertions PostgreSQL natives, le nettoyage des ressources et les essais fournisseurs sont des résultats séparés. Aucun test offline ne garantit qu'un fournisseur réel posera une question suggérée. La publication d'un nouvel export/image et les essais réels restent des opérations distinctes.

## Ordre d'une future livraison

1. Livrer et vérifier un lecteur Voice compatible avec les trois valeurs, ainsi que tous les lecteurs App consommant ces lignes.
2. Appliquer la migration additive dans une opération de livraison autorisée et vérifier les contraintes/politiques conservées.
3. Ouvrir seulement ensuite l'écriture des configurations du nouveau secteur et les admissions opérateur correspondantes, après vérification de tous les lecteurs concernés.

## Repli

Refermer les nouvelles admissions des établissements diagnostic par le mécanisme opérateur existant : `voice_private.deployment_binding.admission_enabled=false` sur leurs seuls bindings. Cette procédure décrit une future opération autorisée ; cette qualification locale ne modifie aucun binding réel. Les identités et les autres paramètres du binding restent inchangés.

Garder les lecteurs compatibles et les traitements des appels déjà admis : ingestion, Inbox, révisions figées, conservation et effacement conservent leurs règles. Ne pas remettre un ancien binaire incapable de décoder les lignes diagnostic. Ne supprimer aucune configuration diagnostic et n'appliquer aucune migration inverse destructive. Fermer les nouvelles admissions ne doit pas devenir un arrêt des obligations de traitement et de nettoyage des appels existants.
