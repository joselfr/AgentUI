# Spike: AgentUI as a channel (Hermes / OpenClaw plugins)

Versions studied (sources read, not just the docs):
- **Hermes Agent 0.19.0** (PyPI sdist: `gateway/platforms/base.py`, `gateway/stream_*.py`, `plugins/platforms/irc`, `plugins/platforms/telegram`, `hermes_cli/plugins.py`, `tools/approval.py`);
- **OpenClaw 2026.10.3** (npm: `docs/plugins/*`, types `dist/plugin-sdk/*.d.ts`, compiled Telegram channel `dist/bot-message-*.mjs`).

Conclusion: **both platforms expose enough to a plugin to keep most of the rich UI**
(streaming, tool cards, approvals, stop, multiple threads), and a plugin gains capabilities the current adapter does not have
(proactive messages, crons delivered into AgentUI, outgoing connection). The losses concern the "administration" lists
(skills, jobs, remote history), which are not a channel's business.

## Capability matrix

| AgentUI capability | Hermes (platform plugin) | OpenClaw (channel plugin) |
|---|---|---|
| Inbound message | `MessageEvent` + `self.handle_message(event)`; `build_source(chat_id=…, chat_type="dm")` | `runtime.channel.inbound.buildContext(...)` then `runtime.channel.inbound.run({ adapter: { ingest, resolveTurn } })` (same sequence as the Telegram channel) |
| **Multiple threads** | ✅ The gateway session key = platform + `chat_id` (+ `thread_id`). One `conversationId` gives one session. | ✅ `routing.resolveAgentRoute({ peer: { kind: "direct", id: conversationId }, dmScope: "per-channel-peer" })`. **`dmScope` must be forced**: with the default value `main`, all DMs fall into the main session. |
| Sub-agent choice | One Hermes profile = one gateway, hence one connection per profile | `resolveAgentRoute({ defaultAgentId })`; configuration bindings keep priority |
| Text deltas | ✅ Override of `render_message_event(event, sink)`: `MessageChunk.text`, `sink.chat_id`. Requires streaming to be enabled (`streaming.enabled`), otherwise only the final text arrives. | ✅ `replyOptions.onPartialReply` (+ `onAssistantMessageStart` to separate segments) |
| Final text | `send(chat_id, content)` | `delivery.deliver(payload)` (`payload.text`, `mediaUrls`) |
| Reasoning | ⚠️ No stream. Available at the end of the turn via the `post_llm_call(conversation_history=…)` hook (`reasoning` field of assistant messages). | ✅ `replyOptions.onReasoningStream` / `onReasoningEnd` |
| Tool started | ✅ `pre_tool_call` hook (name, args, `tool_call_id`); `format_tool_event` as a fallback | ✅ `replyOptions.onToolStart({ toolCallId, name, args })` |
| Tool completed (+ result) | ✅ `post_tool_call(tool_name, args, result, tool_call_id, duration_ms, status)` hook | ✅ `api.runtime.events.onAgentEvent` (`stream: "tool"`, filtered by `runId`); `onItemEvent` as a fallback |
| Hook context | `gateway.session_context.get_session_env("HERMES_SESSION_PLATFORM" / "HERMES_SESSION_CHAT_ID")`: the ContextVars are propagated to the agent thread via `copy_context()` | `runId` imposed by the plugin (`replyOptions.runId`), hence a direct correlation |
| Sub-agents | ✅ `subagent_start` / `subagent_stop` hooks (`parent_session_id`) | ⚠️ Possible via `item` events / the `sessions_spawn` tool (`onAgentEvent`) and `onVisibleWorkSessions`, **not implemented yet** in the plugin |
| Approvals | ✅ Method `send_exec_approval(chat_id, command, session_key, description, …)` then `tools.approval.resolve_gateway_approval(session_key, choice)` (`once` / `session` / `always` / `deny`) | ✅ Delivered by the core as a "same chat" payload (text + `/approve <id> …` buttons). The plugin extracts the id and answers with an `/approve` command. (Native `approvalCapability`: later.) |
| Stop | ✅ Injection of a `/stop` `MessageEvent`, which interrupts the run immediately (`_interrupt_and_clear_session`) | ✅ `replyOptions.abortSignal` (one `AbortController` per run) |
| End of run | ✅ Adapter hook `on_processing_complete(event, ProcessingOutcome.SUCCESS / FAILURE / CANCELLED)` | ✅ Resolution of `inbound.run(...)` + `onAgentRunTerminalOutcome("completed" / "failed")` |
| Outgoing media | `send_image` / `send_image_file` / `send_document` / `send_voice` / `send_video` (URL or local path) | `payload.mediaUrls` (local paths or URLs) in `deliver` |
| Inbound attachments | `cache_image_from_bytes` / `cache_document_from_bytes`, then `MessageEvent.media_urls` + `media_types` | `toInboundMediaFacts([{ path, contentType }])`, then `buildContext({ media })` (recorded via `runtime.channel.media`) |
| **Proactive messages / crons** | ✅ `send()` outside an active run; `cron_deliver_env_var` (`deliver=agentui`); `standalone_sender_fn` for crons run outside the gateway | ✅ `outbound.sendText` / `sendMedia` called by the core (cron, `message` tool) with `to = conversationId` |
| Authorization | `trusted_inbound` **forbidden**; the AgentUI token is enough, with `AGENTUI_ALLOW_ALL_USERS=true` and a fixed `user_id` | `security.dm` set to `open`; authentication happens at the WS token level |
| Remote session list | ❌ (not exposed to platforms) → AgentUI keeps its own database | ❌ (same; `runtime.agent` allows reading transcripts, to look at later) |
| Skills / jobs / administration | ❌ Outside a channel's scope | ❌ Outside a channel's scope |

## Decisions from the spike

1. **Single protocol** (`protocol/PROTOCOL.md`) that reuses AgentUI's `AgentEvent` type as is; only media
   travel as base64 instead of a URL.
2. **The plugin owns the run lifecycle**: each `inbound` receives exactly one `run.completed`, `run.failed` or `run.aborted`.
   This removes the end-of-run heuristics of the current OpenClaw adapter.
3. **Hermes**: streaming must be enabled for the `agentui` platform (the plugin enforces it in `plugin.yaml` / the docs).
   Reasoning arrives as one block at the end of the turn.
4. **OpenClaw**: `dmScope: "per-channel-peer"` is forced in the plugin, not left to the global configuration.
5. **OpenClaw approvals**: phase 1 through the `/approve` command in the same chat. The native `approvalCapability` is deferred
   (heavy and poorly documented API for an external channel).

## Identified risks

- OpenClaw's channel SDK evolves fast (several aliases marked `removeAfter 2026-10-01`). The plugin relies on the
  **non-deprecated** surfaces (`runtime.channel.inbound.run` / `buildContext`, `routing.resolveAgentRoute`).
- Hermes publishes several versions per week. The chosen anchor points (`BasePlatformAdapter`, `register_platform`,
  `VALID_HOOKS` hooks) are the documented public plugin API.
- Neither was run against a real instance during this spike (the agents run on jlfr.io). It will need to be validated
  with `dev/mock-gateway.mjs`.

## Widgets as plugin tools (`agentui_widget_chart`, `agentui_widget_map`, `agentui_widget_code`): tokens

Instead of the ```` ```widget ```` block, each display widget is a tool provided by the plugin. The tool validates its arguments
(JSON schema + semantic checks: length of `y`, a single pie…) and returns a **token** `[[agentui:<id>]]` that the
agent writes in its text, where it wants. AgentUI replaces the token with the widget **at render time** (front end,
`expandWidgetTokens`): the arguments come from `tool.started`, the token from `tool.completed`. No new event,
nothing to develop in the plugins for the expansion, and the reloaded history works as is.

- Schemas: single source `protocol/widget-tools.json`, copied into each plugin by `node plugins/sync-widget-tools.mjs` (to rerun after editing).
- The `chart`/`map`/`code` sections were **removed** from the interface instructions (`WIDGET_INSTRUCTIONS`): only the tools exist for these widgets, so an agent without the plugin does not have them. `ask`/`confirm`/`form` remain as a convention.
- Token being typed (streaming): hidden; unknown token: removed; widget whose token was never written: appended at the end of the message once finished.

| | Hermes 0.19 | OpenClaw 2026.10.3 |
|---|---|---|
| Registration | `ctx.register_tool(name, toolset, schema, handler)` ✅ verified on a real instance | `api.registerTool(factory, { names })` + `contracts.tools` in the manifest ✅ (tests + `tsc`, no real gateway) |
| Visible only in AgentUI | ❌ plugin tools are enabled on **all** platforms (verified: Telegram sees them); `check_fn` is cached for 30 s so unusable per session. Fallback: the handler refuses outside AgentUI. Or disable the `agentui` toolset on the other platforms (`hermes tools`). | ✅ the factory receives `ctx.messageChannel` and returns `null` outside `agentui` |
| Blocking tool (interactive widgets, not migrated) | possible (synchronous handler in the agent thread, like `clarify`) | possible (asynchronous `execute`); `ctx.nativeChannelId` = `conversationId` |

## Interactive widgets as blocking tools (`agentui_ask`, `agentui_confirm`, `agentui_form`)

Schemas in `protocol/widget-tools.json`, `blockingTools` section. Unlike the display tools, the tool **blocks**:
it emits `question.requested`, adds the ```` ```widget ```` block to the text of the current reply, then waits for the `reply` frame
(already used for `clarify` / `ask_user`). The user's answer (button label, `Label: value` per form field) becomes
the tool result `{"answer": …}`, `question.resolved` is emitted, and the agent's turn continues.
A stop, the end of the run or a 30-min timeout unblock the tool with an error; a single question at a time per chat.

- **Hermes**: the handler runs in the agent thread and waits on a `threading.Event` (`AgentUIAdapter.ask_blocking`); the chat comes from the session ContextVars.
- **OpenClaw**: asynchronous `execute`, chat deduced from `sessionKey` (`…:agentui:direct:<conversationId>`); the account's bridge holds the promise (`AgentUIBridge.askBlocking`, `asks.ts` registry).
- Not verified on real instances: tests with a fake AgentUI (Hermes 0.19, simulated OpenClaw). The existing `clarify` test requires Hermes ≥ 0.21 (`attempt_text_response_for_session`).
