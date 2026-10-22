import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { MiniApp } from '@agentui/shared';
import type { DB } from '../db.js';
import { buildApp, type BuildError } from './build.js';
import { AppFs, checkGrantRequest, FS_LIMITS, type FsGrant, type FsMode } from './fs.js';
import { safeJoin } from '../safe-path.js';
import { INLINE_MEDIA, sniffImage, sniffMedia } from '../attachments.js';

export const APP_LIMITS = {
  maxFiles: 80,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 4 * 1024 * 1024,
  maxApps: 50,
  maxDocBytes: 256 * 1024,
  maxDocsPerApp: 20_000,
  maxKvBytes: 256 * 1024,
  maxAssets: 40,
  maxAssetBytes: 25 * 1024 * 1024,
  maxAssetsTotalBytes: 100 * 1024 * 1024,
};

const ASSET_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;


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

  constructor(private db: DB, private dataDir: string, private fsRoots: string[] = []) {
    this.root = resolve(dataDir, 'miniapps');
    mkdirSync(this.root, { recursive: true });
  }

  dir(id: string): string {
    if (!APP_ID_RE.test(id)) throw new AppError(`Invalid miniapp id "${id}" (lowercase letters, digits and dashes, 2-40 chars, starts with a letter).`);
    return safeJoin(this.root, id);
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
  private seq = new Map<string, number>();
  /** Counter of the data changes of a miniapp since the server started (a preview page polls it to refresh the app). */
  dataSeq(id: string): number {
    return this.seq.get(id) ?? 0;
  }
  dataChanged(id: string): void {
    this.seq.set(id, this.dataSeq(id) + 1);
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

  /** File grants of a miniapp (declared by the agent at registration; inactive until `approved`). */
  fsGrants(id: string): FsGrant[] {
    return (this.db.prepare('SELECT path, mode, approved FROM miniapp_fs WHERE app_id = ? ORDER BY path').all(id) as unknown as { path: string; mode: FsMode; approved: number }[])
      .map((r) => ({ path: r.path, mode: r.mode, approved: !!r.approved }));
  }

  /** `ctx.fs` of the handlers: approved grants only. */
  fsFor(id: string): AppFs | undefined {
    const grants = this.fsGrants(id).filter((g) => g.approved);
    return grants.length ? new AppFs(grants, this.fsRoots, this.dataDir) : undefined;
  }

  /** Replaces the declared grants. A grant that is unchanged keeps its approval; a new or widened one (ro → rw) waits for the user. */
  declareFs(id: string, agentId: string, entries: { path: string; mode?: string }[]): FsGrant[] {
    this.owned(id, agentId);
    if (entries.length > FS_LIMITS.maxEntries) throw new AppError(`Too many file grants (maximum ${FS_LIMITS.maxEntries}).`);
    const before = new Map(this.fsGrants(id).map((g) => [g.path, g]));
    const next = new Map<string, { path: string; mode: FsMode; approved: boolean }>();
    for (const e of entries) {
      if (e.mode !== undefined && e.mode !== 'ro' && e.mode !== 'rw') throw new AppError(`Invalid mode "${e.mode}" for "${e.path}" (ro or rw).`);
      const path = checkGrantRequest(e.path, this.fsRoots, this.dataDir);
      const mode: FsMode = e.mode === 'rw' ? 'rw' : 'ro';
      const old = before.get(path);
      next.set(path, { path, mode, approved: !!old?.approved && (old.mode === mode || mode === 'ro') });
    }
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM miniapp_fs WHERE app_id = ?').run(id);
      const ins = this.db.prepare('INSERT INTO miniapp_fs (app_id, path, mode, approved) VALUES (?,?,?,?)');
      for (const g of next.values()) ins.run(id, g.path, g.mode, g.approved ? 1 : 0);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    this.onChange?.(id, 'changed');
    return this.fsGrants(id);
  }

  /** User decision on one declared grant. */
  setFsApproval(id: string, path: string, approved: boolean): FsGrant[] {
    if (!this.get(id)) throw new AppError('Unknown miniapp', 404);
    const r = this.db.prepare('UPDATE miniapp_fs SET approved = ? WHERE app_id = ? AND path = ?').run(approved ? 1 : 0, id, path);
    if (!r.changes) throw new AppError('Unknown file grant', 404);
    this.onChange?.(id, 'changed');
    return this.fsGrants(id);
  }

  /** Scheduled tasks of the agent that belong to a miniapp (tagged by the agent with `agentui_miniapp_job`). */
  jobsOf(id: string): string[] {
    return (this.db.prepare('SELECT job_id FROM miniapp_jobs WHERE app_id = ? ORDER BY job_id').all(id) as unknown as { job_id: string }[]).map((r) => r.job_id);
  }

  /** Miniapp id by job id, for one agent. */
  jobLinks(agentId: string): Map<string, string> {
    const rows = this.db.prepare('SELECT job_id, app_id FROM miniapp_jobs WHERE agent_id = ?').all(agentId) as unknown as { job_id: string; app_id: string }[];
    return new Map(rows.map((r) => [r.job_id, r.app_id]));
  }

  linkJob(id: string, agentId: string, jobId: string): void {
    this.owned(id, agentId);
    this.db.prepare('INSERT OR REPLACE INTO miniapp_jobs (app_id, agent_id, job_id) VALUES (?,?,?)').run(id, agentId, jobId);
    this.onChange?.(id, 'changed');
  }

  /** Forgets the tag of a job (unlinked by the agent, or the job itself was deleted). */
  unlinkJob(agentId: string, jobId: string): void {
    const row = this.db.prepare('SELECT app_id FROM miniapp_jobs WHERE agent_id = ? AND job_id = ?').get(agentId, jobId) as unknown as { app_id: string } | undefined;
    if (!row) return;
    this.db.prepare('DELETE FROM miniapp_jobs WHERE agent_id = ? AND job_id = ?').run(agentId, jobId);
    this.onChange?.(row.app_id, 'changed');
  }

  /** Called with the tagged jobs just before a miniapp is removed, to delete them from the agent's scheduler. */
  purgeJobs?: (agentId: string, jobIds: string[]) => Promise<void>;

  /** Removes a miniapp together with its scheduled tasks (best effort: the miniapp goes away even if the scheduler is unreachable). */
  async destroy(id: string, agentId?: string): Promise<void> {
    const app = agentId ? this.owned(id, agentId) : this.get(id);
    if (!app) throw new AppError(`Unknown miniapp "${id}".`, 404);
    const jobs = this.jobsOf(id);
    if (jobs.length) await this.purgeJobs?.(app.agentId, jobs).catch(() => {});
    this.remove(id, agentId);
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

  // ---------- Assets: images, videos and audio files the agent gives to the miniapp (`<dir>/assets/<name>`) ----------
  private assetsDir(id: string): string {
    return safeJoin(this.dir(id), 'assets');
  }

  /** Media files of a miniapp with their verified type. */
  assets(id: string): { name: string; mimeType: string; size: number }[] {
    const dir = this.assetsDir(id);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((n) => ASSET_RE.test(n)).sort().map((name) => {
      const p = join(dir, name);
      return { name, mimeType: this.assetType(p) ?? 'application/octet-stream', size: statSync(p).size };
    });
  }

  private assetType(path: string): string | undefined {
    const head = readFileSync(path).subarray(0, 16);
    const t = sniffImage(head) ?? sniffMedia(head);
    return t && (/^image\//.test(t) || INLINE_MEDIA.test(t)) ? t : undefined;
  }

  /** Stored asset: its path and verified type, or undefined. Only what `writeAsset` accepted (image, video, audio) is ever served. */
  asset(id: string, name: string): { path: string; mimeType: string; size: number } | undefined {
    if (!ASSET_RE.test(name)) return undefined;
    const path = safeJoin(this.assetsDir(id), name);
    if (!existsSync(path)) return undefined;
    const mimeType = this.assetType(path);
    return mimeType ? { path, mimeType, size: statSync(path).size } : undefined;
  }

  /** Stores (or replaces) an image, video or audio file. The type is read from the content, never from the name. */
  writeAsset(id: string, agentId: string, name: string, data: Buffer): { name: string; mimeType: string; size: number } {
    this.owned(id, agentId);
    if (!ASSET_RE.test(name)) throw new AppError(`Invalid asset name "${name}": letters, digits, ".", "_" and "-" only (100 characters at most, no slash).`);
    const mimeType = sniffImage(data) ?? sniffMedia(data);
    if (!mimeType || !(/^image\//.test(mimeType) || INLINE_MEDIA.test(mimeType))) throw new AppError(`"${name}" is not a png, jpeg, gif, webp image, nor an mp4, webm, mov or common audio file.`);
    if (data.length > APP_LIMITS.maxAssetBytes) throw new AppError(`"${name}" is too large (maximum ${APP_LIMITS.maxAssetBytes / 1048576} MB).`);
    const others = this.assets(id).filter((a) => a.name !== name);
    if (others.length >= APP_LIMITS.maxAssets) throw new AppError(`Too many assets (maximum ${APP_LIMITS.maxAssets}).`);
    if (others.reduce((n, a) => n + a.size, data.length) > APP_LIMITS.maxAssetsTotalBytes) throw new AppError(`The assets of this miniapp exceed ${APP_LIMITS.maxAssetsTotalBytes / 1048576} MB in total.`);
    mkdirSync(this.assetsDir(id), { recursive: true });
    writeFileSync(safeJoin(this.assetsDir(id), name), data, { mode: 0o600 });
    this.dataChanged(id); // open iframes reload their media
    return { name, mimeType, size: data.length };
  }

  deleteAsset(id: string, agentId: string, name: string): void {
    this.owned(id, agentId);
    if (!this.asset(id, name)) throw new AppError(`No such asset "${name}".`, 404);
    rmSync(safeJoin(this.assetsDir(id), name));
    this.dataChanged(id);
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
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name)) return undefined; // no leading dot: neither ".." nor hidden files
    const p = safeJoin(this.dir(id), 'dist', name);
    return existsSync(p) ? p : undefined;
  }

  /** Compiled handler (`dist/server/<name>.cjs`). */
  serverCode(id: string, name: string): string | undefined {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) return undefined;
    const p = safeJoin(this.dir(id), 'dist', 'server', `${name}.cjs`);
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
