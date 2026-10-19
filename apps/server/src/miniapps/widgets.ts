import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build, type Message } from 'esbuild';
import { RUNTIME_EXTERNALS, type BuildError } from './build.js';
import { AppError } from './store.js';

export const WIDGET_LIMITS = { maxCodeBytes: 64 * 1024, maxCached: 300 };
const HASH_RE = /^[0-9a-f]{24}$/;

/**
 * Widgets of the `agentui_custom_widget` tool: a single TSX module written by the agent in the chat, compiled on demand and
 * served to a sandboxed iframe with the same runtime as the miniapps (`@agentui/ui`). The code travels with the tool
 * call (so the widget survives a reload); the server only caches the compiled output by content hash.
 */
export class WidgetStore {
  readonly root: string;
  private building = new Map<string, Promise<void>>();

  constructor(dataDir: string) {
    this.root = resolve(dataDir, 'widgets');
    mkdirSync(this.root, { recursive: true });
  }

  static hash(code: string): string {
    return createHash('sha256').update(code).digest('hex').slice(0, 24);
  }

  static validHash = (h: string) => HASH_RE.test(h);

  /** Compiled bundle of a widget, if built. */
  file(hash: string): string | undefined {
    const f = join(this.root, hash, 'app.js');
    return HASH_RE.test(hash) && existsSync(f) ? f : undefined;
  }

  /** Compiles `code` (cached). Returns the hash, or the compilation errors for the agent/user to read. */
  async compile(code: string): Promise<{ ok: true; hash: string } | { ok: false; errors: BuildError[] }> {
    if (typeof code !== 'string' || !code.trim()) throw new AppError('code is required');
    if (Buffer.byteLength(code) > WIDGET_LIMITS.maxCodeBytes) throw new AppError(`Widget code is too large (max ${WIDGET_LIMITS.maxCodeBytes / 1024} KB).`, 413);
    const hash = WidgetStore.hash(code);
    if (this.file(hash)) return { ok: true, hash };
    const pending = this.building.get(hash) ?? this.run(hash, code);
    this.building.set(hash, pending);
    try { await pending; } catch (e) {
      const errors = (e as { errors?: Message[] }).errors;
      return { ok: false, errors: errors?.length ? errors.map(fmt) : [{ message: (e as Error).message }] };
    } finally { this.building.delete(hash); }
    return { ok: true, hash };
  }

  private async run(hash: string, code: string): Promise<void> {
    const out = join(this.root, hash);
    await build({
      stdin: { contents: code, loader: 'tsx', sourcefile: 'widget.tsx', resolveDir: this.root },
      outfile: join(out, 'app.js'),
      bundle: true, format: 'esm', target: 'es2022', jsx: 'automatic', platform: 'browser',
      external: RUNTIME_EXTERNALS, minify: false, sourcemap: false, logLevel: 'silent', write: false, nodePaths: [],
      plugins: [{
        name: 'sandbox', // only the runtime modules: no relative imports, no filesystem
        setup(b) {
          b.onResolve({ filter: /.*/ }, (a) => (RUNTIME_EXTERNALS.includes(a.path) || a.kind === 'entry-point'
            ? undefined
            : { errors: [{ text: `Cannot import "${a.path}": only ${RUNTIME_EXTERNALS.filter((m) => !m.startsWith('react-dom') && m !== 'react/jsx-runtime').join(', ')} are available.` }] }));
        },
      }],
    }).then((r) => {
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'app.js'), r.outputFiles[0]!.text);
    });
    this.prune();
  }

  /** Keeps the most recently built widgets only. */
  private prune() {
    const dirs = readdirSync(this.root).filter((d) => HASH_RE.test(d)).map((d) => ({ d, t: statSync(join(this.root, d)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const { d } of dirs.slice(WIDGET_LIMITS.maxCached)) rmSync(join(this.root, d), { recursive: true, force: true });
  }
}

const fmt = (m: Message): BuildError => ({
  line: m.location?.line,
  column: m.location ? m.location.column + 1 : undefined,
  message: m.text + (m.location?.lineText ? ` — ${m.location.lineText.trim().slice(0, 120)}` : ''),
});
