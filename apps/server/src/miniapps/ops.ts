import { z } from 'zod';
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
};

export type AppOp = keyof typeof SCHEMAS;
export const isAppOp = (s: unknown): s is AppOp => typeof s === 'string' && s in SCHEMAS;

/** Operations a plugin can request on behalf of its agent (frame `app.op`). Throws `AppError` / `ZodError` for the agent. */
export async function handleAppOp(store: MiniAppStore, agentId: string, op: AppOp, rawArgs: unknown): Promise<unknown> {
  const a = SCHEMAS[op].parse(rawArgs ?? {}) as any;
  switch (op) {
    case 'create': {
      const app = store.create(agentId, a);
      return { app, next: 'Write src/main.tsx (default-export a React component) with agentui_app_write, and optionally server/<route>.js for the backend.' };
    }
    case 'write': {
      const r = await store.writeFiles(a.id, agentId, a.files);
      return r.ok ? { ok: true, files: r.files, url: `/apps/${a.id}` } : { ok: false, errors: r.errors, note: 'Build failed: the previous working version (if any) is still served. Fix the errors and write the files again.' };
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
  }
}

/** Readable error for the agent. */
export function opError(e: unknown): string {
  if (e instanceof AppError) return e.message;
  if (e instanceof z.ZodError) return e.issues.map((i) => `${i.path.join('.') || 'args'}: ${i.message}`).join('; ');
  return (e as Error).message ?? 'Internal error';
}
