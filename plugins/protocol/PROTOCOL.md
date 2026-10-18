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
| `pong` | — | Answer to `ping`. |

## AgentUI → plugin messages

| `type` | Fields | Role |
|---|---|---|
| `welcome` | `protocol: 1` | Accepts the `hello`. |
| `inbound` | `conversationId`, `runId`, `text`, `subAgentId?`, `attachments?: Media[]` | User message. **Each `conversationId` is a distinct chat** for the platform, hence a distinct session (multiple threads). The `runId` is chosen by AgentUI. |
| `abort` | `conversationId`, `runId` | Stop the run. |
| `reply` | `conversationId`, `runId`, `text` | User answer to a question the agent asks **mid-run** (announced by `question.requested`). The plugin hands it to the waiting agent: the run continues and ends normally, it is not a new `inbound`. Optional: AgentUI only sends it while a question is open. |
| `approval` | `conversationId`, `runId`, `id`, `approve: boolean`, `scope?: "once" \| "session" \| "always"` | Answer to an `approval.request`. |
| `rpc` | `id`, `method`, `params?` | Optional call. Unknown method: `rpc.result` with `error`. Methods: `listSubAgents` → `[{ id, name, description?, isDefault? }]`; `listJobs {subAgentId?}` → `[{ id, name, schedule, mode?: agent\|script, prompt?, script?, enabled, nextRunAt?, lastRunAt?, lastStatus? }]` (if `capabilities.jobs`); `jobAction {jobId, action: pause\|resume\|run\|delete}` → `{ ok: true }` (if `capabilities.jobControl`); `listSkills {subAgentId?}` → `[{ id, name, description?, category?, enabled? }]` (if `capabilities.skills`); `readSkill {skillId, subAgentId?}` → `{ content }` (Markdown of the skill, if `capabilities.skills`); `deleteSession {conversationId}` → `{ ok: true }` (if `capabilities.sessionDelete`); `listModels` → `[{ provider, providerName, id }]`, `setModel {conversationId, model, provider?, subAgentId?}` → `{ model, provider?, message? }` and `sessionUsage {conversationId, subAgentId?}` → `Usage` or `null` (if `capabilities.models`). Dates in milliseconds. |
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
| `message.media` | `name`, `mimeType`, `data` (base64) — **instead of `url`**: the plugin pushes the content |
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

A display widget can be **updated**: `agentui_progress` (checklist of steps) accepts `update` = the token
returned by the first call, with the full state. The tool then returns the same token (`"updated": true`); the front end
displays, in place of the token, the arguments of the **latest** call, during streaming as well as after, without a second component.
Plugins have no state to keep.

`agentui_image` accepts, per image, an `https://…` URL (loaded directly by the browser) or an **absolute path** of a
file on the agent's machine. The plugin reads that file (png, jpeg, gif or webp recognized by their first bytes, 20 MB
at most), pushes it through a `message.media` event named `agentui-img-<fingerprint>-<file>` and returns in the tool
result `files` = `{ path → attachment name }`. The front end links the path to the message attachment and does not display it
a second time as an attachment. A missing or too large file, or one that is not an image, makes the tool fail
(the error goes back to the agent).

The interactive widgets `ask`, `confirm` and `form` are **blocking** tools (`agentui_ask`, `agentui_confirm`,
`agentui_form`, `blockingTools` section of the same file). The tool emits `question.requested`, adds the ```` ```widget ````
`{"type": …, "arguments": …}` block to the run's text, waits for the `reply` frame and returns `{"answer": "<answer text>"}` to
the agent; it then emits `question.resolved`. An `abort`, the end of the run or a timeout unblock it with an error. The Markdown
block remains a fallback convention for an agent without the plugin.

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
