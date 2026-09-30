# Préparation de l'authentification et de la livraison SaaS

Date : 10 septembre 2026. **Adopté par l'utilisateur (« Tu as mes autorisations », puis « Vasy »).** L'accord lève le gate d'adoption et autorise la poursuite locale du plan et de l'implémentation. Ce texte ne constitue pas une authentification livrée ni une autorisation de déploiement/altération de services existants.

## Résultat visé

Pouvoir créer un SaaS à partir du template et commencer son code métier sans reconstruire identité, espaces de travail, interface ou commerce sélectionné. La stack reste celle déjà choisie ; Astryx remplace définitivement les références historiques à shadcn.

L'authentification doit couvrir Google, magic links, passkeys, sessions/déconnexion, récupération et e-mails réels. TOTP est une option complète si sélectionnée ; mot de passe, reset-password, trusted-device et contournement support restent absents. Ce document prépare ce volet et conserve les quatre livraisons suivantes : données/Workspace, UI Astryx applicative, commerce et dérivation réutilisable.

L'incrément de maintenance adopté le 11 septembre cible Better Auth 1.7.4 :
clé physique native `(providerId,accountId)`, namespace `google` fixé à
`https://accounts.google.com`, identité logique de session `{issuer,subject}`
inchangée. Une migration forward atomique refuse les bindings legacy ambigus
avant de supprimer `account.issuer`. Le CHECK Google-only évoluera avec le
premier producteur de comptes supplémentaire, en traitant les alias d'issuer ;
il ne retire aucune méthode de la feuille de route. Aucun service existant
n'est migré par cette autorisation locale. Les gates claims, Google réel,
annulation/transport et resolver-tail restent ouverts.

## 1. Acquis à conserver et réemploi

Le candidat applicatif possède déjà son démarrage web, sa configuration, ses frontières TanStack, quatre tables d'authentification, une migration générée et les tests réels des contrats Better Auth/Drizzle. Ces éléments restent en place. La migration n'a pas été appliquée à une base, et aucun parcours de connexion n'est encore livré.

| Existant | Réutilisation attendue | Adaptation nécessaire |
|---|---|---|
| Schéma/options/tests d'auth de l'application | Étendre les mêmes fichiers et tests | Ajouter seulement les modèles consommés par la méthode livrée ; ne pas recréer un deuxième probe de schéma |
| Prototypes Better Auth P2 | Cas de cookies, expiration, révocation, rotation, recovery et chemins HTTP | Les exécuter sur le vrai adapter/issuer/reader de l'application ; identités simulées, commandes internes par header et defaults permissifs restent des fixtures |
| Prototypes PostgreSQL P3 | Cas sentinel, isolation, tenant/RLS et concurrence owner | Le helper jetable expose le client brut et libère après échec du rollback : ne pas le transplanter comme coordinateur produit |
| Prototypes Effect/CSRF de Section7 | Cas interruption, finalisation et refus cross-origin | Conserver la fondation web/lifecycle/CSRF ; adapter les cas Effect au ManagedRuntime à intégrer avec son vrai consommateur. Aucun cookie de test dans le runtime livré |

Manques d'intégration vérifiés : propriétaire transactionnel commun, façade du vrai adapter Better Auth, admission des sessions, lecteur privé, parcours et e-mails. Le choix des bibliothèques n'est pas à refaire.

## 2. Documentation et code source : deux rôles, un besoin concret

- **Agent documentation** : guide/skill officiel et documentation de la version utilisée ; retourne l'API pertinente, ses limites et les divergences de version.
- **Agent source/tests** : suit l'implémentation et les tests upstream du commit correspondant ; propose les scénarios à reprendre et les différences à tester dans l'application.
- **Implémentation et revue** : un agent frais par tâche, puis revue indépendante ; Oracle entre les étapes. Une instruction générique upstream ne modifie pas implicitement les choix du projet.

Ordre d'autorité : invariants et décisions projet ; lockfile/paquets exacts et source/tests correspondants ; documentation officielle versionnée ; guides actuels puis communauté comme compléments. Les exemples password/Resend/Kysely/Effect SQL/catch-all ou cookies maison ne sont pas notre configuration.

### Références locales proposées

Commencer avec les sources, `AGENTS.md` et exemples fournis par Effect, les skills/source TanStack installés et le checkout Better Auth déjà disponible. Un checkout séparé, ignoré et en lecture seule n'est ajouté que pour un manque précis de source/tests. Pas d'import applicatif depuis ces références, pas d'installation/exécution de leurs scripts, pas de synchronisation automatique.

Le `git subtree` de l'article Effect n'est pas retenu ici : le dépôt applicatif est SHA-256 et les upstream sont SHA-1, sans interopérabilité disponible. Il n'est pas nécessaire de convertir le dépôt ou son historique pour lire les sources. Le principe utile de l'article — étudier de vrais exemples et tests — est conservé. [Article Effect](https://www.effect.website/blog/the-one-weird-git-trick-that-makes-coding-agents-more-effect-ive), [documentation Git](https://git-scm.com/docs/git-init).

| Bibliothèque | Tag et commit de référence vérifiés | Lecture prioritaire |
|---|---|---|
| Effect | `effect@4.0.0-rc.111` · `648f566dd259898e7697c7fcb796183ccbc474ab` | AGENTS/source/ai-docs du paquet ; ressources, interruption et ManagedRuntime |
| Better Auth | `v1.7.1` · `2344536054f9164ca5d1670c270d299049ee233e` | Source/tests du Drizzle adapter, transaction context, callback Google et internal adapter |
| TanStack | Start `1.168.49`, Router `1.170.32` · `a5a5bacc8fdf30b7823caf0a94908c3e0db27aa2` | Skills livrés et sources des packages transitoires réellement résolus ; server functions/CSRF |
| Drizzle | `0.45.2` · `273c78071d4841b497f5144734b38294df7ec64b` | Driver/session node-postgres et tests d'intégration ciblés |
| node-postgres | `pg@8.23.0` · `df274d1ba9ad9d11a8f1079314faeafde7208207` | Cycle query/ReadyForQuery, états transactionnels et tests d'erreur |

Ces checkouts de référence et guides sont facultatifs pour développer le template et ne sont pas des dépendances runtime ; les bibliothèques npm sélectionnées restent, elles, requises. La recréation des références utilise URL publique/commit, jamais un chemin du poste d'origine. Un tag résolu ne prouve pas à lui seul l'identité de chaque octet du tarball npm.

### Routage des ressources proposées

| Maintenant | Plus tard ou hors du volet auth |
|---|---|
| [Effect officiel](https://github.com/Effect-TS/skills/blob/main/skills/effect-ts/SKILL.md), guides du paquet | effect.solutions, kitlangton, joelhooks et le gist : compléments si un besoin demeure, pas architecture à importer |
| [Better Auth skills](https://github.com/better-auth/skills) et [llms.txt](https://better-auth.com/llms.txt) | Les pages v1.7 actuelles ne sont pas patch-pinnées1.7.1 ; source/types décident |
| Skills TanStack installés | [Intent](https://github.com/tanstack/intent) seulement si la découverte des skills devient un problème réel |
| [Plunk](https://docs.useplunk.com/llms.txt), [Hatchet](https://docs.hatchet.run/reference/typescript), docs ordinaires Redis/pg/Drizzle | Pas de connexion automatique aux MCP de données ; pg-aiguide est un complément, pas une nouvelle couche SQL |
| [Astryx](https://github.com/facebook/astryx) pour les vrais écrans auth | Storybook optionnel avec un consommateur UI ; pas de shadcn ni second design system |
| Contrats de sortie vers commerce | [Stripe docs](https://docs.stripe.com/llms.txt) et [stripe/ai](https://github.com/stripe/ai) à l'étape commerce ; SDK officiel direct, pas Better Auth Stripe/Entitlements/Billing Credits/preview |
| Aucune dépendance voix ou déploiement dans l'auth | Pipecat/Context Hub/skills/MCP et SDK MCP Python : projet voix séparé ; Dokploy MCP : périmètre opérateur/infra inchangé |
| Routes privées non indexables | SEO/GEO Aaron Marketing : surfaces publiques fournies par le produit, pas les pages privées/auth |

Context7 est disponible, mais sa résolution Better Auth ne propose pas de version1.7.1 ; il peut aider à découvrir des concepts, pas fournir ici une garantie patch-exacte. Aucun skill/MCP supplémentaire n'a été installé.

## 3. Amendement adopté : e-mails avant User/Workspace

**Adopté avant le plan détaillé d'auth.** Les anciennes versions des §§6.3,8.5,9.1,9.2 de BOILERPLATE_DESIGN.md imposaient un e-mail durable sans autoriser ses tables dans auth-global ni son dispatch sans tenant. Les remplacements sont maintenant incorporés au design applicatif. Une demande de magic link peut précéder User et Workspace ; aucun faux Workspace, tenant nul généralisé ou envoi direct depuis le callback n'est introduit.

### A. Propriété des données et accès

Étendre explicitement auth-global aux seuls enregistrements d'e-mail nommés du module auth : `AuthEmailRequest`, `AuthEmailCommand`, `EmailDelivery` et son outbox auth. Ce sont des relations UUID ordinaires, sans FK tenant-composite ; l'absence initiale de User est admise. Ils restent auth-owned après création d'un Workspace. Les tables et contraintes des livraisons tenantées restent inchangées.

Les seules opérations autorisées sont les commandes auth server-only, le relay de cette outbox et son worker d'e-mail. Aucune API arbitraire d'envoi, accès global à d'autres tables, conversion auth-global→tenant ou identité fictive n'est créée. Le tenant ne peut ni lire ni modifier ces enregistrements. Les permissions SQL et la portée d'exécution doivent le démontrer.

### B. Intention durable et transaction

`AuthEmailRequest` est l'autorité durable de la demande, avec unicité par e-mail normalisé/purpose et génération courante augmentée atomiquement sous verrou/CAS. Elle existe sans User et ne se rabat donc pas sur `User.recoveryGeneration` ; un rattachement User ultérieur n'en change pas la génération. Une commande immuable par `(requestId,generation)` fixe purpose, destinataire, locale, expiration et identité logique de l'envoi ; une livraison/outbox ne peut être créée qu'une fois pour cette commande. L'ancienne génération devient non consommable et non réémettable, même si un ancien job arrive après purge de son payload.

**Remplacement normatif proposé du §6.3 :** la règle « recréer l'intention absente pour un User non vérifié » devient « réparer une obligation d'e-mail explicitement autorisée, committée et non satisfaite ». Pour un signup qui exige cet e-mail, l'obligation AuthEmailRequest/commande est persistée dans la même transaction physique que le fait signup causal, pas dans `session.create.after` ni un callback après commit. Le reconciler lit cette obligation durable et insère idempotemment la paire manquante ; être non vérifié ne suffit pas à autoriser des envois répétés. Le point d'intégration BA qui réalise cette atomicité reste à compiler et à tester : la transaction user/account se termine avant la création de session.

La paire EmailDelivery/outbox est persistée atomiquement par le propriétaire transactionnel commun et participe à une transaction auth déjà active. Elle ne peut pas survivre seule au rollback de l'opération qui l'exige. Le callback ne contacte ni Plunk ni Hatchet ; le relay traite seulement les intentions committées. Le rattrapage après perte d'un callback utilise la commande durable, jamais une promesse en mémoire.

Better Auth reste propriétaire des **tokens de session**. Les tokens purpose-bound du flux magic fragment→POST restent ceux prévus au §6.3 : ne pas substituer le vérificateur GET du plugin. Leur vérificateur reste one-way. Pour permettre une reprise à payload identique, **l'amendement autorise séparément une enveloppe AEAD de livraison dans EmailDelivery**, jamais le token en clair dans le stockage de vérification ou dans l'outbox.

Contrat d'enveloppe proposé : AES-256-GCM via l'API native Node, clé dédiée32octets distincte des secrets BA/rate-limit, nonce aléatoire12octets neuf par chiffrement, tag16octets ; `keyId` non secret et AAD liés à deliveryId/purpose/génération/expiration. Pas de crypto maison ni KMS/service ajouté. Les octets de contenu sont figés, chiffrés une fois et réutilisés pour la même tentative logique ; seul le worker auth peut les déchiffrer. Le relay voit uniquement les données de claim/admission, jamais l'enveloppe ni le destinataire.

Les liens de cette livraison auth expirent au plus10minutes après création ; les paramètres de vérification BA utilisés pour ces e-mails doivent imposer la même borne, sans modifier l'expiration7jours des sessions. L'enveloppe expire au plus tôt avec son lien, sa génération supersédée ou la terminalité de la commande. Le worker vérifie ces conditions avant déchiffrement puis avant envoi. Clé absente/tag invalide/expiration → zéro appel Plunk et échec explicite, pas reconstruction d'un token différent. Purger le ciphertext/tag/nonce dès terminalité ou expiration ; conserver seulement l'identité/état non secret nécessaires au rejet des jobs tardifs selon l'horizon de replay figé à l'admission.

Rotation : nouvelles enveloppes avec le seul keyId courant ; anciennes clés déchiffrantes conservées uniquement jusqu'à expiration/purge des enveloppes encore admissibles, puis retirées de la configuration opérateur. Un restart ou une restauration ne rend jamais admissible une enveloppe expirée/supersédée. Les clés ne sont ni stockées dans le dépôt/DB/outbox ni imprimées. Cette politique n'annonce pas un effacement cryptographique des sauvegardes existantes et ne modifie pas leur rétention. Sa mise en œuvre et la rotation seront vérifiées avant e-mails qualifiés.

### C. Dispatch auth explicite, tenant inchangé

Conserver les jobs tenantés `{outboxId, tenantId}`. Ajouter une tâche Hatchet statiquement nommée pour l'e-mail auth, avec le seul input `{outboxId}`. L'identité de la tâche détermine le store auth ; aucun champ scope/module arbitraire, destinataire, token ou contenu n'arrive dans le message de job.

Le worker relit la commande et la livraison committées, vérifie kind/génération/état/expiration et refuse un ID provenant de l'outbox tenantée, sans fallback. Même base, pool/propriétaire, système Hatchet, relay et lifecycle web/worker ; pas de second broker ou service ni de framework universel de dispatch. L'outbox auth est une exception module-owned explicite, pas une modification silencieuse de l'outbox tenantée.

**Extension explicite du §9.2 au relay auth :** fonctions SQL auth distinctes de claim/finalisation, rôle relay sans DML table et avec seulement EXECUTE sur ces fonctions ; owner et definer NOLOGIN séparés, definer non-owner/NOSUPERUSER/NOBYPASSRLS, objets qualifiés, `search_path=pg_catalog,pg_temp`, PUBLIC révoqué. Les fonctions exigent état attendu, fence et lease. Gardes de store et permissions SQL doivent interdire les croisements auth/tenant ; le nom du job seul n'est pas cette preuve.

L'identité/idempotence Hatchet est dérivée de l'outbox auth committée et du nom statique de tâche ; une collision retrouve le run correspondant. Collision sans run ID → `admission_unknown`, jamais une réadmission aveugle. Toute entrée manquante/stale/cross-scope/terminale provoque zéro appel fournisseur. Le worker reste replay-safe avec `retries:0` ; ni lease/fence/TTL Hatchet ne prouvent qu'un ancien appel Plunk est arrêté. La version SDK/engine exacte et les rôles existants adaptés dans un environnement autorisé restent des preuves à produire, pas des déploiements autorisés par ce texte.

### D. Retries et résultats inconnus

Claim SQL court → appel Plunk hors transaction → finalisation conditionnelle. Un doublon conserve l'identité d'envoi et les paramètres ; un worker obsolète ne gagne pas contre une génération/claim plus récent. Le worker ne prolonge pas un lien expiré et ne génère pas un nouveau token ; une nouvelle émission relève de la commande auth correspondante.

Une réponse fournisseur perdue reste `unknown`. Pas de succès inventé, nouvelle clé d'idempotence ou renvoi aveugle hors fenêtre prouvée. Un accusé d'acceptation fournisseur n'est pas une preuve de réception dans la boîte mail. Les documents Plunk hébergés décrivent notamment409 et une fenêtre d'idempotence configurable ; ils ne prouvent pas le comportement de l'image auto-hébergée sélectionnée.

### Cas d'acceptation discriminants de l'amendement

1. Demande autorisée sans User et sans Workspace : intention durable, aucun tenant inventé.
2. Rollback de l'opération auth : aucun e-mail dispatchable issu de cette opération.
3. Signup committé puis callback perdu/restart : une obligation explicite est réparée sans doublons ni renvois illimités.
4. ID tenant envoyé à la tâche auth, ou inversement : zéro appel fournisseur ; aucun store de repli.
5. Job dupliqué, génération remplacée, lien expiré ou ancien worker : refus/reprise déterministes sans nouvelle autorité.
6. Accusé Plunk perdu/409 : état conforme au contrat réellement observé, jamais « livré » par déduction.
7. Captures/logs/télémétries : aucun token, URL complète ou destinataire en clair hors données minimales explicitement autorisées.
8. Restart avec enveloppe admissible : mêmes octets de payload ; clé manquante, tag altéré, AAD différente, génération/TTL périmés ou ancienne clé retirée : zéro appel Plunk. Vérifier purge, rotation et rejet d'une enveloppe expirée restaurée.
9. Rôle relay : SELECT/DML direct sur contenu interdits ; seules les fonctions de claim/finalisation prévues passent. Collision Hatchet sans run ID reste unknown.

## 4. Premier pilote orienté source — spécifié, non exécuté

**Question :** le vrai adapter Better Auth Drizzle délègue-t-il toutes ses opérations au même propriétaire transactionnel applicatif, sans transaction native parallèle ?

Référence MIT : [Better Auth1.7.1](https://github.com/better-auth/better-auth/tree/2344536054f9164ca5d1670c270d299049ee233e), `packages/drizzle-adapter/src/drizzle-adapter.ts`, son test adjacent et `packages/core/src/context/transaction.test.ts`. Le checkout existant suffit ; aucun clone supplémentaire pour ce pilote.

Le consommateur est la vraie configuration auth puis l'émission Google. La façade doit préserver les query builders Drizzle et les signatures du vrai adapter, couvrir les opérations CRUD hors transaction explicite et laisser le propriétaire commun gérer BEGIN/COMMIT/ROLLBACK. L'implémentation native de transaction Drizzle ne devient pas notre mécanisme d'imbrication. Le pilote traverse le propriétaire applicatif réellement implémenté, pas un mock de propriétaire qui s'auto-atteste ; le client de transport reste une fixture typée compatible pg/Drizzle, sans `{query}` déguisé en PoolClient.

Surface discriminée : `create`, `findOne`, `findMany`, `count`, `update`, `updateMany`, `delete`, `deleteMany`, `consumeOne`, `incrementOne` et `transaction`. Vérifier l'entrée hors transaction, puis la participation à une lease active : même client, aucun root/savepoint supplémentaire, erreurs/options incompatibles refusées et builders invalidés après fermeture. Des opérations indépendantes successives peuvent utiliser des clients physiques différents.

```gherkin
Scenario: Toutes les opérations de l'adapter participent au même propriétaire
  Given le vrai adapter Better Auth et de vrais query builders Drizzle
  And un client d'enregistrement limité aux tests
  When une opération CRUD puis une transaction explicite sont exécutées
  Then chaque SQL utilise le client détenu par le propriétaire attendu
  And aucune opération ne passe par pool.query ou une transaction native parallèle

Scenario: Un échec ne transforme pas un rollback en succès
  Given une opération réelle de l'adapter dans une transaction détenue
  When l'opération échoue
  Then son échec se propage et le propriétaire reçoit la décision de rollback
  And aucun cookie ou résultat de session accepté n'est fabriqué
```

Ajouter les branches PostgreSQL réelles `consumeOne`/`incrementOne` et le callback transaction explicite ; les branches de transactions imbriquées MySQL ne sont pas des cas PostgreSQL à inventer. Les tests locaux doivent échouer si un bypass du propriétaire est introduit. Une fixture de transport prouve la délégation, pas la sémantique PostgreSQL/PgBouncer ni la complétude de l'auth.

## 5. Ordre de livraison à détailler après adoption

| Étape | Résultat observable exigé avant passage |
|---|---|
| Auth : stockage/owner et adapter réel | Migration sur base isolée, délégation réelle, finalisation/rollback et isolation prouvées ; réemploi des tests existants |
| Auth : Google, admission et sessions | Connexion réelle, identité provider liée au bon User sous verrou, cookie après commit, lecteur privé, révocation/déconnexion ; expiration absolue7jours/inactivité12h et refus des états restreints |
| Auth : e-mails, magic et limites | Contrat pré-tenant adopté, Plunk/Hatchet qualifiés, worker réel, fragment→POST10min/one-shot/génération, anti-énumération et rate limit Redis partagé fail-closed |
| Auth : passkeys, sécurité et recovery | UV cryptographiquement vérifié, enrôlement initial légitime, grants one-shot5min, linking explicite, recovery deux preuves/générations/hold24h, codes et notifications ; TOTP complet si sélectionné |
| Auth : recette utilisateur | Vrais écrans Astryx FR/EN/320px, clavier/focus/erreurs/reprise ; essais navigateur, accès direct aux endpoints et concurrence sur vraie base ; aucune fausse session dans le runtime |
| Données/Workspace | Principal admis → création/sélection/persistance du Workspace, RLS et lifecycle ; organisations/rôles/invitations du profil B2B |
| UI applicative Astryx | Navigation, onboarding, paramètres compte/espaces et états métier réels ; les écrans auth sont déjà un consommateur obligatoire de l'étape auth |
| Commerce | Plans/Stripe/portail/webhooks/sièges/usage des profils concernés, résultats perdus et doublons testés |
| Template utilisable | Nouvelle dérivation reconstruite, configurée et migrée ; parcours complets des profils requis, sans `.codex`, chemin du poste ou dépendance à Oracle |

Oracle intervient entre ces étapes avec les sources et preuves du changement courant. Un reviewer indépendant valide chaque tâche ; les corrections mineures ne redémarrent pas les fondations. Aucune étape partielle ne remplace les cinq livrables de l'objectif.

## 6. Autorisations et preuves restant ouvertes

- Les autorisations explicites reçues permettent les tests locaux isolés et leurs dépendances jetables annoncées ; vérifier les cibles avant toute opération. Aucune base existante ou credential ne sera substitué, aucun service de production reconfiguré/supprimé.
- Google, Plunk auto-hébergé, Hatchet et les autres providers : version/endpoint/SDK exacts, configuration et essais autorisés à qualifier ; aucune lecture automatique des secrets existants.
- Le futur plan détaillé doit traduire le contrat d'enveloppe/rétention en schéma et tests, et nommer les points d'extension Better Auth réellement compilés. La revue d'un texte ne prouve pas ces interfaces ni l'atomicité de l'obligation signup.
- Aucun code runtime, package, connexion MCP fournisseur, clone, migration appliquée, infrastructure ou CI/CD n'a été changé par cette préparation.

**Décision reçue : exception d'e-mail auth avant tenant (§3) et pilote minimal (§4) adoptés. Poursuivre le plan détaillé et le code de l'auth complète ; ne pas redemander cette adoption.**

## Revues de préparation

Deux agents distincts ont vérifié documentation/contrats et sources/tests, puis relu les corrections ciblées. Leurs derniers verdicts sont favorables à la préparation ; ils ne constituent pas une recette applicative.

- [Oracle étape1](https://chatgpt.com/c/6aa26341-5b84-83eb-b505-ce0a8c247dce) : méthode/réemploi approuvés ; amendement pré-tenant demandé.
- [Oracle étape2](https://chatgpt.com/c/6aa27fa7-409c-83eb-b89c-f117ea61c6a0) : **APPROVE FOR USER ADOPTION**, aucun P0/P1 au niveau préparation. Corps de proposition revu : SHA-256 `a1f38748bf4b00d904f7fe14c59660dd7e1d0b8aa891954954c0f589c3ce14ed`, avant ajout du présent historique et mise à jour du statut.

Après adoption : intégrer les remplacements normatifs désignés aux §§6.3/8.5/9.1/9.2, puis détailler les tâches de l'auth complète. Le plan devra prouver le même échantillon de token dans vérificateur/enveloppe, les deux générations request/User lorsqu'applicables, le tag GCM de16octets strictement vérifié avant toute utilisation du plaintext, le commit causal signup, les permissions réelles et les contrats fournisseur. Aucun de ces tests n'est déclaré exécuté ici. Les liens Oracle sont une trace de revue, pas une dépendance d'exécution ou de dérivation du SaaS.
