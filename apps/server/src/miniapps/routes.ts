import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AuthUser } from '../auth.js';
import type { AppData } from './data.js';
import { runHandler } from './sandbox.js';
import { AppError, type MiniAppStore } from './store.js';

const TOKEN_TTL_MS = 12 * 3600 * 1000;
const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.map': 'application/json',
};

/** Token of the iframe: static files cannot rely on the cookie (opaque origin + SameSite=strict). */
export function signAppToken(secret: string, userId: number, appId: string, now = Date.now()): string {
  const exp = now + TOKEN_TTL_MS;
  const sig = createHmac('sha256', secret).update(`${userId}.${appId}.${exp}`).digest('base64url');
  return `${userId}.${exp}.${sig}`;
}

export function verifyAppToken(secret: string, appId: string, token: string, now = Date.now()): boolean {
  const [uid, exp, sig] = token.split('.');
  if (!uid || !exp || !sig || Number(exp) < now) return false;
  const good = createHmac('sha256', secret).update(`${uid}.${appId}.${exp}`).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(good);
  return a.length === b.length && timingSafeEqual(a, b);
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function indexHtml(base: string, appId: string, name: string, version: number, hasCss: boolean, nonce: string): string {
  const rt = `${base}_runtime/`;
  const imports = {
    react: `${rt}react.js`,
    'react/jsx-runtime': `${rt}jsx-runtime.js`,
    'react-dom': `${rt}react-dom.js`,
    'react-dom/client': `${rt}react-dom.js`,
    '@agentui/ui': `${rt}ui.js`,
    'chart.js': `${rt}chart.js`,
    'chart.js/auto': `${rt}chart.js`,
  };
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(name)}</title>
<link rel="stylesheet" href="${rt}base.css">${hasCss ? `\n<link rel="stylesheet" href="${base}app.css?v=${version}">` : ''}
<script type="importmap" nonce="${nonce}">${JSON.stringify({ imports })}</script>
<script nonce="${nonce}">window.__AGENTUI=${JSON.stringify({ appId, entry: `${base}app.js?v=${version}` })};</script>
</head><body><div id="root"></div><script type="module" nonce="${nonce}" src="${rt}boot.js"></script></body></html>`;
}

export interface MiniAppRoutesOpts {
  store: MiniAppStore;
  data: AppData;
  secret: string;
  userOf: (cookies: Record<string, string | undefined>) => AuthUser | null;
  runtimeDir: string;
}

export function registerMiniApps(app: FastifyInstance, o: MiniAppRoutesOpts): void {
  const { store, data, secret, runtimeDir } = o;
  const must = (id: string) => {
    const a = store.get(id);
    if (!a) throw new AppError('Unknown app', 404);
    return a;
  };

  // ---------- Authenticated API (cookie + CSRF checked by the global /api hook) ----------
  app.get('/api/apps', async () => store.list());
  app.get<{ Params: { id: string } }>('/api/apps/:id', async (req) => must(req.params.id));
  app.delete<{ Params: { id: string } }>('/api/apps/:id', async (req) => {
    store.remove(req.params.id);
    return { ok: true };
  });
  app.get<{ Params: { id: string } }>('/api/apps/:id/session', async (req) => {
    const a = must(req.params.id);
    const user = o.userOf(req.cookies)!;
    return { base: `/a/${a.id}/${signAppToken(secret, user.id, a.id)}/`, version: a.version, name: a.name };
  });

  /** Backend of an app: `/api/apps/<id>/x/<route>/…` → `server/<route>.js`, else `server/index.js`. */
  app.route<{ Params: { id: string; '*': string } }>({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    url: '/api/apps/:id/x/*',
    handler: async (req, reply) => {
      const a = must(req.params.id);
      const rest = req.params['*'].replace(/^\/+/, '');
      const [first = '', ...more] = rest.split('/');
      let name = first;
      let path = '/' + more.join('/');
      let code = first ? store.serverCode(a.id, first) : undefined;
      if (!code) {
        name = 'index';
        path = '/' + rest;
        code = store.serverCode(a.id, 'index');
      }
      if (!code) return reply.code(404).send({ error: `No backend route "${rest || '/'}" in this app.` });
      const user = o.userOf(req.cookies)!;
      const res = await runHandler({
        code,
        appId: a.id,
        req: { method: req.method, path, query: (req.query ?? {}) as Record<string, string>, body: req.body ?? null },
        user: { id: user.id, username: user.username },
        data,
        log: (l) => store.log(a.id, `[${name}] ${l}`),
        onData: () => store.dataChanged(a.id),
      });
      return reply.code(res.status).send(res.body);
    },
  });

  // ---------- Static files of the iframe (token in the path) ----------
  const sendFile = (reply: FastifyReply, file: string, cache: string) => {
    const type = MIME[extname(file)] ?? 'application/octet-stream';
    return reply
      .header('Content-Type', type)
      .header('Cache-Control', cache)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Access-Control-Allow-Origin', '*') // the sandboxed iframe has an opaque origin: module scripts are CORS requests
      .send(createReadStream(file));
  };

  app.get<{ Params: { id: string; token: string; '*': string } }>('/a/:id/:token/*', async (req, reply) => {
    const { id, token } = req.params;
    if (!verifyAppToken(secret, id, token)) return reply.code(403).send({ error: 'forbidden' });
    const a = store.get(id);
    if (!a) return reply.code(404).send({ error: 'not found' });
    const rest = req.params['*'];
    const base = `/a/${id}/${token}/`;

    if (rest === '' || rest === 'index.html') {
      const nonce = randomBytes(16).toString('base64');
      return reply
        .header('Content-Type', 'text/html; charset=utf-8')
        .header('Cache-Control', 'no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .header(
          'Content-Security-Policy',
          `default-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'`,
        )
        .send(indexHtml(base, id, a.name, a.version, !!store.distFile(id, 'app.css'), nonce));
    }
    if (rest.startsWith('_runtime/')) {
      const name = rest.slice('_runtime/'.length);
      const file = resolve(runtimeDir, name);
      if (!/^[A-Za-z0-9_.-]+$/.test(name) || !file.startsWith(resolve(runtimeDir) + sep) || !existsSync(file) || !statSync(file).isFile()) {
        return reply.code(404).send({ error: 'not found' });
      }
      return sendFile(reply, file, 'public, max-age=300');
    }
    if (rest === 'app.js' || rest === 'app.css') {
      const file = store.distFile(id, rest);
      if (!file) return reply.code(404).send({ error: 'not built' });
      return sendFile(reply, file, 'no-cache');
    }
    return reply.code(404).send({ error: 'not found' });
  });
}
