# projetV0 — Boilerplate SaaS privée B2B/B2C

**Date :** 2026-08-25 · protocole probes amendé 2026-08-26  
**Statut :** PROBE PROTOCOL VALIDATED — ready for disposable execution  
**Cible :** futur dépôt applicatif privé séparé de `projetV0-infra`  
**Licence :** AGPL-3.0-only

Amendement applicatif adopté le 10 septembre 2026 :
`../superpowers/specs/2026-09-10-auth-preparation.md` §§3–4 précise les e-mails
auth avant User/Workspace et le pilote de délégation. Les remplacements
ci-dessous en §§6.3,8.5,9.1,9.2 sont normatifs pour l'application ; les probes
et leurs preuves historiques ne sont pas modifiés ni requalifiés.

## 1. But, portée et règle de livraison

Cette boilerplate doit permettre de démarrer un SaaS B2B, B2C ou hybride sans
réinventer l’identité, l’isolation tenant, les plans, les sièges, les unités
d’usage, les transactions, les effets asynchrones et les frontières de
sécurité. Elle fournit du code commun, jamais un runtime IAM ou billing partagé
entre produits.

Un nouveau SaaS possède son propre dépôt, sa base, ses utilisateurs, ses
sessions, ses workspaces, ses intégrations et son domaine de panne. Le dépôt
commun sert de point de départ maintenu; il n’introduit aucun service central
requis par tous les produits.

La livraison n’accepte pas les capacités à moitié activées :

- une capacité du noyau est complète et vérifiée avant d’être déclarée prête;
- une capacité optionnelle est absente du composition root et fail-closed tant
  que ses gates nommées ne passent pas;
- aucun `TODO`, faux adapter, route placeholder ou abstraction générique ne
  simule une prise en charge future;
- un résultat de probe est une preuve version-pinnée, pas une déclaration de
  préparation à la production.

## 2. Hors portée

Le design ne modifie ni ne redéfinit :

- CI/CD, GitHub Actions, Renovate, Trivy, gitleaks ou provenance OCI;
- Docker/Dokploy, Tailscale, CrowdSec, réseau, firewall ou secrets host;
- déploiement PostgreSQL/TimescaleDB/pgvector, Redis, Hatchet, RabbitMQ, R2,
  collecteur OTel, Grafana/Loki/Tempo ou Alertmanager;
- sauvegardes, restauration, monitoring host ou routage d’alertes;
- la cellule vocale Pipecat/Telnyx, conçue séparément;
- une plateforme IAM centrale, un support capable de contourner la MFA, un
  moteur de policy générique ou une plateforme d’intégration universelle.

L’application définit seulement les contrats qu’elle consomme ou les signaux
qu’elle émet vers l’infrastructure existante.

## 3. Topologie produit et modes

### 3.1 Unité de déploiement

Un SaaS correspond à :

```text
un dépôt privé
→ un package pnpm et un lockfile
→ une image
→ deux composition roots web/worker
→ une base et une unité de release
```

Le web et le worker partagent initialement le même package et la même image. Il
n’existe ni monorepo préventif, ni package partagé runtime entre SaaS, ni base
multi-produit.

### 3.2 Identité locale à chaque SaaS

Chaque SaaS déploie sa propre instance Better Auth et possède localement :

- `User`, comptes externes, sessions et facteurs;
- workspaces, organisations, memberships et invitations;
- entitlements, plans, sièges, usage et historique commercial;
- configuration manuelle des IdP entreprise lorsque le SSO est activé.

Il n’existe aucune session, adresse e-mail, membership, facturation ou
révocation implicitement partagée entre produits. Une identité fédérée est
toujours `(issuer, subject)`, jamais l’e-mail.

Le candidat Better Auth 1.7.4 encode cette identité dans la clé physique
`(providerId, accountId)` : `google` désigne exclusivement
`https://accounts.google.com`, et `accountId` conserve le sujet textuel exact.
La session conserve `{issuer, subject}`. La table account impose actuellement
`provider_id='google'` ; le premier vrai producteur supplémentaire fera évoluer
cette restriction et résoudra les alias de même issuer, sans liste statique
grandissante ni migration par client SSO. Aucun namespace n'est réaffecté.

Avec Better Auth 1.7.4, `account.accountLinking.disableImplicitLinking=true`
est obligatoire. Une identité externe nouvelle n’est liée à un User existant
que par une commande explicite depuis sa session authentifiée, avec step-up UV;
aucun callback ne fusionne deux Users par égalité d’e-mail.

Chaque SaaS dérivé enregistre la baseline exacte de la boilerplate et les
amendements communs sécurité/schéma qu’il a adoptés. Un amendement déclare son
applicabilité et sa migration code/données. Cette lignée est une provenance
source uniquement : aucun package runtime, autorité ou disponibilité centrale
n’en découle.

La référence est portable et machine-readable : baseline immuable
`{id, sourceCommit, sourceDigest}` puis amendements `{id, status:
adopted|not-applicable, reason, codeMigration, dataMigration, supersedes}`.
Un chemin local, une session Codex/Oracle ou une URL de conversation ne suffit
jamais comme provenance d’un SaaS dérivé.

### 3.3 Profil de dérivation immuable

```text
selfSignupPolicy        = open | invite-only
workspaceKinds          = { personal, organization } non vide
organizationCreation    = self-service | operator-only
commercialCapabilities  = { plans, stripe, usage, seats }
publicSurface           = none | marketing
pwa                     = absent | public-shell
```

- l’auto-inscription n’implique pas automatiquement un Workspace personnel;
- `seats` exige `organization`;
- seules les capacités sélectionnées et leurs dépendances transitives sont
  montées et soumises à leurs gates;
- une capacité absente ne crée ni route, table, commande, menu, worker, cache ou
  service worker;
- le profil n’est pas un feature-framework runtime : il produit le composition
  root et devient ensuite une décision versionnée du SaaS.

Ce choix est le défaut produit, pas une identité. Lorsqu’un même produit active
un SSO entreprise en restant ouvert au B2C, une règle managed-domain peut router
ou refuser l’admission du domaine vérifié. E-mail/domaine ne devient jamais la
clé du compte. Les comptes préexistants ne sont ni convertis ni fusionnés
silencieusement : ils suivent une décision explicite de linking, maintien
indépendant ou migration opérateur.

Les autres différences produit sont exprimées par un catalogue de plans,
features, limites et `meterKey`, pas par des forks du modèle d’autorité.

## 4. Matrice de capacités

| Capacité | État initial | Contrat |
|---|---|---|
| Google OIDC, magic link, passkey | noyau | activées selon configuration produit |
| E-mails transactionnels Plunk | noyau provider | uniquement depuis worker/outbox |
| Mot de passe et reset password | absent | aucune route ne permet d’en définir un |
| TOTP | option de composition | absent si non configuré; politique complète si activé |
| Workspaces personal/organization selon profil | noyau dérivé | seules les kinds sélectionnées sont matérialisées; lifecycle et isolation restent communs |
| Plans, Stripe, usage, sièges | slices commerciales | montées seulement par le profil qui les consomme |
| SSO entreprise | désactivé | activation OIDC/SAML séparée, opérée manuellement |
| Provisioning JIT SSO | désactivé | `organizationProvisioning.disabled=true` |
| `/api/v1` externe | absent | créé seulement pour un consommateur réel |
| FileAsset/R2 | slice non montée | activation live R2 + antivirus obligatoire |
| PostHog, Sentry tracing, OpenInference, Formbricks | désactivés | chaque intégration possède sa propre preuve capture/transport |
| Storybook classique | option locale | stories vérifiées; aucun runtime requis en production |
| PWA | slice optionnelle | shell public seulement; aucune donnée privée en cache |

## 5. Autorité, tenancy et Better Auth

### 5.1 Frontières d’autorité

Better Auth possède les primitives cryptographiques et d’identité : comptes,
sessions, passkeys/MFA, organisations, memberships, invitations et SSO.

Le domaine applicatif possède :

- `Workspace`, seule unité d’autorisation, entitlement et facturation;
- ressources métier, permissions, quotas et usage;
- audit durable et commandes/outbox;
- aucune gestion cryptographique directe des sessions.

`activeOrganizationId` est une préférence d’interface, jamais une autorité.

### 5.2 Workspace

```text
Workspace
  kind      = personal | organization
  lifecycle = provisioning | active | deleting
```

Contraintes :

```text
personal + active/deleting:
  ownerUserId NOT NULL
  authOrganizationId NULL

organization + provisioning:
  ownerUserId NULL
  authOrganizationId NULL

organization + active/deleting:
  ownerUserId NULL
  authOrganizationId NOT NULL
```

- un seul Workspace personnel par utilisateur;
- `ownerUserId` référence `User.id` avec `ON DELETE RESTRICT`;
- `authOrganizationId` est unique et `ON DELETE RESTRICT`;
- seules les lignes `active` sont visibles et autorisables;
- toutes les relations métier utilisent des FK composites tenantées;
- les tables applicatives tenant-aware activent et forcent RLS;
- les tables Better Auth restent hors RLS tenant applicatif.

Les rôles DB runtime web/worker sont non-owners des tables tenant,
`NOINHERIT`, `NOSUPERUSER`, `NOBYPASSRLS`, `NOCREATEROLE`, `NOCREATEDB` et
`NOREPLICATION`; le rôle migration/ownership est distinct.
L’absence ou l’invalidité de `app.tenant_id` échoue fermé. Le provisioning de
ces rôles reste une responsabilité infrastructure, pas applicative.

Le graphe transitif `pg_auth_members`, y compris `set_option` et
`inherit_option`, ne leur donne aucun chemin vers owner, migration, definer,
rôle prédéfini large, superuser ou `BYPASSRLS`. Ils ne possèdent ni
`TRUNCATE`, `REFERENCES`, `TRIGGER`, création schema/DB/extension, modification
de policy/owner/DDL, ni capacité de désactiver un trigger ou d’escalader un
rôle. Les privilèges `PUBLIC`/par défaut incompatibles sont révoqués. Le gate
inspecte `pg_default_acl` de chaque owner/migrator puis crée table, séquence et
fonction canary : les futurs objets ne peuvent réintroduire un grant implicite.

RLS protège contre l’oubli ou l’erreur de prédicat applicatif; il ne prétend pas
contenir une exécution SQL arbitraire sous le même rôle runtime, qui peut fixer
un custom GUC. Cette limite est explicite. Les FK/UNIQUE/PK peuvent contourner
RLS pour leur contrôle d’intégrité : les opérations cross-tenant existantes,
inexistantes et malformées ont donc une réponse publique équivalente, sans
SQLSTATE, contrainte, relation, ID, valeur ni différence métier divulguée.

### 5.3 Lifecycle organisationnel

Création :

1. persister un intent et un Workspace `provisioning` idempotents;
2. créer l’organisation Better Auth et son owner via le port serveur;
3. enregistrer l’`organizationId` comme checkpoint durable;
4. relire organisation, unicité de membership et owner;
5. transition atomique `provisioning → active`.

Avant le checkpoint, un slug technique immuable dérivé de `Workspace.id` permet
la reprise. Après checkpoint, seule l’ID est utilisée. Une organisation Better
Auth orpheline est tolérée uniquement comme artefact invisible d’un intent non
terminal, puis reprise ou purgée.

Les intents survivent indépendamment aux cascades tenant/Workspace et retiennent
`workspaceId`, slug déterministe, checkpoint `authOrganizationId` et état de
l’opération jusqu’à confirmation que les états application et Better Auth sont
tous deux terminaux.

Suppression :

1. intent durable et transition `active → deleting`;
2. invisibilité immédiate et refus de nouvelles écritures;
3. suppression tenant et Workspace dans la transaction prévue;
4. suppression idempotente de l’organisation Better Auth;
5. reprise depuis l’intent après crash.

`RESTRICT` empêche une suppression Better Auth directe de cascader sur les
données tenant.

### 5.4 Memberships, rôles et owner

Aucune table applicative ne duplique les memberships Better Auth.

```text
member.role:
  owner | admin | billing_admin | member

invitation.role:
  admin | billing_admin | member
```

- un seul rôle; tableaux, virgules et chaînes vides sont rejetés avant écriture
  et par `CHECK` SQL;
- `creatorRole: "owner"` est explicite;
- `billing_admin` est statique;
- Teams et dynamic access control sont désactivés;
- l’ownership n’est jamais attribué par invitation : une commande distincte,
  step-up, sérialisée et auditée effectue promotion ou transfert.

La migration ajoute `UNIQUE(member.organizationId, member.userId)`.

À COMMIT, tout Workspace organisationnel `active` ou `deleting` référence une
organisation ayant au moins un `member.role = owner`. Deux gardes SQL ferment
la concurrence indépendamment du writer :

- constraint trigger différé sur `member` pour protéger le dernier owner;
- garde différée de `Workspace provisioning → active` pour vérifier
  organisation, unicité et owner.

Chaque garde acquiert d’abord le même verrou transactionnel sur la ligne
Workspace autorité, selon l’ordre global, puis relit les owners. Le caractère
différé du trigger n’est jamais considéré à lui seul comme une sérialisation.

### 5.5 Frontière HTTP Better Auth

Avant `auth.handler`, un manifeste version-pinné `(méthode, chemin canonique)`
applique default-deny. Seuls les callbacks protocolaires et cérémonies
explicitement approuvées sont exposés. Toute route nouvelle ou non classée fait
échouer la build.

Linking/unlinking, enrôlement/suppression de facteurs, enable/disable TOTP,
backup codes, trusted-device, changement d’e-mail, suppression User et mutations
Organization ne sont jamais accessibles directement par HTTP. Leurs seuls
appelants sont des commandes server-only nommées qui consomment la preuve UV ou
recovery exigée.

Le namespace dérivé du `basePath` Better Auth est bloqué par segment canonique
avant `auth.handler` :

```text
{basePath}/organization
{basePath}/organization/*
→ 400 ou 404 selon la couche
→ auth.handler jamais atteint
```

Toutes les méthodes et variantes `%2F`, `%5C`, double encodage, `..`, doubles
slashs et caractères de contrôle sont testées. Les capacités Organization sont
appelées uniquement in-process par les commandes applicatives.

Un seul port Organization server-only peut importer ou invoquer les mutations
organization/member/invitation et l’adapter brut. Les autres imports et tout
second mount de `auth.handler` sont interdits statiquement.

Les futurs callbacks OIDC, ACS, metadata SP et SLO protocolaire peuvent être
publics selon la version retenue; l’initiation utilisateur du logout exige une
session; la gestion des providers est opérateur-only; aucun `/sso/*` global
n’est ouvert.

L’activation SSO pinne la version exacte et conserve le modèle d’identité :
linking implicite e-mail/domaine désactivé, résolution par provider/issuer et
subject, provisioning membership interdit hors contrat applicatif. Activation,
rotation/remplacement, désactivation et rollback du provider sont des
transitions explicites; JIT reste désactivé jusqu’à son propre contrat.

### 5.6 Autorisation transactionnelle

Une mutation métier :

```text
BEGIN
  verrouiller Workspace active
  lire/verrouiller la membership courante
  dériver la permission
  autoriser objet et propriétés
  relire entitlement
  réserver quota
  mutation
  audit succès obligatoire
  outbox éventuelle
COMMIT
```

Une révocation concurrente ne peut pas transformer une membership obsolète en
autorisation. Une ressource cross-tenant est indistinguable d’une ressource
inexistante lorsque la non-divulgation est requise.

Les mutations commerciales sensibles à recovery utilisent l’ordre global
`User → Workspace → Agreements triés → SeatAssignments triées`; elles relisent
`recovering`, `recoveryGeneration` et `holdUntil` avant création d’outbox ou
effet provider. Les commandes owner restent mono-Workspace; aucun batch
cross-Workspace n’est offert par la boilerplate.

## 6. Authentification, sessions, MFA et récupération

### 6.1 Méthodes

- Google OIDC par `(issuer, subject)`;
- magic link;
- passkey avec vérification utilisateur requise;
- `account.accountLinking.disableImplicitLinking=true`;
- linking explicite seulement par commande avec session et step-up UV frais;
- initiations Google/magic link via server functions applicatives;
- seuls les callbacks protocolaires nécessaires restent publics.

### 6.2 Sessions et step-up

États serveur :

```text
ACTIVE
MFA_PENDING
RECOVERY_RESTRICTED
```

La session Better Auth est opaque, révocable, stockée dans PostgreSQL, avec
expiration absolue de sept jours et sans prolongation glissante. La
configuration fixe `expiresIn=604800`, `disableSessionRefresh=true` et
`cookieCache.enabled=false`. Un timeout d’inactivité serveur de douze heures est
la baseline; chaque SaaS peut le réduire, et toute hausse exige une décision de
risque explicite. L’utilisateur peut voir et révoquer ses sessions après
réauthentification.

Le cookie est host-only, `Secure`, `HttpOnly`, `SameSite=Lax` ou plus strict,
`Path=/`, sans `Domain`. Le préfixe exact observé (`__Host-` ou `__Secure-`) est
figé seulement après probe du `Set-Cookie` 1.7.1; la portée host-only ne dépend
pas de son nom.

Les champs `authMethod`, `authenticatedAt`, `authState` et
`providerIdentity` sont server-only.

Tout endpoint privé refuse `MFA_PENDING` et `RECOVERY_RESTRICTED` avant toute
lecture tenant, sauf endpoint explicitement limité à la cérémonie MFA/recovery.

Une action sensible consomme atomiquement avec la mutation un grant à usage
unique :

```text
session + user + purpose + Workspace + cible
durée maximale 5 minutes
```

### 6.3 Magic link

- le GET consommant `/magic-link/verify` de Better Auth 1.7.1 n’est pas exposé
  comme route de login applicative;
- l’application possède un token purpose-bound CSPRNG, stocké one-way, dix
  minutes et usage unique;
- seul le dernier token par `(email normalisé, purpose)` reste valide via
  génération/CAS durable;
- l’e-mail place le secret uniquement dans le fragment; GET
  `/auth/magic/confirm` est non mutant, `no-store`, sans tiers ni session, ne
  reçoit donc jamais le secret dans sa request target, puis la page efface
  immédiatement le fragment de l’historique;
- POST `/auth/magic/consume` transporte le secret dans le body, le consomme
  atomiquement puis appelle `SessionAdmission`;
- cross-device, mais n’accorde jamais de step-up;
- page sans tiers, `Referrer-Policy: no-referrer`;
- token et URL complète absents des logs et télémétries.

Précision adoptée pour la première inscription par e-mail (13 septembre2026) :
la première confirmation d'une commande pré-User vérifie le token et l'adresse
que l'utilisateur saisit explicitement, puis démarre l'enrôlement passkey natif
pré-authentification. Elle ne crée pas encore de User, ne consomme pas le token
et n'émet aucune session. Le POST final exige de nouveau le token original,
la continuité du challenge natif et le résultat WebAuthn avec UV vérifié.
Création native du User, première passkey, consommation/purge de la preuve et
émission native de session réussissent dans la même transaction physique.
Aucun cookie n'est publié avant commit et fin réussie de l'invocation.
L'enrôlement expire au plus tôt avec le lien initial ou le challenge natif,
borné à cinq minutes ; aucune transaction n'est conservée pendant la cérémonie.
Il n'y a ni quatrième état de session ni MFA_PENDING détourné en état d'inscription.

Le User nouveau reçoit l'e-mail canonique prouvé comme e-mail et libellé initial
de nom, avec emailVerified vrai ; ce libellé n'est pas une identité civile.
Une commande pré-User n'est jamais réaffectée à un compte apparu après la demande :
elle est refusée et une demande fraîche est nécessaire. Une commande déjà liée
ne peut authentifier que son User et sa génération capturés. Aucun compte OAuth
n'est créé ou fusionné par égalité d'e-mail. Le candidat actuel conserve son
auto-inscription ouverte ; la future dérivation invite-only doit contraindre
tous les chemins de première inscription, Google compris, sans feature-framework.

Le premier signup e-mail exige donc la passkey avant ACTIVE ; les connexions
magic suivantes restent disponibles. La première session conserve
authMethod=magic-link et n'accorde pas de step-up ; une assertion ultérieure de
la clé liée fournit l'autorité passkey pour les opérations sensibles.
Une session native d'un autre compte n'est jamais remplacée silencieusement.
Le token est capturé puis retiré du fragment avant l'initialisation du routeur,
pas dans un effet après hydratation ; il reste uniquement en mémoire jusqu'aux
POST délibérés. L'adresse saisie confirme l'intention, elle ne sélectionne pas
l'identité et n'est pas une preuve supplémentaire. La recette magic compilée
locale utilise HTTPS avec confiance TLS contrôlée, comme le profil de production.

Les e-mails auth suivent le contrat durable :

- `emailVerification.sendOnSignUp=false`;
- toute obligation d'e-mail requise par un signup est persistée dans la même
  transaction physique que le fait signup causal, avant le commit;
- `AuthEmailRequest` porte l'autorité pré-User de demande et de génération,
  unique par e-mail normalisé/purpose ; une commande immuable est unique par
  `(requestId,generation)` et fixe destinataire, locale, expiration et identité;
- après commit, le flux officiel matérialise idempotemment `EmailDelivery` et
  son outbox auth à partir de cette obligation ; leur paire est atomique et
  participe à toute transaction auth déjà active;
- le worker seul appelle Plunk;
- un réconciliateur répare une obligation explicitement autorisée, committée et
  non satisfaite ; un User non vérifié ne suffit pas à déclencher des renvois;
- aucun callback Better Auth n’effectue réseau, filesystem ou queue, et aucun
  hook différé n’est considéré durable.

Le vérificateur magic reste one-way. Une enveloppe de livraison séparée,
AES-256-GCM via Node, est autorisée dans `EmailDelivery`, jamais dans l'outbox :
clé dédiée 32 octets, nonce aléatoire neuf 12 octets, tag 16 octets explicitement
vérifié aussi au déchiffrement, `keyId` et AAD liés à livraison/purpose/génération/
expiration. Le même échantillon CSPRNG alimente atomiquement le vérificateur et
le payload chiffré. Une reprise réutilise ce payload ; elle ne remplace pas le
token. Les liens et enveloppes concernés expirent au plus après 10 minutes,
sans changer la durée des sessions. Seul le worker auth déchiffre, après
contrôle d'état/génération/expiry ; aucune utilisation du plaintext ne précède
l'authentification du tag.

Purge du matériau chiffré dès terminalité/expiration, maintien de l'identité et
de l'état non secrets nécessaires au refus des jobs tardifs ; rotation par
keyId avec déchiffrement des anciennes enveloppes encore admissibles seulement.
Un restore ne réactive jamais une enveloppe expirée. Aucun effacement des
sauvegardes n'est revendiqué. Pour les purposes User/recovery, génération de
demande et `User.recoveryGeneration` sont vérifiées ensemble, sans substitution.
Le contrat complet d'accès, purge et rotation est celui de l'amendement adopté.

La garantie est convergence après commit et absence de ghost e-mail, pas une
fausse transaction distribuée `User + Plunk`.

### 6.4 Passkey et TOTP

La passkey exige `userVerification: required` et un résultat serveur avec bit
signé `UV=1`; challenge, origin, RP ID et signature sont vérifiés.

Better Auth 1.7.1 passant `requireUserVerification:false` à SimpleWebAuthn, le
hook serveur version-pinné inspecte le résultat cryptographiquement vérifié et
refuse `userVerified !== true` avant enregistrement de confiance, session
`ACTIVE` ou grant step-up. Le label `authMethod=passkey` ne prouve jamais UV.

Amendement Task9B adopté le 14 septembre : pour la réauthentification par une
clé existante précédant l'ajout d'une passkey supplémentaire, l'application
utilise le vérificateur public SimpleWebAuthn serveur 13.3.3, et non le hook
d'authentification Better Auth. Une vérification normale doit prouver signature,
challenge, origin, RP ID, type d'assertion, présence et UV avec la clé persistée
verrouillée ; le compteur et l'autorisation dédiée sont ensuite persistés
atomiquement sous le propriétaire de transaction existant. Cette action ne
crée, ne remplace ni ne révoque de session. Better Auth reste le seul
propriétaire des tokens de session. L'enregistrement supplémentaire conserve le
hook natif de vérification et l'appel API complet sous transaction externe.

Ce parcours utilise une seule intention dédiée, dont l'identifiant est aussi
la cible de l'unique insertion autorisée. Elle lie utilisateur, session courante,
espace personnel existant et génération de récupération ; ses états sont
`CHALLENGE`, `AUTHORIZED`, `CONSUMED`. Son échéance est fixée à l'émission du
challenge serveur, au plus cinq minutes et jamais au-delà de l'échéance effective
de la session. Elle n'est pas renouvelée après réauthentification. Les trois
commandes débutent la preuve, autorisent en générant les options natives
d'enregistrement, puis terminent l'insertion. La clé ayant autorisé l'action
doit rester présente avec la même identité et clé publique ; l'avancement normal
de son compteur ou un changement de libellé n'invalide pas l'autorisation.
La consommation et l'insertion native partagent la transaction, avec corrélation
de l'identifiant natif de vérification, contexte serveur et UV de la nouvelle
clé. La nouvelle clé ne s'autorise jamais elle-même. Chaque commande revalide
session, espace et protections de récupération, dont `holdUntil`.

La passkey UV est requise avant les opérations owner/security, transfert d’ownership,
facteurs, linking/unlinking owner, e-mail sensible et configuration SSO.

La première passkey n’est jamais autorisée par le seul cookie `ACTIVE` ni par la
passkey qu’elle est en train de créer. Elle est liée pendant l’enrôlement initial
avant `ACTIVE`, par une réauthentification fraîche d’un provider déjà lié et la
session d’origine, ou par le recovery à deux preuves.

Précision Task9C adoptée le 14 septembre : pour un compte déjà lié à Google,
seul un événement réel d'authentification Google âgé de moins de 300 secondes
au contrôle transactionnel final peut autoriser la première clé, avec la session
applicative d'origine inchangée. L'événement peut précéder le début de la demande,
mais sa preuve doit provenir du nouvel échange lié au state/PKCE/nonce de cette
demande. L'échéance non renouvelable est le minimum entre l'instant de création
de l'intention majoré de 300 secondes, `auth_time` accepté majoré de 300 secondes
et expiration de l'ID token ;
les limites effectives de la session et le challenge natif restent contrôlés.
Le champ `auth_time` doit être un entier sûr positif ou nul, non futur, cohérent
avec `iat` ; `iat` futur est refusé pour cette action sensible uniquement.
Une preuve absente, invalide ou trop ancienne n'accorde aucune autorité.

La disponibilité de cette voie est conditionnelle : Google documente le retour
optionnel de `auth_time` pour une application éligible/configurée, mais pas une
réauthentification du compte à la demande. Ni consentement, sélection de compte,
date d'émission du token, ni âge de session Better Auth ne remplacent cette preuve.
L'interface l'explique sans promettre de forcer une nouvelle authentification.
Une intention dédiée lie User, session d'origine, génération, espace personnel
existant, compte Google déjà lié et emplacement de première clé. Le callback
applicatif explicite compose les primitives OAuth publiques uniquement pour
vérifier la preuve ; il ne crée/modifie ni Account, ni User, ni session. L'insertion
reste native, avec UV vérifié, `createSession:false` et consommation atomique
sous le propriétaire transactionnel existant. La recette Google réelle et son
URI de retour autorisée sont des gates distinctes ; les tests locaux ne les
remplacent pas et cette précision n'autorise aucun changement du projet Google.

Lorsque TOTP est activé :

- Google et magic link ne peuvent produire qu’un challenge/session
  non-autorisante `MFA_PENDING` jusqu’à TOTP;
- aucune ressource applicative n’est accessible avant vérification;
- une passkey UV satisfait directement la politique;
- `trustDevice` est refusé;
- les backup codes et trusted-device Better Auth sont inaccessibles et ne sont
  jamais une autorité projetV0;
- une nouvelle session `ACTIVE` remplace la pending après TOTP;
- TOTP n’est pas présenté comme phishing-resistant.

Better Auth 1.7.1 valide la cryptographie TOTP mais ne persiste pas le timestep
déjà accepté. Après succès Better Auth, projetV0 consomme donc atomiquement un
HMAC serveur court de `(factorId,userId,code)` dans PostgreSQL partagé pendant
toute la fenêtre tolérée, avant toute émission `ACTIVE`. Deux challenges frais,
y compris depuis deux processus/restarts concurrents, ne peuvent produire qu’un
seul succès. Un crash après consommation peut brûler le code et déconnecter,
jamais restaurer son replay. Aucun secret/code brut n’est persisté ou journalisé;
cette seam est une protection de replay, pas un second vérificateur TOTP.

### 6.5 SessionAdmission et émission de session

Better Auth reste l’unique créateur, validateur et révocateur des tokens. Une
seam confinée, version-pinnée et commune à toutes les méthodes détermine le seul
état applicatif autorisable :

```text
SessionAdmission
  passkey UV=1                         → ACTIVE
  Google/magic sans TOTP               → ACTIVE
  Google/magic avec TOTP               → MFA_PENDING uniquement
  TOTP réussi et challenge consommé    → nouvelle ACTIVE
  recovery deux preuves                → RECOVERY_RESTRICTED

AuthSessionIssuer
  replacePendingWithActive
  revokeAllAndIssueRecoveryRestricted
  replaceAfterRecovery
```

Elle utilise un endpoint Better Auth strictement server-only et ne crée aucune
route HTTP. Le nouveau token est créé, l’ancien révoqué, puis le cookie posé;
une panne échoue au pire par déconnexion et ne promeut jamais l’ancien cookie.
Aucune méthode primaire ne contourne `SessionAdmission`.

Les nouveaux endpoints natifs magic/enrôlement sont appelés seulement depuis
la factory privée par auth.api, avec le Request original, asResponse=false et
returnHeaders=true. La transaction applicative englobe l'appel API complet,
ses hooks et la préparation des cookies ; les en-têtes restent retenus jusqu'au
commit et à la fin de l'invocation. Une exception strictement liée au Request,
à l'opération et à la même lease autorise cette transaction externe pour ces
endpoints nommés. Les gardes Google et les endpoints sans cette autorité restent
inchangés. L'émission n'accepte qu'une preuve validée dans cette lease, une fois.
Un échec après commit confirmé peut laisser un token consommé et une session
non publiée : pas de compensation ni de réémission automatique, nouvelle demande
de connexion. Les cookies portés par une erreur sont également éliminés.

Le linking OAuth utilise un `LinkIntent` one-shot, expirant, lié à
`sessionId`, `userId`, provider et purpose. Le callback exige la session
d’origine encore valide et consomme l’intent avec l’écriture
de l'identité logique `(issuer,subject)`, encodée actuellement par la clé native
`(providerId,accountId)`; un grant consommé seulement à l’initiation ne suffit pas.

Précision d'implémentation Task9D retenue après revue Pro le 21 septembre :
pour Google, les primitives OAuth publiques conservent state/PKCE/nonce et le
transport existant. Une API native privée distincte réalise la mutation
Account avec ses hooks, attendue intégralement sous le propriétaire physique
avant contrôle du résultat persisté et consommation de l'intention. Le callback
ne garde aucune connexion DB pendant l'échange fournisseur. La liaison crée
seulement la clé native User/provider/subject, sans nouveau stockage de tokens,
profil fournisseur, User ou session. Un subject libre peut être lié même si son
e-mail diffère du compte applicatif ou correspond à un autre User local : aucun
User n'est sélectionné, fusionné ou modifié par cet e-mail. Un subject déjà lié
à un autre User reste refusé sans divulgation.

La demande fixe `prompt=select_account` par l'interface publique du provider,
sans `login_hint` dérivé de l'e-mail, scopes supplémentaires ou consentement
forcé. Le template propose une connexion Google par User; sous verrou User,
la liaison exige l'emplacement vide. Plusieurs lignes préexistantes rendent
l'action indisponible, sans réparation implicite ni nouvelle unicité SQL.
La déliaison cible l'id natif exact et exige une nouvelle preuve UV de la
passkey survivante; elle fonctionne sans credentials Google. Elle ne révoque
ni le consentement Google ni les autres sessions, et n'interdit pas une future
inscription normale distincte : une connexion ultérieure ne doit simplement
plus authentifier le binding supprimé.

Chaque phase relit la session native d'origine sans cache ni rafraîchissement,
puis les conditions applicatives sous verrou; un autre cookie valide du même
User ne suffit pas. Les effets de refus du lecteur natif sont rollbackés et
leurs cookies non publiés. Une intention Google-only lie action/cible, session,
User, génération, espace personnel et clé autorisante; son échéance ne dépasse
jamais cinq minutes depuis le challenge ni celle de la session. LINK persiste
preuve/compteur et un unique state OAuth atomiquement, puis revendique
`EXCHANGING` avant un seul échange. UNLINK vérifie preuve/compteur et suppression
dans une seule transaction. Les reçus `CONSUMED` restent des faits historiques
lisibles pendant 24 heures depuis la création, sans FK en cascade vers Account,
indépendamment d'une liaison/déliaison ultérieure; l'état courant est lu à part.
Cette précision est un contrat à qualifier, pas une recette exécutée.

### 6.6 Récupération fail-closed

Les codes de récupération sont CSPRNG ≥ 128 bits, affichés une fois, stockés
one-way avec format/version de clé et pepper possible, consommés atomiquement
et régénérés par lot invalidant.

Sans passkey survivante, une récupération privilégiée exige :

```text
code de récupération
AND
(magic link vers l’e-mail déjà enregistré ou authentificateur encore lié)
```

Le flux révoque toutes les sessions, crée `RECOVERY_RESTRICTED`, enrôle et teste
une nouvelle passkey, renouvelle les codes, puis émet une session normale. Les
opérations ownership, linking, e-mail et billing restent interdites pendant
24 heures et les anciens canaux sont notifiés.

Précision utilisateur adoptée le 26 septembre : à la réussite de la récupération,
toutes les anciennes passkeys sont retirées ; seule la nouvelle passkey enrôlée
et effectivement testée est conservée. Ce retrait appartient à la transition
finale atomique, par les opérations natives confinées, avant l'émission normale ;
un abandon ne vaut pas réussite et ne déclenche pas ce retrait. La liaison Google
n'est pas déliée implicitement par cette politique.

Un état User durable `recovering`, `recoveryGeneration` et `holdUntil` est relu
par `SessionAdmission`. Pendant recovery, aucune méthode primaire n’émet
`ACTIVE`; la fin révoque toutes les générations antérieures avant d’émettre la
seule génération courante. `holdUntil` est vérifié par chaque commande sensible,
pas seulement par le cookie recovery. Le registre fermé des commandes
restreintes couvre owner/ownership, facteurs et codes, linking/unlinking,
e-mail, SSO, billing/refund et autorité commerciale; l’application dérive ses
tests de ce registre réel.

Toute émission de session et toute transition recovery verrouillent la même
ligne User et revalident `recoveryGeneration` par CAS. Chaque session autorisable
porte sa génération; toute requête refuse une génération différente de celle du
User ou un User `recovering`. Le début recovery incrémente la génération avant
révocation; la fin émet la seule génération courante sous le même verrou.

Le support ne crée pas de session, ne modifie pas `emailVerified`, ne supprime
pas la MFA et ne fusionne pas les comptes. La perte simultanée de tous les
facteurs, codes et canaux rend le compte personnel irrécupérable. En B2B, un
autre owner peut révoquer la membership et inviter une nouvelle identité sans
fusion.

### 6.7 UX auth

- réponses anti-enumération identiques;
- écran e-mail unique, bouton Google officiel, passkey et alternatives visibles;
- TOTP collable avec `autocomplete="one-time-code"`;
- FR/EN, mobile 320 px, clavier, focus et annonces d’erreur;
- WCAG 2.2 A sur les parcours critiques, plus les critères AA explicitement
  retenus : contraste, focus visible, reflow/zoom, input purpose et Accessible
  Authentication sur les parcours concernés;
- aucune donnée auth/privée dans le cache PWA;
- rate limit partagé Redis, jamais mémoire locale seulement.

## 7. Plans, sièges, usage et Stripe

### 7.1 Autorités

- Workspace : unité unique de facturation, entitlement, sièges et usage;
- Stripe : Customer, Prices, factures, paiements, taxes, refunds, disputes;
- domaine local : plan effectif, features, limites, sièges et unités;
- SDK Stripe officiel directement;
- Better Auth Stripe, Stripe Entitlements, Billing Credits et preview exclus.

### 7.2 Catalogue et accord

```text
Plan
PlanVersion
PlanFeature
PlanLimit
PlanUsageAllowance
PlanPrice
BillingCustomer
BillingAgreement
```

Une `PlanVersion` publiée est immuable : type PERSONAL/ORGANIZATION, cadence,
features, limites, allocations par `meterKey`, grâce, sièges, références Stripe
par environnement et policy d’épuisement `HARD_STOP|ALLOW_PREPAID_TOPUP`.

`Workspace.currentAgreementId` est l’unique pointeur de l’Agreement courant;
il est déplacé atomiquement sous `Workspace FOR UPDATE`. Les Agreements
historiques restent immuables.
L’accord projette `FREE|TRIAL|PAID|GRACE|PAUSED|CANCELED`, dates, références
Stripe et `licensedSeats`. Un statut Stripe `active` seul n’accorde aucun droit.

### 7.3 Pools typés

Les unités sont non fongibles par `meterKey`. Un produit voulant un solde
générique définit simplement `meterKey="tokens"`.

```text
UsageAccount
UsageLot
UsageOperation
UsageAllocation
```

`UsageAccount` possède `PRIMARY KEY(workspaceId,meterKey)` et est le mutex
universel de son meter. Les lots satisfont :

```text
granted >= 0
available, reserved, consumed, held, expired, revoked >= 0
granted = available + reserved + consumed + held + expired + revoked
```

Les opérations sont idempotentes : `RESERVED → COMMITTED|RELEASED|EXPIRED`.
`UsageOperation` porte une identité logique unique. Les allocations suivent
FEFO par `(expiresAt NULLS LAST, grantedAt, id)`, sans `SKIP LOCKED`;
non-négativité et conservation sont des `CHECK` SQL.

Le montant d’une opération égale la somme de ses allocations; une seule
transition terminale est admise. Ces invariants inter-lignes sont fermés dans
la même transaction sous le mutex, avec contraintes/procédures nommées plutôt
qu’un ledger générique.

- inclus mensuels : aucun rollover;
- annuel : grant mensuel unique par
  `(agreementId,planVersionId,meterKey,grantPeriodStart)` et couvert par
  l’intervalle payé réconcilié;
- top-up : unités produit prépayées, non monétaires après émission,
  non transférables, expiration affichée; l’achat reste un fait Stripe;
- upgrade payé : Stripe calcule la monnaie/proration; l’ancien entitlement
  subsiste jusqu’au fait invoice/payment exact réconcilié;
- downgrade : échéance suivante, aucun clawback;
- futurs grants apurent d’abord la dette confirmée.

### 7.4 Sièges et acceptation d’invitation

`SeatAssignment` porte `PENDING|ACTIVE|RELEASED`, `operationId`, invitation,
Workspace, Agreement source, membership nullable, version, lease, dates et
motif terminal.

`operationId` est unique; une invitation possède au plus un assignment
`PENDING|ACTIVE`, et une membership au plus un assignment non libéré.

- PERSONAL : aucun siège commercial;
- owner et membre interactif d’une organisation occupent un siège;
- `billing_admin` sans accès produit n’en occupe pas;
- une invitation pending ne consomme rien avant la réservation TX A;
- membership et licence restent deux faits distincts.

Toute mutation Better Auth faisant passer un rôle sans siège vers
`member|admin|owner`, y compris transfert owner, utilise la même réservation/
finalisation que l’invitation. Toute opération produit `requiresSeat` exige une
membership valide **et** un `SeatAssignment ACTIVE`; absence de capacité refuse
l’accès et ne crée jamais un membre consommateur non licencié silencieux.

Préflight sans transaction Billing : session réelle, `emailVerified=true`,
invitation pending/non expirée, organisation/rôle/e-mail attendus, absence de
membership; l’intention persiste tous les identifiants attendus.

```text
TX A
  lock Workspace et Agreement courant
  retrouver/créer intention
  compter PENDING|ACTIVE
  créer SeatAssignment PENDING
COMMIT

appel Better Auth hors transaction

TX B
  Workspace FOR UPDATE
  Agreements source/destination FOR UPDATE triés par ID
  SeatAssignments FOR UPDATE triées par ID
  relire invitation, User et membership
  revalider par CAS id/workspace/source/state/version
  ACTIVE ou RELEASED
COMMIT
```

Un timeout, lease expiré, réponse perdue ou invitation `accepted` sans
membership ne prouve aucun rollback : le siège reste `PENDING +
NEEDS_RECONCILIATION`, n’accorde aucun accès, et projetV0 n’exécute aucun reset
spéculatif `accepted→pending` ni second appel automatique. Cette règle ne nie
pas la compensation interne Better Auth sur erreur certaine.

Un `PENDING` ne devient `RELEASED` automatiquement que si l’invitation est
`pending`, la membership absente et une preuve durable établit que l’exécution
et la transaction originales sont terminées sans possibilité de commit. Un
simple timeout, lease ou âge ne suffit jamais; sinon l’état reste incident/
reconciliation fail-closed.

Le réconciliateur sans session compare directement invitation, User et
membership à l’intention. Toute divergence reste fail-closed.

### 7.5 Remplacement, capacité et fallback

Tous les flux utilisent le même ordre de verrouillage global. Si l’Agreement a
changé, l’ancien pending est libéré et un nouvel `ACTIVE` est créé seulement
après capacité destination vérifiée. Un pending reste attaché à sa source et ne
consomme jamais le fallback.

Chaque produit possède une PlanVersion fallback interne : FREE réel ou plan
non vendable à zéro entitlement/siège. La fin effective crée l’Agreement
fallback courant, réévalue les actifs et libère les excédents selon owner,
`activatedAt`, ID. `cancel_at_period_end` n’a aucun effet avant échéance.

### 7.6 Stripe, refunds et disputes

Checkout n’accorde aucun droit. Les changements payants sont projetés seulement
après état monétaire confirmé. Inbox provider, commandes et business-effect
idempotency restent distincts.

La version API Stripe, la version d’événement webhook, le SDK officiel et
`billing_mode` sont des pins explicites; aucun défaut du compte n’est hérité
silencieusement. `stripe@22.5.0` utilise explicitement API
`2026-07-29.dahlia` et `maxNetworkRetries:0`: l’application est l’unique owner
du replay. Chaque commande mutante persiste API family/version, endpoint,
account scope, operation/effect ID, hash immuable de requête, idempotency key,
`firstAttemptAt`, `safeReplayUntil` et IDs/request IDs Stripe.

Le replay v1 utilise une marge conservatrice strictement inférieure aux 24 h
minimales documentées, un elapsed monotonic dans le processus et une hypothèse
d’horloge bornée. Un restart, recul ou doute d’horloge ne peut jamais étendre
l’autorisation; il la retire. La même clé/body/account n’est rejouée que dans
cet horizon prouvé. Un conflit concurrent sous la même clé ne prouve pas
l’échec du peer. Search vide, webhook absent ou timeout ne prouvent jamais la
non-exécution; une découverte positive est suivie d’un retrieve autoritatif.

L’observation immuable d’un attempt et sa classification de réconciliation sont
distinctes. Une tentative `unknown` reste un incident observable, peut être
résolue plus tard par preuve autoritative sans réécrire l’histoire, et
n’autorise aucun POST sous une nouvelle clé.

Un refund self-service exige un lot totalement inutilisé et le gèle avant la
commande Stripe. Une dispute gèle l’inutilisé et porte une dette produit
provisoire/confirmée, jamais une créance monétaire inventée.

Le webhook suit le contrat de la section 10 : corps brut borné, validation
provider avant parse, receipt unique et outbox requise atomiques, traitement
asynchrone et réconciliation contre l’autorité Stripe. `event.id` déduplique la
receipt mais pas l’effet métier : account, objet, Agreement/génération, période
et transition constituent l’identité module. Un fait historique ne déplace
jamais le pointeur courant et ne recrée jamais un grant; doublons sémantiques et
ordre arbitraire convergent après reread autoritatif.

Chaque famille create/upgrade/downgrade/cancel/refund/dispute possède sa table
fermée de paramètres et d’états Stripe concluants/pending/échec. Checkout
terminé mais impayé, SCA, invoice échouée/pending, refund pending/requires_action
et dispute non terminale ne sont jamais promus silencieusement en autorité
monétaire.

## 8. Architecture d’exécution

### 8.1 Structure verticale

```text
src/
  modules/<moduletypesc>/
    contract.ts
    model.ts
    use-cases.server.ts
    store.server.ts
    functions.ts
    index.ts
    index.server.ts
  platform/
  interfaces/http-api/
  routes/
  ui/
```

Pas de `BaseRepository`, couche controllers/services/repositories générique,
CQRS, event bus, DSL d’endpoint ou port sans appelant réel.

### 8.2 Baseline de compatibilité pinnée

Le fixture jetable du 2026-08-25 a vérifié cette baseline, sans prouver encore
le lock graph intégré ni la production :

```text
effect, @effect/opentelemetry, @effect/vitest = 4.0.0-rc.111
@effect/tsgo                              = 0.36.5
typescript                                = 7.0.2
drizzle-orm                               = 0.45.2
drizzle-kit                               = 0.31.10
pg                                        = 8.23.0
better-auth                               = 1.7.1
stripe                                    = 22.5.0
redis client                              = 6.2.1
```

Pins exacts, sans `^`, `~`, `@rc` ni automerge des RC. Chaque montée Effect RC
est une migration majeure et rejoue la matrice de compatibilité. Le lockfile est
l’autorité sur les sous-paquets TanStack; aucun alignement artificiel.

Le profil courant n’a aucun consommateur externe `/api/v1`; OpenAPI n’est donc
ni généré ni ajouté au graphe du probe intégré. Storybook/shadcn/MCP restent
également absents tant qu’aucune slice UI et aucun manifeste composants/props
réels n’existent. Leur absence évite une fausse preuve, elle ne diffère pas une
capacité sélectionnée.

Un seul résultat de typecheck est normatif pour le projet. Les diagnostics
Effect/tsgo supplémentaires ne peuvent pas constituer une seconde vérité : toute
divergence matérielle bloque le pin set jusqu’à résolution. Le choix de la
commande normative est fixé par le probe du lock graph réel. Aucun cast large
`as unknown as` ne peut transformer un défaut d’augmentation TanStack/TS7 en
succès.

### 8.3 Effect

Effect structure modèles/erreurs métier, use cases serveur, Context/Layers,
concurrence, interruption, retry ciblé et adaptateurs. React, DTO publics et
callbacks UI restent du TypeScript ordinaire.

Un seul ManagedRuntime par processus, construit et disposé par le lifecycle
owner. Aucun principal, requête ou transaction global.

Effect Schema est l’unique validation runtime applicative. Les DTO retournés
sont des objets encodés; aucun `Schema.Class`, Effect, Option, Exit, Cause ou
erreur interne ne traverse TanStack.

### 8.4 Frontière client/serveur

Le build échoue si Effect, Drizzle, `pg`, Better Auth, Stripe ou un module
`.server` est atteignable depuis un chunk client. Aucun barrel mixte entre
`*.functions.ts` et `*.server.ts`.

`createServerFn` est un RPC HTTP interne appelable indépendamment de l’UI;
chaque handler privé applique session, autorisation tenant/objet/propriété,
validation et budget. `createCsrfMiddleware()` protège les server functions une
fois au boundary; aucun framework CSRF par handler n’est recréé.

`/api/v1` n’existe que pour un consommateur externe réel. Les imports
`effect/unstable/*` sont confinés à `interfaces/http-api`, qui produit OpenAPI
3.1 et RFC 9457 sans règle métier ni accès DB propre. OpenAPI 3.2 n’est adopté
que lorsque le générateur Effect et les consommateurs pinnés le supportent et
que les snapshots/clients passent; la spec ne réécrit pas manuellement un 3.1
en 3.2.

### 8.5 Une seule pile PostgreSQL

```text
pg.Pool
→ PoolClient explicite
→ Drizzle 0.45.2 lié au client
→ application + façade Better Auth
```

Un seul pool par processus, Drizzle pour toutes les migrations, PgBouncer au
runtime et PostgreSQL direct pour les migrations. Aucun `@effect/sql`, second
pool ou Drizzle RC.

Deux façades transactionnelles minces seulement :

1. coordinateur Effect-native pour les use cases;
2. façade Promise-native réservée au `drizzleAdapter` Better Auth.

Elles partagent une seule state machine physique de possession du PoolClient.
Un PoolClient transactionnel est single-flight : le coordinateur possède une
file FIFO et sérialise les opérations SQL; il ne délègue jamais cette sémantique
à la queue interne `pg`. Le début de finalisation ferme atomiquement
l’admission, attend toutes les requêtes déjà admises dans l’ordre, invalide le
handle, puis exécute COMMIT/ROLLBACK; aucune requête n’est admise après cette
transition.

Le coordinateur exécute dans la fibre appelante, protège checkout/BEGIN/COMMIT/
ROLLBACK/release, attend finalisation avant interruption, invalide les stores,
et fait participer les appels imbriqués de même tenant/options sans savepoint ni
commit/rollback indépendant. Toute divergence tenant/timeout est refusée; un
état PostgreSQL aborted rend la transaction extérieure terminale.

`READ COMMITTED` est l’unique isolation business de la baseline et est assertée
immédiatement après BEGIN; RR/Serializable sont refusées avant tout SQL métier
tant qu’aucun retry de transaction complète n’est spécifié. RLS tenant-aware
exige une transaction. Deux scopes fermés existent : `auth-global` donne accès
aux tables Better Auth pré-tenant et, par exception explicite, aux seuls
`AuthEmailRequest`, `AuthEmailCommand`, `EmailDelivery` et outbox auth du module.
Ces enregistrements ne nécessitent pas de User/Workspace préalable et restent
auth-owned ensuite. `tenant` sert aux tables applicatives/opérations
organisationnelles et ne peut accéder aux enregistrements auth globaux ; les
gardes de store et permissions SQL le démontrent. Aucun accès applicatif
global générique n'est ajouté. Le premier SQL après BEGIN fixe en
`SET LOCAL` un UUID zéro fail-closed; `auth-global` conserve le sentinel et ne
peut obtenir aucun store tenant, tandis que `tenant` valide l’autorité puis le
remplace par `app.tenant_id`. Aucun handle n’existe avant cette séquence et un
scope imbriqué ne peut changer/élargir son mode.
`SET`, `RESET` et `set_config(...,false)` session-level sur `app.*` sont
interdits hors coordinateur et testés contre un backend PgBouncer empoisonné.
Le business `statement_timeout` positif est borné par deadline requête et
plafond de config. COMMIT/ROLLBACK/release sont non interruptibles par l’abort
requête et disposent d’un budget finalization/cleanup positif, court et séparé.

Après checkout, chaque sortie confirme le statut PostgreSQL idle avant release
normal. Erreur/ambiguïté BEGIN, COMMIT ou ROLLBACK, client non queryable, statut
inconnu ou non-idle après cleanup → eviction/destroy du PoolClient. Un outcome
métier `unknown` ne rend jamais la connexion réutilisable.

`committed` exige simultanément `CommandComplete=COMMIT`, statut transactionnel
`I`, aucune requête en vol et aucun signal ambigu de phase. Le probe coupe le
vrai flux TCP avant/après transmission COMMIT, `CommandComplete` et
`ReadyForQuery`; toute perte de preuve détruit le client et réconcilie la
commande immuable depuis une nouvelle connexion. Un COMMIT retournant
`CommandComplete=ROLLBACK` signifie `rolled-back`; idle seul ne prouve jamais le
commit.

Une erreur de finalisation expose seulement phase, outcome
`not-started|rolled-back|committed|unknown`, correlationId et causes redacted.
`committed|unknown` ne se rejoue jamais automatiquement.

Better Auth utilise `drizzleAdapter(authDbFacade,{transaction:true})`. Sont
interdits `transaction:false`, Drizzle 0.45.2 brut pour ses transactions, un
custom adapter complet et un patch global non backporté. Le handle tx devient
inutilisable avant COMMIT/ROLLBACK. La façade possède la root transaction via le
coordinateur PoolClient et construit Drizzle sur ce client; elle ne délègue
jamais à `drizzle(pool).transaction()`.

Le runtime atteste PostgreSQL `server_version_num=160015`, PgBouncer
`pool_mode=transaction`, rôles/RLS et paramètres de durabilité observés. Les
preuves locales ne revendiquent aucune réplication/HA non configurée. La policy
des prepared statements protocolaires est explicite; si activée, une migration
incompatible impose drain/reconnect/reprepare vérifiés.

### 8.6 Migrations et lifecycle

- migrations Drizzle générées, relues, commitées;
- fresh DB et compatibilité image N−1;
- expand/contract;
- une application avant activation, jamais au démarrage de chaque replica;
- un lifecycle owner ferme web/worker, ManagedRuntime, API scope, pool et
  télémétrie dans l’ordre prouvé;
- aucun `runPromise*` détaché ni fire-and-forget correctness-relevant.

### 8.7 Connaissance agents et UI

Ordre d’autorité : invariants projetV0, package/lock exacts, source/tests du tag,
docs officielles versionnées, ressources communautaires compilées contre pins.
Pas de subtree Effect par défaut; clone exact ignoré et read-only uniquement
pour une ambiguïté upstream.

shadcn est un générateur pinné soumis à dry-run, diff et audit de dépendances.
Fontes système par défaut, composants locaux et stories comme vérité. Storybook
classique est optionnel; son MCP reste absent jusqu’à preuve manifeste/props
complète sous TS7.

## 9. Effets asynchrones, Redis et fichiers

### 9.1 Outbox et commandes module

`async_outbox` est une primitive d’admission Hatchet seulement. Elle ne contient
ni payload métier, résultat fournisseur, receipt universel, `dedupeKey` ou
`semanticHash` générique.

Chaque module possède commande immuable, identité d’effet, clé provider,
receipts, réconciliation et rétention. La commande tenantée référence l’outbox
par FK composite tenantée ; un hash éventuel appartient au module.

Exception auth adoptée : la demande/commande/livraison/outbox d'e-mail pré-tenant
utilisent des relations UUID ordinaires dans un store auth confiné. Aucune
colonne tenant nullable généralisée, aucun Workspace fictif ni déplacement
d'autorité après signup. Cette outbox auth est une admission au même Hatchet,
sans payload métier et sans deuxième broker/service. Son obligation causale,
sa matérialisation atomique et son enveloppe de livraison suivent §6.3.

Retry automatique : même outbox. Re-admission manuelle : nouvel outbox vers la
même commande et identité d’effet, avec `replay_of` informatif.

### 9.2 Relay et Hatchet

Le relay runtime n’a aucun DML table et possède seulement `EXECUTE` sur les
fonctions `SECURITY DEFINER` de claim/finalisation. Owner et definer sont des
rôles NOLOGIN séparés; definer est non-owner, NOSUPERUSER, NOBYPASSRLS; objets
qualifiés, `search_path=pg_catalog,pg_temp`, PUBLIC révoqué, état/fence/lease
obligatoires.

Entrée Hatchet :

```text
{ outboxId: UUID, tenantId: UUID }
```

La tâche d'e-mail auth possède un nom statique distinct et le seul input
`{outboxId: UUID}`. Sa route détermine le store auth, sans scope/module arbitraire
ni fallback depuis un ID tenant. Elle emploie des fonctions SQL auth distinctes
de claim/finalisation/purge et les mêmes garanties ci-dessus : relay EXECUTE-only,
definer non-owner durci, fence/lease et contrôles d'état. Ni le relay ni un
worker ne reçoit un DML générique en guise de ces fonctions ; seul le worker
auth habilité accède à l'enveloppe. Les contrôles d'isolation sont vérifiés en
SQL et dans les stores, pas déduits du nom de tâche.

`tenantId` bootstrap RLS n’est jamais une autorisation. L’idempotence de tâche
est TTL finie sur `outboxId`; une collision réutilise l’ID de run existant. Un
ID de collision vide produit `admission_unknown`, jamais une réadmission aveugle.
Avant tout provider, le worker relit et compare tenant, outbox, commande,
kind, génération, hash, terminalité et l’identité immuable d’attempt provider;
un task input manquant, stale, cross-tenant ou terminal produit zéro appel.

Hatchet reste at-least-once; chaque task side-effecting est replay-safe
indépendamment de `retries:0`.

Ces garanties de collision, `admission_unknown`, replay et refus des entrées
stales/terminales s'appliquent aussi à l'outbox auth. L'identité de tâche est
dérivée de son outbox committée et de son nom statique. L'appel Plunk reste hors
transaction, puis son résultat est finalisé conditionnellement. Un résultat
inconnu, notamment après perte d'accusé, ne devient ni succès, ni nouvelle clé,
ni renvoi hors fenêtre d'idempotence prouvée. Un 409 documenté par le Plunk
hébergé ne prouve rien pour l'image self-host tant que celle-ci n'est pas
qualifiée ; acceptation fournisseur et réception en boîte restent distinctes.

### 9.3 Worker et résultat ambigu

```text
TX1
  SET LOCAL tenant
  charger outbox + commande
  vérifier kind/génération/hash module
  CAS claim avec executionToken/version
COMMIT

appel Stripe/Plunk/R2/antivirus hors transaction

TX2
  SET LOCAL tenant
  relire et CAS finalisation
COMMIT
```

Un effet possiblement committé devient `effect_unknown`. L’autorité de replay
consomme account, API family/version, endpoint, request hash, clé,
`firstAttemptAt`, `safeReplayUntil` et état de réconciliation issus de la
commande; elle n’est jamais recalculée depuis Hatchet. Il n’est rejoué qu’avec
idempotence provider prouvée et mêmes paramètres dans l’horizon sûr, ou après
réconciliation. Tombstone ou
génération exécutable reste disponible tant qu’un run tardif/replay autorisé
peut arriver.

Lease, fence, TTL et déduplication Hatchet ne prouvent jamais qu’un ancien appel
provider est arrêté et n’autorisent pas sa réémission. Le fence protège TX2,
pas le side effect externe. Engine/image digest et SDK Hatchet exacts sont
enregistrés pour les probes de collision/TTL/run ID; ils ne deviennent pas une
garantie provider.

### 9.4 Redis

Redis sert exclusivement le `customStorage.consume` du rate limiter Better Auth.
Le client est `redis@6.2.1` exact et le script statique utilise `EVAL`; aucun
cycle `EVALSHA/NOSCRIPT` ni replay implicite n’est introduit sans bénéfice
mesuré. Connect/command deadlines, reconnect, shutdown et erreurs process sont
configurés explicitement et fail-closed.
Le protocole projetV0 est décodé sans coercition sous la forme exacte
`[allowedInt,countInt,ttlMs]` : longueur 3, `allowedInt ∈ {0,1}`, `countInt`
entier positif sûr et `ttlMs` entier sûr ≥ 0. Le script définit `countInt` comme
le compteur post-tentative et incrémente aussi les refus; le décodeur exige donc
`(allowedInt === 1) === (countInt <= max)`. Le driver peut normaliser sa
représentation native vers ces entiers bornés uniquement à sa frontière.

`retryAfter = ceil(ttlMs/1000)` secondes pour un refus. Aucun nom générique
sliding/fixed ne remplace l’algorithme exact testé. Cet amendement post-subagents
supersède explicitement l’ancien tuple deux champs de la Section 6.
Un allow renouvelle le TTL; un deny ne le renouvelle pas mais incrémente encore
le compteur post-tentative `countInt`.

- dépassement valide → 429;
- indisponibilité Redis typée → mapping application/Better Auth en 503;
- protocole/configuration invalide → mapping sanitizé en 500, jamais déguisé;
- clés `rl:v1:<env>:<keyId>:HMAC-SHA256(rateLimitHmacSecret,clef Better Auth)>`,
  sans PII/IP/secret; le secret dédié, distinct de Better Auth, est obligatoire,
  stable entre replicas et versionné, sinon la readiness échoue.

L’identité IP n’est fiable que derrière un edge déclaré qui refuse l’accès
direct origin et écrase le header choisi. La configuration Better Auth pinne le
header et les proxies de confiance. Spoofing simple/multi-hop, hops malformés,
header absent, IPv4/IPv6 et accès direct sont testés dans un proxy local
représentatif; `trustedProxies` ne prétend jamais authentifier seul l’émetteur.

Redis n’est pas session store, cache initial, queue, lock, pub/sub, idempotency
ledger ou autorité métier.

### 9.5 FileAsset optionnel

FileAsset est une slice concrète non montée; aucun `BlobStore` universel.
PostgreSQL possède tenant, droits, quota, état/version, métadonnées et commandes.
R2 possède seulement les octets.

Deux buckets séparent matériellement `quarantine` et `ready`; le signer GET n’a
accès qu’au second.

```text
initiated → uploaded_unverified → quarantined → ready | rejected
delete_pending → deleted
```

Completion, scan et cleanup utilisent CAS + commande module + outbox atomiques.
La publication copie vers une destination unique préenregistrée, vérifie source
ETag après réponse perdue, finalise par CAS et cleanup durable. Avant GET, HEAD
doit correspondre à ID, SHA-256, content type, size et ETag PostgreSQL.

Chaque génération conserve `uploadExpiresAt`. Une suppression reste
`delete_pending` et durablement réadmissible jusqu’à
`uploadExpiresAt + boundedGrace`; elle ne devient `deleted` qu’après un DELETE
idempotent exécuté après cet horizon. `NoSuchKey` n’est une preuve terminale
qu’après expiration du dernier writer PUT présigné possible. Un PUT tardif ne
peut donc jamais recréer un objet après cleanup terminal.

Une URL présignée déjà émise reste un bearer token jusqu’à expiration ou
suppression; `delete_pending` bloque seulement les nouvelles émissions.

FileAsset reste désactivé avant tests live R2 SigV4/CORS/copy/réconciliation/
cleanup et antivirus véritable streamé, borné et fail-closed.

## 10. Sécurité, résilience, performance et observabilité

### 10.1 Frontière mécanique

Une frontière TanStack mince, body-free, possède correlationId serveur,
deadline absolue, signal/scope requête, défauts sanitizés, contexte OTel manuel
allowlisté et headers universellement sûrs. Elle ne contient ni authz métier,
body parsing, retry ou policy module.

Chaque server function et route est un endpoint indépendant de l’UI. Il déclare
méthode, schémas DTO, session, tenant/objet/propriété, limites body/résultat,
budget enfant et mapping public. Les mutations utilisent une méthode unsafe.

CSRF : middleware natif pour server functions, installé explicitement aussi
avec un `src/start.ts` custom; same-origin séparé pour routes cookie-auth unsafe;
webhooks signés publics hors CSRF navigateur; protections Better Auth
origin/fetch-metadata/redirect conservées. Le gate utilise une victime déjà
authentifiée : cross-origin POST est refusé avant effet, same-origin POST passe,
GET ne mute pas et l’absence de Fetch Metadata/Origin/Referer suit une policy
fail-closed explicitement testée. Un 401 sans session ne prouve jamais CSRF.

### 10.2 Scope, budgets et retry

Le deadline serveur est intersecté avec `Request.signal`. Tous les child fibers
applicatifs forkés dans le scope sont interrompus à sa fermeture. Cela ne prouve
jamais rollback DB ni absence d’effet provider.

Fan-out et concurrence data-dependent sont bornés. Aucun travail critique
détaché; l’async durable passe par outbox/Hatchet.

Tout outbound mutation est `retry-safe`, `idempotency-keyed` ou `ambiguous`.
Unclassified/ambiguous = une tentative puis réconciliation. Retry borné,
jittered, deadline-aware, même clé. Retry PostgreSQL = transaction DB-only
complète après rollback confirmé.

### 10.3 HTTP sortant et SSRF

Adapters provider : origins fixes approuvées, paths/queries typés et encodés,
bytes/temps/résultats bornés, `redirect:error`. Aucun fetch général contrôlé par
l’utilisateur. Une future callback URL dynamique active une revue DNS,
redirect et destination de connexion distincte.

Baggage est toujours supprimé vers les tiers. `traceparent/tracestate` ne se
propage que vers une destination revue et jamais à travers redirect automatique.

### 10.4 Webhooks

Ingress : bytes bruts exacts, limite transport prouvée, signature provider et
éventuel timestamp/replay avant parsing, receipt unique et outbox requise dans
la même transaction, puis ack et traitement async.

Le variant fail-closed générique exige un `Content-Length` decimal fiable,
rejette missing/chunked/transfer-encoding en 411 et oversize en 413 avant lecture
app. Ce n’est pas une compatibilité Stripe universelle : chaque provider reste
inactif avant preuve de son chemin ingress ou d’un limiteur chunked-capable.

Receipt dedupe et idempotence de l’effet métier sont deux contrats différents.

### 10.5 Erreurs, cache et navigateur

Modules : failures attendues typées. Transport : invalid, unauthenticated,
forbidden/non-disclosing-not-found, not-found, conflict, rate-limited,
temporarily-unavailable. Défauts/interruption : réponse générique avec traceId,
sans stack, SQL, body provider, URL token ou cause.

Réponses confidentielles/private/workspace-specific : `Cache-Control:no-store`
par défaut. Aucun résultat tenant privé static/shared-cache par accident.

CSP part d’un deny baseline et fixe explicitement script/style/connect/image/
font, `base-uri`, `object-src`, `frame-ancestors`, `form-action`; la build réelle
détermine nonce/hash. Aucun HTML non fiable n’atteint un sink raw sans sanitizer
spécifiquement revu. Le PWA ne cache aucun résultat auth/privé.

### 10.6 Données, audit et télémétrie

Classes : public, internal, confidential, secret. Secrets et données
confidentielles sont absents de logs/traces/metrics/analytics/audit payloads par
défaut.

Audit : facts append-only module-owned, minimaux, transactionnels avec les
mutations obligatoires et indépendants du sampling. Aucun payload archive ou
secret. Pas de field-encryption générique sans threat model DB-reader, format
versionné, key source externe et rotation.

OTel est le seul domaine opérationnel, mais la baseline instrumente manuellement
avec vocabulaires fermés module/operation/route/outcome/error. Metrics sans
identité/correlation/raw path; le probe pinné n’a émis aucun exemplar et ils
restent désactivés jusqu’à preuve dédiée.

L’auto-instrumentation HTTP/DB/exception et les failure/defect spans automatiques
`@effect/opentelemetry` sont désactivés : rc.111 a exporté le raw
`exception.message`. Stacktrace capture n’est pas activée et aucun leak status
plus large n’est revendiqué sans preuve.

PostHog, Sentry tracing, OpenInference, Formbricks et tout exporter/analytics
optionnel restent désactivés jusqu’à une preuve version-pinnée, exécutée et
indépendante des fields, headers, destinations, redirects, error/failure paths
et propagation. Un inventaire documentaire seul ne suffit pas.

### 10.7 Boundedness et health

- collections data-dependent : limite explicite;
- hot/growing lists : keyset stable et unique;
- offset uniquement pour petits ensembles bornés;
- aucun N+1 non borné;
- query plans/indexes prouvés sur schéma/données représentatifs;
- inputs, outputs, fan-out et providers coûteux bornés;
- aucune plateforme générique cache/circuit breaker/semaphore;
- `/health/live` sans dépendance ni métadonnée;
- `/health/ready` limité à l’initialisation et, si nécessaire, une dépendance
  synchrone critique sous budget court, jamais tous les providers.

Turnstile, s’il est activé sur une surface d’abus réelle, est vérifié côté
serveur avec action/hostname/replay/expiration; ce n’est jamais une preuve de
non-fraude.

## 11. UI, internationalisation, PWA et surfaces publiques

### 11.1 Shell applicatif

- mobile-first à 320 px;
- navigation clavier, focus visible, erreurs annoncées et contrastes testés;
- FR et EN disponibles dès le scaffold avec clés stables et fallback explicite;
- aucune concaténation de fragments traduits pour les messages métier;
- composants shadcn générés localement puis maintenus comme code du produit;
- Tailwind reste une primitive de style, pas une permission de disperser des
  décisions visuelles sans composants ni tokens locaux;
- pas de webfont, animation ou dashboard générique ajouté sans besoin produit.

Chaque capacité sélectionnée nomme au moins un consommateur et ses états succès,
vide, chargement, erreur, indisponibilité et reprise. Le noyau couvre au minimum
connexion/récupération, premier Workspace selon profil, sélection de Workspace,
sécurité/sessions et fermeture durable d’un compte personnel. Invitations,
pricing/checkout/portail client, usage et sièges ne sont obligatoires que pour
les slices sélectionnées.

FR/EN définit résolution et persistance de locale, `html[lang]`, fallback,
pluriels et formats `Intl` date/nombre/devise/fuseau. La langue des e-mails et de
l’outbox est figée lors de la commande afin qu’un worker tardif n’utilise pas une
préférence différente.

### 11.2 PWA optionnelle

Le profil PWA possède manifest, installation, update et état offline explicites.
Le service worker peut mettre en cache shell public, assets hashés et pages
explicitement publiques. Auth, server-function results, tenant data, billing,
tokens, fichiers signés et recovery restent network-only/no-store. Le mode
offline ne simule aucune mutation et expose clairement l’indisponibilité.

### 11.3 SEO des surfaces publiques optionnelles

Les routes authentifiées et tenantées ne sont pas indexables. La boilerplate
peut fournir une surface marketing SSR minimale configurée par produit : title,
description, canonical, robots, sitemap et données structurées uniquement pour
des faits publics explicitement fournis. Aucun contenu, FAQ, review, schema.org
ou claim n’est généré automatiquement.

Une activation de contenu public produit est revue séparément sur crawlabilité,
canonicalisation, structured data exacte, hreflang FR/EN, performance et absence
de fuite de routes privées. Google Search Console est un consommateur externe,
pas une dépendance runtime.

## 12. Stratégie de vérification

### 12.1 Tests permanents du noyau

- unitaires sur transitions, erreurs et pure policy;
- PostgreSQL/PgBouncer réels pour transaction, RLS, triggers et concurrence;
- HTTP réel pour server functions/routes, CSRF, methods et cache headers;
- Playwright production pour auth, tenant, billing, a11y et PWA boundaries;
- fault injection pour réponse perdue, commit ambigu, lease/fence et worker kill;
- bundle graph/manifest pour absence de code serveur dans le client;
- règles AST/static ciblées sur méthodes server-function, imports client/server
  et interdiction de `forkDetach`, sans créer un framework endpoint maison;
- fresh migrations + N−1;
- snapshots de télémétrie allowlistée et cardinalité;
- contract tests source/version pour seams Better Auth, Hatchet et Effect RC.

### 12.2 Probes bloquants avant gel de la spec

1. **Dérivation et lignée portable** : profil §3.3 exact, B2C personal sans
   commerce, B2B organization avec sièges, hybride marketing+SSO; clone propre,
   aucune surface inactive dans routes/schema/env/packages/workers/SW/bundles,
   y compris imports dynamiques/générés, et provenance sans chemin local.
2. **Better Auth 1.7.1 HTTP/linking/MFA/recovery** : manifeste complet méthode/
   chemin, endpoints account/facteur/User/Organization bruts inaccessibles,
   mount unique, `(issuer,subject)` effectif, linking implicite refusé,
   `LinkIntent` replay/logout/expiration/génération, magic fragment→POST et logs,
   WebAuthn signé UV0/UV1, premier facteur, TOTP fresh-challenge one-use,
   backup/trust refusés, recovery/hold PostgreSQL concurrent, cookie/idle/revoke.
3. **PostgreSQL tenancy/owner** : graphe rôles/ACL/whole-table, FORCE RLS et
   limite arbitrary-SQL explicite, GUC absent/invalide/session-poisoned,
   non-divulgation HTTP FK/UNIQUE, PostgreSQL 16.15/PgBouncer transaction et
   double démotion exactement-one-winner par toutes les voies writer sous RC.
4. **Contraintes commerciales PostgreSQL** : writer/ACL fermé, PK/UNIQUE/CHECK
   usage-siège, conservation inter-lignes, terminalisation/lineage immuables,
   dernière capacité, recovery lock order, Agreement/fallback, ambiguïté
   visible/réparable, invitation Better Auth et promotion vers rôle consommateur
   réelles via TX A/BA/TX B, et contention hot-key/mixed sans deadlock sous RC.
5. **Stripe exact/outcome provider** : API/event/SDK/billing/account pinnés,
   `maxNetworkRetries:0`, autorité par opération, clés/body/account/wire counts,
   horloge/restart, same-key conflict, Search lag, webhooks sémantiques/stale,
   réponse perdue; aucun fresh-key POST avant classification concluante. Le fake
   prouve client/wire/state machine, pas le cache provider.
6. **PoolClient/Better Auth/Drizzle/PgBouncer** : RC/sentinel, single-flight FIFO,
   composition Better Auth réelle, fautes checkout/BEGIN/SET/business/finalize,
   vrai proxy wire autour COMMIT/CommandComplete/ReadyForQuery,
   `COMMIT→ROLLBACK`, poison GUC, abort/handle tardif; release idle ou destroy.
7. **Hatchet/provider** : engine/SDK exacts, store PostgreSQL durable, inputs
   hostiles revalidés, collision/TTL/admission perdue, provider volontairement
   non-idempotent, vrais kills/progrès/réconciliation/tombstone; aucun
   lease/fence/TTL ne déclenche un second effet ambigu.
8. **TS7/Effect/TanStack** : pins/outils directs, lock graph, route roots,
   Vite/build/ast-grep/Drizzle Kit, diagnostics Effect cohérents, graph/bundle
   client, CSRF victime authentifiée et seam P2→P3→P6 réelle; aucun cast large,
   OpenAPI absent sans consommateur et aucune claim UI/perf/HA.
9. **Redis Better Auth 1.7.1** : `redis@6.2.1`+`EVAL`, allow, 429,
   indisponibilité/timeout → 503,
   tuple exact `[allowedInt,countInt,ttlMs]`, arité/types/no-coercion/cohérence,
   allow renouvelle TTL, deny ne le renouvelle pas mais incrémente `countInt`,
   `retryAfter=ceil(ttlMs/1000)`, secret HMAC dédié/versionné partagé entre
   processus, ingress proxy spoof-resistant, configuration invalide → 500
   sanitizé; tous les échecs fail-closed.

Ces probes sont jetables; leurs contrats, commandes, observations et gates
restent dans la spec. `PROTOCOL_CLAIMS.v1.json`, dérivé puis revu séparément de
l’implémentation des probes, est l’inventaire fermé des claims §12.2,
amendements A01–A32, C02–C07 et P2 de fermeture. Le runner lie son SHA-256 à l’exécution,
exécute chaque negative/positive ID, refuse claim absent/inconnu,
`PASS+specImpact!=none` et tout P0/P1 ouvert, puis atteste versions/runtime et
sources taggées ou digests documentaires. Un résumé RED ou un pin dupliqué à la
main n’est pas une preuve. Un échec modifie le contrat au lieu d’ajouter
automatiquement une abstraction.

### 12.3 Gates obligatoires avant « boilerplate prête »

Les gates s’appliquent au profil livré : une capacité absente n’a ni probe ni
gate. Le noyau commun reste obligatoire; les lignes TOTP, commerce, PWA,
marketing, FileAsset ou SSO ne bloquent que les profils qui les sélectionnent.
Les sous-gates Organization/invitation ne s’appliquent qu’aux profils contenant
`organization`; le lifecycle personal ne s’applique qu’aux profils contenant
`personal`.

1. lifecycle/shutdown web + worker + runtime + pool + telemetry;
2. Better Auth réel : signup, Google callback, magic link, passkey, TOTP,
   recovery, organization, invitation et session rotation;
3. authz tenant/objet/propriété et revocation concurrente;
4. Stripe/usage/seat concurrency, webhooks et ambiguous outcomes;
5. outbox → Hatchet → worker avec PgBouncer, restarts et providers réconciliés;
6. Redis limiter exact et fail-closed par endpoint;
7. CSP production, private cache, request/resource bounds;
8. migrations fresh DB et compatibilité N−1;
9. bundle/performance budgets sur scaffold intégré;
10. FR/EN, mobile, clavier, axe/Playwright et parcours critiques WCAG;
11. aucune intégration optionnelle montée sans sa gate dédiée.

### 12.4 Gates spécifiques d’activation

- SSO/JIT : endpoints exacts, gestion provider opérateur, linking, import et
  causalité membership revus;
- FileAsset/R2 : credentials scoped, SigV4, CORS, copy conditions, antivirus,
  `uploadExpiresAt + boundedGrace`, cleanup/orphans et URL bearer;
- analytics/telemetry externes : capture et transport exacts, privacy/lawful
  basis/retention par SaaS;
- public `/api/v1` : consommateur réel, OpenAPI/RFC9457 et auth propre;
- SEO/GEO : contenu et structured data publics, exacts et spécifiques au produit.

## 13. Séquences d’acceptation transverses

```gherkin
Scenario: appel direct d'une server function privée
  Given aucune session valide
  When la fonction est appelée sans passer par son écran
  Then elle refuse avant toute lecture tenant
```

```gherkin
Scenario: abort après commit
  Given une mutation commit avant la coupure client
  When la réponse est perdue
  Then la commande ne conclut pas que la mutation a échoué
  And elle converge par idempotence ou réconciliation
```

```gherkin
Scenario: deux writers tentent le dernier owner
  When les deux transactions démotent concurremment
  Then exactement une commit
  And l'autre échoue pour l'invariant owner attendu
  And une transaction fraîche observe exactement un owner actif
```

```gherkin
Scenario: dernier siège concurrent
  When deux invitations vérifiées finalisent concurremment
  Then une seule assignment devient ACTIVE
  And aucun Agreement ne dépasse sa capacité
```

```gherkin
Scenario: webhook dupliqué et désordonné
  Given plusieurs événements représentent le même effet logique
  When ils arrivent dans un ordre arbitraire
  Then receipt et business idempotency convergent vers un effet au plus une fois
```

```gherkin
Scenario: métriques sous entrées attaquant
  When dix mille users, workspaces, IDs et paths uniques sont traités
  Then le nombre de séries dépend uniquement du vocabulaire fermé
  And aucun identifiant n'est un label
```

```gherkin
Scenario: cache PWA hors ligne
  Given des données tenant ont été consultées en ligne
  When le navigateur passe hors ligne
  Then aucune donnée privée n'est servie depuis le cache applicatif
```

## 14. Décisions explicitement rejetées

- identité, session ou billing central partagé entre SaaS;
- duplication applicative des memberships Better Auth;
- rôles dynamiques/Teams avant besoin produit;
- mot de passe ou bypass support;
- Drizzle RC ou deuxième pile SQL comme fallback;
- transaction ouverte pendant Stripe, Better Auth inter-base ou autre réseau;
- effet externe dans TX worker;
- RabbitMQ applicatif, cache Redis général ou exactly-once broker;
- retry global, circuit breaker générique, policy engine ou endpoint DSL;
- auto-instrumentation permissive et analytics activées par défaut;
- BlobStore universel, subtree Effect ou monorepo préventif;
- claims SEO, contenu marketing ou structured data inventés par le template.

## 15. Chaîne d’autorité

Les sources exactes et leur ordre de remplacement sont dans
`SOURCE_MANIFEST.md`.

Gates de revue :

1. auto-revue de contradictions/placeholders/scope — passée;
2. cinq Oracle GPT-5.6 Sol/Pro Deep Research sections 1–5 — passés et amendés;
3. Oracle sections 6–7 — déjà passés et intégrés;
4. reviewers identity/security, billing/execution et product/quality puis
   convergence — passés et amendés;
5. Oracle post-subagents global puis fermeture ciblée Redis/FileAsset —
   `POST-SUBAGENT CONVERGENCE VALIDATED — READY FOR PROBES`;
6. validation utilisateur d’exécuter les probes §12.2 — obtenue;
7. trois Oracle plan adversariaux, reviewers spécialisés et arbitrage — amendés;
8. Oracle closure rounds 1–3 — `AMENDED PROTOCOL VALID — READY TO IMPLEMENT PROBES`.

Ce fichier ne modifie ni ne prouve le dépôt applicatif, qui n’existe pas encore.
