# Sparra — refonte visuelle Refero / Quo

Base : `8ff9a914c77d71b7113ba93ee8faf2dde3b773b6`. Travail dans le clone indépendant `C:/Users/louis/Documents/ChatGPT/.worktrees/sparra-design-refero`, branche `z/sparra-design-refero`. Aucun changement ni serveur arrêté dans le checkout ou la conversation principale. Aucun push, déploiement, donnée métier, credential ou migration.

Référence utilisateur : https://styles.refero.design/style/792089e6-c045-498c-8ba1-48d72c206c66 . Reprise du langage visuel : papier clair, noir, accent chartreuse ponctuel, grands titres centrés, cadre produit unique et contrôles compacts. Astryx0.5.4, son thème neutral et les composants existants restent en place. DM Sans pour les titres et Inter pour l'UI sont auto-hébergées depuis Google Fonts avec leurs licences OFL ;84 Ko de WOFF2, aucune requête de police externe au runtime.

La page publique présente la démo existante dans un cadre blanc, avec conversation et fiche de réception. Les textes fictifs restent explicitement identifiés et aucune nouvelle preuve commerciale n'est inventée. L'application adopte une navigation latérale desktop, des lignes d'inbox structurées, un état vide, des groupes de formulaire et une vue de détail à deux colonnes. Sur mobile les vues redeviennent un flux unique. Les handlers audio, RPC, droits, données, conflits d'enregistrement et confirmations d'effacement sont conservés.

Validation locale finale : typecheck, lint, build natif et28 tests existants UI/marketing passent. Contrôles visuels desktop et390px : site et formulaire sans débordement ; champs nom/secteur44px, contours#949494 ; ouverture du sélecteur au clavier et fermeture avec Échap observées. Revue indépendante UX/UI approuvée après correction des tailles et du contraste.

L'aperçu temporaire utilise les composants réels dans un harness local ignoré, sans API ni compte réel. L'inbox est vide ; le formulaire n'enregistre rien. Cet aperçu ne prouve pas l'authentification ou la téléphonie. Les écrans de détail et l'inbox remplie n'ont pas fait l'objet d'une capture avec des appels réels. Aucun test Docker ou modification de services partagés n'a été exécuté pour cette tâche.

Les captures et la revue se trouvent dans `C:/Users/louis/.codex/artifacts/sparra-design/2026-10-02/`. L'intégration dans la branche de la conversation principale doit être faite séparément après son propre travail ; ce changement n'y a pas été fusionné. À l'intégration, vérifier le rendu avec les données et le bandeau de langue natifs, puis requalifier les artefacts de livraison affectés.
