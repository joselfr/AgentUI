import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build, transform, type Message } from 'esbuild';

export interface BuildError {
  file?: string;
  line?: number;
  column?: number;
  message: string;
}

/** Modules provided by the runtime (import map of the iframe): never bundled in the app. */
export const RUNTIME_EXTERNALS = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@agentui/ui', 'chart.js', 'chart.js/auto'];

const fmt = (m: Message): BuildError => ({
  file: m.location?.file,
  line: m.location?.line,
  column: m.location ? m.location.column + 1 : undefined,
  message: m.text + (m.location?.lineText ? ` — ${m.location.lineText.trim().slice(0, 120)}` : ''),
});

/**
 * Compiles a miniapp: front `src/main.tsx` → `dist/app.js` (+ `dist/app.css`), handlers `server/*.{js,ts}` → `dist/server/*.cjs`.
 * Returns the errors (empty = ok). The previous `dist/` is kept untouched if the build fails.
 */
export async function buildApp(dir: string): Promise<{ ok: boolean; errors: BuildError[] }> {
  const errors: BuildError[] = [];
  const out = join(dir, 'dist.tmp');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'server'), { recursive: true });

  const entry = ['src/main.tsx', 'src/main.ts', 'src/main.jsx', 'src/main.js'].find((e) => existsSync(join(dir, e)));
  if (!entry) errors.push({ file: 'src/main.tsx', message: 'Missing entry point: create src/main.tsx (default-export a React component).' });
  else {
    try {
      const r = await build({
        absWorkingDir: dir,
        entryPoints: [entry],
        outfile: join(out, 'app.js'),
        bundle: true,
        format: 'esm',
        target: 'es2022',
        jsx: 'automatic',
        platform: 'browser',
        external: RUNTIME_EXTERNALS,
        loader: { '.svg': 'dataurl', '.json': 'json' },
        minify: false,
        sourcemap: 'inline',
        logLevel: 'silent',
        write: true,
        nodePaths: [],
      });
      errors.push(...r.errors.map(fmt));
    } catch (e) {
      const f = (e as { errors?: Message[] }).errors;
      if (f?.length) errors.push(...f.map(fmt));
      else errors.push({ message: (e as Error).message });
    }
  }

  const srv = join(dir, 'server');
  if (existsSync(srv)) {
    for (const f of readdirSync(srv)) {
      if (!/\.(js|ts)$/.test(f)) continue;
      try {
        const r = await transform(readFileSync(join(srv, f), 'utf8'), {
          loader: f.endsWith('.ts') ? 'ts' : 'js',
          format: 'cjs',
          target: 'es2022',
          sourcefile: `server/${f}`,
          logLevel: 'silent',
        });
        writeFileSync(join(out, 'server', f.replace(/\.(js|ts)$/, '.cjs')), r.code);
      } catch (e) {
        const f2 = (e as { errors?: Message[] }).errors;
        if (f2?.length) errors.push(...f2.map(fmt).map((x) => ({ ...x, file: x.file ?? `server/${f}` })));
        else errors.push({ file: `server/${f}`, message: (e as Error).message });
      }
    }
  }

  if (errors.length) {
    rmSync(out, { recursive: true, force: true });
    return { ok: false, errors };
  }
  const dist = join(dir, 'dist');
  rmSync(dist, { recursive: true, force: true });
  renameSync(out, dist);
  return { ok: true, errors: [] };
}
