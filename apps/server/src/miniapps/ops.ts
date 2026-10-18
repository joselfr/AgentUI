import { z } from 'zod';
import type { AppData } from './data.js';
import { AppError, type MiniAppStore } from './store.js';

const id = z.string().min(1).max(60);
const path = z.string().min(1).max(200);

const SCHEMAS = {
  create: z.object({ id, name: z.string().min(1).max(60), icon: z.string().max(40).optional(), description: z.string().max(300).optional() }),
  write: z.object({ id, files: z.array(z.object({ path, content: z.string() })).min(1).max(40) }),
  read: z.object({ id, path }),
  list: z.object({}).passthrough(),
  delete_file: z.object({ id, path }),
  remove: z.object({ id }),
  logs: z.object({ id }),
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
export async function handleAppOp(store: MiniAppStore, data: AppData, agentId: string, op: AppOp, rawArgs: unknown): Promise<unknown> {
  const a = SCHEMAS[op].parse(rawArgs ?? {}) as any;
  switch (op) {
    case 'create': {
      const app = store.create(agentId, a);
      return { app, next: 'Write src/main.tsx (default-export a React component) with agentui_miniapp_write, and optionally handlers in server/<route>.js.' };
    }
    case 'write': {
      const r = await store.writeFiles(a.id, agentId, a.files);
      return r.ok ? { ok: true, files: r.files, url: `/miniapps/${a.id}` } : { ok: false, errors: r.errors, note: 'Build failed: the previous working version (if any) is still served. Fix the errors and write the files again.' };
    }
    case 'read':
      return { path: a.path, content: store.readFile(a.id, agentId, a.path) };
    case 'list':
      return store.list().filter((x) => x.agentId === agentId).map((x) => ({ ...x, files: store.files(x.id) }));
    case 'delete_file': {
      const r = await store.deleteFile(a.id, agentId, a.path);
      return r.ok ? { ok: true } : { ok: false, errors: r.errors };
    }
    case 'remove':
      store.remove(a.id, agentId);
      return { ok: true };
    case 'logs':
      return { lines: store.getLogs(a.id, agentId) };
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
