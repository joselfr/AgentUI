# Installing AgentUI

This guide installs everything: the AgentUI server and web app, then the **channel plugin** that connects your agent platform (Hermes Agent or OpenClaw) to it. You can run AgentUI [with Docker](#option-a--docker-recommended) or [without Docker](#option-b--without-docker).

- [How the pieces fit](#how-the-pieces-fit)
- [1. Prepare the configuration](#1-prepare-the-configuration)
- [2. Run AgentUI](#2-run-agentui) — [with Docker](#option-a--docker-recommended) · [without Docker](#option-b--without-docker)
- [3. HTTPS and reverse proxy](#3-https-and-reverse-proxy)
- [4. Connect your agents](#4-connect-your-agents) — [Hermes](#hermes-agent) · [OpenClaw](#openclaw)
- [5. Check that it works](#5-check-that-it-works)
- [Updating, backups, uninstalling](#updating-backups-uninstalling)
- [Troubleshooting](#troubleshooting)

## How the pieces fit

```
 Agent platform (Hermes, OpenClaw…) + channel plugin
                    │  WebSocket, outgoing connection  (ws(s)://<agentui>/gateway)
                    ▼
              AgentUI server  ── SQLite database, attachments, miniapps (DATA_DIR)
                    │  HTTP(S) + WebSocket (/ws)
                    ▼
        Web app (PWA) in your browser or on your phone
```

AgentUI works like a messenger gateway: it never calls your agent. The agent platform's **plugin connects to AgentUI**, authenticates with a **token**, and stays connected. So the machine running the agent must be able to reach AgentUI's address, but AgentUI does not need to reach the agent.

You need:

- a machine to run the AgentUI server (a small VPS or a home server is enough);
- an agent platform: Hermes Agent ≥ 0.19 (validated on 0.21) or OpenClaw ≥ 2026.9.9 (validated on 2026.9.9);
- optionally, a domain name with HTTPS (strongly recommended, required for push notifications and for installing the app on a phone).

## 1. Prepare the configuration

Get the code and create the two configuration files:

```bash
git clone https://github.com/joselfr/AgentUI.git
cd AgentUI
cp .env.example .env
cp agents.config.example.yaml agents.config.yaml
```

### `.env`

Generate secrets (any long random strings work):

```bash
openssl rand -hex 32    # for COOKIE_SECRET
openssl rand -hex 16    # for each agent token (16 characters minimum)
```

Then edit `.env`:

```env
ADMIN_USER=admin
ADMIN_PASSWORD=choose-a-strong-password
COOKIE_SECRET=<64 hex characters>
AGENTUI_HERMES_TOKEN=<32 hex characters>
AGENTUI_OPENCLAW_TOKEN=<32 hex characters>
# INSECURE_COOKIES=1    # only for plain http://localhost, see "HTTPS" below
```

- The administrator account is **created at the first start only**. Changing `ADMIN_USER` / `ADMIN_PASSWORD` afterwards has no effect on the existing account.
- Keep `COOKIE_SECRET` stable: if it changes (or is empty, which makes AgentUI pick a random one), everyone is signed out at each restart.

### `agents.config.yaml`

Declare each agent that will connect. The `${...}` placeholders are read from the environment (`.env`):

```yaml
agents:
  - id: hermes
    type: gateway
    name: Hermes
    token: ${AGENTUI_HERMES_TOKEN}
  - id: openclaw
    type: gateway
    name: OpenClaw
    token: ${AGENTUI_OPENCLAW_TOKEN}
```

Keep only the agents you use. The `token` must be at least 16 characters and is the **same** one you will give the plugin in [step 4](#4-connect-your-agents). If a variable used in this file is missing from the environment, the server refuses to start.

### Other settings (optional)

| Variable | Purpose | Default |
|---|---|---|
| `PORT`, `HOST` | Listening address | `8080`, `0.0.0.0` |
| `DATA_DIR` | Database, attachments and miniapps | `/data` in Docker, `./data` otherwise |
| `AGENTS_CONFIG` | Path of the agents file | `agents.config.yaml` |
| `VAPID_SUBJECT` | Contact for push notifications | `mailto:admin@agentui.local` |
| `PUBLIC_URL` | Public address of AgentUI (e.g. `https://agentui.example.com`), base of the links given to agents by `agentui_miniapp_open` | none: relative links |
| `MINIAPP_FS_ROOTS` | Colon-separated absolute folders that miniapps may ask to read (each one must then be approved in the interface) | none: file access disabled |

## 2. Run AgentUI

### Option A — Docker (recommended)

Requirements: Docker with the Compose plugin.

```bash
docker compose up -d --build
```

That builds the image (the first build takes a few minutes) and serves AgentUI on <http://localhost:8080>. The provided `docker-compose.yml`:

- reads `.env`,
- keeps your data in `./data` (mounted on `/data`),
- mounts `agents.config.yaml` read-only on `/config/agents.config.yaml`,
- restarts the container automatically.

Useful commands:

```bash
docker compose logs -f agentui     # follow the logs
docker compose restart agentui     # after editing .env or agents.config.yaml
docker compose down                # stop (data is kept in ./data)
```

To use another port, change `ports: ["8080:8080"]` (for example `"3000:8080"`). If you plan to open AgentUI on plain `http://` (local test), add `INSECURE_COOKIES=1` to `.env`.

**If your agent platform also runs in Docker**, put it on the same Docker network as AgentUI, so the plugin can reach `ws://agentui:8080/gateway` (the service name replaces the host name). With Compose, either run both in the same project or declare a shared network:

```yaml
services:
  agentui:
    networks: [default, agents]
networks:
  agents:
    external: true     # docker network create agents
```

### Option B — Without Docker

Requirements:

- **Node.js 22.13 or later** (the project declares `>=22.13`; AgentUI uses the built-in `node:sqlite`, which needs no flag from 22.13 on) and npm,
- a build toolchain is **not** required: there are no native dependencies.

```bash
npm install            # installs all workspaces
npm run build          # builds shared, app-runtime, server and web
npm -w @agentui/server run start
```

The server reads `.env` by itself (from the current folder or from the repository root), listens on port 8080 and serves the web app. (Node prints an `ExperimentalWarning` about SQLite: it is harmless, and the `--disable-warning` flag used below hides it.) It looks for `agents.config.yaml` in the repository root, stores its data in `./data` and finds the built web app and the miniapp runtime on its own **when started this way**. If you start it from elsewhere, give absolute paths:

```bash
cd /opt/agentui
NODE_ENV=production \
DATA_DIR=/var/lib/agentui \
AGENTS_CONFIG=/opt/agentui/agents.config.yaml \
WEB_DIST=/opt/agentui/apps/web/dist \
APP_RUNTIME_DIST=/opt/agentui/packages/app-runtime/dist \
node --disable-warning=ExperimentalWarning apps/server/dist/index.js
```

**Keep it running with systemd** (`/etc/systemd/system/agentui.service`). The server reads `/opt/agentui/.env` itself because it is the working directory, so no `EnvironmentFile` is needed:

```ini
[Unit]
Description=AgentUI
After=network-online.target
Wants=network-online.target

[Service]
User=agentui
WorkingDirectory=/opt/agentui
Environment=NODE_ENV=production
Environment=DATA_DIR=/var/lib/agentui
Environment=AGENTS_CONFIG=/opt/agentui/agents.config.yaml
Environment=WEB_DIST=/opt/agentui/apps/web/dist
Environment=APP_RUNTIME_DIST=/opt/agentui/packages/app-runtime/dist
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning apps/server/dist/index.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd --system --home /opt/agentui agentui
sudo mkdir -p /var/lib/agentui && sudo chown agentui: /var/lib/agentui
sudo systemctl enable --now agentui
journalctl -u agentui -f
```

(Adapt the paths and the `node` location: `which node`. The `agentui` user needs read access to `/opt/agentui` and write access to `DATA_DIR`.)

**For development** (auto-reload): `npm run dev:server` (port 8080) and `npm run dev:web` (port 5173, proxies to 8080). On plain HTTP, start the server with `INSECURE_COOKIES=1`.

## 3. HTTPS and reverse proxy

Browsers only keep AgentUI's session cookie over **HTTPS**, and push notifications and the "install the app" prompt need it too (`localhost` is the only exception). So put AgentUI behind a reverse proxy that handles the certificate. Two things to know:

- **WebSockets** must be forwarded: `/ws` (the live updates of the web app) and `/gateway` (the agent plugins).
- Attachments are uploaded in one request of up to about **40 MB**: raise your proxy's body size limit.

**Caddy** (certificates are automatic, WebSockets work out of the box):

```caddyfile
agentui.example.com {
    reverse_proxy localhost:8080
}
```

**nginx**:

```nginx
server {
    listen 443 ssl;
    server_name agentui.example.com;
    # ssl_certificate / ssl_certificate_key …

    client_max_body_size 50m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 1h;
    }
}
```

**Traefik** (Docker labels on the `agentui` service; WebSockets are handled automatically):

```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.agentui.rule=Host(`agentui.example.com`)"
  - "traefik.http.routers.agentui.entrypoints=websecure"
  - "traefik.http.routers.agentui.tls=true"
  - "traefik.http.routers.agentui.tls.certresolver=<your resolver>"
  - "traefik.http.services.agentui.loadbalancer.server.port=8080"
```

Do **not** set `INSECURE_COOKIES=1` in production behind HTTPS. Plugins then connect to `wss://agentui.example.com/gateway`.

## 4. Connect your agents

Each plugin makes the agent platform connect to `…/gateway` with the token declared in `agents.config.yaml`. Use the URL the **agent machine** can reach:

| Situation | Plugin URL |
|---|---|
| Behind HTTPS | `wss://agentui.example.com/gateway` |
| Same machine, no proxy | `ws://127.0.0.1:8080/gateway` |
| Both in Docker, same network | `ws://agentui:8080/gateway` |

### Hermes Agent

Requires Hermes ≥ 0.19. The plugin needs no extra dependency.

1. Copy the plugin files (from the AgentUI repository) to Hermes' plugin folder:

   ```bash
   mkdir -p ~/.hermes/plugins/agentui
   cp plugins/hermes-agentui/{plugin.yaml,__init__.py,adapter.py,widget_tools.json} ~/.hermes/plugins/agentui/
   hermes plugins enable agentui-platform      # plugins are opt-in
   ```

   `widget_tools.json` must sit next to `adapter.py`: it holds the tools the agent gets. If Hermes runs in Docker, copy the files into the plugin folder of its data volume instead (for example `<hermes data>/plugins/agentui/`), keeping the files readable by the container user.

2. Add the connection to Hermes' `.env` (`~/.hermes/.env`, or the one mounted in the container):

   ```env
   AGENTUI_URL=wss://agentui.example.com/gateway
   AGENTUI_TOKEN=<the same token as AGENTUI_HERMES_TOKEN>
   # AGENTUI_NAME=Hermes                 # display name in AgentUI
   # AGENTUI_HOME_CHANNEL=…              # chat that receives cron deliveries (default: "home")
   ```

3. Hermes shows a progress bubble for every tool by default, which duplicates what AgentUI already displays. Turn it off for this platform and keep streaming on:

   ```bash
   hermes config set display.platforms.agentui.tool_progress off
   hermes config set display.platforms.agentui.streaming true
   ```

4. **Restart the Hermes gateway** (the plugin is only loaded at startup; with Docker, restart the container). `hermes gateway status` must list **AgentUI**.

Crons delivered with `deliver=agentui` arrive in AgentUI's "Messages from Hermes" chat. With several Hermes profiles, each profile runs its own gateway and needs its own connection.

### OpenClaw

Requires OpenClaw ≥ 2026.9.9. The package must be **compiled** before installing, because OpenClaw needs the JavaScript (`dist/`), which is not versioned:

```bash
cd plugins/openclaw-agentui
npm install
npm run build
cd ../..
openclaw plugins install ./plugins/openclaw-agentui --force
openclaw config set channels.agentui.url wss://agentui.example.com/gateway
openclaw config set channels.agentui.token <the same token as AGENTUI_OPENCLAW_TOKEN>
# openclaw config set channels.agentui.name OpenClaw
```

OpenClaw applies the installation and the configuration **without a restart**. `openclaw channels status` must show **AgentUI** connected.

If OpenClaw runs in Docker, `plugins install` runs inside the container, which cannot see your checkout (or cannot traverse `/root`). Copy the **compiled** folder into the container and install it from there, as the container's user:

```bash
docker cp plugins/openclaw-agentui openclaw:/tmp/agentui-plugin
docker exec -u root openclaw chown -R node /tmp/agentui-plugin
docker exec -u node openclaw openclaw plugins install /tmp/agentui-plugin --force
docker exec -u node openclaw openclaw config set channels.agentui.url ws://agentui:8080/gateway
docker exec -u node openclaw openclaw config set channels.agentui.token <token>
```

(Adjust the container name and user. Do not install npm dependencies in the installed plugin: it must only rely on what OpenClaw provides.)

Each AgentUI conversation becomes an isolated session on the platform side (the plugin enforces `dmScope: "per-channel-peer"`).

## 5. Check that it works

1. Open AgentUI (`https://agentui.example.com`, or <http://localhost:8080>) and sign in with `ADMIN_USER` / `ADMIN_PASSWORD`.
2. In the top right corner of a conversation, the agent name shows a **green dot** once its plugin is connected. (You can also check the **Agents** page.)
3. Start a new conversation with that agent and ask something visual: *"Show me a chart of monthly sales with made-up numbers."* The agent should answer with an interactive chart.
4. Optional: in **Settings**, enable *"Notify me when an agent replies"* (HTTPS required; on iPhone, add the app to the home screen first).

On the server side, the logs show `channel plugin connected` when a plugin connects.

## Updating, backups, uninstalling

**Update**

```bash
git pull
docker compose up -d --build            # Docker
# or, without Docker:
npm install && npm run build && sudo systemctl restart agentui
```

Then **update the plugins too**: the schema and the description of every tool the agent receives live in the plugin, so a new AgentUI may bring new tools. Copy the Hermes files again and restart Hermes; rebuild (`npm run build` in `plugins/openclaw-agentui`) and run `openclaw plugins install … --force` again for OpenClaw. After an update, reload the web app (Ctrl+Shift+R) so the browser drops its cached version.

**Backup**: everything lives in `DATA_DIR` (`./data` with Docker): `agentui.db` (conversations, users, push keys), attachments and miniapps. Stop the server (or copy while it is idle) and archive that folder. Do not delete `agentui.db` casually: it also holds the push notification keys, and devices would have to subscribe again.

**Uninstall**: stop the server, remove the plugin on the agent side (Hermes: disable `agentui-platform` and delete its plugin folder; OpenClaw: uninstall the `agentui` plugin with `openclaw plugins`), then delete the AgentUI folder and its data.

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| The login works but you are signed out immediately, or cannot stay signed in | The cookie is `Secure` and you are on plain `http://`. Use HTTPS, or `INSECURE_COOKIES=1` for a local test. |
| `No user: set ADMIN_USER and ADMIN_PASSWORD on first start.` | The first start needs both variables (the database is empty). |
| `Configuration file not found` or a missing `${VARIABLE}` at startup | `agents.config.yaml` is missing or not mounted (`AGENTS_CONFIG`), or a variable it uses is not defined in `.env`. |
| `No such built-in module: node:sqlite` or a flag error | Node.js is too old. Use 22.13 or later. |
| Blank page, or a 404 on `/` | The web app is not built (`npm run build`) or `WEB_DIST` points to the wrong folder. |
| Custom widgets or miniapps stay empty | The miniapp runtime is not built, or `APP_RUNTIME_DIST` is wrong (it is `packages/app-runtime/dist`). |
| The agent never gets a green dot | Check the URL (`wss://` behind HTTPS, `ws://` otherwise), that the token is **identical** on both sides, that your proxy forwards WebSockets on `/gateway`, and that Hermes was restarted after adding the plugin. The AgentUI logs show rejected connections. |
| Hermes starts but AgentUI is not listed | `hermes plugins enable agentui-platform` was not run, a file of the plugin is missing (`widget_tools.json`), or `AGENTUI_URL` / `AGENTUI_TOKEN` are not in the `.env` Hermes reads. |
| `Plugin path not found` with OpenClaw in Docker | The container cannot see your folder: use the `docker cp` method above. |
| Uploading a large attachment fails | Raise the proxy's body size limit (about 40 MB are accepted). |
| No push notifications | They need HTTPS, a subscribed device (Settings), and on iPhone the app added to the home screen. |
