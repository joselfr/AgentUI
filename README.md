# AgentUI

PWA de chat pour agents IA (Hermes, OpenClaw…) avec backend persistant.

```bash
cp .env.example .env && cp agents.config.example.yaml agents.config.yaml   # puis éditer
npm install
npm run dev:server   # :8080  (AGENTS_CONFIG, DATA_DIR, ADMIN_USER/ADMIN_PASSWORD, INSECURE_COOKIES=1 en HTTP local)
npm run dev:web      # :5173, proxy vers :8080
npm test             # tests serveur
docker compose up --build
```

Ajouter un agent : implémenter `AgentAdapter` (`apps/server/src/agents/types.ts`), l'enregistrer dans `agents/registry.ts`, le déclarer dans `agents.config.yaml`.

## Agents par plugin canal
La plateforme se connecte à AgentUI comme à Telegram, via un plugin canal : agent de type `gateway` (token) dans `agents.config.yaml`, plugin installé côté
plateforme, connexion WebSocket sur `/gateway`. Apporte les messages proactifs (crons, envois spontanés), rangés dans
la discussion « Messages de <agent> ». Protocole, plugins Hermes / OpenClaw et installation : [`plugins/`](plugins/README.md).

## Notifications push
Activables dans Réglages → « Notifications quand un agent répond ». Elles exigent **HTTPS** (hors `localhost`) ;
sur iPhone, l'app doit d'abord être ajoutée à l'écran d'accueil. Les clés VAPID sont générées au premier démarrage et
conservées dans la base (`data/agentui.db`) : ne pas la supprimer, sinon les appareils devront se réabonner.
`VAPID_SUBJECT` (défaut `mailto:admin@agentui.local`) peut être défini dans `.env`.
Tests : `npm run e2e` (interface) et `npm run e2e:push` (voir l'en-tête de `e2e/push.mjs`).
