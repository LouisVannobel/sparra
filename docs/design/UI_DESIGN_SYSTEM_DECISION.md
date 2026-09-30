# Choix UI courant — Astryx remplace shadcn

Date : 7 septembre 2026. Décision utilisateur explicite : adopter Astryx comme design system de la future boilerplate SaaS, à la place de shadcn/ui.

## Portée et préséance

Cette décision remplace le choix shadcn de `BOILERPLATE_DESIGN.md` §8.2, §8.7 et §11.1, ainsi que sa reprise dans la synthèse anti-slop. Elle concerne le design system, pas seulement une inspiration visuelle.

Les documents scellés et les rapports précédents restent historiques, inchangés dans leurs conclusions originales. Leurs validations shadcn/Storybook ne qualifient pas Astryx. Le présent changement n'autorise ni installation, migration de code, nouveau dépôt, exécution de plan, CI/CD ou infrastructure. Aucun remplacement global du mot shadcn dans les preuves anciennes.

## Forme minimale retenue

- Astryx est la seule bibliothèque de composants/design tokens choisie pour les nouvelles interfaces. Pas de shadcn maintenu comme second socle ou fallback implicite.
- Consommateurs prévus : les vrais parcours auth/recovery, Workspace, organisations et commerce sélectionné. La vague de probes P1–P5 ne devient pas un chantier UI par ce choix.
- Préférer les composants publiés, leurs points d'entrée ciblés et le CSS précompilé ; un thème au départ, adapté aux besoins du produit. Le thème visuel précis n'est pas choisi par cette décision.
- Tailwind n'est pas remplacé automatiquement : il peut rester une primitive de layout/personnalisation compatible avec les tokens Astryx. Une seule autorité visuelle ; pas de duplication des tokens ou de composants concurrents.
- Pas de wrapper générique autour de chaque composant. Un composant local n'existe que pour un usage métier ou un comportement réellement manquant. Pas de fork/swizzle, source build, plugin StyleX, bibliothèque de charts ou paquet expérimental sans besoin établi.
- Les peer dependencies nécessaires seront vérifiées et pinnées avec le graphe réel. Utiliser le CSS précompilé n'autorise pas à omettre un peer requis ; cela n'impose pas de transformer toute l'application en code StyleX.
- CLI/MCP/init, génération de templates, codemods et docs agents ne sont pas ajoutés automatiquement. Une consultation de référence ciblée peut les justifier plus tard ; aucune génération ne remplace les instructions du projet sans revue.
- FR/EN, mobile 320 px, clavier, focus, erreurs annoncées, contrastes, CSP et budgets de bundle restent des exigences propres au produit. Une promesse d'accessibilité de la bibliothèque ne vaut pas recette de nos parcours.

## Faits vérifiés dans les sources officielles

Au 7 septembre 2026, le [README officiel](https://github.com/facebook/astryx) présente Astryx en bêta, basé sur React 19+ et StyleX. Il décrit des composants React publiés, des thèmes et une personnalisation par CSS variables/className, notamment avec Tailwind. Ce statut n'est pas une validation de stabilité pour notre application.

Le [guide d'installation](https://astryx.atmeta.com/docs/getting-started) déclare React/react-dom >=19, `@astryxdesign/core`, le peer `@stylexjs/stylex` et un thème. Il détaille l'ordre des couches CSS, important avec un reset existant ou Tailwind.

Le [README du package core](https://github.com/facebook/astryx/blob/main/packages/core/README.md) documente une consommation précompilée sans plugin de build pour Vite, et un pont de tokens Tailwind. C'est une piste d'intégration, **pas** une preuve de compatibilité TanStack Start/SSR/hydratation/TypeScript 7 avec nos pins.

Sources consultées sur leur branche/site courant ; aucune version npm n'est déclarée adoptée, aucun benchmark ou test d'intégration exécuté.

## Vérification au moment de la première tranche UI

Dans la recette UI déjà prévue, sur les versions et le lockfile réellement sélectionnés :

1. Une page représentative utilise les composants requis par son parcours, avec thème et navigation TanStack, sans importer un deuxième design system.
2. Typecheck normatif, build de production, SSR/hydratation et ordre du CSS passent ; pas de style manquant ou collision reset/Tailwind.
3. Les interactions réellement utilisées (formulaire, erreurs, menu/dialogue selon le parcours) passent clavier/focus, mobile et FR/EN ; thème clair/sombre uniquement si retenu.
4. Vérifier les imports/bundle, les ressources externes éventuelles et la CSP ; ne pas charger fontes/CDN/analytics parce qu'un exemple documentaire les utilise.

Si un composant nécessaire manque ou échoue, remonter le point concret. Ne pas remettre silencieusement shadcn, ajouter une abstraction universelle, ni considérer le marketing Astryx comme une preuve. Cette vérification s'insère dans la tranche UI existante : pas de nouvelle plateforme de qualification.
