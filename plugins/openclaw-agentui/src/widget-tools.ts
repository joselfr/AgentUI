// One tool per widget (`agentui_widget_chart`, `agentui_widget_map`, `agentui_widget_code`): the model validates its arguments with the tool's schema
// instead of writing a ```widget block. The tool returns a `[[agentui:<id>]]` token that the agent places in its text;
// AgentUI replaces it with the widget (arguments of `tool.started`, token in the result of `tool.completed`).
import { randomBytes } from 'node:crypto';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import spec from './widget-tools.json' with { type: 'json' };
import { miniappOp, notifyUser, askUser, emitMedia } from './hosts.js';
import { imagesError, readLocalImage } from './images.js';

export const MINIAPP_TOOL_PREFIX = `${spec.prefix}miniapp_`;
/** Prefix of a tool: `agentui_widget_` for the widgets (and what belongs to a widget, like its live session), `agentui_` for the interactions (ask, confirm, form). */
const toolPrefix = (t: object) => ('widget' in t && t.widget ? spec.widgetPrefix : spec.prefix);
export const WIDGET_TOOL_NAMES = [...Object.keys(spec.tools).map((k) => spec.widgetPrefix + k), ...Object.entries(spec.blockingTools).map(([k, t]) => toolPrefix(t) + k)].concat(Object.keys(spec.miniappTools).map((k) => MINIAPP_TOOL_PREFIX + k), Object.keys(spec.notifyTool).map((k) => spec.prefix + k));

type Args = Record<string, any>;

/** Checks the JSON schema cannot express: the model corrects and retries based on this message. */
export function widgetError(key: string, args: Args): string | undefined {
  if (key === 'chart') {
    const x: unknown[] = args.x ?? [];
    const series: Array<{ name?: string; y?: unknown[] }> = args.series ?? [];
    for (const s of series) if ((s.y ?? []).length !== x.length) return `Series "${s.name}" must have ${x.length} values (as many as x), it has ${(s.y ?? []).length}.`;
    if (args.kind === 'pie' && series.length !== 1) return "A pie chart has only one series.";
  } else if (key === 'table') {
    const n = (args.columns ?? []).length;
    for (const [i, row] of ((args.rows ?? []) as unknown[][]).entries()) {
      if (row.length !== n) return `Row ${i + 1} has ${row.length} values, ${n} are needed (one per column).`;
      if (row.some((v) => v !== null && typeof v === 'object')) return `Row ${i + 1} contains a value that is neither text, number, boolean nor null.`;
    }
  } else if (key === 'progress') {
    if (args.update !== undefined && !/^\[\[agentui:[0-9a-f]+\]\]$/.test(String(args.update))) return '`update` must be the [[agentui:…]] token returned by the first call.';
  } else if (key === 'map' && !args.points?.length) return 'At least one point is required.';
  else if (key === 'code' && !String(args.code ?? '').trim()) return 'The code is empty.';
  else if (key === 'custom') {
    if (args.state !== undefined && Buffer.byteLength(JSON.stringify(args.state)) > 32 * 1024) return 'The state is too large (max 32 KB).';
    if (args.update !== undefined) {
      if (!/^\[\[agentui:[0-9a-f]+\]\]$/.test(String(args.update))) return '`update` must be the [[agentui:…]] token of the widget to update.';
      if (args.state === undefined) return 'An update needs a `state`.';
      return undefined;
    }
    const code = String(args.code ?? '');
    if (!code.trim()) return 'The code is empty.';
    if (Buffer.byteLength(code) > 64 * 1024) return 'The code is too large (max 64 KB).';
    if (!/export\s+default\b/.test(code)) return 'The module must default-export the React component (`export default function Widget() { … }`).';
  }
  return undefined;
}

/** Checks of the interactive tools (ask / confirm / form), like `widgetError` for display widgets. */
export function askError(key: string, args: Args): string | undefined {
  if (key === 'custom_wait' && !/^\[\[agentui:[0-9a-f]+\]\]$/.test(String(args.widget ?? ''))) return '`widget` must be the [[agentui:…]] token of the widget returned by agentui_widget_custom.';
  if (key === 'ask' && !String(args.question ?? '').trim()) return 'The question is empty.';
  if (key === 'confirm' && !String(args.title ?? '').trim()) return 'The title is empty.';
  if (key === 'form') {
    const names = new Set<string>();
    for (const f of (args.fields ?? []) as Array<{ name?: string; kind?: string; options?: unknown[] }>) {
      if (names.has(String(f.name))) return `Field "${f.name}" appears twice: names must be unique.`;
      names.add(String(f.name));
      if (f.kind === 'select' && !f.options?.length) return `Field "${f.name}" is of type select: it needs options.`;
    }
  }
  return undefined;
}

/**
 * Result of `agentui_widget_custom_wait` from what the user's side delivered: a widget event (the server wraps it in a small JSON object so that it
 * is not mistaken for a chat message), a chat message typed meanwhile, or the end of the wait.
 */
export function waitResult(answer: string): Record<string, unknown> {
  try {
    const o = JSON.parse(answer) as { agentui?: string; widget?: string | null; text?: string };
    if (o?.agentui === 'widget-event') return { from: 'widget', widget: o.widget ?? undefined, event: o.text ?? '' };
    if (o?.agentui === 'timeout') return { timeout: true };
  } catch { /* plain chat message */ }
  return { from: 'user', message: answer };
}

/** AgentUI chat of a tool call: the session key of a direct peer ends with `agentui:direct:<conversationId>`. */
export function conversationOf(ctx: { sessionKey?: string; nativeChannelId?: string }): string | undefined {
  return /:agentui:direct:(.+)$/.exec(ctx.sessionKey ?? '')?.[1] ?? ctx.nativeChannelId;
}

/**
 * Usage guide added to the system prompt of AgentUI runs only: the tool descriptions say how each tool works, this says
 * when to reach for them (without it, models rarely pick a widget on their own).
 */
export function registerUsageGuide(api: OpenClawPluginApi): void {
  if (typeof (api as { on?: unknown }).on !== 'function') return; // host without prompt hooks
  (api as unknown as { on: (hook: string, fn: (event: unknown, ctx: { sessionKey?: string; channelId?: string; messageChannel?: string }) => unknown) => void })
    .on('before_prompt_build', (_event, ctx) => {
      const agentui = ctx.channelId === 'agentui' || ctx.messageChannel === 'agentui' || /:agentui:direct:/.test(ctx.sessionKey ?? '');
      return agentui ? { appendSystemContext: spec.usageGuide } : undefined;
    });
}

export function registerWidgetTools(api: OpenClawPluginApi): void {
  api.registerTool((ctx) => {
    // The tools only exist in runs started from AgentUI (elsewhere, they would clutter the prompt).
    if (ctx.messageChannel !== 'agentui') return null;
    const conversationId = conversationOf(ctx);
    const blocking = Object.entries(spec.blockingTools).map(([key, tool]) => ({
      name: toolPrefix(tool) + key,
      label: toolPrefix(tool) + key,
      description: tool.description,
      parameters: tool.parameters as any,
      // Blocks until the user's answer (`reply` frame), which becomes the tool result.
      async execute(_id: string, args: Args, signal?: AbortSignal) {
        const problem = askError(key, args);
        if (problem) throw new Error(problem);
        if (!conversationId) throw new Error("AgentUI chat not found for this tool call.");
        const res = await askUser(conversationId, key, args, signal);
        if ('error' in res) throw new Error(res.error);
        const out = key === 'custom_wait' ? waitResult(res.answer) : { answer: res.answer };
        return { content: [{ type: 'text' as const, text: JSON.stringify(out) }], details: out };
      },
    }));
    const display = Object.entries(spec.tools).map(([key, tool]) => ({
      name: spec.widgetPrefix + key,
      label: spec.widgetPrefix + key,
      description: tool.description,
      parameters: tool.parameters as any, // raw JSON schema (no dependency on typebox, absent from a plugin install)
      async execute(_id: string, args: Args) {
        const problem = widgetError(key, args) ?? (key === 'image' ? imagesError(args) : undefined);
        if (problem) throw new Error(problem);
        // Local images: copied into the chat (message.media); the result says which attachment matches which path.
        const files: Record<string, string> = {};
        if (key === 'image') {
          for (const im of args.images as Array<{ src: string }>) {
            if (!im.src.startsWith('/') || files[im.src]) continue;
            const media = await readLocalImage(im.src);
            if (!conversationId || !emitMedia(conversationId, media)) throw new Error("No AgentUI exchange in progress: cannot copy the image.");
            files[im.src] = media.name;
          }
        }
        if ((key === 'progress' || key === 'custom') && args.update) {
          // Update: same token, the front shows the state of the latest call.
          return { content: [{ type: 'text' as const, text: JSON.stringify({ widget: args.update, updated: true, instruction: spec.updateInstruction }) }], details: { token: args.update } };
        }
        const token = `[[agentui:${randomBytes(3).toString('hex')}]]`;
        return { content: [{ type: 'text' as const, text: JSON.stringify({ widget: token, instruction: key === 'progress' ? spec.progressInstruction : spec.tokenInstruction, ...(key === 'image' ? { files } : {}) }) }], details: { token } };
      },
    }));
    // Miniapps: files are built and stored on the AgentUI server; the result (or the build errors) comes back to the model.
    const miniapps = Object.entries(spec.miniappTools).map(([op, tool]) => ({
      name: MINIAPP_TOOL_PREFIX + op,
      label: MINIAPP_TOOL_PREFIX + op,
      description: tool.description,
      parameters: tool.parameters as any,
      async execute(_id: string, args: Args) {
        const result = op === 'guide' ? { guide: spec.miniappGuide } : await miniappOp(op, args);
        return { content: [{ type: 'text' as const, text: typeof result === 'string' ? result : JSON.stringify(result) }], details: { op } };
      },
    }));
    // Push notification to the user's devices: sent by the AgentUI server (own `notify` frame).
    const notify = Object.entries(spec.notifyTool).map(([key, tool]) => ({
      name: spec.prefix + key,
      label: spec.prefix + key,
      description: tool.description,
      parameters: tool.parameters as any,
      async execute(_id: string, args: Args) {
        if (!String(args.title ?? '').trim()) throw new Error('The title is empty.');
        const result = await notifyUser(String(args.title), args.body === undefined ? undefined : String(args.body), args.url === undefined ? undefined : String(args.url));
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], details: { op: key } };
      },
    }));
    return [...display, ...blocking, ...miniapps, ...notify];
  }, { names: WIDGET_TOOL_NAMES });
}
