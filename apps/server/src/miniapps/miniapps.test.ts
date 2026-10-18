import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../db.js';
import { AppData } from './data.js';
import { signAppToken, verifyAppToken } from './routes.js';
import { runHandler } from './sandbox.js';
import { AppError, MiniAppStore } from './store.js';

let dir: string;
let db: DB;
let store: MiniAppStore;
let data: AppData;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentui-apps-'));
  db = openDb(dir);
  store = new MiniAppStore(db, dir);
  data = new AppData(db);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const MAIN = 'export default function App() { return <div>hi</div>; }';
const call = (appId: string, name: string, method: string, body: unknown = null, path = '/') =>
  runHandler({ code: store.serverCode(appId, name)!, appId, req: { method, path, query: {}, body }, user: { id: 1, username: 'u' }, data, log: (l) => store.log(appId, l) });

describe('store', () => {
  it('creates, builds and reports build errors', async () => {
    store.create('a1', { id: 'todo', name: 'Todo' });
    const ok = await store.writeFiles('todo', 'a1', [{ path: 'src/main.tsx', content: MAIN }, { path: 'server/todos.js', content: 'export function GET() { return []; }' }]);
    expect(ok.ok).toBe(true);
    expect(store.distFile('todo', 'app.js')).toBeTruthy();
    const bad = await store.writeFiles('todo', 'a1', [{ path: 'src/main.tsx', content: 'export default () => <div>' }]);
    expect(bad.ok).toBe(false);
    expect(bad.errors[0]?.file).toBe('src/main.tsx');
    expect(store.distFile('todo', 'app.js')).toBeTruthy(); // previous build kept
  });

  it('refuses other agents, bad ids and bad paths', async () => {
    store.create('a1', { id: 'todo', name: 'Todo' });
    await expect(store.writeFiles('todo', 'a2', [{ path: 'src/main.tsx', content: MAIN }])).rejects.toBeInstanceOf(AppError);
    expect(() => store.create('a1', { id: '../x', name: 'x' })).toThrow(AppError);
    await expect(store.writeFiles('todo', 'a1', [{ path: 'src/../../etc/passwd.js', content: 'x' }])).rejects.toThrow(/Invalid path/);
    await expect(store.writeFiles('todo', 'a1', [{ path: 'server/sub/x.js', content: 'x' }])).rejects.toThrow(/Invalid/);
  });
});

describe('sandbox', () => {
  const setup = async (id: string, js: string, name = 'index') => {
    store.create('a1', { id, name: id });
    await store.writeFiles(id, 'a1', [{ path: 'src/main.tsx', content: MAIN }, { path: `server/${name}.js`, content: js }]);
  };

  it('runs a handler with db access scoped to the app', async () => {
    const js = `export async function POST(req, ctx) { return ctx.db.collection('t').insert(req.body); }
export function GET(req, ctx) { return ctx.db.collection('t').find(); }`;
    await setup('one', js);
    await setup('two', js);
    const created = await call('one', 'index', 'POST', { title: 'x' });
    expect(created.status).toBe(200);
    expect((created.body as any).title).toBe('x');
    expect(((await call('one', 'index', 'GET')).body as any[]).length).toBe(1);
    expect(((await call('two', 'index', 'GET')).body as any[]).length).toBe(0);
  });

  it('supports ctx.status, kv and 405', async () => {
    await setup('kv', `export function GET(req, ctx) { ctx.kv.set('n', 5); return ctx.status(201, { n: ctx.kv.get('n') }); }`);
    expect(await call('kv', 'index', 'GET')).toEqual({ status: 201, body: { n: 5 } });
    expect((await call('kv', 'index', 'DELETE')).status).toBe(405);
  });

  it('has no access to node globals nor eval', async () => {
    await setup('esc', `export function GET() {
      const out = {};
      out.process = typeof process; out.require = typeof require; out.fetch = typeof fetch;
      try { out.fn = new Function('return 1')(); } catch (e) { out.fn = 'blocked'; }
      try { out.ctor = (() => {}).constructor('return process')(); } catch (e) { out.ctor = 'blocked'; }
      return out;
    }`);
    const r = await call('esc', 'index', 'GET');
    expect(r.body).toEqual({ process: 'undefined', require: 'undefined', fetch: 'undefined', fn: 'blocked', ctor: 'blocked' });
  });

  it('cannot reach the host function through ctx', async () => {
    await setup('host', `export function GET(req, ctx) {
      try { return ctx.log.constructor('return typeof process')(); } catch (e) { return 'blocked'; }
    }`);
    expect((await call('host', 'index', 'GET')).body).toBe('blocked');
  });

  it('kills infinite loops', async () => {
    await setup('loop', `export function GET() { while (true) {} }`);
    const r = await call('loop', 'index', 'GET');
    expect(r.status).toBe(504);
  }, 10_000);

  it('turns thrown errors into 500', async () => {
    await setup('err', `export function GET() { throw new Error('boom'); }`);
    const r = await call('err', 'index', 'GET');
    expect(r.status).toBe(500);
  });
});

describe('tokens', () => {
  it('binds the token to the app and expiry', () => {
    const t = signAppToken('s', 1, 'a');
    expect(verifyAppToken('s', 'a', t)).toBe(true);
    expect(verifyAppToken('s', 'b', t)).toBe(false);
    expect(verifyAppToken('x', 'a', t)).toBe(false);
    expect(verifyAppToken('s', 'a', signAppToken('s', 1, 'a', Date.now() - 13 * 3600 * 1000))).toBe(false);
  });
});

describe('network', () => {
  const serve = async (h: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void) => {
    const { createServer } = await import('node:http');
    const srv = createServer(h);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    return { srv, url: `http://127.0.0.1:${(srv.address() as import('node:net').AddressInfo).port}` };
  };

  it('classifies private addresses', async () => {
    const { isPrivateAddress } = await import('./net.js');
    for (const a of ['127.0.0.1', '10.1.2.3', '172.18.0.5', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) expect(isPrivateAddress(a), a).toBe(true);
    for (const a of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1111']) expect(isPrivateAddress(a), a).toBe(false);
  });

  it('appFetch: body, json, redirects (auth stripped across origins), size cap', async () => {
    const { appFetch } = await import('./net.js');
    const seen: Record<string, string | undefined>[] = [];
    const { srv, url } = await serve((req, res) => {
      seen.push({ auth: req.headers.authorization as string | undefined, url: req.url });
      if (req.url === '/r') { res.writeHead(302, { location: '/ok' }).end(); return; }
      if (req.url === '/big') { res.end(Buffer.alloc(3 * 1024 * 1024)); return; }
      let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ got: b, m: req.method })));
    });
    try {
      const r = await appFetch(`${url}/r`, { method: 'POST', body: { a: 1 }, headers: { Authorization: 'Bearer k' } }, true);
      expect(r.ok).toBe(true);
      expect(JSON.parse(r.text)).toEqual({ got: '', m: 'GET' }); // 302 after POST → GET, body dropped
      expect(seen[0]!.auth).toBe('Bearer k');
      await expect(appFetch(`${url}/big`, {}, true)).rejects.toThrow(/too large/);
      await expect(appFetch('file:///etc/passwd', {}, true)).rejects.toThrow(/http/);
      await expect(appFetch(url, { method: 'TRACE' }, true)).rejects.toThrow(/not allowed/);
    } finally { srv.close(); }
  });

  it('handlers cannot reach private or internal addresses', async () => {
    store.create('a1', { id: 'net', name: 'net' });
    await store.writeFiles('net', 'a1', [{ path: 'src/main.tsx', content: MAIN }, { path: 'server/index.js', content: `export async function GET(req, ctx) {
      const out = {};
      for (const u of ['http://127.0.0.1:1/', 'http://169.254.169.254/latest/meta-data', 'http://localhost/', 'http://[::1]/']) {
        try { await ctx.fetch(u); out[u] = 'reached'; } catch (e) { out[u] = e.message; }
      }
      return out;
    }` }]);
    const r = await call('net', 'index', 'GET');
    expect(r.status).toBe(200);
    for (const v of Object.values(r.body as Record<string, string>)) expect(v).toMatch(/private or internal/);
  });

  it('ctx.fetch works from a handler without being counted as CPU time', async () => {
    const { SANDBOX_LIMITS } = await import('./sandbox.js');
    expect(SANDBOX_LIMITS.maxTotalMs).toBeGreaterThan(SANDBOX_LIMITS.timeoutMs);
    store.create('a1', { id: 'net2', name: 'net2' });
    await store.writeFiles('net2', 'a1', [{ path: 'src/main.tsx', content: MAIN }, { path: 'server/index.js', content: `export function GET(req, ctx) { return typeof ctx.fetch; }` }]);
    expect((await call('net2', 'index', 'GET')).body).toBe('function');
  });
});
