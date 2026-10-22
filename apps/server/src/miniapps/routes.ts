import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthUser } from '../auth.js';
import type { AppData } from './data.js';
import { runHandler, type SandboxResult } from './sandbox.js';
import { AppError, type MiniAppStore } from './store.js';
import { WidgetStore } from './widgets.js';
import type { AttachmentStore } from '../attachments.js';
import { serveStoredFile } from '../serve-file.js';
import { previewHtml, verifyPreviewToken, widgetHashOfPreview, widgetPreviewHtml } from './preview.js';

const PUBLIC_RATE_PER_MIN = 120;
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
/**
 * Limit per client address for the routes that serve files (widget and miniapp iframes, attachments), applied by `@fastify/rate-limit`
 * (registered with `global: false` in index.ts: routes opt in with `config: { rateLimit }`). A page load makes a few dozen requests.
 */
export const FILE_RATE_LIMIT = { max: 600, timeWindow: '1 minute' } as const;

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

/**
 * Sends a handler's result. Headers were validated by the sandbox. A handler that serves a document (HTML, XML, SVG) is
 * confined: this runs on the app's own origin, so it gets an opaque origin without scripts (CSP sandbox) and cannot use the session.
 */
function sendResult(reply: FastifyReply, res: SandboxResult) {
  reply.code(res.status);
  for (const [k, v] of Object.entries(res.headers ?? {})) reply.header(k, v);
  if (/html|xml|svg/i.test(res.headers?.['content-type'] ?? '')) {
    reply.header('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:").header('X-Content-Type-Options', 'nosniff');
  }
  return reply.send(res.body);
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function indexHtml(base: string, appId: string, name: string, version: number, hasCss: boolean, nonce: string, runtimeBase = base): string {
  const rt = `${runtimeBase}_runtime/`;
  const imports = {
    react: `${rt}react.js`,
    'react/jsx-runtime': `${rt}jsx-runtime.js`,
    'react-dom': `${rt}react-dom.js`,
    'react-dom/client': `${rt}react-dom.js`,
    '@agentui/ui': `${rt}ui.js`,
    'chart.js': `${rt}chart.js`,
    'chart.js/auto': `${rt}chart.js`,
    leaflet: `${rt}leaflet.js`,
  };
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(name)}</title>
<link rel="stylesheet" href="${rt}base.css">
<link rel="stylesheet" href="${rt}leaflet.css">${hasCss ? `\n<link rel="stylesheet" href="${base}app.css?v=${version}">` : ''}
<script type="importmap" nonce="${nonce}">${JSON.stringify({ imports })}</script>
<script nonce="${nonce}">window.__AGENTUI=${JSON.stringify({ appId, entry: `${base}app.js?v=${version}` })};</script>
</head><body><div id="root"></div><script type="module" nonce="${nonce}" src="${rt}boot.js"></script></body></html>`;
}

export interface MiniAppRoutesOpts {
  store: MiniAppStore;
  widgets: WidgetStore;
  attachments: AttachmentStore;
  data: AppData;
  secret: string;
  userOf: (cookies: Record<string, string | undefined>) => AuthUser | null;
  /** User a preview link acts as (the one who was logged in when the agent opened it). */
  userById: (id: number) => AuthUser | null;
  runtimeDir: string;
}

export function registerMiniApps(app: FastifyInstance, o: MiniAppRoutesOpts): void {
  const { store, data, secret, runtimeDir, widgets } = o;
  const must = (id: string) => {
    const a = store.get(id);
    if (!a) throw new AppError('Unknown miniapp', 404);
    return a;
  };

  // ---------- Authenticated API (cookie + CSRF checked by the global /api hook) ----------
  app.get('/api/miniapps', async () => store.list());
  app.get<{ Params: { id: string } }>('/api/miniapps/:id', async (req) => must(req.params.id));
  app.delete<{ Params: { id: string } }>('/api/miniapps/:id', async (req) => {
    await store.destroy(req.params.id);
    return { ok: true };
  });
  app.get<{ Params: { id: string } }>('/api/miniapps/:id/session', async (req) => {
    const a = must(req.params.id);
    const user = o.userOf(req.cookies)!;
    return { base: `/m/${a.id}/${signAppToken(secret, user.id, a.id)}/`, version: a.version, name: a.name };
  });

  /** File grants declared by the agent; the user approves or revokes each one (nothing is accessible before). */
  app.get<{ Params: { id: string } }>('/api/miniapps/:id/fs', async (req) => store.fsGrants(must(req.params.id).id));
  app.put<{ Params: { id: string }; Body: { path?: unknown; approved?: unknown } }>('/api/miniapps/:id/fs', async (req) => {
    const b = req.body ?? {};
    if (typeof b.path !== 'string' || typeof b.approved !== 'boolean') throw new AppError('path and approved are required');
    return store.setFsApproval(must(req.params.id).id, b.path, b.approved);
  });

  /** Runs the handler `server/<route>.js` (else `server/index.js`) for `rest` = `<route>/…`, on behalf of `user`. */
  async function callHandler(req: FastifyRequest, reply: FastifyReply, appId: string, rest: string, user: AuthUser) {
    rest = rest.replace(/^\/+/, '');
    const [first = '', ...more] = rest.split('/');
    let name = first;
    let path = '/' + more.join('/');
    let code = first ? store.serverCode(appId, first) : undefined;
    if (!code) {
      name = 'index';
      path = '/' + rest;
      code = store.serverCode(appId, 'index');
    }
    if (!code) return reply.code(404).send({ error: `No handler for route "${rest || '/'}" in this miniapp.` });
    const res = await runHandler({
      code,
      appId,
      req: { method: req.method, path, query: (req.query ?? {}) as Record<string, string>, body: req.body ?? null },
      user: { id: user.id, username: user.username },
      data,
      fs: store.fsFor(appId),
      log: (l) => store.log(appId, `[${name}] ${l}`),
      onData: () => store.dataChanged(appId),
    });
    return sendResult(reply, res);
  }

  /** Handlers of a miniapp: `/api/miniapps/<id>/x/<route>/…` → `server/<route>.js`, else `server/index.js`. */
  app.route<{ Params: { id: string; '*': string } }>({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    url: '/api/miniapps/:id/x/*',
    handler: async (req, reply) => callHandler(req, reply, must(req.params.id).id, req.params['*'], o.userOf(req.cookies)!),
  });

  // ---------- Preview for the agent's browser (`agentui_miniapp_open`): the link is the credential, one miniapp, short-lived ----------
  /** The miniapp (or the custom widget) and the user of a preview link, or the error already sent. */
  const previewOf = (req: FastifyRequest<{ Params: { id: string; token: string } }>, reply: FastifyReply) => {
    const { id, token } = req.params;
    const uid = verifyPreviewToken(secret, id, token);
    const user = uid === undefined ? null : o.userById(uid);
    if (!user) return void reply.code(403).send({ error: 'forbidden' });
    const hash = widgetHashOfPreview(id);
    if (hash) return widgets.file(hash) ? { widget: hash, a: undefined, user } : void reply.code(404).send({ error: 'not found' });
    const a = store.get(id);
    if (!a) return void reply.code(404).send({ error: 'not found' });
    return { widget: undefined, a, user };
  };
  const previewHeaders = (reply: FastifyReply, nonce: string) => reply
    .header('Content-Type', 'text/html; charset=utf-8')
    .header('Cache-Control', 'no-store')
    .header('Referrer-Policy', 'no-referrer')
    .header('X-Robots-Tag', 'noindex')
    .header('X-Content-Type-Options', 'nosniff')
    .header('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'`);
  app.get<{ Params: { id: string; token: string }; Querystring: { w?: string } }>('/preview/:id/:token', { config: { rateLimit: FILE_RATE_LIMIT } }, async (req, reply) => {
    const p = previewOf(req, reply);
    if (!p) return;
    const nonce = randomBytes(16).toString('base64');
    if (p.widget) {
      const frameSrc = `/w/${p.widget}/${signAppToken(secret, p.user.id, `widget-${p.widget}`)}/`;
      return previewHeaders(reply, nonce).send(widgetPreviewHtml({ hash: p.widget, frameSrc, nonce, width: Number(req.query.w) }));
    }
    return previewHeaders(reply, nonce)
      .send(previewHtml({ appId: p.a!.id, name: p.a!.name, frameSrc: `/m/${p.a!.id}/${signAppToken(secret, p.user.id, p.a!.id)}/`, nonce, version: p.a!.version, seq: store.dataSeq(p.a!.id) }));
  });
  /** Version and data counter: the page reloads on a new version and tells the app to refetch on new data. */
  app.get<{ Params: { id: string; token: string } }>('/preview/:id/:token/state', { config: { rateLimit: FILE_RATE_LIMIT } }, async (req, reply) => {
    const p = previewOf(req, reply);
    return p?.a ? reply.header('Cache-Control', 'no-store').send({ version: p.a.version, seq: store.dataSeq(p.a.id) }) : p ? reply.code(404).send({ error: 'not found' }) : undefined;
  });
  app.route<{ Params: { id: string; token: string; '*': string } }>({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    url: '/preview/:id/:token/x/*',
    config: { rateLimit: FILE_RATE_LIMIT },
    handler: async (req, reply) => {
      const p = previewOf(req, reply);
      return p?.a ? callHandler(req, reply, p.a.id, req.params['*'], p.user) : p ? reply.code(404).send({ error: 'not found' }) : undefined;
    },
  });

  // ---------- Public handlers (webhooks…): NO authentication, opt-in with `server/public.js` ----------
  /** `/public/<id>/<path>` → `server/public.js` with `req.path = /<path>`; `ctx.user` is null. The handler must authenticate the caller itself (secret in the URL, signature header…). */
  const hits = new Map<string, number[]>();
  const limited = (key: string) => {
    const now = Date.now();
    const arr = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
    arr.push(now);
    hits.set(key, arr);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < 60_000)) hits.delete(k);
    return arr.length > PUBLIC_RATE_PER_MIN;
  };
  app.register(async (pub) => {
    // Webhooks send any content type: keep the raw text, parse JSON / forms ourselves.
    pub.removeAllContentTypeParsers();
    pub.addContentTypeParser('*', { parseAs: 'string', bodyLimit: 1024 * 1024 }, (_req, body, done) => done(null, body));
    pub.route<{ Params: { id: string; '*': string } }>({
      method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      url: '/public/:id/*',
      handler: async (req, reply) => publicCall(req, reply),
    });
    pub.route<{ Params: { id: string } }>({
      method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      url: '/public/:id',
      handler: async (req, reply) => publicCall(req, reply),
    });
    async function publicCall(req: FastifyRequest<{ Params: { id: string; '*'?: string } }>, reply: FastifyReply) {
      const a = store.get(req.params.id);
      const code = a && store.serverCode(a.id, 'public');
      if (!a || !code) return reply.code(404).send({ error: 'Not found' });
      if (limited(`${a.id}|${req.ip}`)) return reply.code(429).send({ error: 'Too many requests' });
      const rawBody = typeof req.body === 'string' ? req.body : '';
      const type = String(req.headers['content-type'] ?? '').toLowerCase();
      let body: unknown = rawBody || null;
      try {
        if (type.includes('json') && rawBody) body = JSON.parse(rawBody);
        else if (type.includes('x-www-form-urlencoded')) body = Object.fromEntries(new URLSearchParams(rawBody));
      } catch { /* keep the raw text */ }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (k !== 'cookie' && typeof v === 'string') headers[k] = v.slice(0, 2000);
      const res = await runHandler({
        code,
        appId: a.id,
        req: { method: req.method, path: '/' + (req.params['*'] ?? '').replace(/^\/+/, ''), query: (req.query ?? {}) as Record<string, string>, body, headers, rawBody },
        user: null,
        data,
        fs: store.fsFor(a.id),
        log: (l) => store.log(a.id, `[public] ${l}`),
        onData: () => store.dataChanged(a.id),
      });
      return sendResult(reply, res);
    }
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

  const sendRuntime = (reply: FastifyReply, name: string) => {
    const file = resolve(runtimeDir, name);
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || !file.startsWith(resolve(runtimeDir) + sep) || !existsSync(file) || !statSync(file).isFile()) {
      return reply.code(404).send({ error: 'not found' });
    }
    return sendFile(reply, file, 'public, max-age=300');
  };

  /**
   * OpenStreetMap tiles for every Leaflet map (the `map` widget through `/api/tiles/`, custom widgets and miniapps through their own `tiles/`).
   * A sandboxed iframe has an opaque origin and sends no Referer, which OSM refuses (and its CSP forbids remote images), so tiles go
   * through the server: it identifies itself as the usage policy asks, and OSM never sees the user's IP.
   */
  const sendTile = async (reply: FastifyReply, path: string) => {
    const m = /^(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.png$/.exec(path);
    const z = Number(m?.[1]), x = Number(m?.[2]), y = Number(m?.[3]);
    if (!m || z > 19 || x >= 2 ** z || y >= 2 ** z) return reply.code(404).send({ error: 'not found' });
    try {
      const r = await fetch(`https://tile.openstreetmap.org/${z}/${x}/${y}.png`, { headers: { 'User-Agent': 'AgentUI (+https://github.com/joselfr/AgentUI)' }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) return reply.code(502).send({ error: 'tile unavailable' });
      return reply.header('Content-Type', 'image/png').header('Cache-Control', 'public, max-age=86400').header('X-Content-Type-Options', 'nosniff').send(Buffer.from(await r.arrayBuffer()));
    } catch {
      return reply.code(502).send({ error: 'tile unavailable' });
    }
  };

  app.get<{ Params: { '*': string } }>('/api/tiles/*', { config: { rateLimit: FILE_RATE_LIMIT } }, (req, reply) => sendTile(reply, req.params['*']));

  // ---------- Widgets of the `agentui_widget_custom` tool: compiled on demand, same runtime and sandbox as the miniapps ----------
  /** Compiles the code of a widget; answers the iframe base URL (token-protected, like a miniapp's) or the build errors. */
  app.post<{ Body: { code?: unknown } }>('/api/widgets', async (req) => {
    const r = await widgets.compile(String(req.body?.code ?? ''));
    if (!r.ok) return r;
    return { ok: true, base: `/w/${r.hash}/${signAppToken(secret, o.userOf(req.cookies)!.id, `widget-${r.hash}`)}/` };
  });

  app.get<{ Params: { hash: string; token: string; '*': string } }>('/w/:hash/:token/*', { config: { rateLimit: FILE_RATE_LIMIT } }, async (req, reply) => {
    const { hash, token } = req.params;
    if (!WidgetStore.validHash(hash) || !verifyAppToken(secret, `widget-${hash}`, token)) return reply.code(403).send({ error: 'forbidden' });
    const rest = req.params['*'];
    const base = `/w/${hash}/${token}/`;
    if (rest === '' || rest === 'index.html') {
      const nonce = randomBytes(16).toString('base64');
      return reply
        .header('Content-Type', 'text/html; charset=utf-8')
        .header('Cache-Control', 'no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', `default-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self'; font-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'`)
        .send(indexHtml(base, 'widget', 'Widget', 1, false, nonce)); // content-addressed: version never changes
    }
    if (rest.startsWith('tiles/')) return sendTile(reply, rest.slice('tiles/'.length));
    if (rest.startsWith('_runtime/')) return sendRuntime(reply, rest.slice('_runtime/'.length));
    // Media of the widget: the attachments the agent copied into the chat (the id is an unguessable UUID, like on /api/attachments), streamed with byte ranges.
    if (rest.startsWith('att/')) {
      const f = o.attachments.get(rest.slice('att/'.length));
      return f ? serveStoredFile(req, reply, f, true) : reply.code(404).send({ error: 'not found' });
    }
    if (rest === 'app.js') {
      const file = widgets.file(hash);
      return file ? sendFile(reply, file, 'public, max-age=31536000, immutable') : reply.code(404).send({ error: 'not built' });
    }
    return reply.code(404).send({ error: 'not found' });
  });

  app.get<{ Params: { id: string; token: string; '*': string } }>('/m/:id/:token/*', { config: { rateLimit: FILE_RATE_LIMIT } }, async (req, reply) => {
    const { id, token } = req.params;
    if (!verifyAppToken(secret, id, token)) return reply.code(403).send({ error: 'forbidden' });
    const a = store.get(id);
    if (!a) return reply.code(404).send({ error: 'not found' });
    const rest = req.params['*'];
    const base = `/m/${id}/${token}/`;

    if (rest === '' || rest === 'index.html') {
      const nonce = randomBytes(16).toString('base64');
      return reply
        .header('Content-Type', 'text/html; charset=utf-8')
        .header('Cache-Control', 'no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .header(
          'Content-Security-Policy',
          `default-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self'; font-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'`,
        )
        .send(indexHtml(base, id, a.name, a.version, !!store.distFile(id, 'app.css'), nonce));
    }
    if (rest.startsWith('tiles/')) return sendTile(reply, rest.slice('tiles/'.length));
    if (rest.startsWith('_runtime/')) return sendRuntime(reply, rest.slice('_runtime/'.length));
    // Media the agent gave to the miniapp (assets), streamed with byte ranges.
    if (rest.startsWith('assets/')) {
      const name = decodeURIComponent(rest.slice('assets/'.length));
      const asset = store.asset(id, name);
      return asset ? serveStoredFile(req, reply, { name, mimeType: asset.mimeType, path: asset.path }, true) : reply.code(404).send({ error: 'not found' });
    }
    if (rest === 'app.js' || rest === 'app.css') {
      const file = store.distFile(id, rest);
      if (!file) return reply.code(404).send({ error: 'not built' });
      return sendFile(reply, file, 'no-cache');
    }
    return reply.code(404).send({ error: 'not found' });
  });
}
