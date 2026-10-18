---
name: update-site
description: Mettre à jour la page de présentation d'AgentUI (docs/index.html, GitHub Pages) — refaire les screenshots desktop/mobile, ajouter un widget ou une fonction à la page, publier. À utiliser quand l'utilisateur veut modifier le site, la landing page ou la page de présentation, rafraîchir ses captures, ou y présenter un nouveau widget.
---

# Mettre à jour le site de présentation

Pages statiques : `docs/index.html` (français), `docs/en/index.html` (anglais) — HTML + CSS + un peu de JS inline, aucune dépendance — et `docs/img/*.webp`, partagées par les deux (l'anglais les référence en `../img/`). Servie par GitHub Pages (branche `main`, dossier `/docs`) ; `docs/.nojekyll` désactive Jekyll. Pas de build : ce qui est dans `docs/` est publié tel quel.

Les captures ne viennent **pas** d'une vraie plateforme : un faux agent (`e2e/demo/fake-agent.mjs`) se connecte à une instance AgentUI jetable et joue des scénarios (graphique, tableau, carte, progression, code, confirmation, formulaire) avec de vrais appels d'outils `agentui_<widget>`. L'UI photographiée est donc toujours celle du code actuel, avec des données fictives et reproductibles.

## 1. Changer le texte ou la mise en page

Éditer `docs/index.html`, **puis reporter le même changement dans `docs/en/index.html`** : les deux pages ont la même structure et doivent rester synchrones (mêmes sections, mêmes images, même ordre). L'interface d'AgentUI n'existant qu'en français, les captures restent françaises dans la version anglaise (le pied de page de l'anglaise le dit). Dans l'anglaise, traduire aussi les `alt` et les commentaires visibles, et garder `../img/`. Un sélecteur de langue (`a.lang`) est dans la navigation des deux pages. Points à connaître :
- Couleurs en variables `:root` (`--bg #0e1015`, `--accent #ff5c5c`, celles de l'app) ; page sombre uniquement.
- Une ligne de widget = `<div class="row">` (copie à gauche, capture à droite) ou `row flip` (inversé). Elle contient `.copy` (kicker, `h3`, `p`, liste, `<span class="tag">agentui_xxx</span>`) et `.shot` (une `.frame` desktop + une `.phone` mobile).
- Les blocs `.reveal` apparaissent au défilement (sans JS ou avec mouvement réduit, tout est visible).
- `REPO_URL` (script en bas, **dans les deux fichiers**) : mettre l'URL du dépôt pour afficher les boutons GitHub (masqués tant qu'elle est vide).
- N'affirmer que ce que le code fait : vérifier dans `apps/web/src/components/` (rendu des widgets), `plugins/protocol/widget-tools.json` (arguments) ou le README avant de promettre une fonction.

## 2. Refaire les screenshots

```sh
DEMO_DIR=<scratchpad>/demo e2e/demo/demo.sh up     # build du front + serveur :8181 + faux agent (demo / demo-pass-123)
node e2e/demo/capture.mjs http://localhost:8181 demo demo-pass-123 <scratchpad>/shots   # ~3 min : 25 PNG
DEMO_DIR=<scratchpad>/demo e2e/demo/demo.sh down
e2e/demo/demo.sh webp <scratchpad>/shots docs/img   # WebP : desktop 1600 px, mobile 600 px (+ hero-desktop / hero-mobile)
```

- Les captures vont dans le scratchpad, jamais dans le dépôt : seuls les `.webp` de `docs/img/` sont versionnés.
- `capture.mjs` joue chaque scénario en desktop sombre (thème par défaut), puis rouvre les discussions en desktop clair, mobile sombre et mobile clair. Le thème se règle par `localStorage.themeMode`.
- **Regarder les images** (outil Read) avant de les garder : widget coupé, titre de discussion périmé, carte sans fond, message d'erreur… Le port 8181 doit être libre (`DEMO_PORT` pour en changer).
- La carte charge ses tuiles OpenStreetMap : il faut du réseau.
- Nom des fichiers = `<desktop|mobile>-<dark|light>-<scénario>.webp` ; `docs/index.html` les référence par ce nom, et vérifier qu'aucun n'est manquant :
  `grep -o 'img/[a-z0-9-]*\.[a-z]*' docs/index.html | sort -u | while read f; do [ -f docs/$f ] || echo MANQUANT $f; done`

### Tâches cron
La section `#taches` de la page s'appuie sur deux choses du faux agent : `JOBS` (réponse au RPC `listJobs`, donc la page « Tâches » : une tâche en erreur, avec `lastError`) et `CRON_MESSAGES` (messages proactifs `outbound` envoyés à la connexion ; un `conversationId` en `cron-…` crée la discussion « ⏰ titre » dans la section « Tâches cron »). `capture.mjs` les photographie via `EXTRA` (`cron` = discussion « Résumé du matin », `jobs` = page `/jobs`). Pour changer le contenu des messages ou des tâches, éditer ces deux constantes puis refaire les captures.

## 3. Présenter un nouveau widget

1. **Scénario** : dans `e2e/demo/fake-agent.mjs`, ajouter un objet à `SCENARIOS` (`match` : regex sur le message, `intro`, `tools: [[type, arguments]]`, `outro`). Widget bloquant (`ask`/`confirm`/`form`) : champ `blocking: [type, arguments]` (le run reste ouvert pendant la capture). Les arguments suivent `plugins/protocol/widget-tools.json`.
2. **Capture** : dans `e2e/demo/capture.mjs`, ajouter l'entrée à `SCENARIOS` (`id`, `prompt` qui déclenche le `match`, `ready` = sélecteur visible quand le widget est affiché, `blocking`) et, si besoin, aux listes `only` des variantes claires/mobile.
3. **Page** (FR et EN) : copier une `.row` existante dans la section `#widgets`, en alternant `flip`, avec les images `desktop-dark-<id>.webp` / `mobile-dark-<id>.webp`.
4. Refaire les captures (étape 2).

## 4. Vérifier avant de publier

- Pour chaque langue, ouvrir la page dans Chromium (Playwright est installé : `playwright-core`, `/usr/bin/chromium`) en 1440 px et 390 px ; faire défiler pour charger les images `loading="lazy"` ; contrôler `document.documentElement.scrollWidth - innerWidth === 0` (pas de débordement horizontal), aucune image cassée (`[...document.images].filter(i => !i.naturalWidth)`) et aucune erreur de console.
- Regarder une capture pleine page (outil Read) : alignement des téléphones superposés, texte lisible sur mobile.
- Poids : `du -sh docs/img` (viser ~1-2 Mo ; ne pas committer de PNG).

## 5. Publier

Commit (`docs/` — français et anglais —, `e2e/demo/` si modifiés) puis push sur `main` : GitHub Pages republie tout seul. Premier déploiement : Settings → Pages → *Deploy from a branch* → `main` / `/docs`. Ne pas pousser sans demande explicite de l'utilisateur.
