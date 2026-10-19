import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, normalize, resolve, sep } from 'node:path';
import { AppError } from './store.js';

export type FsMode = 'ro' | 'rw';
export interface FsGrant { path: string; mode: FsMode; approved: boolean }

export const FS_LIMITS = { maxEntries: 20, maxFileBytes: 2 * 1024 * 1024, maxDirEntries: 1000 };

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/** Real path of `p`, or of its nearest existing ancestor + the missing tail (so a symlink cannot lead out of a grant). */
function realish(p: string): string {
  let cur = p;
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) return p;
    tail.unshift(cur.slice(up.length).replace(/^[\\/]+/, ''));
    cur = up;
  }
  return resolve(realpathSync(cur), ...tail);
}

/** Validates the paths a miniapp asks for: absolute, normalised, under a root allowed by the admin, never inside the AgentUI data dir. */
export function checkGrantRequest(p: unknown, roots: string[], dataDir: string): string {
  if (typeof p !== 'string' || !isAbsolute(p) || p.includes('\0')) throw new AppError(`File path "${String(p)}" must be absolute.`);
  const path = normalize(p).replace(/(.)[\\/]+$/, '$1');
  if (path.split(/[\\/]/).includes('..')) throw new AppError(`File path "${p}" must not contain "..".`);
  if (!roots.length) throw new AppError('File access is not enabled on this server (the administrator must set MINIAPP_FS_ROOTS).');
  const real = realish(path);
  if (inside(real, realish(dataDir)) || inside(realish(dataDir), real)) throw new AppError(`"${p}" overlaps AgentUI's own data and cannot be granted.`);
  if (!roots.some((r) => inside(real, realish(r)))) throw new AppError(`"${p}" is outside the folders the administrator allows: ${roots.join(', ')}.`);
  return path;
}

/** `ctx.fs` of a miniapp handler: only the paths granted at registration AND approved by the user, re-checked on each call. */
export class AppFs {
  constructor(private grants: FsGrant[], private roots: string[], private dataDir: string) {}

  private resolveFor(p: unknown, write: boolean): string {
    if (typeof p !== 'string' || !isAbsolute(p) || p.includes('\0')) throw new AppError('fs: the path must be absolute.');
    const path = normalize(p);
    if (path.split(/[\\/]/).includes('..')) throw new AppError('fs: ".." is not allowed.');
    const real = realish(path);
    const g = this.grants.find((x) => x.approved && (path === x.path || inside(path, x.path)) && this.roots.some((r) => inside(realish(x.path), realish(r))));
    if (!g) throw new AppError(`fs: "${p}" is not an approved path of this miniapp.`);
    if (write && g.mode !== 'rw') throw new AppError(`fs: "${g.path}" is read-only.`);
    // The real target (symlinks resolved) must stay inside the real granted path, and out of AgentUI's data.
    if (!inside(real, realish(g.path)) || inside(real, realish(this.dataDir))) throw new AppError(`fs: "${p}" leaves its granted folder.`);
    return path;
  }

  readFile(p: unknown, encoding?: unknown): string {
    const f = this.resolveFor(p, false);
    if (statSync(f).size > FS_LIMITS.maxFileBytes) throw new AppError(`fs: file larger than ${FS_LIMITS.maxFileBytes} bytes.`);
    return readFileSync(f).toString(encoding === 'base64' ? 'base64' : 'utf8');
  }
  writeFile(p: unknown, content: unknown, encoding?: unknown): true {
    const f = this.resolveFor(p, true);
    const buf = Buffer.from(String(content), encoding === 'base64' ? 'base64' : 'utf8');
    if (buf.length > FS_LIMITS.maxFileBytes) throw new AppError(`fs: content larger than ${FS_LIMITS.maxFileBytes} bytes.`);
    writeFileSync(f, buf);
    return true;
  }
  readdir(p: unknown): { name: string; type: 'file' | 'dir' | 'other'; size: number }[] {
    const f = this.resolveFor(p, false);
    return readdirSync(f, { withFileTypes: true }).slice(0, FS_LIMITS.maxDirEntries).map((e) => {
      let size = 0;
      try { if (e.isFile()) size = statSync(resolve(f, e.name)).size; } catch { /* vanished */ }
      return { name: e.name, type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other', size };
    });
  }
  stat(p: unknown): { type: 'file' | 'dir' | 'other'; size: number; mtime: number } | null {
    const f = this.resolveFor(p, false);
    if (!existsSync(f)) return null;
    const s = statSync(f);
    return { type: s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other', size: s.size, mtime: s.mtimeMs };
  }
  mkdir(p: unknown): true {
    mkdirSync(this.resolveFor(p, true), { recursive: true });
    return true;
  }
  /** Removes a file or an EMPTY folder (never recursive). */
  remove(p: unknown): boolean {
    const f = this.resolveFor(p, true);
    if (this.grants.some((g) => g.approved && normalize(g.path) === f)) throw new AppError('fs: the granted root itself cannot be removed.');
    if (!existsSync(f)) return false;
    if (statSync(f).isDirectory()) rmdirSync(f); else rmSync(f);
    return true;
  }
}
