# Passation du boilerplate applicatif pour Sparra

Date : 30 septembre 2026. Cette livraison transmet du code et ses limites ; elle ne lance pas Sparra et n'active aucun fournisseur.

## Lire ceci en premier

Le code qualifié provient de l'objet Git SHA-256 **4919660f4703817a4e3c4b543bf50076f2f0239cdf3d4fd2dbf467d17fddae14**. La branche locale **z/handoff/boilerplate-r1-20260930** est un instantané de transmission : même code/tests/lockfile/migrations, plus les documents de clôture et ce guide. Elle ne doit plus être déplacée. Le SHA exact livré et les SHA-256 des archives figurent dans DELIVERY.json, à côté des archives.

Le développeur du template continue dans son checkout de travail. L'agent Sparra travaille dans SON dépôt/dossier/base de données. Il ne doit jamais éditer le checkout producteur ni dépendre de ses fichiers non commités, de son node_modules, de ses builds ou de son dossier .superpowers.

**On peut démarrer le travail produit séparé sur ce candidat. Il n'est pas prêt à accueillir des clients payants en production.** Il reste notamment récupération complète, notifications, fermeture de compte, B2B/commerce/Stripe, dérivations et recette intégrée. Aucun faux login, contournement de session ou isolation tenant provisoire ne comble ces manques.

## Deux bases distinctes : ne pas les écraser l'une par l'autre

| Base | Contenu vérifié / provenance | Conséquence |
|---|---|---|
| Cet instantané applicatif | TanStack Start/Router, React/Astryx, Effect, Better Auth, PostgreSQL/Drizzle, Redis, mail worker ; Node24.14.0, pnpm10.32.1 | C'est ici que se trouve le travail applicatif de ce chat. |
| Dépôt GitHub projetV0-saas-template | La passation infra au commit9f059e8 décrit un starter Next.js, pnpm11.21.0, Docker/CI/Oxlint anti-slop/React Doctor | Sa branche main n'est pas réputée contenir cet instantané ; ce n'est pas le même graphe ni le même routeur. |
| projetV0-infra / pipelines / voice | Passation séparée référencée plus bas | Ni ces repos ni les serveurs n'ont été modifiés par cette livraison. |

L'agent produit doit décider explicitement de sa base applicative avant de générer des écrans ou modifier les dépendances. S'il garde Next.js, ce code TanStack n'est pas un module prêt à fusionner tel quel : tout portage devient une intégration à requalifier. S'il part de cet instantané, il reprend les contrôles CI/anti-slop pertinents après lecture des dépôts/PR actuels, sans remplacer globalement les pins ou scripts par ceux du starter.

Les deux historiques peuvent également différer : ce dépôt local utilise les objets Git SHA-256. Ne pas supposer qu'un SHA64 peut être cherry-pické dans un dépôt SHA-1 existant. L'archive source ZIP permet une reprise de fichiers indépendante de ce format ; le bundle conserve l'historique local pour les outils compatibles. Aucun remote ni push n'a été créé ici.

## Ce que le code contient

- Connexion Google selon le protocole configuré, magic link pour User existant, premier enrôlement natif de passkey et connexion primaire par passkey.
- Lecture du compte, déconnexion, Workspace personnel persistant, création/lecture/renommage contrôlés.
- Passkey supplémentaire après preuve de clé existante ; première passkey d'un compte Google conditionnée à un auth_time récent réellement fourni.
- Liaison/déliaison Google explicite, liste des sessions et révocation exacte d'une autre session avec preuve fraîche.
- Pipeline e-mail durable, outbox/worker, contraintes de rôles/RLS et propriétaire transactionnel physique.
- R1 : émission/rotation réelle de huit codes et nouvelle preuve Google liée. **Ce dernier bloc reste interne : aucun écran/endpoint public de récupération, code non consommé, preuve non consommée, aucune session PREPARED/activation.**

Les parcours antérieurs ont leurs preuves locales et limites propres, pas une recette monolithique du template. Google/TLS/mail ont été observés avec des fournisseurs contrôlés ; les parcours passkeys navigateur emploient un authentificateur virtuel. Ni Google réel, ni réception en boîte mail, ni authentificateur physique, ni Safari/iOS, ni conformité/hébergement français ne sont établis par cet instantané.

## Preuves transportées

Voir [boilerplate-r1-verification.json](boilerplate-r1-verification.json). Ce résumé est extrait des reçus du contrôleur ; il ne contient ni exports DB ni inventaire de ressources d'autres projets.

- Sur4919660f, le30septembre : suite source53fichiers/682tests PASS ; typecheck normatif exit0.
- Les intégrations sont exclues de cette suite. Les sélections natives gardent leur candidat/commande/résultat et leurs comparaisons de nettoyage.
- Les29nouveaux cas A–D sont couverts par A1+6, B5+4, C7, D3, avec les échecs historiques conservés ; pas un nouveau run global56cas.
- Deux avertissements RouterProvider de tests UI FR/EN subsistent ; les simulations de règlement COMMIT/cancellation ne prouvent pas une ambiguïté physique réelle.
- Revue indépendante finale : SpecCompliancePass, TaskQualityApproved. Oracle6Pro : APPROVE_SCOPED de R1, sans amendement obligatoire. Rien de cela ne clôt le produit.
- Aucun install/build/test applicatif n'a été relancé pour fabriquer les archives. La vérification de livraison porte sur les objets Git, le contenu, les empreintes et l'importabilité du bundle/ZIP ; elle ne remplace pas la recette du produit dérivé.

## Points d'entrée à lire

1. [README](../../README.md), [instructions du dépôt](../../AGENTS.md), package.json, pnpm-lock.yaml et pnpm-workspace.yaml. Conserver le patch nice-grpc déclaré dans patches/ : supprimer cette déclaration ou changer son pin demande une requalification.
2. [Design](../design/BOILERPLATE_DESIGN.md), [périmètre complet](../design/APPLICATION_DELIVERY_CONTINUATION.md) et [plan auth](../superpowers/plans/2026-09-10-functional-auth.md). Les parties proposées ne sont pas des fonctionnalités livrées.
3. [Contrat Workspace](../personal-workspaces.md), [opérateur mail](../auth-mail-operator.md), src/platform/db/, src/modules/auth/ et src/modules/workspaces/.
4. src/routes/, src/ui/, src/platform/config.server.ts et les tests du consommateur concerné. Les types/adaptateurs natifs sont ceux des versions installées, pas ceux d'un exemple trouvé au hasard.

AGENTS.md décrit le périmètre du mainteneur du template. Dans sa dérivation, l'agent Sparra doit le contextualiser à son mandat explicite ; il ne doit pas interpréter une ancienne instruction de branche locale comme une autorisation de modifier le checkout producteur. Les invariants sécurité/tenancy/secrets restent applicables.

## Travail parallèle et futures mises à jour

| Propriétaire | Zone |
|---|---|
| Ce chat / mainteneur du template | Auth, récupération, sessions, mail générique, DB owner/RLS, noyau Workspace et futurs lots génériques B2B/commerce. |
| Agent Sparra | Produit vocal/téléphonique, contenu/démo, inbox métier, configuration de l'entreprise, intégrations métier et présentation du produit. |
| À coordonner avant intégration | Lockfile/pins, auth/functions, routeur partagé, schéma/migrations/journal, worker et configuration commune. |

Les chemins produit ci-dessus sont des responsabilités, pas une nouvelle architecture Sparra imposée par ce guide. Ne pas reconstruire une deuxième auth, un deuxième propriétaire DB ou un second moteur de facturation juste pour attendre le lot générique. Une première offre mensuelle Sparra ne prouve pas que le commerce générique est disponible.

Règle de mise à jour :

1. Conserver le SHA de base livré et les fichiers originaux, en lecture seule.
2. Le mainteneur publie un nouvel instantané LOCAL numéroté avec changement source, migrations et preuves ; il ne déplace pas cette branche et ne modifie pas Sparra.
3. L'agent Sparra compare base -> nouvel instantané et ses propres changements, puis intègre explicitement. Pas de copie récursive écrasant le projet, de pull automatique ou de patch forcé.
4. Pour des historiques compatibles : examiner le diff avant merge/cherry-pick. Pour une reprise ZIP/SHA-1 : utiliser les deux sources figées comme base de comparaison ; les conflits doivent être résolus, pas contournés.
5. Les migrations appliquées restent immuables. Deux projets peuvent avoir produit leur propre0013 : ne pas copier aveuglément numéros/journal/snapshots. L'agent qui intègre construit une nouvelle migration forward sur SON état, conserve les grants/RLS/contraintes de l'amont et teste avec données préexistantes. Jamais réécrire une migration déjà appliquée ni migrer une base partagée pour faire passer un test.
6. Requalifier le code intégré et ses vrais consommateurs. Le résultat682tests de l'amont ne certifie pas une dérivation modifiée.

Aucune synchronisation automatique ou travail planifié caché n'est installé. La suite du template peut avancer indépendamment ici, mais chaque livraison et intégration reste explicite.

## Suite prévue du template

Le choix de permettre la reprise après expiration serveur est adopté. Les anciens cookies restent sans autorité ; aucune disparition physique garantie n'en découle. Le [plan R2](../superpowers/plans/2026-09-30-recovery-preparation.md) contient les propositions de préparation/statut/annulation et limites, **pas du code opérationnel**. Ses paramètres et gates restent ceux du plan, sans activation implicite par cette passation.

Après cela : activation atomique, nouvelle clé enrôlée/testée, retrait de toutes les anciennes passkeys à la réussite (Google reste lié), renouvellement des codes, hold24h, notifications, alternative e-mail, fermeture personnelle et UX intégrée ; puis B2B/Stripe/derivations/recette. Ne pas exposer ces capacités comme déjà présentes.

## Reprendre et vérifier dans un environnement séparé

Ne pas réutiliser les secrets exposés en conversation. Les révoquer/remplacer et les fournir par le mécanisme de secrets choisi, jamais via ce guide, un prompt Oracle, Git ou une URL.

L'archive ZIP contient le source sans .git, .env, node_modules, builds ou .superpowers. Extraire dans un NOUVEAU répertoire ; conserver DELIVERY.json et la provenance. Le bundle optionnel contient une branche Git locale SHA-256 complète, sans dépendance au magasin d'objets du producteur. Exemples non exécutés pour Sparra :

~~~powershell
git bundle verify 'CHEMIN/boilerplate-r1.bundle'
git clone --branch z/handoff/boilerplate-r1-20260930 'CHEMIN/boilerplate-r1.bundle' 'NOUVEAU_DOSSIER'
~~~

Les commandes applicatives, après choix de la base et installation des pins exacts :

~~~text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
~~~

Intégrations : lire vitest.integration.config.ts et les fixtures AVANT toute exécution. Les fixtures actuelles attendent Docker Desktop desktop-linux/Linuxamd64 et des images pinnées ; elles ne sont pas un environnement de production. Ne pas lancer la suite entière sur une machine/Docker partagés sans coordination. Bornes actuelles du contrôleur : au moins2GiBphysiques/6GiBvirtuels libres ;1worker ; processus sélectionné borné ; aucun arrêt/cleanup de ressources étrangères. Pas de changement de compilateur/heap pour masquer un échec.

Le README détaille rôles, grants et ingress : le listener privé n'est pas le point d'entrée navigateur de confiance. Les migrations actuelles vont de0000à0012 ; ni leur génération ni les instructions SQL n'autorisent une application à une base existante. La readiness HTTP n'est pas une preuve de disponibilité des fournisseurs ou du produit.

## Références du studio, état à revalider par l'agent produit

La [passation CI/CD au commit9f059e8](https://github.com/LouisVannobel/projetV0-infra/blob/9f059e8c6beb7d238fa01d4d2c81ab8d607b6521/docs/ci-cd/README.md) a été lue depuis cet objet Git local. Elle documente son observation GitHub du29septembre, pas une vérification distante effectuée pour cette livraison. Elle distingue runtime voice, pipelines existants et future passerelle de déploiement sans secret non implémentée.

Consulter les dépôts/PR actuels et les contrôles anti-slop au moment de l'intégration reste le travail de l'agent Sparra. Aucun contrôle CI/remote actuel, appel Telnyx, achat de numéro, DNS, Vercel, SSH, serveur ou conformité n'a été exécuté ici. Les clés du prompt produit n'ont été ni utilisées ni conservées.

Pour Stripe, l'instruction est de lire les guides/skills officiels et les sources au point de consommation. Le SDK de facturation IA et un MCP ne sont pas des dépendances automatiques. Pour Effect/Better Auth/TanStack, privilégier le code/tests de la version installée et ses guides natifs ; aucun subtree de dépendance n'est imposé ou ajouté par cette passation.
