# Sparra — spécification adoptée de première livraison

30 septembre 2026. Périmètre écrit validé explicitement par l'utilisateur : « Valider ce perimetre ». Le présent document est la spécification adoptée. L'ordre retenu est site/démonstration, puis pilote relié. Les alternatives ci-dessous restent le contexte de ce choix. Aucun code produit, achat, déploiement, migration, merge ou changement DNS n'a encore été effectué.

## Résultat recherché

Sparra répond aux appels des professionnels locaux lorsqu'ils sont indisponibles, connaît les informations qu'ils lui ont confiées et transforme les demandes en actions lisibles. Le professionnel garde son numéro lorsque le renvoi de sa ligne le permet et conserve la main sur les règles et le relais humain.

Le produit global demandé comprend le site, une démonstration audio par métier, une inbox, la configuration de l'entreprise et un service téléphonique réel. Cette proposition organise leur livraison ; elle ne réduit pas cet objectif à une vitrine.

La première cible proposée est le garage, puis le contrôle technique. Les autres métiers seront activés dans le même démonstrateur lorsqu'ils disposent d'un exemple complet et vérifié. Une offre mensuelle unique et une configuration accompagnée sont retenues ; aucun prix, volume illimité ou frais d'onboarding n'est inventé.

## Base imposée et reprise

Lire et suivre [START_HERE.md](C:/Users/louis/Documents/ChatGPT/boilerplate-handoffs/r1-20260930/START_HERE.md). La base est le R1 local **TanStack Start + Effect + Better Auth + Drizzle/PostgreSQL + Astryx**. Livraison Git SHA-256 : `f932b25356c82d9a5c89d0849409f043b05f95cb2206b1d7870878c00cc4e4c6`.

La reprise produit proposée utilise un nouveau dossier `C:/Users/louis/Documents/ChatGPT/sparra`, actuellement absent. Le producteur `projetV0-template`, le checkout infra dirty, les checkouts Voice et l'ancien `sparraprivate` restent des références. Le ZIP fournit une base de fichiers compatible avec un nouvel historique SHA-1 ; le bundle SHA-256 et DELIVERY.json restent conservés comme provenance. Une future livraison amont s'intègre par comparaison explicite des deux bases et des changements Sparra.

Garder Node `24.14.0`, pnpm `10.32.1`, le lockfile, les pins R1 et le patch nice-grpc. Requalifier installation figée, typecheck, tests et build dans cette dérivation. Les 682 tests annoncés par le producteur ne constituent pas une exécution Sparra.

## Ordre de livraison et options

**Option recommandée : démonstration, puis pilote relié.** Construire le parcours de compréhension et ses vrais médias ; qualifier ensuite un premier appel entrant jusqu'à sa fiche persistée. La première interface devient vérifiable sans attendre tout le commerce amont. Sa publication reste distincte de l'ouverture du service vocal.

**Option possible : commencer par le pilote téléphonique.** Cela valide plus tôt la chaîne technique, mais dépend immédiatement des accès fournisseurs remplacés, des justificatifs du numéro français, du raccordement SQL et de l'ingress. Le site vient ensuite.

**Option possible : attendre la prochaine livraison complète du socle.** Cela simplifie l'ouverture aux clients payants, mais reporte le travail produit qui peut déjà être mené sur R1. Ce n'est pas nécessaire pour les données fictives et les consommateurs locaux.

Oracle Astra/Pro recommande la première option. Le premier parcours téléphonique complet reste indispensable avant de présenter le service comme opérationnel.

## Première livraison : comprendre et écouter

Une page principale, en français, conserve un contenu métier présent dans le HTML initial. Elle présente une promesse concrète, « Écouter un appel », puis une démonstration à deux côtés :

- **Ce que votre client entend** : fichier audio réel, commandes lecture/pause/recommencement, transcription fidèle et repérage de la réplique courante.
- **Ce que vous recevez** : motif, contact fictif/masqué, résumé, préférence exprimée, état et prochaine action. Une fiche éditoriale est identifiée comme illustrative ; une fiche produite par le runtime dispose d'une provenance correspondante.

Le premier scénario qualifié est une demande de révision au garage. Le contrôle technique utilise ensuite le même lecteur avec son propre audio, sa transcription et sa fiche. Seuls les métiers qui ont ces trois éléments peuvent être sélectionnés. Le changement de métier arrête l'ancien son et remplace les deux côtés ensemble.

Un enregistrement de démonstration est explicitement identifié comme tel. Il n'est pas présenté comme un appel live. Si l'audio est issu du runtime Sparra, conserver version du runtime, configuration métier et scénario de recette. Un dialogue produit avec des voix de synthèse à partir d'un script reste identifié comme illustration ; il ne qualifie pas la chaîne téléphonique.

Exemple de début : « Bonjour, je suis l'agent IA du Garage Horizon. L'équipe est à l'atelier. Que puis-je transmettre ? » Le garage et l'appelant sont fictifs. Sparra recueille la demande et une préférence de rappel. Sans agenda relié, le résultat est **RDV à confirmer**, jamais « RDV pris ». L'urgence est celle déclarée par l'appelant ; elle ne prouve pas un diagnostic ou un transfert réussi.

Sous la démonstration : numéro existant selon compatibilité du renvoi, aucun matériel spécifique à installer pour le parcours retenu, configuration accompagnée et contrôle du professionnel. Les quatre étapes reprennent la demande utilisateur : activité → ligne → réponse → essentiel. Tant que leur raccordement n'est pas qualifié, elles décrivent le fonctionnement prévu du service.

Le CTA de contact peut ouvrir la rédaction d'un e-mail vers l'adresse professionnelle déjà affichée sur l'ancien site, `contact@sparra.fr`. Ce lien ne prétend pas envoyer un formulaire ni confirmer sa réception. L'adresse doit être confirmée pour ce projet avant publication. Aucun nouveau service de collecte de prospects n'est nécessaire à ce lot.

Pas de témoignage, logo client, chiffre de performance, essai gratuit, paiement ou confirmation d'action sans preuve correspondante. Les pages légales utilisent l'identité réelle de l'opérateur avant publication ; elles ne sont pas remplies avec une société inventée.

## Direction visuelle

[Référence Refero examinée](https://styles.refero.design/style/792089e6-c045-498c-8ba1-48d72c206c66) : papier `#f7f6f5`, surfaces blanches, texte noir, boutons noirs, touches de surligneur `#edfc47`, traits fins et angles modérés. La démonstration est le visuel principal. Les composants publiés Astryx restent l'unique socle UI.

Les fontes restent locales et dûment disponibles/licenciées ; la référence ne fournit pas de droit sur Roobert. Les textes secondaires doivent passer les contrastes requis, même si une couleur de la référence ne les permet pas. Les statuts métier ont un libellé et une icône, sans dépendre uniquement de la couleur.

## Adaptations R1 nécessaires à ce lot

- Ajouter la route publique `/` dans le routeur de fichiers. Les sorties générées suivent le générateur ; pas de retouche manuelle de `routeTree.gen.ts`.
- Adapter le shell partagé pour la navigation marketing en préservant les parcours FR/EN et la sémantique de langue de l'auth existante. La page publique française reste identifiée comme française ; un paramètre de langue ne doit pas la marquer à tort en anglais.
- `src/server.ts` impose actuellement `X-Robots-Tag: noindex` partout. Définir une exception explicite pour les seules routes publiques créées, conserver l'exclusion des routes privées et des routes inconnues.
- Sa CSP n'a pas de `media-src`. Autoriser les médias locaux avec `media-src 'self'` ; conserver nonce, restrictions de scripts, formulaires, connexions et framing. Aucun CDN ou tracker ajouté implicitement.
- Le serveur R1 attend DB/Redis avant écoute même pour une page publique. La recette utilise les fixtures isolées compatibles ; aucun faux adaptateur de démarrage et aucune dépendance au node_modules du producteur.
- Adapter les contrôles anti-slop au graphe R1. Ne pas recopier Dockerfile Next, scripts de génération de SaaS stateless ou pins du starter.

## Premier incrément applicatif réel

Parcours cible : **modifier les informations du garage → passer un appel d'essai → retrouver sa fiche → la marquer traitée**.

Un propriétaire administre une activité dans son Workspace personnel. Cela ne crée ni organisation partagée, invitations, collaborateurs ou transfert de propriété. L'auth et l'autorité tenant viennent exclusivement de R1.

Les connaissances contiennent horaires, prestations, tarifs réellement renseignés, questions fréquentes et consignes. Une sauvegarde ne doit pas prétendre avoir changé un appel déjà engagé : chaque appel conserve la version de configuration utilisée. Le texte fourni à l'agent est une donnée métier validée, pas une autorité pour déclencher des outils ou accéder à un autre Workspace.

L'inbox expose demandes à rappeler, renseignements, demandes de rendez-vous à confirmer et urgences déclarées. L'écran initial reste utile avec zéro appel. Pas d'agenda, devis, SMS, CRM ou tableau de bord supplémentaire pour ce premier parcours.

Autorité : requête → principal natif → `withPersonalWorkspacePromise(..., principal, false, callback)` → connexion physique déjà possédée par R1. Le sélecteur Workspace du client n'est jamais l'autorité. Les fonctions serveur valident les entrées, contrôlent chaque opération, transmettent l'annulation et conservent CSRF/no-store et des erreurs publiques bornées.

Les tables métier sont liées au Workspace, protégées par USING/WITH CHECK et FORCE RLS, avec propriétaire distinct et grants minimaux. Les migrations `0000–0012` restent immuables ; une migration produit forward se construit sur l'état Sparra et se teste avec données préexistantes. La capacité personnelle actuelle n'expose pas DELETE : la conservation/suppression métier exige un contrat explicite avant données réelles, sans recopier la rétention permanente des faits d'audit du socle.

## Raccordement vocal à spécifier avant le pilote

Réutiliser le runtime Python/Pipecat publié au SHA `6327b576feaa61421f77a2a3e80572d16f1d8433`. Il ne fournit pas encore l'inbox/configuration Sparra ou le transfert humain métier. Son image publiée ne constitue pas un déploiement.

La lecture du câblage livré précise les ajouts nécessaires : `prompt_path` est validé mais son contenu n'est pas injecté dans le `LLMContext` initialement vide ; il faut donc raccorder effectivement les instructions et connaissances avant de démontrer que Sparra connaît l'entreprise. L'outbox contient déjà les tours utilisateur/assistant chiffrés (`turn.upsert`) : les réutiliser pour la transcription. Résumé et coordonnées structurées ne sont pas encore fournis, et le webhook validé ne conserve pas le numéro appelant. Définir leur capture/confirmation sans supposer qu'ils sont déjà disponibles. Le contrôleur Telnyx n'expose pas de transfert : ajouter et qualifier cette action avant de la promettre comme fonction opérationnelle.

Les endpoints STT/LLM/TTS OpenRouter sont actuellement fixes ; les modèles, voix et politiques viennent du profil d'inférence. La décision utilisateur autorise des traitements IA externes déclarés : cette base peut rester candidate, avec qualification des destinations, politiques et rétention. Un changement d'endpoint/région n'est pas une option actuelle du profil à activer silencieusement.

Trois contrats courts suffisent :

1. **Routage** : connexion/numéro appelé associé côté serveur au Workspace ; le numéro appelant, le modèle et un `workspaceId` reçu ne peuvent pas choisir le tenant.
2. **Configuration** : schéma, version et accès limités au Workspace attribué. Raccorder le mécanisme réellement consommé par Voice ; ne pas supposer une API dynamique déjà présente.
3. **Résultat et rétention** : événements authentifiés, identité d'appel, déduplication, désordre, résultats incomplets et effacement. Voice consomme réellement les fonctions SQL `voice.ingest_operation_v1`, `voice.lease_recording_purge_v1`, `voice.ack_recording_purge_v1` via un DSN limité. Ces fonctions/rôles et le consommateur des fiches doivent être conçus sur la frontière R1, pas remplacés par une interface imaginaire.

Départ proposé : un numéro entrant, une activité, un appel simultané, collecte d'un message et accès à la fiche. Ne pas activer un enregistrement audio client par défaut ; la transcription et les autres données personnelles restent soumises à des décisions d'information, accès, conservation et suppression.

Le renvoi conditionnel de la ligne existante et le fallback humain sont des comportements à tester sur la ligne retenue. Un humain injoignable ou une panne fournisseur doit produire un repli réellement disponible. Les fonctionnalités promises dans le site suivent les preuves de ce parcours.

## Conditions avant utilisation réelle et publication

Les serveurs possèdent les versions nécessaires PG16.15/PgBouncer1.25.2/Redis7.2.16 et Hatchet. Il reste à qualifier une base et des identités propres à Sparra, les rôles exacts R1, les fonctions Voice, la capacité, la sauvegarde et l'ingress. Aucune modification des ressources partagées n'est implicite.

L'ancien site M&A fonctionne encore ; DNS et déploiement se préparent séparément avec un retour possible à cet état. Les endpoints de santé R1 ne satisfont pas encore le contrat JSON/revision du workflow de déploiement : adapter ce contrat et le packaging à ses vrais consommateurs.

Le fichier d'objectif contient des accès exposés. La passation exige leur remplacement et leur injection transitoire via un mécanisme de secrets, avant usage. Ne pas demander de nouvelles clés dans un rapport, un dépôt ou un prompt Oracle.

Le numéro français Telnyx dépend des justificatifs, de l'activation et des prix réels. Le crédit de 5 USD est un plafond à respecter ; examiner frais d'achat, récurrence et coût du scénario avant toute commande. Il ne prouve pas qu'une offre particulière est acquise.

L'annonce IA intervient au début de l'échange. L'information sur les traitements et un éventuel enregistrement doit correspondre au fonctionnement réel. **Décision utilisateur du 30 septembre : application et données en France, traitements IA externes explicitement déclarés.** Qualifier l'hébergement de l'application, des données persistées et des sauvegardes en France ; documenter séparément les flux opérateur/STT/LLM/TTS, leurs destinataires, localisation et rétention. Aucun fournisseur ou territoire n'a été qualifié ici. Ne pas étendre la promesse française à l'ensemble des traitements IA.

Avant clients payants : récupérer puis recetter les capacités amont nécessaires de récupération/notifications/fermeture/commerce et les parcours fournisseurs exposés. Aucun second login, second moteur de facturation ou contournement de tenant pour compenser leurs absences.

## Recette qui ferme chaque lot

Pour site/audio : typecheck et build R1, tests du vrai sélecteur/lecteur, page compilée avec SSR, CSP/audio et indexation ciblée ; clavier, focus, 320px, zoom, lecteur d'écran aux points critiques et contrastes. Aucun autoplay. Erreur audio compréhensible avec transcription toujours accessible. Le changement de scénario garde audio/transcript/fiche cohérents. Les protections privées ne régressent pas.

Pour persistance : fixture PostgreSQL jetable, deux propriétaires, refus des lectures/écritures croisées par identifiant deviné, session invalide/révoquée, Workspace en cours de suppression/inactif, tenant absent/malformé, champs supplémentaires et erreurs. Rechargement/redémarrage conservent les données ; une lecture GET ne crée pas de Workspace. Annulation ou panne ne publie pas un succès sans preuve.

Pour téléphone : appel réel attribué au bon Workspace, bonne version de configuration, fiche unique, événements répétés/désordonnés, interruption, fournisseurs indisponibles, transfert/refus/repli et limites de dépenses. Rapport séparant tests locaux, CI hébergée et acceptation réelle. Une démo enregistrée ne remplace pas ce test.

## Travail des agents et documentation

Documentation et source sont deux revues distinctes. Utiliser les guides natifs et types/sources de la version exacte, puis les tests amont pinnés si une incertitude reste. Effect et TanStack publient déjà des guides agents dans leurs paquets. Un checkout externe en lecture seule reste préférable au subtree tant que ce dernier n'a pas montré un avantage concret.

Context Hub est un outil de développement éventuel, pas une dépendance Sparra. Ses docs restent partiellement courantes malgré un pin framework. MCP Python, Pipecat MCP et Stripe AI ne sont pas ajoutés sans consommateur. Les guides Stripe deviennent utiles lors de l'intégration du commerce amont. SEO : HTML utile, métadonnées exactes, vrais liens/404 et pas de pages métiers quasi identiques.

Oracle intervient aux décisions importantes et fermetures de lots. Les revues spécialisées suivent les risques réellement touchés : sécurité/tenancy/résilience pour persistance et téléphone, simplicité/qualité pour modules, produit/design/accessibilité/SEO pour parcours. Pas de comité permanent pour une retouche de texte.

Voir [les preuves de découverte](C:/Users/louis/.codex/artifacts/sparra/2026-09-30/SPARRA_DISCOVERY_EVIDENCE.md) et [l'avis Oracle](C:/Users/louis/.codex/artifacts/sparra/2026-09-30/ORACLE_FIRST_SLICE_REVIEW.md). Le périmètre architectural est adopté ; le plan d'exécution du premier lot est [site et audio](../plans/2026-09-30-sparra-site-audio.md). Sa revue précède l'implémentation. La validation du périmètre n'autorise pas à présenter le produit ou les fournisseurs comme déjà qualifiés.
