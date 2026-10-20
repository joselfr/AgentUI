/** ```widget block: JSON `{ "type": "ask" | "confirm" | "chart" | …, "arguments": { … } }`. `undefined` if invalid. */
export function parseWidget(raw: string): { type: string; arguments: Record<string, unknown> } | undefined {
  try {
    const j = JSON.parse(raw) as { type?: unknown; arguments?: unknown };
    if (typeof j?.type !== 'string' || !j.arguments || typeof j.arguments !== 'object' || Array.isArray(j.arguments)) return undefined;
    return { type: j.type, arguments: j.arguments as Record<string, unknown> };
  } catch { return undefined; }
}

/**
 * Removes an empty fence left open just before a ```widget / ```ask block (stray "```" at the end of the agent's text):
 * Markdown would read it as the opener of a code block and the widget fence as its closer, so the widget would
 * never render and its JSON would show up as plain text.
 */
export function dropStrayFence(text: string): string {
  const lines = text.split('\n');
  let opener = -1; // index of the open fence, -1 if none
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (!/^\s*```/.test(l)) continue;
    if (opener < 0) { opener = i; continue; }
    // Open fence: the widget fence is dropped into it only if the block so far is blank and the opener has no language
    if (/^```(widget|ask)[^\S\n]*$/.test(l.trim()) && /^\s*```\s*$/.test(lines[opener]!) && lines.slice(opener + 1, i).every((x) => !x.trim())) {
      lines.splice(opener, 1);
      i--; opener = i; // the widget fence is now the opener
      continue;
    }
    opener = -1;
  }
  return lines.join('\n');
}

const INTERACTIVE = new Set(['ask', 'confirm', 'form']);

/** Interactive blocks of a text (`ask`/`confirm`/`form` widgets and legacy ```ask block), in order: each waits for an answer. */
export function interactiveBlocks(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/```(widget|ask)[^\S\n]*\n([\s\S]*?)\n?```/g)) {
    const raw = m[2]!;
    if (m[1] === 'ask' || INTERACTIVE.has(parseWidget(raw)?.type ?? '')) out.push(raw);
  }
  return out;
}

/** Plugins expose each display widget as an `agentui_widget_<type>` tool (e.g. `agentui_widget_chart`): its arguments are the widget's. */
const WIDGET_TOOL_PREFIX = 'agentui_widget_';
export type ToolCallLike = { id?: string; name: string; args?: unknown; resultPreview?: string; startedAt?: number; endedAt?: number };
const DISPLAY_WIDGETS = new Set(['chart', 'map', 'code', 'table', 'progress', 'image', 'custom']);
/** Tool names from before the `agentui_widget_` prefix (`agentui_chart`, `agentui_ui`, `agentui_custom_widget`…): conversations that used them keep rendering. */
const LEGACY_TOOL_PREFIX = 'agentui_';
const LEGACY_CUSTOM = new Set(['ui', 'custom_widget']);

/** Widget type of a tool name (`agentui_widget_chart`, or the legacy `agentui_chart`); `undefined` if the tool is not a display widget. */
function widgetTypeOfTool(name: string): string | undefined {
  const type = name.startsWith(WIDGET_TOOL_PREFIX) ? name.slice(WIDGET_TOOL_PREFIX.length)
    : name.startsWith(LEGACY_TOOL_PREFIX) ? (LEGACY_CUSTOM.has(name.slice(LEGACY_TOOL_PREFIX.length)) ? 'custom' : name.slice(LEGACY_TOOL_PREFIX.length))
    : undefined;
  return type && DISPLAY_WIDGETS.has(type) ? type : undefined;
}

export function widgetOfTool(t: { name: string; args?: unknown }): { type: string; arguments: Record<string, unknown> } | undefined {
  const type = widgetTypeOfTool(t.name);
  const args = t.args;
  if (!type || !args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  return { type, arguments: args as Record<string, unknown> };
}

const TOKEN = /\[\[agentui:([0-9a-f]+)\]\]/g;
const HEAD = '[[agentui:';
/** Removes a token being typed at the end of the text ("[[agent", "[[agentui:a3f", "[[agentui:a3f9c1]"). */
function stripPartialToken(text: string): string {
  for (let i = Math.min(text.length, HEAD.length + 7); i > 0; i--) {
    const tail = text.slice(-i);
    if (HEAD.startsWith(tail) || (tail.startsWith(HEAD) && /^\[\[agentui:[0-9a-f]*\]?$/.test(tail))) return text.slice(0, -i);
  }
  return text;
}
const fence = (w: { type: string; arguments: Record<string, unknown> }) => '\n\n```widget\n' + JSON.stringify(w) + '\n```\n\n';

/** `agentui_widget_custom` call that only pushes a new state to a widget already displayed (`update` = its token): it creates no component. */
const isUiUpdate = (t: ToolCallLike) => widgetOfTool(t)?.type === 'custom' && typeof (t.args as { update?: unknown } | undefined)?.update === 'string';

const sameCall = (a: ToolCallLike, b: ToolCallLike) => (a.id !== undefined && b.id !== undefined ? a.id === b.id : a === b);

/** Widgets that live outside the text: shown from their first tool call (without waiting for the agent to write the token), updated in place. */
const OUT_OF_TEXT = new Set(['progress']);

/**
   * "Out-of-text" widgets created in this message (one per token, in creation order), with the state of the **latest** call of
   * the chat: an `update` call (widget token) replaces the displayed state, it does not create a second component.
 */
export function outOfTextWidgets(own: ToolCallLike[], all: ToolCallLike[] = own): OutOfTextWidget[] {
  const latest = new Map<string, { type: string; arguments: Record<string, unknown> }>();
  const first = new Map<string, ToolCallLike>();
  const calls = new Map<string, ToolCallLike[]>();
  for (const t of all) {
    const token = tokenOf(t);
    const w = token ? widgetOfTool(t) : undefined;
    if (!token || !w || !OUT_OF_TEXT.has(w.type)) continue;
    latest.set(token, w);
    if (!first.has(token)) first.set(token, t);
    calls.set(token, [...(calls.get(token) ?? []), t]);
  }
  const out: OutOfTextWidget[] = [];
  for (const [token, w] of latest) if (own.some((t) => sameCall(t, first.get(token)!))) out.push({ token, ...w, times: stepTimes(calls.get(token)!) });
  return out;
}

export interface StepTime { start?: number; end?: number }
export interface OutOfTextWidget { token: string; type: string; arguments: Record<string, unknown>; times: StepTime[] }

/**
   * Duration of each step of a progress widget, derived from the time of each call (creation then updates): a step
   * starts when a call shows it `running`, and ends when a call shows it `done`/`failed`. A step seen
   * directly finished started at the previous call; at creation, its duration is unknown.
 */
export function stepTimes(calls: ToolCallLike[]): StepTime[] {
  const times: StepTime[] = [];
  let prev: number | undefined;
  for (const c of calls) {
    const at = c.endedAt ?? c.startedAt;
    const steps = (c.args as { steps?: Array<{ status?: unknown }> } | undefined)?.steps;
    if (at === undefined || !Array.isArray(steps)) continue;
    steps.forEach((s, i) => {
      const t = (times[i] ??= {});
      if (s.status === 'running' && t.start === undefined) t.start = at;
      if ((s.status === 'done' || s.status === 'failed') && t.end === undefined) {
        t.end = at;
        t.start ??= prev;
      }
    });
    prev = at;
  }
  return times;
}

/** `image` widget: the plugin copies local files and returns, in the tool result, `files` = { path → attachment name }. */
function filesOf(t: { resultPreview?: string }): Record<string, string> {
  try {
    const f = (JSON.parse(t.resultPreview ?? '') as { files?: unknown }).files;
    return f && typeof f === 'object' && !Array.isArray(f) ? Object.fromEntries(Object.entries(f).filter(([, v]) => typeof v === 'string')) as Record<string, string> : {};
  } catch { return {}; }
}

/** Attachments copied for an image widget: their name starts with this prefix, they are not displayed on top of the widget. */
export const WIDGET_ATTACHMENT_PREFIX = 'agentui-img-';

/** Token (`[[agentui:<id>]]`) returned by the tool, read from its result. */
const tokenOf = (t: { resultPreview?: string }) => t.resultPreview?.match(/\[\[agentui:([0-9a-f]+)\]\]/)?.[1];

/**
   * Replaces with their widget the tokens the agent placed in its text after an `agentui_widget_<type>` tool call.
   * The widget arguments are those of the call (`own`: tools of the message; `all`: whole chat, since the agent may
   * reuse a token from an earlier message). An unknown or in-progress token disappears; a widget whose token
   * was never written is appended at the end of the message once it is finished, so that it is not lost
   * (unless the agent redid it: a later widget of the same type is in the text).
 */
export function expandWidgetTokens(text: string, own: ToolCallLike[], all: ToolCallLike[] = own, done = true): string {
  const widgets = new Map<string, { type: string; arguments: Record<string, unknown> }>();
  for (const t of all) {
    const id = tokenOf(t);
    const w = id ? widgetOfTool(t) : undefined;
    if (id && w) {
      const prev = widgets.get(id);
      // State update of a dynamic widget: the code stays that of the first call, only `state` follows the latest call.
      if (isUiUpdate(t)) { if (prev) widgets.set(id, { ...prev, arguments: { ...prev.arguments, state: w.arguments.state } }); continue; }
      // A dynamic widget knows its token: its events to the agent say which widget they come from.
      widgets.set(id, w.type === 'image' ? { ...w, arguments: { ...w.arguments, files: filesOf(t) } } : w.type === 'custom' ? { ...w, arguments: { ...w.arguments, token: `[[agentui:${id}]]` } } : w);
    }
  }
  const used = new Set<string>();
  let out = text.replace(TOKEN, (_m, id: string) => {
    const w = widgets.get(id);
    if (!w) return '';
    if (OUT_OF_TEXT.has(w.type)) return ''; // shown by `outOfTextWidgets`; a token written by the agent is ignored
    used.add(id);
    return fence(w);
  });
  out = stripPartialToken(out);
  if (done) own.forEach((t, i) => {
    if (isUiUpdate(t)) return; // the widget lives where it was created
    const id = tokenOf(t);
    const w = id ? widgets.get(id) : undefined;
    if (!id || !w || used.has(id) || OUT_OF_TEXT.has(w.type)) return;
    // A draft the agent redid: a later widget of the same type was placed in the text, this one is superseded (not shown twice)
    if (own.slice(i + 1).some((n) => { const nid = tokenOf(n); return !!nid && used.has(nid) && widgets.get(nid)?.type === w.type; })) return;
    out += fence(w);
  });
  return out;
}
