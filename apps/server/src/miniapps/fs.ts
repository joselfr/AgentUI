import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
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

  /** Validates a path against the grants. `real` is what was checked (symlinks resolved): read and write operate on it, not on `path`. */
  private check(p: unknown, write: boolean): { path: string; real: string; grantReal: string } {
    if (typeof p !== 'string' || !isAbsolute(p) || p.includes('\0')) throw new AppError('fs: the path must be absolute.');
    const path = normalize(p);
    if (path.split(/[\\/]/).includes('..')) throw new AppError('fs: ".." is not allowed.');
    const real = realish(path);
    const g = this.grants.find((x) => x.approved && (path === x.path || inside(path, x.path)) && this.roots.some((r) => inside(realish(x.path), realish(r))));
    if (!g) throw new AppError(`fs: "${p}" is not an approved path of this miniapp.`);
    if (write && g.mode !== 'rw') throw new AppError(`fs: "${g.path}" is read-only.`);
    // The real target (symlinks resolved) must stay inside the real granted path, and out of AgentUI's data.
    const grantReal = realish(g.path);
    if (!inside(real, grantReal) || inside(real, realish(this.dataDir))) throw new AppError(`fs: "${p}" leaves its granted folder.`);
    return { path, real, grantReal };
  }

  private resolveFor(p: unknown, write: boolean): string {
    return this.check(p, write).path;
  }

  /**
   * Opens the checked target without following a symlink as the last component, then checks again what the descriptor really points to
   * (Linux): a path swapped for a link between the check and the open cannot lead out of the grant. Size checks and I/O use the descriptor.
   */
  private open(p: unknown, write: boolean): number {
    const { real, grantReal } = this.check(p, write);
    const flags = write ? constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW : constants.O_RDONLY | constants.O_NOFOLLOW;
    let fd: number;
    try { fd = openSync(real, flags, 0o666); } catch (e) { throw new AppError(`fs: cannot open "${String(p)}" (${(e as NodeJS.ErrnoException).code ?? 'error'}).`); }
    try {
      if (existsSync('/proc/self/fd')) {
        const actual = realpathSync(`/proc/self/fd/${fd}`);
        if (!inside(actual, grantReal) || inside(actual, realish(this.dataDir))) throw new AppError(`fs: "${String(p)}" leaves its granted folder.`);
      }
    } catch (e) { closeSync(fd); throw e; }
    return fd;
  }

  readFile(p: unknown, encoding?: unknown): string {
    const fd = this.open(p, false);
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) throw new AppError('fs: not a regular file.');
      if (st.size > FS_LIMITS.maxFileBytes) throw new AppError(`fs: file larger than ${FS_LIMITS.maxFileBytes} bytes.`);
      return readFileSync(fd).toString(encoding === 'base64' ? 'base64' : 'utf8');
    } finally { closeSync(fd); }
  }
  writeFile(p: unknown, content: unknown, encoding?: unknown): true {
    const buf = Buffer.from(String(content), encoding === 'base64' ? 'base64' : 'utf8');
    if (buf.length > FS_LIMITS.maxFileBytes) throw new AppError(`fs: content larger than ${FS_LIMITS.maxFileBytes} bytes.`);
    const fd = this.open(p, true);
    try { writeFileSync(fd, buf); } finally { closeSync(fd); }
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
