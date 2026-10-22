import { z } from 'zod';
import type { AppData } from './data.js';
import { PREVIEW_DEFAULT_TTL_S, PREVIEW_MAX_TTL_S, WIDGET_WIDTH, widgetPreviewId } from './preview.js';
import type { WidgetStore } from './widgets.js';
import { AppError, type MiniAppStore } from './store.js';

const id = z.string().min(1).max(60);
const path = z.string().min(1).max(200);

const SCHEMAS = {
  create: z.object({ id, name: z.string().min(1).max(60), icon: z.string().max(40).optional(), description: z.string().max(300).optional(),
    fs: z.array(z.object({ path: z.string().min(1).max(500), mode: z.enum(['ro', 'rw']).optional() })).max(20).optional(),
  }),
  write: z.object({ id, files: z.array(z.object({ path, content: z.string() })).min(1).max(40) }),
  read: z.object({ id, path }),
  list: z.object({}).passthrough(),
  delete_file: z.object({ id, path }),
  remove: z.object({ id }),
  asset: z.object({ id, name: z.string().min(1).max(100), data: z.string().min(1) }), // base64 content, read by the plugin from the agent's machine
  delete_asset: z.object({ id, name: z.string().min(1).max(100) }),
  logs: z.object({ id }),
  open: z.object({ id, ttl_s: z.number().int().min(60).max(PREVIEW_MAX_TTL_S).optional() }),
  widget_open: z.object({ code: z.string().min(1), width: z.number().int().min(WIDGET_WIDTH.min).max(WIDGET_WIDTH.max).optional(), ttl_s: z.number().int().min(60).max(PREVIEW_MAX_TTL_S).optional() }),
  job: z.object({ id, action: z.enum(['link', 'unlink', 'list']), job_id: z.string().min(1).max(200).optional() }),
  data: z.object({
    id,
    action: z.enum(['find', 'get', 'insert', 'update', 'remove', 'kv_get', 'kv_set', 'kv_delete']),
    collection: z.string().max(40).optional(),
    doc_id: z.string().max(100).optional(),
    doc: z.record(z.unknown()).optional(),
    filter: z.record(z.unknown()).optional(),
    limit: z.number().int().min(1).max(5000).optional(),
    sort: z.string().max(60).optional(),
    desc: z.boolean().optional(),
    key: z.string().max(200).optional(),
    value: z.unknown().optional(),
  }),
};

export type AppOp = keyof typeof SCHEMAS;
export const isAppOp = (s: unknown): s is AppOp => typeof s === 'string' && s in SCHEMAS;

/** Operations a plugin can request on behalf of its agent (frame `miniapp.op`). Throws `AppError` / `ZodError` for the agent. */
/** What only the server wiring knows: how to mint a preview link (`open`, `widget_open`) and the widget compiler. */
export interface AppOpContext {
  widgets: WidgetStore;
  preview(appId: string, ttlS: number): { url: string; expiresAt: number };
}

export async function handleAppOp(store: MiniAppStore, data: AppData, agentId: string, op: AppOp, rawArgs: unknown, ctx?: AppOpContext): Promise<unknown> {
  const a = SCHEMAS[op].parse(rawArgs ?? {}) as any;
  switch (op) {
    case 'create': {
      const app = store.create(agentId, a);
      const fs = a.fs ? store.declareFs(a.id, agentId, a.fs) : undefined;
      const pending = fs?.filter((g: { approved: boolean }) => !g.approved).length;
      return { app, ...(fs ? { fs, fsNote: pending ? `${pending} file grant(s) wait for the user's approval in the miniapp header; ctx.fs fails on them until then. Tell the user.` : 'All file grants are approved.' } : {}), next: 'Write src/main.tsx (default-export a React component) with agentui_miniapp_write, and optionally handlers in server/<route>.js.' };
    }
    case 'write': {
      const r = await store.writeFiles(a.id, agentId, a.files);
      return r.ok ? { ok: true, files: r.files, url: `/miniapps/${a.id}` } : { ok: false, errors: r.errors, note: 'Build failed: the previous working version (if any) is still served. Fix the errors and write the files again.' };
    }
    case 'read':
      return { path: a.path, content: store.readFile(a.id, agentId, a.path) };
    case 'list':
      return store.list().filter((x) => x.agentId === agentId).map((x) => ({ ...x, files: store.files(x.id), assets: store.assets(x.id), fs: store.fsGrants(x.id) }));
    case 'delete_file': {
      const r = await store.deleteFile(a.id, agentId, a.path);
      return r.ok ? { ok: true } : { ok: false, errors: r.errors };
    }
    case 'remove':
      await store.destroy(a.id, agentId);
      return { ok: true };
    case 'job': {
      store.assertOwner(a.id, agentId);
      if (a.action === 'list') return { jobs: store.jobsOf(a.id) };
      if (!a.job_id) throw new AppError(`"job_id" is required for action ${a.action}.`);
      if (a.action === 'link') store.linkJob(a.id, agentId, a.job_id);
      else store.unlinkJob(agentId, a.job_id);
      return { ok: true, jobs: store.jobsOf(a.id) };
    }
    case 'asset': {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(a.data)) throw new AppError('The asset content must be base64.');
      const r = store.writeAsset(a.id, agentId, a.name, Buffer.from(a.data, 'base64'));
      return { ok: true, ...r, usage: `In the front: useMedia('${r.name}') or <Media name="${r.name}" />.` };
    }
    case 'delete_asset':
      store.deleteAsset(a.id, agentId, a.name);
      return { ok: true };
    case 'logs':
      return { lines: store.getLogs(a.id, agentId) };
    case 'open': {
      store.assertOwner(a.id, agentId);
      if (!ctx) throw new AppError('Preview links are not available on this server.');
      const p = ctx.preview(a.id, a.ttl_s ?? PREVIEW_DEFAULT_TTL_S);
      return {
        ...p,
        expiresAt: new Date(p.expiresAt).toISOString(),
        note: 'Open this URL in your browser. The page runs the miniapp for real, as the user would use it (handlers and data included). Errors of the front and failed handler calls are written in the page text (#agentui-errors, body[data-state]). The link only opens this miniapp and expires; ask for a new one after that.',
      };
    }
    case 'widget_open': {
      if (!ctx) throw new AppError('Preview links are not available on this server.');
      const r = await ctx.widgets.compile(a.code);
      if (!r.ok) return { ok: false, errors: r.errors, note: 'The widget does not compile. Fix the errors and call again; nothing was opened.' };
      const p = ctx.preview(widgetPreviewId(r.hash), a.ttl_s ?? PREVIEW_DEFAULT_TTL_S);
      return {
        ok: true,
        url: `${p.url}?w=${a.width ?? WIDGET_WIDTH.default}`,
        expiresAt: new Date(p.expiresAt).toISOString(),
        note: `Open this URL in your browser. The page shows the widget as in the chat, in a column ${a.width ?? WIDGET_WIDTH.default}px wide (a phone), sized to its content, in the theme of your browser. Errors of the widget are written in the page text (#agentui-errors, body[data-state] is loading, ready or error); what it sends with reply() shows in #agentui-replies instead of reaching a conversation. It has no backend and no state from the agent. The link shows this code only and expires; the page does not reload when you fix the code, call this tool again.`,
      };
    }
    case 'data': {
      store.assertOwner(a.id, agentId);
      const need = (v: unknown, name: string) => {
        if (v === undefined) throw new AppError(`"${name}" is required for action ${a.action}.`);
        return v;
      };
      switch (a.action) {
        case 'find': return data.find(a.id, need(a.collection, 'collection'), a.filter, { limit: a.limit, sort: a.sort, desc: a.desc });
        case 'get': return data.get(a.id, need(a.collection, 'collection'), need(a.doc_id, 'doc_id'));
        case 'insert': { const r = data.insert(a.id, need(a.collection, 'collection'), need(a.doc, 'doc')); store.dataChanged(a.id); return r; }
        case 'update': { const r = data.update(a.id, need(a.collection, 'collection'), need(a.doc_id, 'doc_id'), need(a.doc, 'doc')); store.dataChanged(a.id); return r ?? { error: 'No such document.' }; }
        case 'remove': { const r = data.remove(a.id, need(a.collection, 'collection'), need(a.doc_id, 'doc_id')); store.dataChanged(a.id); return { removed: r }; }
        case 'kv_get': return { value: data.kvGet(a.id, need(a.key, 'key')) };
        case 'kv_set': { data.kvSet(a.id, need(a.key, 'key'), a.value); store.dataChanged(a.id); return { ok: true }; }
        case 'kv_delete': { data.kvDelete(a.id, need(a.key, 'key')); store.dataChanged(a.id); return { ok: true }; }
      }
    }
  }
}

/** Readable error for the agent. */
export function opError(e: unknown): string {
  if (e instanceof AppError) return e.message;
  if (e instanceof z.ZodError) return e.issues.map((i) => `${i.path.join('.') || 'args'}: ${i.message}`).join('; ');
  return (e as Error).message ?? 'Internal error';
}
