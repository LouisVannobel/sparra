# Sparra — correction fin d'appel et parcours guidé, recette locale

## Sources

- App : branche `z/sparra-guided-config-app`, qualification `2a45537fd3fe4041e5e7c18807e3ba9256f14403`. Artefact natif compilé à `fc46f712ccbc70ceb6d410582d641ed84d7719f4` ; la différence suivante est uniquement le test de retour Calendar canonique, sans changement runtime.
- Voice : branche `z/sparra-end-call-fix-voice`, `6c3e28a8c35a25f7da9e5562cc515a1ec353a320`. Seul `tests/integration/test_call_session.py` change après le lot 1 ; aucun code runtime, délai fournisseur ou budget n'est modifié.
- Base lot 1 conservée : App `73cf9b1`, Voice `3453abb`. Migration et publication futures restent décrites dans [la recette multi-secteur](multi-sector-pilot.md). La fixture officielle `990c2ad` n'est pas une preuve de compatibilité diagnostiqueur.

## Résultat fonctionnel

Quatre sections librement accessibles : établissement, connaissances, traitement/outils, récapitulatif/essai. Un seul brouillon d'entreprise ; champs et aides gardés montés. Les aides FAQ exigent une réponse explicite et les questions appelant complètent les consignes sur action du propriétaire. Les textes existants et limites 3000/2000 caractères UTF16 sont conservés.

Les conflits, annulations et réponses de sauvegarde incertaines conservent leur lecture protégée de réconciliation, sans second POST automatique. Calendar garde sa propre instance, ses données et sa sauvegarde. Le retour OAuth révèle automatiquement son résultat et place le focus sur la carte ; `calendar=returned` choisit uniquement la présentation, jamais une autorisation. La révision enregistrée ne qualifie pas une ligne téléphonique.

Le défaut fin d'appel était une borne de fixture englobant détection native de fin de tour et import SDK froid. Le test attend désormais la vraie fin de tour avant sa borne audio inchangée. Le cas froid et les protections exactes de contexte, PCM, marque, ACK, interruption et annulation restent vérifiés. Aucun SLO réel fournisseur n'en est déduit.

## Vérifications

| Périmètre | Résultat |
| --- | --- |
| Voice, suite offline complète sur `6c3e28a` | 3331 réussis, 118 ignorés, 10 sous-tests réussis, 204 avertissements existants ; exit 0, 951,69 s |
| App, UI + Calendar source sur `2a45537` | 288 réussis, 24 fichiers ; exit 0, 39,03 s |
| TypeScript normatif, lint et build web/worker | PASS ; dernier rebuild runtime `fc46f71` |
| Navigateur compilé, parcours existants et guidés | 17 réussis dans l'exécution complète, puis les 4 échecs corrigés réussissent séparément sur `fc46f71` ; aucune affirmation d'un seul run 21/21 |
| Calendar confirmé, vrai consommateur App/Voice/Inbox | PASS 1/1, 7 autres modes non exécutés, 87,80 s |
| Nettoyage des fixtures natives | PASS pour les exécutions ci-dessus ; inventaire tiers inchangé dans chaque exécution |

Le consommateur confirmé couvre un refus Google en français puis un succès en anglais, visibilité/focus automatiques, entreprise réussie/Calendar en conflit puis l'inverse, brouillons et révisions conservés, absence de répétition de POST, lecture protégée et remplacement explicite. Un garage existant ne change que sa prestation ; autres connaissances, coordonnées et audio OFF restent identiques. Le vrai producteur Voice admet la révision 3 et l'Inbox authentifiée affiche exactement ce snapshot.

Les captures FR/EN à 320 px et Axe couvrent connaissances, traitement et récapitulatif. Les tests attendent l'actionnabilité et la fin effective de la transition d'opacité Astryx avant contrôle ; aucun style n'est forcé et aucune règle Axe n'est exclue. Les titres FAQ utilisent `h2`, avec leur taille visuelle conservée.

Trois spécialistes indépendants ont validé le correctif de fixture vocal. Le lot 2 a reçu une revue qualité/tests, une revue React/accessibilité, puis Oracle en mode standard GPT-6 Astra/Pro (`sparra-guided-config-architectu-oct21`, architecture source PASS à `b4932ea`). Les correctifs de retour Calendar, d'accessibilité et d'attentes natives ont ensuite été relus dans leurs diffs ; aucun finding nouveau n'est resté ouvert dans ce périmètre.

## Limites conservées explicitement

Lors de cette recette initiale, deux scénarios historiques supplémentaires — `sparra-voice-connected.test.ts` et `sparra-voice-retention.test.ts` — étaient **FAIL avant admission** avec leur ancienne fixture de profil qualifié. Le producteur exige une politique budgétaire possédée, absente de cette fixture depuis une évolution antérieure au lot 2 (`e1da005`). La chaîne historique comptait dix admissions contre un plafond durable de cinq et régénérait des identités de profil/clé aux redémarrages. Ajouter une fausse factory ou réinitialiser le budget aurait masqué le problème.

Le portage complémentaire explicitement autorisé ensuite utilise des pilotes indépendants et des identités durables, avec enrôlement et comptabilité natifs. Les deux fichiers passent désormais ; les sources et résultats courants sont détaillés dans [la recette complémentaire du 22 octobre](2026-10-22-qualified-native-fixtures.md). Les résultats initiaux et leurs diagnostics restent historiques. Aucun PASS global de toute la matrice native App/CI n'est revendiqué.

Publication officielle, image/release, migration d'un service existant, essais téléphoniques réels et aptitude à recevoir des clients payants restent hors de cette recette locale. Aucun push ni déploiement n'a été réalisé.

## Reproduction locale

Utiliser les environnements figés des deux worktrees et le descripteur explicite `SPARRA_VOICE_TEST_ROOT` vers Voice `6c3e28a`, avec `SPARRA_VOICE_TEST_HOME` dans un répertoire de test possédé. Exécuter les scénarios lourds séquentiellement. À la demande explicite de l'utilisateur, la garde d'entrée est de 2 Gio physiques et 2 Gio virtuels libres ; les gardes d'inventaire, de provenance et de nettoyage restent inchangées.

```text
uv run --offline pytest -q
pnpm exec vitest run tests/ui tests/calendar --maxWorkers=1
pnpm typecheck
pnpm lint
pnpm build
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/sparra-browser.test.ts --maxWorkers=1
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/calendar-consumer.test.ts --testNamePattern "native phone-only Calendar confirmed preserves booking authority and the authenticated compiled Inbox" --maxWorkers=1
```

Les rapports, diffs de revue et logs complets sont conservés dans les artefacts locaux de cette exécution, séparément des sources et de la publication officielle.
