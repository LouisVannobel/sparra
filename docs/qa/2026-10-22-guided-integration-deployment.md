# Parcours guidé — intégration et qualification avant livraison

## Candidat et périmètre

Payload de code : `1ac656e29bb5a86621cc576887d23e533d01d56c`, branche `z/sparra-guided-integration`, base déployée `30f12f02008464bd931c03910e00f45199ef0370`. Ce reçu et le plan ajoutent uniquement de la documentation après ce payload. Le runtime a changé pour la dernière fois à `49d116a55fc5e4489e4d2dcac2dde8c18843cf9b` ; build frais à `b635d3872add60f73d138cdfe72ac13ecec5b56e`, entrée serveur SHA256 `bf6f0252b8dce939525a53f68395f38235286755bb935ff4d6d8dcd512fbbf5e`.

Le choix humain du22octobre livre le parcours guidé et les correctifs sur Garage/Contrôle technique. Les diagnostiqueurs restent sur leurs branches dédiées pour une livraison ultérieure. Catalogue et validation serveur refusent cette troisième valeur. Le dossier `drizzle` correspond exactement à main0025 ; les quatre fichiers marketing déployés sont conservés. Aucun changement live de schéma, Voice, worker, fournisseur, configuration ou plafond n'est prévu : seule l'image web qualifiée pourra être remplacée.

Producteur local des tests historiques : Voice `89b3c2e2f3fb0aa76a9aa31112a50c8860345440`, dérivé du code réellement actif `3dafb2877011aef6db20ee24b7dbffe8c3730d6c` avec quatre fichiers de tests uniquement. Runtime et pins identiques à cette production. La fixture officielle CI reste `990c2ad7b83da72b535772991b23602afc6a7567`, archive/manifeste/vérifieurs inchangés. Les consommateurs Calendar/audio normatifs utilisent `audio_candidate:true`, sans l'import du helper réservé aux scénarios historiques nonaudio. Aucun producteur Voice n'est publié par cette livraison. Le driver conserve sa vérification du producteur canonique explicite ; aucun résultat local n'est présenté comme une preuve d'exécution sur l'archive CI.

## Résultats locaux réellement obtenus

| Contrôle | Résultat et limite |
| --- | --- |
| Typecheck normatif, lint configuré, build web/worker frais | PASS ; typecheck et lint ciblé repassés après les corrections de tests |
| Première suite ordinaire | FAIL :2360pass,5skip,3fail,726,56s ; ancre SSR périmée, Doctor30s, observer mail5s |
| Ancre SSR revue `34c52ad` | PASS1/1 ; seul le hash du contexte complet et sa provenance changent, quatre callbacks et cas d'expiration conservés |
| Doctor/mail isolés, délais inchangés | PASS1/1 en8,85s et7/7 en1,19s ; ces replays ne transforment pas la suite complète en PASS |
| Deuxième suite ordinaire sur `1ac656e` | FAIL :2357pass,6skip,5fail,966,98s, trois fichiers en échec ; quatre canaries de qualification ETIMEDOUT, un SSR5s, un hook auth15s non terminé. Mémoire observée sous1GiB pendant le run. Aucun délai relevé ; la cause de chaque dépassement n'est pas établie par cette corrélation |
| Activity native |12/12PASS dans la première matrice, ressources retirées/inventaire inchangé |
| Navigateur compilé |23/23 corps PASS ; run global refusé car conteneur tiers supprimé pendant le run. Replay propre requis |
| Calendar composant et navigation Business |14/14+17/17PASS ; seuls ces fichiers sont verts dans le run mixte44/45FAIL, sans prétention de PASS global |
| Bridge Voice après correction |14/14PASS, retraite confirmée, inventaire inchangé, delta vide et fingerprints identiques,11volumes |
| Budget/identité/helper, Voice actuel `89b3c2e` |99PASS et2sous-tests PASS,28,11s, offline/frozen ; includes15régressions nouvelles et les tests budgétaires existants |
| Calendar complet96, replay navigateur et scénarios historiques | En attente de leur cohorte séquentielle complète ; ancien reçu Voice3346PASS concerne une autre branche et ne les remplace pas |
| CI PR entière, release et image immuable, déploiement | En attente ; aucun feu vert de production |

Les logs/JSON exacts sont dans le workspace SDD de ce plan. Les exécutions échouées sont conservées séparément des replays. La première matrice native était FAIL61pass/5fail/14nonexécutés ; les14cas bridge étaient bloqués par leur hook et ne sont pas comptés comme réussis.

## Causes corrigées sans changement runtime

L'empreinte SSR complète était périmée après l'adaptation du comptage des contrôles guidés, hors des quatre callbacks approuvés. L'ancre a été revue indépendamment ; toutes les vérifications adverses d'expiration restent présentes.

La fixture de migration prefix évaluait deux fois une horloge volatile, en contradiction avec l'égalité exacte de rétention. Un timestamp matérialisé unique fournit maintenant les deux colonnes. La vraie contrainte, le rollback de migration et les assertions d'immutabilité des lignes/journal sont conservés. Le dernier cas bridge conservait une hypothèse de prompt neutre propre aux diagnostiqueurs différés : il vérifie désormais l'ouverture réelle Garage/Contrôle et l'égalité exacte de l'autorité système avant/après des données métier adverses. Instruction injectée et destination restent dans le document non fiable, absentes du message système.

Les assertions Calendar lisaient trop tôt un snapshot parent publié par effet. Une sonde a observé24/24transitions converger après4–11ms. Les conditions attendent les mêmes états exacts ; les actions de départ réelles n'attendent pas ces snapshots. Des contextes Calendar seuls vérifient immédiatement départ document et OAuth : bon dialogue refusé, route/brouillon conservés, zéro effet. La revue indépendante ne constate pas de défaut runtime reproduit sur ces frontières testées.

## Gardes, revues et publication

Tests lourds séquentiels, minimum2GiB physiques et virtuels libres à l'entrée. Un essai d'entrée refusé après la deuxième suite n'a lancé aucun test ; le run budget suivant a démarré avec4,97GiB physiques/9,75GiB virtuels. Les initialisations/fins d'environnements de revue restent hors des cohortes Docker. Aucun tiers n'est arrêté ou exempté du contrôle d'inventaire.

Architecture/source PASS à `34c52ad`, puis SPEC/QUALITY PASS indépendant sur les trois fichiers de tests de `1ac656e`, avec inspection des JSON et reçus de nettoyage réels. L'ancienne approbation Oracle de la conception budgétaire est distincte ; aucune nouvelle approbation Oracle de livraison n'est revendiquée.

La PR brouillon sert uniquement à qualifier ce candidat sur le runner GitHub isolé existant. Le FAIL local reste explicite. La CI PR complète, notamment Fallow/Doctor sur le vrai diff, doit réussir avant toute fusion ; aucun changement de workflow, seuil, deadline, provenance ou plafond n'est permis pour obtenir le vert. La release qualifiera ensuite le SHA main et l'image immuable exacts. Les scénarios historiques hors de `scripts/test.mjs` restent liés à leur producteur explicite et à leurs reçus séparés.

Le chat `01a16023-c6bd-7901-ba1d-e128ae1c0bae` est le seul opérateur de publication/Dokploy. L'autorisation de qualification en PR n'autorise ni fusion anticipée ni déploiement. Avant tout changement live, vérifier les préimages, l'image publiée, les services et les données ; après remplacement web, confirmer la conservation de0025, Voice, worker et configuration. Aucun appel réel ni aptitude aux clients payants n'est prouvé par ces fixtures.
