---
name: update-site
description: Update AgentUI's presentation page (docs/index.html, GitHub Pages) — redo the desktop/mobile screenshots, add a widget or a feature to the page, publish. Use when the user wants to edit the site, the landing page or the presentation page, refresh its screenshots, or present a new widget on it.
---

# Update the presentation site

Static pages: `docs/index.html` (French), `docs/en/index.html` (English) — HTML + CSS + a bit of inline JS, no dependency — and `docs/img/*.webp`, shared by both (the English page references them as `../img/`). Served by GitHub Pages (`main` branch, `/docs` folder); `docs/.nojekyll` disables Jekyll. No build: what is in `docs/` is published as is.

The screenshots do **not** come from a real platform: a fake agent (`e2e/demo/fake-agent.mjs`) connects to a throwaway AgentUI instance and plays scenarios (chart, table, map, progress, code, confirmation, form) with real `agentui_<widget>` tool calls. The photographed UI is therefore always that of the current code, with fictional and reproducible data.

## 1. Change the text or the layout

Edit `docs/index.html`, **then carry the same change over to `docs/en/index.html`**: both pages have the same structure and must stay in sync (same sections, same images, same order). The English page uses its own captures in `docs/img/en/` (English interface and demo content, see section 2), referenced as `../img/en/…`; only `icon.svg` stays shared (`../img/icon.svg`). In the English page, also translate the `alt` attributes and the visible comments. A language switcher (`a.lang`) is in the navigation of both pages. Things to know:
- Colors as `:root` variables (`--bg #0e1015`, `--accent #ff5c5c`, those of the app); dark page only.
- A widget row = `<div class="row">` (copy on the left, capture on the right) or `row flip` (reversed). It contains `.copy` (kicker, `h3`, `p`, list, `<span class="tag">agentui_xxx</span>`) and `.shot` (one desktop `.frame` + one mobile `.phone`).
- `.reveal` blocks appear on scroll (without JS or with reduced motion, everything is visible).
- `REPO_URL` (script at the bottom, **in both files**): set the repository URL to show the GitHub buttons (hidden while it is empty).
- Only claim what the code does: check `apps/web/src/components/` (widget rendering), `plugins/protocol/widget-tools.json` (arguments) or the README before promising a feature.

## 2. Redo the screenshots

```sh
DEMO_DIR=<scratchpad>/demo e2e/demo/demo.sh up     # front build + server :8181 + fake agent (demo / demo-pass-123)
node e2e/demo/capture.mjs http://localhost:8181 demo demo-pass-123 <scratchpad>/shots   # ~3 min: 25 PNGs
DEMO_DIR=<scratchpad>/demo e2e/demo/demo.sh down
e2e/demo/demo.sh webp <scratchpad>/shots docs/img   # WebP: desktop 1600 px, mobile 600 px (+ hero-desktop / hero-mobile)
```

**English captures** (`docs/img/en/`, used by `docs/en/`): same steps with `DEMO_LANG=en` for the fake agent (it then plays `e2e/demo/content.en.mjs` instead of `content.fr.mjs`) and the `en` argument for the capture script (English interface, English prompts):
```sh
DEMO_LANG=en DEMO_DIR=<scratchpad>/demo e2e/demo/demo.sh up
node e2e/demo/capture.mjs http://localhost:8181 demo demo-pass-123 <scratchpad>/shots-en en
DEMO_DIR=<scratchpad>/demo e2e/demo/demo.sh down
e2e/demo/demo.sh webp <scratchpad>/shots-en docs/img/en
```
When the demo content changes (scenarios, jobs, cron messages), edit **both** `content.fr.mjs` and `content.en.mjs`, and the prompts / UI labels of `TEXT` in `capture.mjs` if needed.

- Captures go to the scratchpad, never into the repository: only the `.webp` files of `docs/img/` are versioned.
- `capture.mjs` plays each scenario in dark desktop (default theme), then reopens the chats in light desktop, dark mobile and light mobile. The theme is set through `localStorage.themeMode`.
- **Look at the images** (Read tool) before keeping them: cut-off widget, stale chat title, map without background, error message… Port 8181 must be free (`DEMO_PORT` to change it).
- The map loads its OpenStreetMap tiles: network access is needed.
- File name = `<desktop|mobile>-<dark|light>-<scenario>.webp`; `docs/index.html` references them by that name, and check that none is missing:
  `grep -o 'img/[a-z0-9-]*\.[a-z]*' docs/index.html | sort -u | while read f; do [ -f docs/$f ] || echo MISSING $f; done`

### Cron tasks
The `#taches` section of the page relies on two things in the fake agent: `JOBS` (in `content.<lang>.mjs`; answer to the `listJobs` RPC, hence the "Tasks" page: one task in error, with `lastError`) and `CRON_MESSAGES` (also in `content.<lang>.mjs`; proactive `outbound` messages sent to the connection; a `conversationId` starting with `cron-…` creates the "⏰ title" chat in the "Cron tasks" section). `capture.mjs` photographs them through `EXTRA` (`cron` = "Résumé du matin" chat, `jobs` = `/jobs` page). To change the content of the messages or tasks, edit these two constants then redo the captures.

## 3. Present a new widget

1. **Scenario**: in `e2e/demo/fake-agent.mjs`, add an object to `SCENARIOS` (`match`: regex on the message, `intro`, `tools: [[type, arguments]]`, `outro`). Blocking widget (`ask`/`confirm`/`form`): `blocking: [type, arguments]` field (the run stays open during the capture). Arguments follow `plugins/protocol/widget-tools.json`.
2. **Capture**: in `e2e/demo/capture.mjs`, add the entry to `SCENARIOS` (`id`, `prompt` that triggers the `match`, `ready` = selector visible once the widget is displayed, `blocking`) and, if needed, to the `only` lists of the light/mobile variants.
3. **Page** (FR and EN): copy an existing `.row` into the `#widgets` section, alternating `flip`, with the `desktop-dark-<id>.webp` / `mobile-dark-<id>.webp` images.
4. Redo the captures (step 2).

## 4. Check before publishing

- For each language, open the page in Chromium (Playwright is installed: `playwright-core`, `/usr/bin/chromium`) at 1440 px and 390 px; scroll to load the `loading="lazy"` images; check `document.documentElement.scrollWidth - innerWidth === 0` (no horizontal overflow), no broken image (`[...document.images].filter(i => !i.naturalWidth)`) and no console error.
- Look at a full-page capture (Read tool): alignment of the overlapping phones, text readable on mobile.
- Weight: `du -sh docs/img` (aim for ~1-2 MB; do not commit PNGs).

## 5. Publish

Commit (`docs/` — French and English —, `e2e/demo/` if modified) then push to `main`: GitHub Pages republishes by itself. First deployment: Settings → Pages → *Deploy from a branch* → `main` / `/docs`. Do not push without an explicit request from the user.
