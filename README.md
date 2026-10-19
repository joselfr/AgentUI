# AgentUI

Chat PWA for AI agents (Hermes, OpenClaw…) with a persistent backend.

```bash
cp .env.example .env && cp agents.config.example.yaml agents.config.yaml   # then edit
npm install
npm run dev:server   # :8080  (AGENTS_CONFIG, DATA_DIR, ADMIN_USER/ADMIN_PASSWORD, INSECURE_COOKIES=1 on local HTTP)
npm run dev:web      # :5173, proxy to :8080
npm test             # server and web tests
docker compose up --build
```

The interface is available in French and English (automatic from the browser language, or chosen in Settings). Texts live in `apps/web/src/i18n/`.

To add an agent: implement `AgentAdapter` (`apps/server/src/agents/types.ts`), register it in `agents/registry.ts`, declare it in `agents.config.yaml`.

## Agents through a channel plugin
The platform connects to AgentUI the way it connects to Telegram, through a channel plugin: an agent of type `gateway` (token) in `agents.config.yaml`, a plugin installed on the
platform side, a WebSocket connection on `/gateway`. It brings proactive messages (crons, spontaneous sends), filed in
the "Messages from <agent>" chat. Protocol, Hermes / OpenClaw plugins and installation: [`plugins/`](plugins/README.md).

## Miniapps built by the agents
Agents with a channel plugin can build **miniapps** — a React **front** plus server-side **handlers** — shown in the **Miniapps** tab, using the tools
`agentui_miniapp_*` and the guide in [`plugins/protocol/miniapps-guide.md`](plugins/protocol/miniapps-guide.md) (also the `agentui-miniapps` skill).
- Files live in `DATA_DIR/miniapps/<id>/`; the server compiles them with esbuild. Handlers (`server/*.js`) run in an isolated worker,
  namespaced per miniapp (`/api/miniapps/<id>/x/…`) and protected by the AgentUI session; data is stored in SQLite, scoped per miniapp. Handlers can call public HTTP APIs with `ctx.fetch` (private/internal addresses are refused).
- The front runs in a sandboxed iframe (no access to the session cookie). The `@agentui/ui` kit (`packages/app-runtime`, built by
  `npm run build`, served from `APP_RUNTIME_DIST`) gives it React, chart.js, components and the `--au-*` CSS variables of the current theme.
- `node e2e/miniapps.mjs` is the browser E2E (throwaway server + fake plugin).

## Push notifications
Enable them in Settings → "Notify me when an agent replies". They require **HTTPS** (except on `localhost`);
on iPhone, the app must first be added to the home screen. VAPID keys are generated at first start and
kept in the database (`data/agentui.db`): do not delete it, otherwise devices will have to subscribe again.
`VAPID_SUBJECT` (default `mailto:admin@agentui.local`) can be set in `.env`.
Tests: `npm run e2e` (interface) and `npm run e2e:push` (see the header of `e2e/push.mjs`).

## Presentation site
Bilingual static page in [`docs/`](docs/index.html) (French) and [`docs/en/`](docs/en/index.html) (English), published by GitHub Pages (`main` branch, `/docs` folder). To edit it or redo its screenshots: `update-site` skill (`.claude/skills/update-site/SKILL.md`).

## License
MIT, see [`LICENSE`](LICENSE).
