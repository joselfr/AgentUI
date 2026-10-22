# AgentUI Channel Protocol — v1

Protocol between AgentUI (the "gateway", like Telegram for a bot) and a **channel plugin** installed in an agent platform
(Hermes, OpenClaw…). JSON schema: [`channel.schema.json`](channel.schema.json).

## Transport

- WebSocket, **opened by the plugin** towards AgentUI: `wss://<agentui>/gateway` (ws:// locally).
- One frame = one JSON text object, with a `type` field.
- The plugin authenticates in its first message (`hello.token`). AgentUI closes with code **4001** if the token is
  invalid, and **4002** if the protocol version is not supported.
- The plugin reconnects by itself (exponential backoff capped at 30 s). AgentUI sends `ping` every 30 s; the
  plugin answers `pong`.

## Plugin → AgentUI messages

| `type` | Fields | Role |
|---|---|---|
| `hello` | `protocol: 1`, `token`, `agent: { type, name, version }`, `capabilities`, `subAgents?: [{ id, name, description?, isDefault? }]`, `activeRuns?: [{ runId, conversationId }]`, `mode?: "send-only"` | First message. `capabilities` reuses AgentUI's `Capabilities` type. `activeRuns` lists the runs still in progress after a reconnection: AgentUI reattaches them instead of marking them failed. `mode: "send-only"`: ephemeral connection (cron run outside the main process) that only sends `outbound` and **does not replace** the main connection. |
| `event` | `conversationId`, `runId`, `event` | A run event, in AgentUI's `AgentEvent` format (see below). |
| `outbound` | `id`, `conversationId?`, `title?`, `text?`, `media?: Media[]` | **Proactive message** (cron, reminder, `send_message` tool…) outside any run. Without `conversationId`, AgentUI files it in the agent's "home" chat. `title`: proposed title if the chat has to be created (e.g. "⏰ task-name" for a cron). |
| `rpc.result` | `id`, `result?` \| `error?` | Answer to an `rpc`. |
| `miniapp.op` | `id`, `op`, `args?` | Operation on the agent's **miniapps** (Miniapps tab): `create`, `write`, `read`, `list`, `delete_file`, `remove`, `logs`, `open`, `data`. Answer: `miniapp.result`. An agent only touches its own apps. |
| `notify` | `id`, `title`, `body?`, `url?` | **Push notification** to the user's devices (backs the `agentui_notify` tool). `url`: opened on tap — an AgentUI path (`/…`) or an `https://` URL (default `/`). Answer: `notify.result`. |
| `thread.get` | `id`, `conversationId` | Current **title** of the chat (backs the `agentui_get_thread_title` tool). Answer: `thread.result`. |
| `pong` | — | Answer to `ping`. |

## AgentUI → plugin messages

| `type` | Fields | Role |
|---|---|---|
| `welcome` | `protocol: 1`, `miniapps?: true`, `notify?: true` | Accepts the `hello`. `miniapps: true`: the server handles `miniapp.op` frames; `notify: true`: it handles `notify` frames. |
| `inbound` | `conversationId`, `runId`, `text`, `subAgentId?`, `attachments?: Media[]` | User message. **Each `conversationId` is a distinct chat** for the platform, hence a distinct session (multiple threads). The `runId` is chosen by AgentUI. |
| `abort` | `conversationId`, `runId` | Stop the run. |
| `reply` | `conversationId`, `runId`, `text` | User answer to a question the agent asks **mid-run** (announced by `question.requested`). The plugin hands it to the waiting agent: the run continues and ends normally, it is not a new `inbound`. Optional: AgentUI only sends it while a question is open. |
| `approval` | `conversationId`, `runId`, `id`, `approve: boolean`, `scope?: "once" \| "session" \| "always"` | Answer to an `approval.request`. |
| `rpc` | `id`, `method`, `params?` | Optional call. Unknown method: `rpc.result` with `error`. Methods: `listSubAgents` → `[{ id, name, description?, isDefault? }]`; `listJobs {subAgentId?}` → `[{ id, name, schedule, mode?: agent\|script, prompt?, script?, enabled, nextRunAt?, lastRunAt?, lastStatus? }]` (if `capabilities.jobs`); `readJobScript {jobId}` → `{ name, content }` (source of the task's script, if `capabilities.jobs`); `jobAction {jobId, action: pause\|resume\|run\|delete}` → `{ ok: true }` (if `capabilities.jobControl`); `listSkills {subAgentId?}` → `[{ id, name, description?, category?, enabled? }]` (if `capabilities.skills`); `readSkill {skillId, subAgentId?}` → `{ content }` (Markdown of the skill, if `capabilities.skills`); `deleteSession {conversationId}` → `{ ok: true }` (if `capabilities.sessionDelete`); `listModels` → `[{ provider, providerName, id }]`, `setModel {conversationId, model, provider?, subAgentId?}` → `{ model, provider?, message? }` and `sessionUsage {conversationId, subAgentId?}` → `Usage` or `null` (if `capabilities.models`). Dates in milliseconds. |
| `miniapp.result` | `id`, `ok`, `result?` \| `error?` | Answer to a `miniapp.op`. `ok: false`: `error` is a message readable by the agent (invalid id, miniapp of another agent…). A failing build is **not** an error: `ok: true` with `result = { ok: false, errors: [{ file, line, message }] }`. |
| `notify.result` | `id`, `ok`, `result?` \| `error?` | Answer to a `notify`. `result = { sent, note? }` (`sent`: devices reached; `0` if none is subscribed). |
| `thread.result` | `id`, `ok`, `result?: { title }` \| `error?` | Answer to a `thread.get`. |
| `ping` | — | Keep-alive. |

## Events (`event.event`)

Identical to the `AgentEvent` type of `packages/shared` (a single exception: `message.media`):

| `type` | Fields |
|---|---|
| `message.delta` | `text` (increment) |
| `message.final` | `text` (full text of the message; replaces the accumulated deltas) |
| `reasoning.delta` | `text` |
| `tool.started` | `id`, `name`, `args?`, `parentSubAgentRunId?` |
| `tool.completed` | `id`, `name?`, `result?`, `truncated?`, `failed?` |
| `subagent.start` / `subagent.sync` / `subagent.end` | `id`, `name`, `sessionId?` / `id` / `id`, `failed?` |
| `message.media` | `name`, `mimeType`, `data` (base64) — **instead of `url`**: the plugin pushes the content (45 MB at most). AgentUI checks the real type from the content and shows the attachment in the matching player (images in one gallery, video, audio, PDF, Markdown), or as a download chip for anything else: this is how `MEDIA:/path` lines and `send_*` calls appear. |
| `conversation.title` | `title` — renames the conversation (backs the `agentui_set_thread_title` tool); emitted into the chat's running run, applied by AgentUI and not shown in the chat |
| `usage` | `usage`: `{ model?, provider?, inputTokens, outputTokens, cacheReadTokens?, reasoningTokens?, costUsd?, costEstimated? }` — **accumulated** consumption of the session, emitted before `run.completed` (if `capabilities.models`) |
| `approval.request` | `id`, `description`, `payload?` |
| `question.requested` | `id` | The agent awaits a user answer **without ending the run** (Hermes' `clarify` tool, OpenClaw's `ask_user`…). To emit **before** the message that carries the question, which the plugin renders in the text (`ask` widget, or `form` for several questions at once). While it is open, AgentUI accepts a user message as the answer (`reply` frame) instead of refusing with "run already in progress". |
| `question.resolved` | `id` | Question `id` no longer awaits an answer: answered, cancelled or expired. A terminal `run.*` also closes it. |
| `run.completed` / `run.failed` (`error`) / `run.aborted` | — |

## Widgets as tools

The `chart`, `map` and `code` display widgets are **no longer described to the agent by a Markdown convention**: a plugin
exposes them as `agentui_<type>` tools. The tool validates its arguments and returns a **token** `[[agentui:<id>]]` in its result;
the agent places this token in its text. AgentUI replaces it at display time with the widget, whose arguments are those of
`tool.started`. No specific event: plugins forward `tool.started` / `tool.completed` as for any tool.
Schemas: `widget-tools.json` (copied into each plugin by `plugins/sync-widget-tools.mjs`). An agent without the plugin therefore does not have
these widgets.

A display widget can be **updated**: `agentui_widget_progress` (checklist of steps) accepts `update` = the token
returned by the first call, with the full state. The tool then returns the same token (`"updated": true`); the front end
displays, in place of the token, the arguments of the **latest** call, during streaming as well as after, without a second component.
Plugins have no state to keep.

`agentui_widget_image` accepts, per image, an `https://…` URL (loaded directly by the browser) or an **absolute path** of a
file on the agent's machine. The plugin reads that file (png, jpeg, gif or webp recognized by their first bytes, 20 MB
at most), pushes it through a `message.media` event named `agentui-img-<fingerprint>-<file>` and returns in the tool
result `files` = `{ path → attachment name }`. The front end links the path to the message attachment and does not display it
a second time as an attachment. A missing or too large file, or one that is not an image, makes the tool fail
(the error goes back to the agent).

**When to use the tools** (`usageGuide` in `widget-tools.json`): the tool descriptions say how each one works, not when to prefer it
over plain text, and models rarely pick a widget on their own. The plugins therefore add this short guide to the system prompt of
AgentUI chats only: Hermes through `platform_hint`, OpenClaw through a `before_prompt_build` hook (`appendSystemContext`) filtered on
AgentUI sessions.

`agentui_widget_custom` is the **dynamic** display widget: its `code` argument is a single TSX module (default-exported React component)
that uses the miniapps UI kit (`@agentui/ui`, `react`, `chart.js`, `leaflet` only). Plugins only validate it (non-empty, ≤ 64 KB, has an
`export default`); the front end sends the code to `POST /api/widgets`, which compiles it (esbuild, cached by hash) and returns the
URL of a token-protected sandboxed iframe (`/w/<hash>/<token>/`, same runtime and CSP as a miniapp, no backend, no `/api`).

**Media in a custom widget.** The optional `media` argument lists absolute paths (8 at most) of images, videos or audio files on the agent's machine.
For each one the plugin reads the file, checks its real type from the content, pushes it as a `message.media` named `agentui-img-<fingerprint>-<file>`
(hidden under the message, like the media of the other widgets) and returns `files` = `{ path → attachment name }` in the tool result. The widget refers to a file by
the path exactly as declared (`<Media name={path} />`, `useMedia(path)`): the iframe has no cookie and its CSP forbids remote loads, so it asks the host
(`agentui:media`), which answers with a URL under the iframe's own token-protected base (`/w/<hash>/<token>/att/<attachment id>`, `agentui:media.result`), served with byte
ranges (`media-src 'self'`: streaming, seeking, iOS Safari). A file still being copied is awaited until the end of the message.
Nothing is stored apart from the tool call itself, so the widget survives a reload but not the component state.
A widget can ask to be shown over the whole screen: `requestFullscreen()` / `exitFullscreen()` / `useFullscreen()` / `useHeight()` (`@agentui/ui`). The
host (`UiCard`) does not move or reload the iframe, it stretches that same element over the viewport (`position: fixed`, so the component keeps its
state and its running loop), tries the browser's own full screen on top of it when available, draws a close button above it, and closes on Escape
(forwarded by the runtime when the focus is inside the iframe). Like `reply`, the request is only granted right after a click in the widget
(`agentui:fullscreen` → `agentui:fullscreen.result`); the host tells the runtime the state with `agentui:fullscreen.state`. The widget gets the width of the chat bubble (about 250-330 px on a phone, anything wider is cut): `useWidth()` returns it, updated on resize, so a canvas or board can follow it. The widget can talk back through `reply(text)` (`@agentui/ui`): the front end sends `text` as the user's next `inbound` message. Because that text
reaches the agent as if the user had typed it, the host only accepts it when the chat is idle (no run in progress, so it never answers a pending
question), the iframe has the focus (the user clicked in it), at most once every 1.5 s, and for 1 to 2000 characters. `useCanReply()` tells the widget
when it would be refused.

**Live widgets (two-way).** A `agentui_widget_custom` widget becomes a *live widget* when the agent keeps a session open with it: it talks to its agent over a connection the agent keeps open, like `agentui_ask`, but for as long as
it wants. It is a loop of the agent inside **one run**, and so inside the single chat message that holds the widget:
1. `agentui_widget_custom` creates the widget (`code`, initial `state`) and returns its token;
2. `agentui_widget_custom_wait` (`token`, `timeout_s` default 600, max 1800; `blockingTools` section) blocks like `agentui_ask` — `question.requested`, then
   `question.resolved` on the answer — but displays nothing (no ```` ```widget ```` block: the widget is already there). It returns
   `{"from":"widget","widget":<token>,"event":<text>}` for an event of the widget, `{"from":"user","message":<text>}` if the user typed in the
   chat meanwhile, or `{"timeout":true}` (a normal outcome, the agent may listen again). Cancelling the run ends it with an error as usual;
3. `agentui_widget_custom` with `update` (the token) and `state` (any JSON, ≤ 32 KB, replaces the previous one) pushes the new state; like
   `agentui_widget_progress`, it returns the same token with `updated: true` and creates no component. The front keeps the code of the first call and
   posts the `state` of the latest one into the running iframe (`agentui:state`), where `useAgentState()` returns it. The iframe is neither
   reloaded nor remounted (a live widget stays mounted while the agent thinks), so the component keeps its own React state; after a page reload
   it starts again from the latest `state`;
4. back to 2, until the agent stops calling `agentui_widget_custom_wait`: that is how it closes the session, then the run ends normally.

In the component, `reply(text, { silent: true })` posts an event: `POST /api/conversations/:id/send` with `widget: { token }` (the front gives
the component its token). It is only accepted while the agent waits (`awaitingReply`, otherwise 409): the server hands it to the adapter as the
`reply` frame, whose `text` is `{"agentui":"widget-event","widget":<token>,"text":<text>}` (so the plugin does not mistake it for a chat message),
and stores the user message `hidden`. A plugin that times out a wait delivers `{"agentui":"timeout"}`. `useCanReply()` is therefore true only while
the agent listens: the widget is disabled while it thinks. Nothing is delivered without an open wait. Demo and test: `e2e/ui-twoway.mjs`.

The interactive widgets `ask`, `confirm` and `form` are **blocking** tools (`agentui_ask`, `agentui_confirm`,
`agentui_form`, `blockingTools` section of the same file). The tool emits `question.requested`, adds the ```` ```widget ````
`{"type": …, "arguments": …}` block to the run's text, waits for the `reply` frame and returns `{"answer": "<answer text>"}` to
the agent; it then emits `question.resolved`. An `abort`, the end of the run or a timeout unblock it with an error. The Markdown
block remains a fallback convention for an agent without the plugin.

## Miniapps (`agentui_miniapp_*` tools)

An agent can create **miniapps** — a React **front** and **handlers** (the server side) — displayed in the **Miniapps** tab. The files
live on the AgentUI server; the plugin is only a relay: each `agentui_miniapp_<op>` tool (`miniappTools` section of
`widget-tools.json`) sends a `miniapp.op` frame and waits for the matching `miniapp.result` (suggested timeout: 60 s). Exception:
`agentui_miniapp_guide`, local, returns the `miniapps-guide.md` guide (embedded by `sync-widget-tools.mjs` under `miniappGuide`, and also
published as the `.claude/skills/agentui-miniapps` skill). The server compiles (esbuild), isolates the handlers (worker + vm) and serves
the front in a sandboxed iframe. Media of a miniapp (images, videos, audio) are its **assets**: `agentui_miniapp_asset` (`id`, `src`, `name?`) is read by the plugin
on the agent's machine and sent as the `asset` op (`id`, `name`, `data` base64, 25 MB, 40 per miniapp, type checked from the content); `delete_asset` removes one. The front shows them
with `<Media name>` / `useMedia(name)`, through the same host bridge as above (`/m/<id>/<token>/assets/<name>`). A miniapp's handlers have no direct network access: `ctx.fetch` goes through the server, which refuses private/internal addresses. See `miniapps-guide.md` for the agent-side constraint.

**Preview for the agent's browser.** `agentui_miniapp_open` (`id`, `ttl_s?` 60-3600, default 900) is the `open` op: it answers `{ url, expiresAt, note }`. The URL (`<PUBLIC_URL>/preview/<id>/<token>`, relative when `PUBLIC_URL` is not set) opens the running miniapp in the agent's own browser tool, without a session cookie: the token is signed (HMAC, `preview.` domain, so an iframe token never opens a preview), bound to one miniapp and one user (the first account), and expires. The page is a minimal host (same sandboxed iframe and postMessage bridge as the Miniapps tab) whose handler calls go through `/preview/<id>/<token>/x/…`; it reloads itself on a new version and refreshes on new data (`/state`). Front errors and failed handler calls are written in its text (`#agentui-errors`, `body[data-state]`). Handlers run for real: what the agent clicks writes real data. No plugin change is needed: any `miniappTools` entry is relayed as a `miniapp.op`.

## Rules

1. **The plugin owns the run lifecycle**: every `inbound` receives exactly **one** terminal event
   (`run.completed`, `run.failed` or `run.aborted`), including on a platform error.
2. The same `conversationId` always gives the same session on the platform side. A new `conversationId` gives a
   new session, without `/new`.
3. Messages produced during a run (including media) are `event`s carrying that `runId`. Outside a run,
   they are `outbound`.
4. `Media` = `{ name, mimeType, data }`, `data` in base64. Plugins limit the size announced in
   `capabilities.attachments.maxBytes`.
5. Unknown fields: ignore them (forward compatibility). Incompatible change: `protocol: 2`.
6. `deleteSession` (if `capabilities.sessionDelete`): deletes the platform session linked to this
   `conversationId` — the chat is only erased on the AgentUI side if the plugin answers `ok`. A chat
   unknown to the platform is **not** an error (idempotent); a refusal (active session, internal error)
   is answered with `rpc.result` and `error`.

## Example

```jsonc
// plugin → AgentUI
{"type":"hello","protocol":1,"token":"…","agent":{"type":"hermes","name":"Hermes","version":"0.19.0"},
 "capabilities":{"sessions":true,"abort":true,"approvals":true,"subagents":true,"reasoning":true,"toolDetails":true,
  "skills":false,"jobs":false,"jobControl":false,"attachments":{"images":true,"files":true,"maxBytes":20971520}}}
// AgentUI → plugin
{"type":"welcome","protocol":1}
{"type":"inbound","conversationId":"c_42","runId":"r_1","text":"List the files"}
// plugin → AgentUI
{"type":"event","conversationId":"c_42","runId":"r_1","event":{"type":"tool.started","id":"t1","name":"terminal","args":{"command":"ls"}}}
{"type":"event","conversationId":"c_42","runId":"r_1","event":{"type":"tool.completed","id":"t1","result":"a.txt\nb.txt"}}
{"type":"event","conversationId":"c_42","runId":"r_1","event":{"type":"message.delta","text":"Here "}}
{"type":"event","conversationId":"c_42","runId":"r_1","event":{"type":"message.final","text":"Here are the files: a.txt, b.txt"}}
{"type":"event","conversationId":"c_42","runId":"r_1","event":{"type":"run.completed"}}
// later, a cron:
{"type":"outbound","id":"o_7","text":"Reminder: meeting at 2 pm"}
```
