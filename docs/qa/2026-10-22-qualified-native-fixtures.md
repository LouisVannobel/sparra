# Sparra — portage des deux consommateurs natifs historiques

## Sources et portée

App `697f5bc12f154b6617365ff058a05c696ac2345f`, branche `z/sparra-qualified-fixtures-app`. Voice final `7c5f298dc6de96f852fa37a56d466b927a51337e`, branche `z/sparra-qualified-fixtures-voice`. Les changements portent uniquement sur les fixtures, tests et leur documentation. Les sources de production, versions, politiques budgétaires et délais natifs sont inchangés.

Le runtime App compilé à `fc46f712ccbc70ceb6d410582d641ed84d7719f4` est réutilisé : comparaison des sources/configurations/pins sans différence sur ce couple. Le producteur Voice est sélectionné par son descripteur canonique explicite et sa venv figée ; la provenance de la fixture publiée n'est pas modifiée.

## Comportements conservés et renforcés

Le fichier connected comporte deux pilotes jetables indépendants, chacun avec PostgreSQL, SQLite, état de reprise, crypto et identité propres. Le premier consomme cinq admissions : appel initial, effacement, appel suivant indépendant, begin en vol et bail bloqué. Le second consomme cinq admissions : backlog, remplacement de claim, transfert humain, course de révision et expiration. Le fichier retention conserve son pilote indépendant de cinq admissions. Les 100 lignes synthétiques du backlog servent aux assertions d'effacement ; elles ne remplacent aucune admission native.

Chaque pilote utilise le véritable `OwnedPilotBudgetGate` et le writer natif, avec la limite existante de **cinq admissions** et les contrôles **USD5 indépendants pour OpenRouter et Telnyx**. Les réserves, prévisions et conditions de financement restent celles du code de production. Une petite identité de fixture non secrète reconstruit le même profil, les mêmes empreintes de credentials synthétiques et la même politique après crash. Seule la collecte d'observations est rafraîchie. L'enrôlement est réservé à la création effective du pilote ; un historique absent, modifié ou ambigu ferme l'admission. Aucun compteur n'est remis à zéro et aucune politique enrôlée n'est remplacée.

Les assertions initiales d'isolation propriétaire, snapshot figé, transcript chiffré, débordement, reprise, effacement et ACK, bail bloqué, claim remplacé, transfert sans nouvelle IA, course de révision et expiration sont conservées. Des lectures du compteur et du hash de politique entourent chaque crash. Les tests ciblés vérifient le refus d'une sixième admission avec observations valides et capacité libre, avant et après reprise ; une fin tardive d'un ancien appel ne libère pas l'appel suivant.

## Deux défauts de fixture révélés après le portage

Le démarrage du backlog ajoutait une connexion SQL et une vérification de doublon à chaque ACK. La mesure a observé 79 ACK en 5002 ms, dont 2488 ms de connexion/vérification supplémentaires. Les contrôles de confidentialité avant ACK et le véritable ACK restent exécutés dans la phase native. Les 100 vérifications SQL supplémentaires sont rejouées avec leurs tuples exacts après démarrage, sur une connexion possédée, et doivent toutes retourner NULL. Le scénario attend désormais explicitement **101 ACK natifs distincts** avant de produire sa preuve. La borne native de cinq secondes est conservée.

Le premier STT natif chargeait les ressources du SDK OpenAI sur la boucle d'événements : import mesuré à 2176 ms, contre 1500 ms pour la garde writer ; STT à 2282 ms à froid et 2 ms ensuite, avec exactement deux requêtes MockTransport et aucun socket fournisseur. La fixture qualifiée importe ce même module installé avant de construire le graphe. Elle ne change ni adaptateur, ni résultat, ni délai, ni autorité d'appel. Les sondes temporaires ont été retirées.

La dernière revue a resserré le report des vérifications SQL à la première préparation native du relais. Le flag et le callback d'origine sont restaurés avant toute reprise, publication ou tâche suivante, y compris en cas d'erreur ou d'annulation. Deux régressions persistantes vérifient cette frontière ; elles ont échoué avant la correction puis réussi après.

## Vérifications et versions exactes

| Contrôle | Résultat |
| --- | --- |
| Deux fichiers natifs historiques, trois scénarios en une exécution sur Voice `f61b9a6` | PASS 3/3, 330,75 s ; deux fichiers réussis |
| Replay du seul backlog affecté par le resserrage final, Voice `7c5f298` | PASS 1/1, 98,78 s au total ; autre groupe volontairement non sélectionné |
| 13 régressions budget/identité, deux régressions de portée et tests budgétaires existants | PASS, inclus dans la suite complète finale |
| Consommateur Calendar confirmé App/Voice/Inbox, Voice `7c5f298` | PASS 1/1, 84,18 s ; sept autres modes non sélectionnés |
| Suite Voice offline complète sur `7c5f298` | PASS : 3346 réussis, 118 ignorés, 12 sous-tests réussis, 204 avertissements existants ; exit 0, 873,34 s |
| Typecheck normatif et lint configuré App, lint des trois fichiers TS modifiés | PASS |
| Ruff complet, Mypy et lock Voice | PASS ; 46 fichiers source, 159 packages figés |
| Nettoyage des trois pilotes, du replay final et de Calendar | PASS : retraite des consommateurs confirmée, inventaire tiers inchangé, delta vide |

Les runs intermédiaires et leurs échecs restent archivés séparément. Le résultat 3/3 appartient au commit `f61b9a6` ; le changement suivant ne touche que la frontière du backlog et ses nouveaux tests, puis ce consommateur est rejoué sur `7c5f298`. Les chemins des deux autres groupes sont inchangés. Aucun run unique 3/3 n'est inventé sur le dernier commit. La suite complète finale couvre également les cinq fichiers consommateurs du helper et tous les tests budgétaires existants ; leurs passages ciblés antérieurs restent des preuves historiques séparées.

## Revues et limites

Revues indépendantes de qualité, pratiques et architecture réalisées ; aucun finding ouvert dans ce périmètre. La revue a identifié puis fermé le défaut d'import du driver Python isolé : le chemin canonique du producteur est maintenant disponible pour ses helpers de test, avec les contrôles de source et de venv conservés. La reproduction isolée échoue avant correction et réussit après, en vérifiant les origines des modules sans réseau, SQLite ou sous-processus. Les deux relectures du resserrage final ferment également la course de fixture sur le SHA `7c5f298`.

Oracle standard, Astra/Pro vérifié, session `sparra-qualified-fixture-budget-oct22`, approuve la conception des pilotes indépendants sous réserve des preuves natives, de l'absence de remboursement des admissions et du refus de réenrôler un historique perdu. La revue porte sur cette conception ; elle ne remplace pas l'exécution finale.

Cette recette qualifie localement les sémantiques d'admission et de cycle de vie avec les ressources SDK déjà importées. **La latence de contrôle du premier import SDK à froid et un SLO de production ne sont pas qualifiés.** Les fournisseurs sont contrôlés hors ligne. Aucune publication de producteur, image, migration sur service existant, téléphonie réelle, CI hébergée ou mise en production n'est établie par ces tests.

Garde de ressources : au moins 2 Gio physiques et virtuels libres à l'entrée, tests lourds séquentiels ; inventaire Docker et nettoyage exacts conservés. Les rapports détaillés, logs et reçus JSON de cette recette sont archivés dans `C:/Users/louis/.codex/artifacts/sparra-strategy/2026-10-22/qualified-native-fixtures/`.

## Reproduction locale

Depuis le worktree App, avec son runtime compilé et les deux environnements figés :

```powershell
$env:SPARRA_VOICE_TEST_ROOT='C:/Users/louis/Documents/ChatGPT/.worktrees/sparra-diagnostic-lot1-voice'
$env:SPARRA_VOICE_TEST_HOME='C:/Users/louis/Documents/ChatGPT/.worktrees/sparra-diagnostic-lot1-app/.output/task-2-voice-home'
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/sparra-voice-connected.test.ts tests/integration/sparra-voice-retention.test.ts --maxWorkers=1
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/calendar-consumer.test.ts --testNamePattern 'native phone-only Calendar confirmed preserves booking authority and the authenticated compiled Inbox' --maxWorkers=1
pnpm typecheck
pnpm lint
```

Depuis le worktree Voice, exécuter les contrôles offline habituels et la suite complète avec `uv run --offline --frozen pytest -q`. `pnpm test` n'est pas un alias pour ces commandes ciblées : il lance une autre qualification native et ses contrôles de couverture.
