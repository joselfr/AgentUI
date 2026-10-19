# AgentUI channel plugins

AgentUI plays the role of the **gateway**, like Telegram for a bot: the agent platforms are the ones that connect to it,
through a channel plugin that translates their specifics into a single protocol.

| Folder | Content |
|---|---|
| [`SPIKE.md`](SPIKE.md) | Feasibility study: Hermes / OpenClaw capability matrix, APIs used, risks |
| [`protocol/`](protocol/PROTOCOL.md) | **AgentUI Channel Protocol v1** (`PROTOCOL.md` + `channel.schema.json`) |
| [`hermes-agentui/`](hermes-agentui/) | Hermes Agent platform plugin (Python) |
| [`openclaw-agentui/`](openclaw-agentui/) | OpenClaw channel plugin (TypeScript) |
| [`dev/mock-gateway.mjs`](dev/mock-gateway.mjs) | Interactive fake AgentUI to test a plugin without the app |

Deleting a chat in AgentUI asks the plugin to erase the matching session on the platform side (`rpc
deleteSession`, `sessionDelete` capability): the chat is only erased locally **if** the plugin confirmed. An agent
whose plugin cannot do it — direct adapters, plugin not yet updated — refuses the deletion (explicit message,
chat kept); a chat without a platform-side session (never used, or "home") can be deleted normally.

On the AgentUI side: declare the agent in `agents.config.yaml` (`type: gateway`, `token` of at least 16 characters).
The plugin connects to `ws(s)://<agentui>/gateway`; in Docker on the same network: `ws://agentui:8080/gateway`.
The old direct adapters (`hermes` via api_server, `openclaw` via the operator WebSocket) were removed.

The `chart`, `map` and `code` widgets are also exposed as plugin tools (`agentui_widget_chart`, `agentui_widget_map`, `agentui_widget_code`,
see `SPIKE.md`), and the interactive widgets `ask`, `confirm` and `form` as **blocking** tools (`agentui_ask`,
`agentui_confirm`, `agentui_form`: the tool displays the widget, waits for the `reply` frame and returns the user's answer
to the agent, without ending its turn). Their schemas are in `protocol/widget-tools.json`: after editing, run
`node plugins/sync-widget-tools.mjs` to copy them into both plugins (Hermes: the `widget_tools.json` file must be
copied along with `adapter.py`).

The **miniapp** tools (`agentui_miniapp_guide`, `agentui_miniapp_create`, `agentui_miniapp_write`, …; `miniappTools` section of the same file) let an
agent build miniapps (a React front + server-side handlers) shown in AgentUI's **Miniapps** tab. They are relayed to the server with the
`miniapp.op` / `miniapp.result` frames; the guide the agent reads is `protocol/miniapps-guide.md` (the sync script embeds it in each plugin and
publishes it as the `agentui-miniapps` skill in `.claude/skills/`).

## Test a plugin without AgentUI (fake server)

```bash
AGENTUI_TOKEN=dev node plugins/dev/mock-gateway.mjs --port 8790
# then type a message; /new for a new chat (= new session on the agent side),
# /agent [name] to pick the targeted agent (several plugins can be connected),
# /abort, /approve [once|session|always], /deny, /attach <file>, /rpc <method> [json]
# (e.g. /rpc listSubAgents; /rpc deleteSession = erases the session of the current chat)
```

The URL to give to the plugins is `ws://<host>:8790/gateway`. If the agent runs on another server, open a tunnel,
for example `ssh -R 8790:127.0.0.1:8790 root@jlfr.io`, then use `ws://127.0.0.1:8790/gateway` on the server side.

## Hermes Agent (≥ 0.19, validated on 0.21)

```bash
cp plugins/hermes-agentui/{plugin.yaml,__init__.py,adapter.py,widget_tools.json} ~/.hermes/plugins/agentui/
hermes plugins enable agentui-platform     # plugins are opt-in
```

`~/.hermes/.env`:

```env
AGENTUI_URL=wss://agentui.example.com/gateway
AGENTUI_TOKEN=…            # agent token in AgentUI's agents.config.yaml
# AGENTUI_NAME=Hermes
```

The plugin enables streaming by default and turns off the tool progress bubbles for the platform. But a
**global** `display.tool_progress` setting in `config.yaml` takes precedence: in that case, set it for the platform:

```bash
hermes config set display.platforms.agentui.tool_progress off
hermes config set display.platforms.agentui.streaming true
```

Restart `hermes gateway`; `hermes gateway status` must list **AgentUI**. `deliver=agentui` crons arrive in
AgentUI's "home" chat (`AGENTUI_HOME_CHANNEL` to choose another one). With several profiles, each
profile runs its own gateway and therefore its own connection.

Integration test, against the real `BasePlatformAdapter` class, in an environment where Hermes is installed:

```bash
<Hermes python> plugins/hermes-agentui/tests/test_adapter.py
```

## OpenClaw (≥ 2026.9.9, validated on 2026.9.9)

Installing a package requires compiled JavaScript (`dist/`, not versioned):

```bash
cd plugins/openclaw-agentui && npm install && npm run build
openclaw plugins install ./plugins/openclaw-agentui --force
openclaw config set channels.agentui.url wss://agentui.example.com/gateway
openclaw config set channels.agentui.token …
```

The gateway applies the installation and configuration hot; `openclaw channels status` must show **AgentUI** connected. Each AgentUI chat is an
isolated direct peer (the plugin enforces `dmScope: "per-channel-peer"`). The sub-agent chosen in AgentUI is passed as the
route's default agent; configuration bindings keep priority.

Development:

```bash
cd plugins/openclaw-agentui
npm install            # openclaw (types) + typescript
npm run typecheck      # against the real SDK types
npm test               # simulated OpenClaw runtime + fake AgentUI
```

## Known limits

- **Hermes**: reasoning arrives as one block at the end of the turn (`post_llm_call` hook), not streamed.
- **OpenClaw**: sub-agents not relayed yet (`subagents: false`); approvals through the `/approve` command in the same chat
  (the native `approvalCapability` remains to be done).
- Neither platform exposes the list of sessions, skills or jobs to channels: AgentUI relies on
  its own message database.
- Direct sends: target = AgentUI chat id or `home` (`openclaw message send --channel agentui --target home …`).
  Outside the gateway process (CLI, isolated cron), both plugins open a one-off `send-only` connection.

## Validation on jlfr.io (2026-10-15)

Fake AgentUI launched on the server (`agentui-mock` in `media_default`), plugins installed in the real instances,
then everything restored (configs restored identically, plugins uninstalled).

| Scenario | Hermes 0.21.0 | OpenClaw 2026.9.9 |
|---|---|---|
| Connection, reconnection after a server cut | ✅ | ✅ |
| Real tool: card with arguments + result, streamed text, reply, end | ✅ | ✅ |
| Isolated threads (a word given in thread A, unknown in thread B, found again in A) | ✅ | ✅ |
| Stop mid-tool (`sleep 120` interrupted, `run.aborted`) | ✅ | ✅ |
| Reasoning | ✅ (at end of turn) | not observed with the current model |
| Proactive message | ✅ cron `--deliver agentui` | ✅ `openclaw message send` |
| Approval | ⚠️ not triggered: the server auto-approves ("smart approval"); covered by the tests | ⚠️ no approval request during the trials; covered by the tests |

Defects found and fixed during validation: Hermes 0.21 streaming (going through `send`/`edit_message`),
`allow_session` argument added in 0.21, tool bubbles despite the plugin's default (global setting), OpenClaw package without
`dist/`, unresolved direct-send targets, send from the CLI outside the gateway.

## In production on jlfr.io (2026-10-15)

Agents `hermes-canal` and `openclaw-canal` declared in `config/agentui/agents.config.yaml` (generated tokens, file mode
640), next to the unchanged `hermes` and `openclaw`. Plugins installed: `config/hermes-agent/plugins/agentui` (+
`AGENTUI_URL`/`AGENTUI_TOKEN` in its `.env`, `display.platforms.agentui.*`) and the OpenClaw `agentui` extension
(`channels.agentui.*`). Verified through AgentUI's API: the 4 agents connected, a message with a tool handled by each
channel, a Hermes cron and an OpenClaw send delivered in "Messages from …".

Then, the same day, propagated deletion: `apps/agentui` rebuilt, the Hermes plugin's `adapter.py` replaced
(`hermes-agent` restarted, backup `adapter.py.bak-session-delete`) and the OpenClaw extension reinstalled hot
(`plugins install … --force`, no restart). The deprecated direct adapters were removed from the
configuration. Verified on a throwaway chat of each channel: the chat deleted in the app disappears from its
database and its platform session with it — no more `sessions` row in Hermes, a single session key erased
in OpenClaw (the others intact).
