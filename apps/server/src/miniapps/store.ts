import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { MiniApp } from '@agentui/shared';
import type { DB } from '../db.js';
import { buildApp, type BuildError } from './build.js';

export const APP_LIMITS = {
  maxFiles: 80,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 4 * 1024 * 1024,
  maxApps: 50,
  maxDocBytes: 256 * 1024,
  maxDocsPerApp: 20_000,
  maxKvBytes: 256 * 1024,
};

/** Validation error meant for the agent (tool error) or the user (HTTP 4xx). */
export class AppError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export interface MiniAppRow {
  id: string;
  agent_id: string;
  name: string;
  icon: string;
  description: string;
  version: number;
  created_at: number;
  updated_at: number;
}

export const APP_ID_RE = /^[a-z][a-z0-9-]{1,39}$/;
const FILE_RE = /^(src|server)\/[A-Za-z0-9_./-]+\.(tsx?|jsx?|css|json|svg|txt|md)$/;
const SERVER_RE = /^server\/[A-Za-z0-9_-]+\.(js|ts)$/;
const LOG_MAX = 200;

export const toDto = (r: MiniAppRow): MiniApp => ({
  id: r.id,
  agentId: r.agent_id,
  name: r.name,
  icon: r.icon,
  description: r.description,
  version: r.version,
  updatedAt: r.updated_at,
});

/** Files of the miniapps (`<dataDir>/miniapps/<id>/{src,server,dist}`) + their metadata in SQLite. */
export class MiniAppStore {
  readonly root: string;
  private logs = new Map<string, string[]>();
  /** Notified after each change (create / write / remove) so that the web clients refresh. */
  onChange?: (id: string, kind: 'changed' | 'removed') => void;

  constructor(private db: DB, dataDir: string) {
    this.root = resolve(dataDir, 'miniapps');
    mkdirSync(this.root, { recursive: true });
  }

  dir(id: string): string {
    if (!APP_ID_RE.test(id)) throw new AppError(`Invalid miniapp id "${id}" (lowercase letters, digits and dashes, 2-40 chars, starts with a letter).`);
    return join(this.root, id);
  }

  list(): MiniApp[] {
    return (this.db.prepare('SELECT * FROM miniapps ORDER BY name').all() as unknown as MiniAppRow[]).map(toDto);
  }

  get(id: string): MiniApp | undefined {
    const r = this.db.prepare('SELECT * FROM miniapps WHERE id = ?').get(id) as unknown as MiniAppRow | undefined;
    return r && toDto(r);
  }

  /** Notified when the data of a miniapp changed (agent tool or handler): open iframes refresh. */
  onData?: (id: string) => void;
  dataChanged(id: string): void {
    this.onData?.(id);
  }

  assertOwner(id: string, agentId: string): void {
    this.owned(id, agentId);
  }

  /** The agent can only touch its own miniapps. */
  private owned(id: string, agentId: string): MiniApp {
    const a = this.get(id);
    if (!a) throw new AppError(`Unknown miniapp "${id}". Create it first with agentui_miniapp_create.`, 404);
    if (a.agentId !== agentId) throw new AppError(`Miniapp "${id}" belongs to another agent.`, 403);
    return a;
  }

  create(agentId: string, input: { id: string; name: string; icon?: string; description?: string }): MiniApp {
    const dir = this.dir(input.id);
    const name = input.name.trim().slice(0, 60);
    if (!name) throw new AppError('The miniapp needs a name.');
    const now = Date.now();
    const existing = this.get(input.id);
    if (existing) {
      if (existing.agentId !== agentId) throw new AppError(`Miniapp "${input.id}" already exists (other agent).`, 403);
      this.db
        .prepare('UPDATE miniapps SET name = ?, icon = ?, description = ?, updated_at = ? WHERE id = ?')
        .run(name, (input.icon ?? existing.icon).slice(0, 40), (input.description ?? existing.description).slice(0, 300), now, input.id);
    } else {
      if (this.list().length >= APP_LIMITS.maxApps) throw new AppError(`Too many miniapps (maximum ${APP_LIMITS.maxApps}).`);
      this.db
        .prepare('INSERT INTO miniapps (id, agent_id, name, icon, description, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
        .run(input.id, agentId, name, (input.icon ?? 'apps').slice(0, 40), (input.description ?? '').slice(0, 300), now, now);
      mkdirSync(join(dir, 'src'), { recursive: true });
      mkdirSync(join(dir, 'server'), { recursive: true });
    }
    this.onChange?.(input.id, 'changed');
    return this.get(input.id)!;
  }

  remove(id: string, agentId?: string): void {
    if (agentId) this.owned(id, agentId);
    else if (!this.get(id)) throw new AppError(`Unknown miniapp "${id}".`, 404);
    this.db.prepare('DELETE FROM miniapps WHERE id = ?').run(id); // docs / kv: ON DELETE CASCADE
    rmSync(this.dir(id), { recursive: true, force: true });
    this.logs.delete(id);
    this.onChange?.(id, 'removed');
  }

  private safePath(id: string, path: string): string {
    if (!FILE_RE.test(path) || path.includes('..') || path.includes('//')) {
      throw new AppError(`Invalid path "${path}": must be src/** (front) or server/** (handlers) (tsx, ts, jsx, js, css, json, svg, txt, md).`);
    }
    if (path.startsWith('server/') && !SERVER_RE.test(path)) {
      throw new AppError(`Invalid handler path "${path}": handler files are flat, e.g. server/todos.js.`);
    }
    const base = this.dir(id);
    const full = resolve(base, path);
    if (!full.startsWith(base + sep)) throw new AppError(`Invalid path "${path}".`);
    return full;
  }

  files(id: string): { path: string; size: number }[] {
    const base = this.dir(id);
    const out: { path: string; size: number }[] = [];
    const walk = (rel: string) => {
      const abs = join(base, rel);
      if (!existsSync(abs)) return;
      for (const e of readdirSync(abs, { withFileTypes: true })) {
        const r = `${rel}/${e.name}`;
        if (e.isDirectory()) walk(r);
        else out.push({ path: r, size: statSync(join(base, r)).size });
      }
    };
    walk('src');
    walk('server');
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  readFile(id: string, agentId: string, path: string): string {
    this.owned(id, agentId);
    const full = this.safePath(id, path);
    if (!existsSync(full)) throw new AppError(`No such file "${path}".`, 404);
    return readFileSync(full, 'utf8');
  }

  /** Writes (or replaces) files then rebuilds. Build errors are reported, not thrown: the agent fixes and rewrites. */
  async writeFiles(id: string, agentId: string, files: { path: string; content: string }[]): Promise<{ ok: boolean; errors: BuildError[]; files: number }> {
    this.owned(id, agentId);
    if (!files.length) throw new AppError('No file to write.');
    const current = this.files(id);
    const sizes = new Map(current.map((f) => [f.path, f.size]));
    for (const f of files) {
      const bytes = Buffer.byteLength(f.content);
      if (bytes > APP_LIMITS.maxFileBytes) throw new AppError(`"${f.path}" is too large (${bytes} bytes, maximum ${APP_LIMITS.maxFileBytes}).`);
      this.safePath(id, f.path);
      sizes.set(f.path, bytes);
    }
    if (sizes.size > APP_LIMITS.maxFiles) throw new AppError(`Too many files (maximum ${APP_LIMITS.maxFiles}).`);
    if ([...sizes.values()].reduce((a, b) => a + b, 0) > APP_LIMITS.maxTotalBytes) throw new AppError('The miniapp is too large.');
    for (const f of files) {
      const full = this.safePath(id, f.path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, f.content);
    }
    return this.rebuild(id);
  }

  async deleteFile(id: string, agentId: string, path: string): Promise<{ ok: boolean; errors: BuildError[] }> {
    this.owned(id, agentId);
    const full = this.safePath(id, path);
    if (!existsSync(full)) throw new AppError(`No such file "${path}".`, 404);
    rmSync(full);
    return this.rebuild(id);
  }

  async rebuild(id: string): Promise<{ ok: boolean; errors: BuildError[]; files: number }> {
    const res = await buildApp(this.dir(id));
    this.db.prepare('UPDATE miniapps SET version = version + 1, updated_at = ? WHERE id = ?').run(Date.now(), id);
    this.onChange?.(id, 'changed');
    return { ...res, files: this.files(id).length };
  }

  /** Built file served to the iframe (`dist/…`), or undefined. */
  distFile(id: string, name: string): string | undefined {
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) return undefined;
    const p = join(this.dir(id), 'dist', name);
    return existsSync(p) ? p : undefined;
  }

  /** Compiled handler (`dist/server/<name>.cjs`). */
  serverCode(id: string, name: string): string | undefined {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) return undefined;
    const p = join(this.dir(id), 'dist', 'server', `${name}.cjs`);
    return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
  }

  log(id: string, line: string): void {
    const l = this.logs.get(id) ?? [];
    l.push(`${new Date().toISOString().slice(11, 19)} ${line}`.slice(0, 600));
    if (l.length > LOG_MAX) l.shift();
    this.logs.set(id, l);
  }

  getLogs(id: string, agentId: string): string[] {
    this.owned(id, agentId);
    return this.logs.get(id) ?? [];
  }
}
