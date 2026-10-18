---
name: design-widget
description: Design a new AgentUI widget (a component rendered in the chat, provided to the agent by a plugin tool) — HTML mockup, user validation, then implementation. Use when the user wants to create, add or imagine a widget for the agents.
---

# Design an AgentUI widget

A widget is a chat component, rendered by the front end from a Markdown code block with the `widget` language. The agent does not write it by hand: a plugin tool `agentui_<type>` validates its arguments (JSON schema) and makes it appear. The front end receives:

```widget
{"type": "<name>", "arguments": { … }}
```

Existing types: `chart`, `map`, `code` (display tools, which return a token); `ask`, `confirm`, `form` (**blocking** tools, which wait for the user's answer). All the JSON follows this same format: `type` + `arguments`, never Markdown or free key/value.

**Mandatory order: mockup → user validation → implementation.** Do not write code in `apps/` before an explicit "yes" on the mockup.

## 1. Frame it (short)

If the intent is vague, ask at most one grouped question. Otherwise, choose and announce:
- the `type` (one word, lowercase, English like the existing ones);
- the role: display only (like `chart`) or interactive with an answer (like `ask`, `confirm`);
- the `arguments`: names, types, required or not, default values. Name the keys without reusing `type` (conflict with the widget; e.g. `kind` for `chart`);
- for an interactive widget: what the user sends back. The answer goes out as a **text message** (button label, comma-separated values, or one `Label: value` line per field), because that is what the tool returns to the agent as the result `{"answer": …}`; the widget then freezes by reading the next user message (`answer`).

## 2. Mockup

Create `mockups/<type>/<type>.html` (standalone page, a single file, no external dependency), using `mockups/confirm-chart/confirm-chart.html` as a model:
- the tokens of `apps/web/src/theme.ts` (light and dark, `prefers-color-scheme` + toggle button);
- on the left the exact `widget` block the agent would write, on the right the rendering in a chat bubble;
- all states: active, answered/frozen, variant (e.g. `danger`), edge cases (empty list, long values, a single series);
- the fallback: invalid JSON or missing arguments → raw code block;
- correct rendering on mobile (≈ 390 px).

Generate the captures with the system Chromium and `playwright-core` (already in `node_modules`, see `e2e/front.mjs`): `mockups/<type>/mockups-light.png` and `mockups-dark.png`. **Look at the captures** (Read on the PNG) and fix before presenting them.

## 3. User confirmation

Present: the arguments JSON, the states shown, the choices made (and those left open), the file paths. Ask through AskUserQuestion with the options *Validate and implement* / *Edit the mockup* / *Abandon*. Iterate on the mockup until it is validated. Never infer agreement from silence.

## 4. Implementation (only after validation)

1. **Component** `apps/web/src/components/<Type>Card.tsx`, modeled on `ConfirmCard.tsx` (interactive) or `ChartCard.tsx` (display):
   - export `parse<Type>(args: Record<string, unknown>)` that validates and returns `undefined` if invalid;
   - MUI styles and theme tokens (`useTheme`, `primary`, `divider`…), no hard-coded color except series palettes;
   - interactive: props `answer?` and `onAnswer?`; without `onAnswer` the widget is frozen;
   - texts: every visible string goes through `t()` with keys added to **both** `apps/web/src/i18n/fr.ts` and `en.ts` (the test checks they define the same keys).
2. **Wiring** in `apps/web/src/components/chat/MessageBubble.tsx`: an `if (w?.type === '<type>')` next to the others. Rendering only happens if `m.status !== 'streaming'`.
3. **Plugin tool, no Markdown convention or instructions**: the agent knows the widget through the tool's description (there are no more injected interface instructions). Add an entry in `plugins/protocol/widget-tools.json` (description, `arguments` schema), then run `node plugins/sync-widget-tools.mjs`:
   - **display widget** → `tools` section; add the type to `DISPLAY_WIDGETS` (`apps/web/src/components/widget.ts`); optional semantic check in `_widget_error` (Hermes, `adapter.py`) and `widgetError` (OpenClaw, `src/widget-tools.ts`). The tool returns a `[[agentui:<id>]]` token that the front end replaces with the widget;
   - **evolving display widget** (like `progress`): `update` parameter = token of the first call; the plugin returns it as is (`widgetError` / `_widget_error` validate its format, `updateInstruction` tells the agent not to write the token again). The front end keeps the latest call per token (`expandWidgetTokens`); to show it during streaming, allow it in the `live` condition of `MessageBubble.tsx`;
   - **interactive widget** → `blockingTools` section, with the sentence "The tool BLOCKS until the answer…" in the description; semantic check in `_ask_error` (Hermes) and `askError` (OpenClaw). No other plugin code: the tool emits `question.requested`, adds the ```` ```widget ```` block to the text, waits for the `reply` frame and returns the answer (see `plugins/protocol/PROTOCOL.md`). Do not list the type in `DISPLAY_WIDGETS`: the block is in the message text.
4. **Plugin tests**: OpenClaw (`cd plugins/openclaw-agentui && npm test`, extend the "widget tools" test: the list of tool names changes); Hermes (`plugins/hermes-agentui/tests/test_adapter.py`, with the Python of a Hermes ≥ 0.21 install).
5. **Plugin deployment**: the schemas live in the plugins, not in the app. Without reinstalling `hermes-agentui` (`adapter.py` + `widget_tools.json`) and `openclaw-agentui` (build, `plugins install --force`) on the server, the agents do not have the tool (see `deploy-jlfr`, with the user's agreement to touch Hermes and OpenClaw).
6. **Verify**: `npx tsc --noEmit -p apps/web`, `npx tsc --noEmit -p apps/server`, `npm test`, the plugin tests, then `npm run build`. Check the real rendering in a browser if possible (local server on port 8080).

## 5. Wrap-up

Summarize what was done and what was **not** verified (notably: does a real model pick the tool?). Only commit and deploy on request (deployment: `deploy-jlfr` skill, see the project memory for the pitfalls).
