# Parcours guidé — qualification du candidat regroupé

## Périmètre et identité

Payload de code et tests `0b476721e6727faee517a3172cab55c0c6b287d6`, branche `z/sparra-guided-integration`, base déployée `30f12f02008464bd931c03910e00f45199ef0370`. Le choix humain du22octobre livre le parcours guidé et les correctifs sur Garage/Contrôle technique. Les diagnostiqueurs restent sur leurs branches dédiées. Catalogue et validation serveur refusent cette troisième valeur. Le dossier `drizzle` reste exactement celui de main0025, arbre `289ebf97cac854cd5bc19316223e725b9ca456b2` ; les quatre fichiers marketing déployés sont conservés.

Dernier changement runtime : `32c7f8897123fe5d204473622cf391efbae2179e`. Build web/worker frais à ce commit, entrée serveur SHA256 `84b5dbc0fbb14efeab36c05b5b7da4b35ed8d6099ad38a187f9e157f024c18ec`, worker `3643f7c97a65442c6a3c2c8773919583ac2ae0812786cd9fe2961f045b4a11b2`. La mise à jour ultérieure des fixtures et de ce reçu ne modifie pas le runtime. Le SHA final de publication et les preuves postérieures au gel seront enregistrés dans les artefacts de livraison pour conserver le candidat pendant sa CI.

La livraison remplace seulement l'image web qualifiée. Aucun changement live de schéma, Voice, worker, fournisseur, configuration ou plafond ; aucun appel réel, migration ou remise à zéro des admissions. Le chat `01a16023-c6bd-7901-ba1d-e128ae1c0bae` reste le seul opérateur App de publication/Dokploy.

## Deux producteurs de tests explicitement identifiés

Les scénarios historiques locaux utilisent Voice `81a86a0c4b0a306874094085d01df290af40c9c9` : runtime effectivement déployé `3dafb2877011aef6db20ee24b7dbffe8c3730d6c`, helpers qualifiés89b, puis correctif de fixture NoACK9f. Runtime, pins, profils et workflow identiques à3daf. Ce checkout n'est pas publié ni exporté comme source officielle.

La fixture officielle App provient du main Voice authentique `31acb9d2de220765e6cbf3833fd50c474f0bc2db`, arbre `0b61b47a6503fcaabbb7db2dacc7bcf35974b860`, identique au head entièrement qualifié de la [PR source Voice57](https://github.com/LouisVannobel/projetV0-voice/pull/57). Son delta depuis3daf comporte exactement deux fichiers de tests. L'arbre `src`, `13cabb16c50149426680659bfc2b73557cd46cd9`, est inchangé. Aucun helper historique local n'est injecté dans l'archive officielle ; aucune image Voice n'est publiée.

Les neuf racines exportées restent identiques. Les59 fichiers proviennent exclusivement des octets Git immuables31ac ; chaque chemin, contenu, taille et blob est vérifié contre Git. Seuls les en-têtes de conteneur sont sérialisés dans l'ancien format déterministe regular-file-only USTAR/gzip. Archive SHA256 `f8d745818fb231bcb072edde1a8e4d36384cccba7e65d6c9607c37bb4ba83981`,405751octets compressés,1943556octets de source. Refus PAX/répertoires, liens, chemins adverses, membres supplémentaires, mauvais contenu et interprète non admis conservés. Les vérificateurs changent uniquement leurs identités et cardinalités exactes.

## Vérifications et limites

| Contrôle | Résultat réel |
| --- | --- |
| Typecheck, lint configuré, build web/worker | PASS32c ; typecheck/lint explicite repassés pour la fixture |
| Première suite ordinaire locale | FAIL :2360pass,5skip,3fail,726,56s : ancre SSR périmée, Doctor30s et observer mail5s |
| Ancre SSR34c revue ; Doctor/mail isolés | PASS1/1 ; PASS1/1 et7/7, délais conservés. Aucun PASS global déduit |
| Deuxième suite ordinaire locale1ac | FAIL :2357pass,6skip,5fail,966,98s. Canaries/SSR/hook auth expirés ; mémoire observée sous1GiB pendant le run sans preuve de causalité pour chaque erreur. Aucun délai relevé |
| Activity native / bridge Voice |12/12 et14/14PASS, retrait et inventaire conformes |
| UI Calendar après extraction32c |171/171 dans11fichiers ;31/31 composants navigateur ; typecheck/lint/build PASS |
| Calendar complet actuel |96/96PASS,5fichiers,522,25s, admission exacte du rapport ; neuf reçus retirement=true, unrelatedUnchanged=true, delta=[], entrée84b5 |
| Navigateur Sparra compilé |23/23PASS avec nettoyage et inventaire conformes, même build |
| Connected/retention actuels | Trois corps PASS dans le run26/26 ; backlog nettoyé sans delta. Owner-recovery et retention globalement FAIL pour inventaire Docker tiers modifié, malgré leur propre retrait. Replay propre ciblé encore requis |
| Budget/helper Voice89b, runtime3daf |99PASS et2sous-tests,28,11s ; cinq admissions et plafondsUSD5 indépendants conservés |
| Régression upstream NoACK | Ancienne observation RED, nouvelle fixture GREEN ;110tests Calendar PASS, Ruff/mypy47/lockfile PASS. Pipeline natif contrôlé, distinct de PostgreSQL/fournisseur réel |
| CI source Voice57 | Push et PR entièrement SUCCESS9f :3421pass,100skip,10sous-tests,930,82s. Arbre fusionné31ac identique ; [CI main39754453623](https://github.com/LouisVannobel/projetV0-voice/actions/runs/39754453623) également SUCCESS (Python, packaging, sécurité ; validation infra non applicable selon le filtre inchangé) |
| Fixture App / synchronisation Business |69PASS et1skip Linux préexistant sur Windows ; Business17/17 avant/après, sans délai arbitraire. Aucune acceptation globale déduite |
| Première CI Appd3c | Native-image, scans, WCAG et image PASS ; quality FAIL Calendar95/96, retry-after-no-ACK. Run échoué conservé |
| Nouveau candidat App : CI PR / release / image / livraison | Encore requis avant fusion et déploiement ; aucun PASS global ou live revendiqué ici |

Logs, JSON et revues sont conservés dans le workspace SDD de ce plan et les artefacts de livraison. Les échecs restent séparés des replays. Un essai a été refusé avant exécution par la garde mémoire. La cohorte pendant la panne Docker avait32pass/7fail/57nonexécutés, sans ressource créée ; elle ne compte pas comme acceptée. L'ancien reçu Voice3346PASS appartient à une autre branche.

## Corrections et revues

L'ancre SSR complète a été revue après le comptage des contrôles guidés hors des quatre callbacks approuvés. Hashes des callbacks et cas adverses d'expiration conservés. La fixture SQL prefix matérialise une seule horloge pour respecter la vraie égalité de rétention. Le bridge vérifie le prompt Garage/Contrôle réel, son immutabilité face aux données adverses et leur séparation dans le document non fiable.

Les observations Calendar attendent le snapshot parent publié par effet. Les actions réelles de départ restent immédiates ; les cas Calendar seuls vérifient dialogues document/OAuth refusés, brouillon conservé et zéro effet. Le helper Business attend le dialogue réel et la fin de son rejet avec le clic au lieu de dormir100ms, en conservant les17noms de cas, routes, valeurs et compte/type des dialogues.

Le seul changement runtime aprèsd3c est l'extraction privée synchrone des erreurs Calendar32c. Garde live, identité du contrôleur, signaux, ordre et finally conservés. Sept cas de caractérisation couvrent statuts400/409/503/erreur, annulation et remplacement du contrôleur. Revue indépendante SPEC/QUALITY PASS ; mesure Sonar du nouveau SHA à observer. Les deux hotspots TEMP/TMP ont été revus sûrs pour ce driver borné, sans suppression ni garantie contre un acteur local malveillant.

La dépendance990 obsolète traitait unknown comme terminal ;3daf déjà déployé attend le résultat canonique en lecture seule dans les12secondes existantes. Une régression indépendante le reproduit ; cela ne prouve pas l'état exact lu lors de l'unique échec CI. L'ancienne fixture attendait aussi une inférence et la suppression de tâche après un affirmatif sans ACK, hypothèses dépassées. Voice57 vérifie répétition native, marque, recorder/TTS et absence de réservation/inférence ; sa régression exige une nouvelle sélection, son ACK réellement reçu par le sérialiseur et un nouvel affirmatif avant l'unique réservation. Revue indépendante approuvée avant fusion source. Aucune nouvelle approbation Oracle de livraison revendiquée.

## Conditions restantes

Un seul runner lourd local, minimum2GiB physiques et virtuels libres à l'entrée. Cycles de vie des agents hors des cohortes Docker. Aucun tiers arrêté ou exempté du contrôle d'inventaire. Nettoyage et inventaire restent bloquants même quand les assertions métier passent.

La [PR App28](https://github.com/LouisVannobel/sparra/pull/28) qualifie d'abord le candidat regroupé sur le runner isolé existant. CI PR complète, notamment Fallow/Doctor sur le vrai diff, avant fusion ; puis SHA main et image immuable qualifiés par la release. Aucun workflow, seuil, skip, deadline, plafond ou interprète assoupli. L'I001 Ruff hérité du vérificateur Python reste un constat de formatage hors contrôle normatif configuré, sans changement de parsing.

Avant remplacement web : contrôler source, digest publié, préimages des services/configuration, journal0025, admissions et données. Après : comportements public/privé/guidé et conservation de Voice, worker, base et autres services. Une réponse de déploiement ambiguë impose observation plutôt qu'un second envoi. Ces fixtures ne prouvent ni fournisseur réel, ni aptitude aux clients payants, ni acceptation humaine.
