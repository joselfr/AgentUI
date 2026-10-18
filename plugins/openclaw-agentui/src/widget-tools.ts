// One tool per widget (`agentui_chart`, `agentui_map`, `agentui_code`): the model validates its arguments with the tool's schema
// instead of writing a ```widget block. The tool returns a `[[agentui:<id>]]` token that the agent places in its text;
// AgentUI replaces it with the widget (arguments of `tool.started`, token in the result of `tool.completed`).
import { randomBytes } from 'node:crypto';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import spec from './widget-tools.json' with { type: 'json' };
import { askUser, emitMedia } from './hosts.js';
import { imagesError, readLocalImage } from './images.js';

export const WIDGET_TOOL_NAMES = [...Object.keys(spec.tools), ...Object.keys(spec.blockingTools)].map((k) => spec.prefix + k);

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
  return undefined;
}

/** Checks of the interactive tools (ask / confirm / form), like `widgetError` for display widgets. */
export function askError(key: string, args: Args): string | undefined {
  if (key === 'ask' && !String(args.question ?? '').trim()) return 'The question is empty.';
  if (key === 'ask' && !(Array.isArray(args.options) ? args.options : []).some((o) => String(o).trim())) return 'Options are required: propose at least one choice (add an "Other" choice for a free answer), or ask your question in your reply.';
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

/** AgentUI chat of a tool call: the session key of a direct peer ends with `agentui:direct:<conversationId>`. */
export function conversationOf(ctx: { sessionKey?: string; nativeChannelId?: string }): string | undefined {
  return /:agentui:direct:(.+)$/.exec(ctx.sessionKey ?? '')?.[1] ?? ctx.nativeChannelId;
}

export function registerWidgetTools(api: OpenClawPluginApi): void {
  api.registerTool((ctx) => {
    // The tools only exist in runs started from AgentUI (elsewhere, they would clutter the prompt).
    if (ctx.messageChannel !== 'agentui') return null;
    const conversationId = conversationOf(ctx);
    const blocking = Object.entries(spec.blockingTools).map(([key, tool]) => ({
      name: spec.prefix + key,
      label: spec.prefix + key,
      description: tool.description,
      parameters: tool.parameters as any,
      // Blocks until the user's answer (`reply` frame), which becomes the tool result.
      async execute(_id: string, args: Args, signal?: AbortSignal) {
        const problem = askError(key, args);
        if (problem) throw new Error(problem);
        if (!conversationId) throw new Error("AgentUI chat not found for this tool call.");
        const res = await askUser(conversationId, key, args, signal);
        if ('error' in res) throw new Error(res.error);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ answer: res.answer }) }], details: { answer: res.answer } };
      },
    }));
    const display = Object.entries(spec.tools).map(([key, tool]) => ({
      name: spec.prefix + key,
      label: spec.prefix + key,
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
        if (key === 'progress' && args.update) {
          // Update: same token, the front shows the state of the latest call.
          return { content: [{ type: 'text' as const, text: JSON.stringify({ widget: args.update, updated: true, instruction: spec.updateInstruction }) }], details: { token: args.update } };
        }
        const token = `[[agentui:${randomBytes(3).toString('hex')}]]`;
        return { content: [{ type: 'text' as const, text: JSON.stringify({ widget: token, instruction: key === 'progress' ? spec.progressInstruction : spec.tokenInstruction, ...(key === 'image' ? { files } : {}) }) }], details: { token } };
      },
    }));
    return [...display, ...blocking];
  }, { names: WIDGET_TOOL_NAMES });
}
