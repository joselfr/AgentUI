---
name: design-widget
description: Concevoir un nouveau widget AgentUI (composant rendu dans le chat, fourni à l'agent par un outil de plugin) — maquette HTML, validation par l'utilisateur, puis implémentation. À utiliser quand l'utilisateur veut créer, ajouter ou imaginer un widget pour les agents.
---

# Concevoir un widget AgentUI

Un widget est un composant du chat, rendu par le front à partir d'un bloc de code Markdown de langage `widget`. L'agent ne l'écrit pas à la main : un outil de plugin `agentui_<type>` valide ses arguments (schéma JSON) et le fait apparaître. Le front reçoit :

```widget
{"type": "<nom>", "arguments": { … }}
```

Types existants : `chart`, `map`, `code` (outils d'affichage, qui renvoient un jeton) ; `ask`, `confirm`, `form` (outils **bloquants**, qui attendent la réponse de l'utilisateur). Tout le JSON suit ce même format : `type` + `arguments`, jamais de Markdown ni de clé/valeur libre.

**Ordre obligatoire : maquette → validation de l'utilisateur → implémentation.** Ne pas écrire de code dans `apps/` avant un « oui » explicite sur la maquette.

## 1. Cadrer (court)

Si l'intention est floue, poser au plus une question groupée. Sinon, choisir et annoncer :
- le `type` (un mot, minuscule, anglais comme les existants) ;
- le rôle : affichage seul (comme `chart`) ou interactif avec réponse (comme `ask`, `confirm`) ;
- les `arguments` : noms, types, obligatoires ou non, valeurs par défaut. Nommer les clés sans réutiliser `type` (conflit avec le widget ; ex. `kind` pour `chart`) ;
- pour un widget interactif : ce que l'utilisateur renvoie. La réponse part comme un **message texte** (libellé du bouton, valeurs séparées par des virgules, ou une ligne `Libellé: valeur` par champ), car c'est ce que l'outil renvoie à l'agent en résultat `{"answer": …}` ; le widget se fige ensuite en lisant le message utilisateur suivant (`answer`).

## 2. Maquette

Créer `mockups/<type>/<type>.html` (page autonome, un seul fichier, sans dépendance externe), en reprenant `mockups/confirm-chart/confirm-chart.html` comme modèle :
- les tokens de `apps/web/src/theme.ts` (clair et sombre, `prefers-color-scheme` + bouton de bascule) ;
- à gauche le bloc `widget` exact que l'agent écrirait, à droite le rendu dans une bulle de chat ;
- tous les états : actif, répondu/figé, variante (ex. `danger`), cas limites (liste vide, valeurs longues, une seule série) ;
- le repli : JSON invalide ou arguments manquants → bloc de code brut ;
- rendu correct sur mobile (≈ 390 px).

Générer les captures avec le Chromium système et `playwright-core` (déjà dans `node_modules`, voir `e2e/front.mjs`) : `mockups/<type>/maquettes-clair.png` et `maquettes-sombre.png`. **Regarder les captures** (Read sur le PNG) et corriger avant de les présenter.

## 3. Confirmation par l'utilisateur

Présenter : le JSON des arguments, les états montrés, les choix faits (et ceux restant ouverts), les chemins des fichiers. Poser la question via AskUserQuestion avec les options *Valider et implémenter* / *Modifier la maquette* / *Abandonner*. Itérer sur la maquette tant que ce n'est pas validé. Ne jamais déduire un accord du silence.

## 4. Implémentation (après validation seulement)

1. **Composant** `apps/web/src/components/<Type>Card.tsx`, sur le modèle de `ConfirmCard.tsx` (interactif) ou `ChartCard.tsx` (affichage) :
   - exporter `parse<Type>(args: Record<string, unknown>)` qui valide et renvoie `undefined` si invalide ;
   - styles MUI et tokens du thème (`useTheme`, `primary`, `divider`…), pas de couleur en dur sauf palette de séries ;
   - interactif : props `answer?` et `onAnswer?` ; sans `onAnswer` le widget est figé.
2. **Branchement** dans `apps/web/src/components/chat/MessageBubble.tsx` : un `if (w?.type === '<type>')` à côté des autres. Le rendu n'a lieu que si `m.status !== 'streaming'`.
3. **Outil de plugin, sans convention Markdown ni instructions** : l'agent connaît le widget par la description de l'outil (il n'existe plus d'instructions d'interface injectées). Ajouter une entrée dans `plugins/protocol/widget-tools.json` (description, schéma des `arguments`), puis lancer `node plugins/sync-widget-tools.mjs` :
   - **widget d'affichage** → section `tools` ; ajouter le type à `DISPLAY_WIDGETS` (`apps/web/src/components/widget.ts`) ; contrôle sémantique éventuel dans `_widget_error` (Hermes, `adapter.py`) et `widgetError` (OpenClaw, `src/widget-tools.ts`). L'outil renvoie un jeton `[[agentui:<id>]]` que le front remplace par le widget ;
   - **widget interactif** → section `blockingTools`, avec la phrase « L'outil BLOQUE jusqu'à la réponse… » dans la description ; contrôle sémantique dans `_ask_error` (Hermes) et `askError` (OpenClaw). Aucun autre code plugin : l'outil émet `question.requested`, ajoute le bloc ```` ```widget ```` au texte, attend la trame `reply` et renvoie la réponse (voir `plugins/protocol/PROTOCOL.md`). Ne pas inscrire le type dans `DISPLAY_WIDGETS` : le bloc est dans le texte du message.
4. **Tests des plugins** : OpenClaw (`cd plugins/openclaw-agentui && npm test`, étendre le test « outils-widgets » : la liste des noms d'outils change) ; Hermes (`plugins/hermes-agentui/tests/test_adapter.py`, avec le Python d'une installation Hermes ≥ 0.21).
5. **Déploiement des plugins** : les schémas vivent dans les plugins, pas dans l'app. Sans réinstaller `hermes-agentui` (`adapter.py` + `widget_tools.json`) et `openclaw-agentui` (build, `plugins install --force`) sur le serveur, les agents n'ont pas l'outil (voir `deploy-jlfr`, avec accord de l'utilisateur pour toucher Hermes et OpenClaw).
6. **Vérifier** : `npx tsc --noEmit -p apps/web`, `npx tsc --noEmit -p apps/server`, `npm test`, les tests des plugins, puis `npm run build`. Contrôler le rendu réel dans un navigateur si possible (serveur local sur le port 8080).

## 5. Fin

Résumer ce qui a été fait et ce qui n'a **pas** été vérifié (notamment : un vrai modèle choisit-il l'outil ?). Ne commiter et ne déployer que sur demande (déploiement : skill `deploy-jlfr`, voir la mémoire du projet pour les pièges).
