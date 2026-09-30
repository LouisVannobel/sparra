# Continuation de livraison du template applicatif

Date : 10 septembre 2026. Statut : proposition de changement d'ordonnancement et de racine, a faire relire avant adoption. Ce document n'est ni une preuve de readiness ni une nouvelle autorite d'execution.

## Decision precise

Le livrable reste toute la boilerplate privee B2B/B2C de BOILERPLATE_DESIGN.md, avec la preseance Astryx de UI_DESIGN_SYSTEM_DECISION.md. Le plan PREP + Tasks 1-15 ne contient pas cette implementation : son terme exclut explicitement le scaffold applicatif. Son depot reserve ne sera pas renomme ou presente comme l'application.

Ajouter une voie applicative dans le repertoire local neuf `C:/Users/louis/Documents/ChatGPT/projetV0-template`, constate absent le 10 septembre. Ce sera un candidat prive local, un package pnpm et un lockfile, deux composition roots web/worker dans une unite de release. Aucune creation GitHub, publication, push, installation globale, modification de CI/CD/infra, migration d'une base existante ou utilisation de credentials/provider existants n'en decoule. Avant toute creation, verifier de nouveau l'absence du chemin et les instructions de ses parents ; si le chemin existe, ne rien ecraser.

L'adoption porte sur cette racine applicative et sur le fait de ne plus serialiser toute ecriture applicative independante derriere la fin du controleur PREP. Les prerequis techniques restent attaches a leurs vrais consommateurs et a leurs claims : produire du code candidat n'est ni activer une capacite ni attester qu'elle est prete. Aucune exposition pour usage produit n'est permise avant les gates pertinentes. Pour obtenir ces preuves, les tests peuvent monter le vrai composition root candidat stable dans un environnement isole et autorise, avec donnees jetables ; session, tenant et CSRF restent controles. Les doubles controles restent dans les tests, sans branche de bypass, session fabriquee ou adapter de demonstration dans le runtime livre. Cela n'autorise ni credentials/provider existants ni un claim live.

Les autorites PREP restent immuables. Leur contenu, leurs exigences INCOMPLETE et leur futur BootstrapUse exact ne sont pas modifies. Ce gate continue de regir les usages prevus du depot commercial de probes ; il n'est pas transforme en autorite de l'application. La continuation ne reprend pas son moteur de recus, decoders PowerShell/TypeScript, controleur, schemas de journaux ou graphes d'autorisation comme dependances du template.

## Pourquoi cette correction est necessaire

Etat observe : aucun depot applicatif dans le parent retenu ; design de 66 892 octets ; plan PREP de 388 832 octets ; module PREP de 101 595 octets ; tests PREP de 330 780 octets avant correction courante. Ces tailles n'etablissent pas a elles seules qu'un controle est inutile. Elles montrent en revanche qu'une progression importante du chantier preparatoire ne constitue toujours aucun parcours applicatif livre.

L'Oracle `template-delivery-recenter-20260909` a deja confirme les cinq jalons ci-dessous, la necessite d'une continuation adoptee et l'interdiction d'une substitution auth-only/no-commerce. La presente proposition fournit la racine et l'ordonnancement qui manquaient. Elle ne redemande pas la revue descendant ou le classement local UX deja clos.

## Cinq jalons, avec resultats observables

### A. Authentification vers Workspace persistant

Livrer le graphe applicatif pinne, la configuration server-only, le lifecycle, le stockage transactionnel requis et le premier parcours complet : connexion par methode configuree, selection/creation du Workspace admis par le profil, affichage et mise a jour d'une preference tenant persistante. Aucun dashboard de donnees inventees, login simule, mot de passe ou adapter de demonstration dans le runtime.

Astryx est consomme par les vrais controles de ce parcours. Proposer `@astryxdesign/theme-neutral` comme theme initial unique, CSS precompile et fontes systeme ; conserver les peers requis sans installer CLI/MCP, plugin StyleX ou un second design system. Le choix de pin n'est effectif qu'apres verification du manifeste publie, des peers et du lock graph. Tailwind n'est ajoute que si une utilisation de layout concrete le justifie ; pas de duplication des tokens.

Tests decisifs : production build et typecheck normatif ; SSR/hydratation ; connexion reelle du runtime avec donnees de test ; refus de l'appel direct sans session avant lecture tenant ; lecture/ecriture uniquement dans le Workspace autorise ; persistance apres restart ; FR/EN, clavier/focus et 320 px. La recette UI_DESIGN_SYSTEM_DECISION.md de la premiere tranche UI s'applique integralement sur ce lockfile : ordre CSS, contrastes, erreurs annoncees, ressources externes, CSP et imports/bundle inclus. Les prerequis P2/P3/P6/P8/P9 applicables sont satisfaits sur le meme graphe avant que ce parcours soit declare qualifie. Les sous-exigences P7 sont satisfaites avant la qualification du premier parcours consommant relay/Hatchet/worker/provider, en A ou B selon la methode retenue ; C ajoute la preuve Stripe. Une outbox stockee sans effet encore consomme ne justifie pas de construire un worker vide. Les parties indispensables d'admission de session et d'outbox appartiennent a ce jalon, meme si les autres parcours du noyau sont livres en B.

### B. Noyau identite, securite et lifecycle complet

Achever Google OIDC, magic fragment-vers-POST, passkeys UV, sessions/revocation/idle, step-up atomique, linking explicite, recovery deux preuves/generation/hold, fermeture personnelle durable et e-mails depuis worker/outbox. Aucun bypass support, session de test ou fallback cryptographique dans le runtime. TOTP reste une option complete si selectionnee, jamais un chemin incomplet monte.

Tests decisifs : ceremonies et routes reelles avec controles positifs/negatifs, replay et concurrence, interruption/restart, secrets absents des captures/logs, absence de ghost email, notifications et recovery selon le design. Les parcours ont leurs etats succes/vide/chargement/erreur/indisponibilite/reprise, pas seulement leurs fonctions pures.

### C. B2B et commerce de bout en bout

Livrer organisations, memberships/invitations/owner, plans, Stripe officiel, sieges et usage ; pricing/checkout/portail, invitations et pages usage/sieges sont leurs consommateurs. Transformer les contrats COMMERCIAL_WAVE_SPEC.md et COMMERCIAL_TRANSITIONS_SPEC.md en comportement applicatif sans importer le controleur de probes dans le runtime.

Tests decisifs : dernier owner/dernier siege concurrents, conservation usage, transitions Agreement/fallback, recovery lock order, webhook duplique/desordonne, confirmation monetaire avant entitlement, reconciliation des reponses perdues, refund/dispute/cancel. P4/P5 et la partie provider de P7 doivent etre prouves avant qualification. Une preuve fake-provider ne vaut pas observation Stripe live. Les autorisations de sandbox/provider requises sont demandees sur une operation precise, jamais supposees a partir d'un secret disponible.

### D. Derivation reusable

Livrer et tester trois candidats derives : B2C personal sans commerce, B2B organization avec plans/Stripe/usage/sieges, et hybride marketing+SSO tel que nomme par la spec. Pour chacun, reconstruire la derivation et verifier l'absence des surfaces non selectionnees. La preuve de derivation hybride et la preuve d'activation de ses capacites SSO/marketing ont des statuts distincts : E clot leurs gates applicables avant toute declaration de template complet. Une autorisation provider manquante laisse cette acceptance explicitement ouverte ; l'inventaire ou le succes des deux autres profils ne la remplace pas. Une option non selectionnee est absente du composition root, routes, tables, commandes, env, packages, worker, SW et bundles. La derivation n'est pas un framework de flags runtime.

Tests decisifs : une derivation neuve reconstruit depuis un commit et un lockfile precis ; provenance portable de baseline/amendements ; aucune dependance a `.codex`, aux conversations Oracle, aux chemins absolus du poste ou au controleur PREP. Les dependances de developpement necessaires aux tests ne doivent pas devenir des dependencies runtime de chaque produit.

### E. Recette integree et livraison

Executer toutes les gates applicables de BOILERPLATE_DESIGN.md 12.3 et les scenarios transverses 13 sur le candidat et les profils livres. Fournir README de demarrage, configuration sans secret, commandes de build/test, migrations relues, contrats d'exploitation sans changement infra, et commandes de derivation. Les versions/requetes/live results encore non verifies restent nommes comme tels. Le but complet reste non atteint tant qu'une exigence obligatoire est manquante ou non prouvee.

Les bornes de securite, deadlines, cleanup et allocation du pool existent des leur premier consommateur en A/B/C ; E ne permet pas de les reporter. Avant la recette finale, fixer et mesurer aussi les budgets des vrais parcours : taille JS/CSS par entree, LCP/INP/CLS en conditions de test declarees et temps/requetes DB des actions bornees. Ne pas inventer un benchmark ou un chiffre de production. Un seul typecheck normatif ; pas de casts larges pour masquer une incompatibilite.

## Tranches de code, sans nouveau projet de controle

Le premier plan d'implementation couvre A, decompose en tranches avec tests propres : (1) graphe/runtime/configuration et lifecycle reel, (2) transaction/auth persistence et admission, (3) parcours Astryx vers Workspace. Setup, docs et tests vont avec leur consommateur, pas dans des tâches de meta-outillage separees. Les invariants B necessaires a A sont implementes avant son acceptation ; les jalons ne permettent pas un demi-login annonce comme securise.

Les autres sous-systemes suivent la meme regle : un agent frais par tranche de jugement, une revue independante specs+qualite, puis Oracle pour les choix structurants et la cloture du jalon. Les revues mineures ne rouvrent pas toute l'architecture. Un refus de securite Oracle n'autorise ni reformulation d'evasion ni boucle de relance ; les erreurs de transport suivent le skill Oracle.

Les fichiers applicatifs suivent `src/modules/<module>/`, `src/platform/`, `src/routes/` et `src/ui/`. Creer uniquement les fichiers qu'une tranche consomme : aucun dossier avec index vide, BaseRepository, bus generique, DSL d'endpoint, second pool ou moteur de validation maison. Effect Schema valide les entrees serveur ; les DTO client restent TypeScript ordinaire.

Les travaux PREP deja engages conservent leur preuve et leur proprietaire. Leur correction ne devient pas une nouvelle fonctionnalite du template. Il n'y a jamais deux implementers sur un meme fichier, ni execution d'un candidat pendant son ecriture.

## Passe anti-slop sur les ajouts de cette continuation

| Element | Consommateur reel | Probleme demontre | Gain conserve | Suppression/simplification |
|---|---|---|---|---|
| Repertoire applicatif separe | SaaS derives et leur developpeur | Le seul checkout courant est infra ; les probes ne sont pas l'app | Isolation et source livrable | Un package ; ni monorepo ni remote cree automatiquement |
| Cette continuation | Coordinateur et implementer de A | Le plan actuel se termine avant l'app | Relie objectif et code sans rebaptiser les probes | Un document, pas de schema/registre/receipt nouveau |
| Astryx precompile + un theme | Connexion, Workspace, securite et commerce | Choix explicite utilisateur ; UI applicative absente | Composants et tokens coherents | Pas de shadcn, CLI, wrapper universel, webfont/CDN ou plugin de build sans besoin |
| Tests du parcours integre | Utilisateur du template | Les tests de primitives ne prouvent aucune connexion/tenancy UI | Prouve le comportement consomme | Cas specifiques dans l'app, pas de second runner de preuves |
| README/commands de demarrage | Developpeur qui derive le template | Aucune app demarrable n'est livree | Reproduction et usage autonome | Une source de verite ; pas de runbooks dupliques avec infra |

Tous les autres services/frameworks restent ceux du design deja selectionne. L'ajout d'un service ou d'une abstraction exige un nouveau consommateur concret, pas une opportunite generique.

## References consultees pour cette proposition

- BOILERPLATE_DESIGN.md, UI_DESIGN_SYSTEM_DECISION.md, deux specs commerciales ; leurs exigences restent normatives, leurs vieux pins restent a verifier sur le graphe applicatif.
- Oracle recentering : https://chatgpt.com/c/6aa1d41c-8a28-83eb-983b-07ffc9b2f392 ; avis consultatif, pas autorisation utilisateur.
- Documentation officielle Astryx : https://github.com/facebook/astryx/blob/main/packages/core/README.md ; consommation Vite precompilee et theme publie. Cette documentation courante ne prouve pas l'integration TanStack.
- Documentation officielle TanStack Start : https://tanstack.com/start/latest/docs/framework/react/build-from-scratch ; configuration de base, pas proof du lock graph specifique.

## Adoption et limite actuelle

Cette proposition ajoute explicitement la voie applicative et change son ordonnancement par rapport aux seuls probes : ce n'est pas une correction silencieuse des autorites PREP. Elle sera presentee avec les avis independants et Oracle avant implementation. Une adoption simple du document et de la racine suffit ; aucun nouveau mecanisme de recu, hash signe ou gate repetitif n'est ajoute. Tant que cette adoption manque, ne pas creer cette nouvelle application et ne pas pretendre que le precedent plan l'autorisait.
