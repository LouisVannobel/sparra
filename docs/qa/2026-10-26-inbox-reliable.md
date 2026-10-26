# Inbox fiable — qualification locale du 26 octobre 2026

Implémentation terminée et revue localement. Aucun P1/P2 résiduel établi après la contre-revue ciblée du dernier correctif. Cette qualification concerne les sources et les consommateurs exercés ci-dessous ; elle ne qualifie pas la production.

## Sources et résultat

| Dépôt | Base vérifiée | Branche locale | Dernier commit produit |
|---|---|---|---|
| Web | `45a5061ea605e79a152b952c0b477880d33f22bf` | `z/sparra-inbox-reliable-oct26` | `aa9af8100f8a9b1127a76dbee2e95dfb3a674605` |
| Voice | `565d434cb1779ac20a342bce22d24a4bd6842b7e` | `z/voice-inbox-reliable-oct26` | `5fd3149314ebecc40af44c59118e8bfd2b1fd674` |

Worktrees : `C:/Users/louis/Documents/ChatGPT/.worktrees/sparra-inbox-reliable-oct26` et `C:/Users/louis/Documents/ChatGPT/.worktrees/sparra-voice-inbox-reliable-oct26`. Les autres checkouts et travaux en cours sont préservés. Le plan et la spécification sont dans `docs/superpowers/`.

- Voice publie un manifeste de collecte après la jonction effective des producteurs. Le receiver vérifie les tours et le terminal audio attendus. Le statut téléphonique seul ne clôt pas la collecte.
- La migration forward `0027_sparra_inbox_publication.sql` conserve un instantané décisionnel chiffré : contenu, preuves et résultats agenda existants. Une publication tardive renouvelle sa révision C ; les répétitions et modifications de transport sans effet décisionnel ne créent pas une nouvelle revue.
- Le suivi humain conserve la dernière révision déclarée A, une déclaration active/révoquée, la première date et un jeton serveur T. « À traiter » signifie déclaration inactive ou A < C. Les commandes comparent C/T sous verrou ; un ancien clic ne peut pas annuler une révocation plus récente.
- Le DTO vient d'un seul instantané. La liste filtre avant sa limite et propose « À traiter » / « Tous ». La fiche présente contact, demandes, suite et preuves avant la conversation longue, avec actualisation explicite, liens vers les tours et effacement distinct.
- Le classement exige une collecte clôturée et des pièces publiées restituables. La révocation reste possible si la collecte redevient provisoire ou si le déchiffrement est indisponible. Un simple reçu ne peut pas rendre lisible un corps encore absent : seule une lecture complète peut le faire.

Pas de nouvelle dépendance, framework, journal général, diffusion temps réel ou service intermédiaire. Les migrations antérieures restent intactes. La fixture Voice épingle le vrai commit local `5fd3149` et ses 59 fichiers ; elle n'est pas présentée comme déjà fusionnée.

## Vérifications exécutées

Node **24.22.1**, pnpm **10.32.1**, Python **3.13.17**, dépendances figées. Les lectures du 26 octobre ont porté sur la documentation officielle React, TanStack Start, Drizzle et PostgreSQL 16 ; les API et types des versions installées ont guidé l'implémentation, sans mise à niveau de dépendances.

Les nombres suivants correspondent à des exécutions distinctes, parfois sur des consommateurs existants. Ils ne doivent pas être additionnés en une campagne globale au dernier commit.

| Lot | Preuve utile |
|---|---|
| Producteur / publication | RED puis GREEN : 14 cas Voice de freeze/capture ; 4 cas SQL natifs ciblés et un dernier contrôle de reçu. Ruff/mypy ciblés passés. Garde du tour retardé exercée. |
| Fixture Voice | 26 vérifications lecteur/export passées, 1 cas Linux ignoré ; archive déterministe et pin réel vérifiés. Aucun bootstrap Linux revendiqué. |
| DTO / commandes | 6 cas natifs et 48 cas parseurs/helpers ciblés passés. Un cas natif supplémentaire RED/GREEN a corrigé la révocation après nouvelle publication provisoire. |
| Interface | 112 cas UI/SSR ciblés, dont 19 parcours de vrais composants compilés, passés lors du lot initial. Les deux défauts de récupération audio et d'alerte après effacement ont ensuite été reproduits/corrigés : RED 2, GREEN 2, puis 4 consommateurs audio. |
| Pièces illisibles | Un cas natif regroupé et un cas UI compilé, chacun RED/GREEN : classement refusé sans mutation A/T, restauration sans changement de C, révocation possible et vrais terminaux partiels préservés. |
| Reçu sans corps | À `aa9af81` : **RED 2 puis GREEN 2**, 46 cas non sélectionnés. Le détail garde son blocage après un reçu annonçant true, jusqu'à la relecture du corps ; le helper de liste conserve la même règle. |
| Contrôles finaux | À `aa9af81`, `pnpm run typecheck`, `pnpm run lint`, `pnpm run build` web/worker : **code 0 chacun**, une exécution finale par commande. Contrôles de whitespace Git passés. |

Les timeouts initiaux de montage UI à froid sont conservés dans les traces. Le lot UI a utilisé le build/preview des composants existants, sans gonfler les délais. Un préflight SQL/RLS et un contrôle d'inventaire étranger ont aussi échoué pendant la mise au point ; les passes finales et leurs nettoyages sont distincts. Aucune ressource étrangère n'a été modifiée.

Les parcours UI compilés emploient des DTO contrôlés. Les tests natifs exercent séparément PostgreSQL/Redis jetables et les opérations serveur réelles sous le lease R1. Ce n'est pas un nouveau parcours navigateur authentifié complet jusqu'à SQL. Aucune suite globale ni campagne exhaustive de 35 scénarios n'a été lancée. Le warning Pipecat amont et celui de taille du chunk de fixture n'ont pas déclenché de chantier annexe.

## Revues et Oracle

Chaque lot a eu un implémenteur et une revue indépendante. Les P2 réellement établis ont été corrigés puis relus sur leurs seuls consommateurs : révocation provisoire, récupération audio, alerte d'actualisation et pièces illisibles. La première correction de lisibilité a été refusée en re-revue pour son reçu sans corps ; `aa9af81` complète le même correctif. Verdict final indépendant : **ADDRESSED, aucun P1/P2 résiduel établi, prêt pour intégration locale**.

Oracle a rendu **APPROVE_SCOPED sur le backend fourni**, Web `45a5061..cdfd21d` et Voice `565d434..5fd3149`, sans P1/P2 identifié dans ses pièces. Sa consultation précède les correctifs UI/lisibilité finaux ; elle n'est pas une approbation Oracle de `aa9af81`. Oracle n'a exécuté aucun test.

Le premier contrôleur CLI a échoué avant envoi (`attachment-send-not-ready`). Après preuve de zéro tour, du même brouillon et des trois pièces, l'envoi original a été achevé une seule fois dans son onglet, GPT-6 sélectionné et effort Pro actif. Le résultat terminal a ensuite été récupéré par le harvest officiel ; l'erreur CLI initiale est conservée. La première interprétation d'une limite de quota provenait de texte d'interface inactif : elle a été corrigée, sans changement d'effort ni nouvelle soumission. Le navigateur partagé est resté ouvert.

Oracle réservait son avis sur des dépendances absentes du diff. Inspection source bornée complémentaire : `0016` prend le verrou Workspace dans `lock_binding()` ; les fonctions calendrier `0025` prennent ce verrou avant les commandes, puis les nouveaux triggers verrouillent l'appel. Les transitions agenda examinées modifient des champs surveillés ; les autres champs du bundle sont initialisés à INSERT, modifiés avec l'état, ou expurgés lors de l'effacement. Aucun chemin concret contournant la publication ni inversion nouvelle n'a été identifié. C'est une lecture des chemins actuels, sans nouvelle preuve de concurrence globale ni certification d'acteurs futurs.

Traces externes conservées :

- [Avis Oracle brut](C:/Users/louis/.codex/artifacts/sparra/2026-10-26/inbox-implementation/ORACLE_CODE_ANSWER.md) et [compte rendu de consultation](C:/Users/louis/.codex/artifacts/sparra/2026-10-26/inbox-implementation/ORACLE_CODE_REVIEW.md).
- [Dernière contre-revue](C:/Users/louis/.codex/artifacts/sparra/2026-10-26/inbox-implementation/implementation-evidence/final-re-review-complete.md), rapports, diffs et logs dans le même dossier `implementation-evidence/`.
- [Fiche à 320 px, données fictives](C:/Users/louis/.codex/artifacts/sparra/2026-10-26/inbox-implementation/INBOX_DETAIL_MOBILE_26OCT.png).

## Arbitrages et coûts

| Décision retenue | Motif / coût ou conséquence à surveiller |
|---|---|
| Partir des sources actuelles et conserver l'agenda déjà présent | Un résultat agenda tardif omis rendrait la publication incohérente. |
| Ne pas inventer la clôture des anciens appels | Certains historiques restent provisoires et non classables faute de preuve. |
| Garder C=0 sans instantané avant la première publication réelle | L'appel peut apparaître temporairement sans résumé ni classement. |
| Réserver la garde de clôture à true, permettre false | Sinon une déclaration ne pourrait plus être retirée après l'arrivée d'une pièce provisoire. |
| Bloquer true pour des pièces présentes illisibles, sans bloquer false ni les vrais partiels | Le classement devient temporairement indisponible pendant un incident de déchiffrement ; cela évite de révéler ensuite des demandes à C constant après déclaration. |

## Limites de remise

Commits et worktrees conservés localement. La migration a été exercée sur des ressources jetables ; elle n'a pas été appliquée à une base partagée. Les anciens appels ne reçoivent aucune fausse attestation de collecte. Le retour arrière d'une migration déployée n'a pas été qualifié.

Le skill SDD prévoit la suppression du scratch après revue propre. Le contrôle automatique a refusé la commande groupant archivage et nettoyage (« blocked by policy », sans autre motif). Le dossier ignoré `.superpowers/sdd/2026-10-26-inbox-reliable/` est donc conservé ; la copie des preuves est effectuée séparément sans suppression. Cela n'affecte ni les sources livrées ni les validations.

Aucun push, merge, CI, image, déploiement, appel/replay, écriture Calendar live ou changement de quota/provider. Aucun `.env`, keyring réel ou donnée client n'a été utilisé pour ces validations. Cette remise n'est ni une qualification d'écran lecteur, ni une acceptation complète en production.
