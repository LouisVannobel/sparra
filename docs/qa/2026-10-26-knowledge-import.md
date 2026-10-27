# Connaissances confirmées et copie d’une page — 26 octobre 2026

Implémentation locale sur `z/sparra-knowledge-import-oct26`, depuis `origin/main` 45a5061. Le lot réutilise l’écran Entreprise, ses quatre étapes, les révisions de configuration et les transactions Workspace. Aucune mise en production, migration d’un service existant, modification de fournisseur ou appel téléphonique effectué.

## Utilisation

1. Dans **Entreprise → Connaissances**, saisir les informations manuellement ou lire l’adresse d’une page publique HTTPS. L’import est une copie ponctuelle, sans connexion, navigation de liens ni modèle IA.
2. Choisir les passages utiles pour horaires, prestations, tarifs ou FAQ, puis corriger leur texte. L’original, sa source et sa date restent distincts de l’adaptation du gérant. Les consignes et destinations restent manuelles. Un tarif vide reste inconnu ; aucune estimation ou gratuité n’est ajoutée.
3. **Vérifier avant d’enregistrer** présente les cinq textes complets déjà normalisés et bornés. Les informations doivent être applicables dès maintenant : retirer prise d’effet future, expiration et exception datée. La confirmation est humaine, sans détecteur automatique de vérité, de date ou de contradiction.
4. Après relecture et attestation, **Confirmer pour les prochains appels** enregistre une révision et son justificatif atomiquement. Une édition invalide la revue. Les appels déjà admis gardent leur ancienne version ; cette sauvegarde n’active ni une ligne ni un agenda.

Le brouillon d’édition reste en mémoire de la page. La navigation normale est protégée ; une fermeture forcée ne garantit pas sa récupération. Une capture serveur est valable une heure. Les justificatifs et leur provenance sont consultables sept jours fixes, y compris après rechargement ; ensuite l’origine est signalée indisponible, jamais reconstruite depuis une page actuelle.

En cas de résultat incertain, l’interface vérifie l’identité exacte de la soumission puis lit séparément l’état courant. Une confirmation historique peut concerner K8 alors que K9 est courante. Une preuve absente/expirée ne prouve pas l’absence d’enregistrement ; aucun retry ne rafraîchit silencieusement la base. Le gérant doit revoir la version actuelle avant une nouvelle confirmation.

## Composition et limites

- HTML UTF-8 public, HTTPS/443, sans paramètres de query ni credentials ; fragment retiré. Au plus trois redirections de même origine, quinze secondes d’acquisition dans trente secondes totales, deux Mio et 50 000 unités UTF-16. Au plus 200 passages, sans troncature ; formats/compressions non pris en charge renvoient à la saisie manuelle.
- DNS validé, connexion épinglée avec certificat/SNI natifs, aucune requête de média ou exécution HTML. Le modèle ne reçoit aucun droit supplémentaire depuis ces textes. Les erreurs n’exposent pas le corps capturé ou des secrets.
- Deux tables seulement : une capture courte par Workspace et des justificatifs immuables. Révision et reçu partagent le verrou/commit natif ; le reçu est recherché avant les préconditions périssables. Aucune FK du reçu vers capture/révision, car elles peuvent être purgées indépendamment.
- Le cleanup borné réutilise les capacités et la maintenance existantes, avec FORCE RLS et droits minimaux. Aucun nouveau pool, tenant, worker, gestionnaire documentaire, LLM, RAG ou moteur temporel.
- Les réglages audio/transfert compatibles restent explicites. Le mode audio hérité exige toujours sa correction manuelle préexistante ; il n’est jamais désactivé silencieusement par l’import.
- Les cellules et passages voisins doivent être reliés par le gérant : aucune association sémantique automatique de service/prix/conditions n’est promise. Avant confirmation l’ancien prix reste utilisable, et il peut encore être cité par les appels déjà admis après un retrait.

## Vérifications

Code métier figé à `d8ab075`, puis ancrage du contexte SSR relu à `0a19acc`. Aucun changement métier après les revues. Typecheck normatif, lint normatif et build : **codes 0** sur `0a19acc`.

| Contrôle | Résultat et portée |
|---|---|
| Acquisition et extraction | **39/39** variantes utiles, dont espaces inline, limites 200/201 passages, IP/DNS, redirections, abandon et flux bornés. Un smoke HTTPS natif sur example.com a aussi passé ; il confirme TLS/SNI, sans mesurer indépendamment peer=IP choisie. |
| Confirmation native PostgreSQL | **4/4** nouveaux contrats regroupés et **12/12** tests activité existants : isolation, concurrence, atomicité, reprise après K9 et purge K8, expiration, privilèges et conservation des réglages. |
| UI et navigation | **74/74** tests UI et **19/19** navigation, dont les deux nouveaux parcours. Ces suites passent également dans le passage ordinaire final. |
| Parcours compilé réel | Dernière exécution sur `0a19acc` : **1/1**, code 0, import public HTTPS, édition, aperçu des cinq textes, attestation clavier, RPC réelle, reçu SQL, rechargement/provenance et expiration. Auth protocolaire locale de fixture ; aucun OAuth fournisseur réel. Garde de nettoyage conservée et passée. Captures FR 320 px relues, sans débordement horizontal observé. |
| Suite ordinaire unique | **2 555 réussites, 7 échecs, 5 skips**, 167 fichiers, 741,66 s. Ce résultat n’est pas réécrit en succès global. |
| Reprise des seuls échecs pertinents | **3/3**, code 0 : empreinte SSR renouvelée après revue indépendante, puis react-doctor et observateur mail passés sans changement de code ni de timeout. Les quatre autres contrôles Voice restent non qualifiés ci-dessous. |

Les quatre contrôles Voice échouent avant leur qualification native : cette invocation directe n’a pas préparé `SPARRA_VOICE_TEST_ROOT` et l’interpréteur de fixture attendu. Les deux environnements existants constatés sont en **Python 3.13.15**, alors que le contrat exige **3.13.17**. Aucun environnement d’un autre propriétaire n’a été modifié pour ce lot. Leur code et leurs fixtures sont inchangés par le lot. `pnpm test`, qui orchestre aussi Voice, mail, billing, Calendar et publication de couverture, n’a pas été exécuté ; aucune couverture globale ni acceptation de ces consommateurs n’est revendiquée.

Une exécution compilée antérieure avait réussi fonctionnellement mais échoué au nettoyage parce qu’un conteneur étranger était apparu pendant la fixture. Le retrait des consommateurs possédés était confirmé ; le témoin d’échec reste conservé. Le dernier passage borné décrit ci-dessus réussit aussi sa clôture, sans affaiblir la garde ni toucher une ressource étrangère.

Oracle a challengé la conception puis huit fichiers du code réellement livré. Son verdict de code reste **NEEDS_AMENDMENT** : le cas 201 passages pour 200 décisions a été corrigé par refus intégral. La revue de branche a aussi fait corriger les espaces inventés dans les mots/nombres inline et une annotation de type redondante signalée par le lint. Une seule vague corrective, trois tests comportementaux supplémentaires, puis re-review indépendante : **trois constats traités, aucun nouveau constat dans ce delta**. Aucun second verdict Oracle favorable n’est inventé.

Les rapports, sorties et captures sont conservés dans [le dossier de preuves local](C:/Users/louis/.codex/artifacts/sparra/2026-10-26/knowledge-import/INDEX.md). La branche et le worktree restent disponibles localement, sans merge, push ou déploiement.

## Arbitrages de méthode et coût si erronés

| Décision prise | Motif | Coût si elle est erronée |
|---|---|---|
| Trois tâches séquentielles avec revue indépendante, sans refaire dix expertises | Recherche déjà adoptée ; garder un lot proportionné | Un angle hors des revues ciblées peut rester à découvrir. |
| Une seule suite ordinaire, tests ciblés pendant les corrections | Demande explicite de limiter les campagnes | Une interaction non couverte peut subsister ; les quatre contrôles Voice sont explicitement non qualifiés. |
| Node 24.22.1 et pnpm 10.32.1 exacts, runtime existant réutilisé | Respecter les pins sans installation globale | Un environnement différent nécessite sa propre vérification. |
| Worktree Git manuel isolé plutôt que l’API liée au dépôt infra | Éviter toute écriture dans le mauvais dépôt ; attachement natif refusé | Le checkout doit être géré manuellement ; il n’est pas attaché comme worktree Codex géré. |
| Reçu sans FK vers capture/révision, contrairement à la proposition initiale d’audit | Ces objets sont purgeables ; la maintenance ne tolère que sa FK appel native | L’intégrité historique dépend du commit atomique et de la copie de provenance, vérifiés par les contrats natifs. |

## Références appliquées

Interfaces contrôlées sur les pins locaux, sans migration de stack ni mise à jour générale. Références primaires consultées le 26 octobre : [fonctions serveur TanStack](https://tanstack.com/start/latest/docs/framework/react/guide/server-functions), [parse5](https://parse5.js.org/modules/parse5.html), [ipaddr.js](https://github.com/whitequark/ipaddr.js), [SSRF OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html), [verrouillage PostgreSQL](https://www.postgresql.org/docs/current/explicit-locking.html) et [instrumentation Node 24](https://nodejs.org/docs/latest-v24.x/api/diagnostics_channel.html).

Les deux nouvelles dépendances ont chacune un consommateur : HTML inerte et classification d’adresses IP. Les dates sont affichées comme provenance et ne constituent pas une actualisation automatique des connaissances.
