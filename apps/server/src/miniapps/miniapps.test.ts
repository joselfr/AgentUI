import { createHmac, createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../db.js';
import { mkdirSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { AppData } from './data.js';
import Fastify from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';
import { FILE_RATE_LIMIT, registerMiniApps, signAppToken, verifyAppToken } from './routes.js';
import { handleAppOp } from './ops.js';
import { signPreviewToken, verifyPreviewToken } from './preview.js';
import { runHandler, sanitizeHeaders } from './sandbox.js';
import { AppError, MiniAppStore } from './store.js';
import { WidgetStore } from './widgets.js';
import { AttachmentStore } from '../attachments.js';

let dir: string;
let db: DB;
let store: MiniAppStore;
let data: AppData;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentui-miniapps-'));
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

  it('tags jobs to a miniapp and deletes them with it', async () => {
    store.create('a1', { id: 'todo', name: 'Todo' });
    store.create('a1', { id: 'other', name: 'Other' });
    store.linkJob('todo', 'a1', 'j1');
    store.linkJob('todo', 'a1', 'j2');
    store.linkJob('other', 'a1', 'j3');
    expect(store.jobsOf('todo')).toEqual(['j1', 'j2']);
    expect(store.jobLinks('a1').get('j3')).toBe('other');
    expect(() => store.linkJob('todo', 'a2', 'j9')).toThrow(AppError);
    store.unlinkJob('a1', 'j2');
    const purged: string[][] = [];
    store.purgeJobs = async (_agent, ids) => { purged.push(ids); throw new Error('scheduler down'); };
    await store.destroy('todo', 'a1'); // best effort: removed even if the purge fails
    expect(purged).toEqual([['j1']]);
    expect(store.get('todo')).toBeUndefined();
    expect(store.jobLinks('a1').has('j1')).toBe(false);
    expect(store.jobLinks('a1').get('j3')).toBe('other');
  });

  it('refuses other agents, bad ids and bad paths', async () => {
    store.create('a1', { id: 'todo', name: 'Todo' });
    await expect(store.writeFiles('todo', 'a2', [{ path: 'src/main.tsx', content: MAIN }])).rejects.toBeInstanceOf(AppError);
    expect(() => store.create('a1', { id: '../x', name: 'x' })).toThrow(AppError);
    await expect(store.writeFiles('todo', 'a1', [{ path: 'src/../../etc/passwd.js', content: 'x' }])).rejects.toThrow(/Invalid path/);
    await expect(store.writeFiles('todo', 'a1', [{ path: 'server/sub/x.js', content: 'x' }])).rejects.toThrow(/Invalid/);
  });
});

describe('assets', () => {
  const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(20)]);
  const MP4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(20)]);

  it('stores images and videos by their real type and refuses anything else', () => {
    store.create('a1', { id: 'gal', name: 'Gallery' });
    expect(store.writeAsset('gal', 'a1', 'logo.png', PNG)).toMatchObject({ mimeType: 'image/png' });
    expect(store.writeAsset('gal', 'a1', 'clip.mov', MP4).mimeType).toBe('video/mp4'); // the extension means nothing
    expect(store.assets('gal').map((a) => a.name)).toEqual(['clip.mov', 'logo.png']);
    expect(() => store.writeAsset('gal', 'a1', 'x.png', Buffer.from('<svg onload=alert(1)>'))).toThrow(AppError);
    expect(() => store.writeAsset('gal', 'a1', '../x.png', PNG)).toThrow(AppError);
    expect(() => store.writeAsset('gal', 'a1', 'a/b.png', PNG)).toThrow(AppError);
    expect(() => store.writeAsset('gal', 'other', 'y.png', PNG)).toThrow(AppError); // not the owner
  });

  it('serves them to the logged-in host only and removes them with the miniapp', async () => {
    store.create('a1', { id: 'gal', name: 'Gallery' });
    store.writeAsset('gal', 'a1', 'logo.png', PNG);
    expect(store.asset('gal', 'logo.png')?.mimeType).toBe('image/png');
    expect(store.asset('gal', '../../x')).toBeUndefined();
    store.deleteAsset('gal', 'a1', 'logo.png');
    expect(store.asset('gal', 'logo.png')).toBeUndefined();
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

describe('public handlers', () => {
  const server = async () => {
    const app = Fastify();
    registerMiniApps(app, { store, widgets: new WidgetStore(dir), attachments: new AttachmentStore(db, dir), data, secret: 's', userOf: () => null, userById: () => null, runtimeDir: dir });
    await app.ready();
    return app;
  };
  const JS = `export function POST(req, ctx) { return { user: ctx.user, path: req.path, body: req.body, raw: req.rawBody, sig: req.headers['x-sig'] }; }`;

  it('serves only server/public.js, without authentication', async () => {
    store.create('a1', { id: 'hook', name: 'hook' });
    await store.writeFiles('hook', 'a1', [{ path: 'src/main.tsx', content: MAIN }, { path: 'server/index.js', content: JS }]);
    const app = await server();
    expect((await app.inject({ method: 'POST', url: '/public/hook/x' })).statusCode).toBe(404); // private handlers are never exposed
    await store.writeFiles('hook', 'a1', [{ path: 'server/public.js', content: JS }]);
    const res = await app.inject({ method: 'POST', url: '/public/hook/github/push', headers: { 'content-type': 'application/json', 'x-sig': 'abc' }, payload: '{"a":1}' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user: null, path: '/github/push', body: { a: 1 }, raw: '{"a":1}', sig: 'abc' });
    const form = await app.inject({ method: 'POST', url: '/public/hook', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'a=1&b=2' });
    expect(form.json().body).toEqual({ a: '1', b: '2' });
    expect((await app.inject({ method: 'POST', url: '/public/nope/x' })).statusCode).toBe(404);
    await app.close();
  });
});

describe('file grants', () => {
  let shared: string;
  let secret: string;
  let fsStore: MiniAppStore;
  beforeEach(() => {
    shared = join(dir, 'shared');
    secret = join(dir, 'secret');
    mkdirSync(join(shared, 'docs'), { recursive: true });
    mkdirSync(secret);
    writeFileSync(join(shared, 'docs', 'a.txt'), 'hello');
    writeFileSync(join(secret, 'key.txt'), 'nope');
    symlinkSync(secret, join(shared, 'docs', 'escape'));
    fsStore = new MiniAppStore(db, join(dir, 'data'), [shared]);
    fsStore.create('a1', { id: 'files', name: 'files' });
  });
  const run = (js: string) => {
    const code = `module.exports.GET = (req, ctx) => { ${js} };`;
    return runHandler({ code, appId: 'files', req: { method: 'GET', path: '/', query: {}, body: null }, user: null, data, fs: fsStore.fsFor('files'), log: () => {} });
  };

  it('refuses paths outside the allowed roots and the data dir', () => {
    expect(() => fsStore.declareFs('files', 'a1', [{ path: secret }])).toThrow(/outside/);
    expect(() => fsStore.declareFs('files', 'a1', [{ path: 'docs' }])).toThrow(/absolute/);
    expect(() => fsStore.declareFs('files', 'a1', [{ path: join(shared, '..', 'secret') }])).toThrow(/outside/);
  });

  it('is inactive until approved, then read-only unless rw', async () => {
    const g = fsStore.declareFs('files', 'a1', [{ path: join(shared, 'docs') }]);
    expect(g[0]).toMatchObject({ mode: 'ro', approved: false });
    const read = `return ctx.fs.readFile(${JSON.stringify(join(shared, 'docs', 'a.txt'))});`;
    expect((await run(read)).status).toBe(500); // not approved
    fsStore.setFsApproval('files', join(shared, 'docs'), true);
    expect((await run(read)).body).toBe('hello');
    expect((await run(`return ctx.fs.writeFile(${JSON.stringify(join(shared, 'docs', 'b.txt'))}, 'x');`)).status).toBe(500); // read-only
    expect((await run(`return ctx.fs.readFile(${JSON.stringify(join(shared, 'other.txt'))});`)).status).toBe(500); // outside the grant
    expect((await run(`return ctx.fs.readFile(${JSON.stringify(join(shared, 'docs', 'escape', 'key.txt'))});`)).status).toBe(500); // symlink escape
  });

  it('writes with rw and resets approval when a grant is widened', async () => {
    const d = join(shared, 'docs');
    fsStore.declareFs('files', 'a1', [{ path: d }]);
    fsStore.setFsApproval('files', d, true);
    expect(fsStore.declareFs('files', 'a1', [{ path: d }])[0]!.approved).toBe(true); // unchanged
    expect(fsStore.declareFs('files', 'a1', [{ path: d, mode: 'rw' }])[0]!.approved).toBe(false); // widened
    fsStore.setFsApproval('files', d, true);
    expect((await run(`ctx.fs.writeFile(${JSON.stringify(join(d, 'new.txt'))}, 'ok'); return ctx.fs.readdir(${JSON.stringify(d)}).map((e) => e.name).sort();`)).body).toEqual(['a.txt', 'escape', 'new.txt']);
    expect(readFileSync(join(d, 'new.txt'), 'utf8')).toBe('ok');
  });
});

describe('handler response headers', () => {
  const server = async () => {
    const app = Fastify();
    registerMiniApps(app, { store, widgets: new WidgetStore(dir), attachments: new AttachmentStore(db, dir), data, secret: 's', userOf: () => ({ id: 1, username: 'u' }) as any, userById: () => null, runtimeDir: dir });
    await app.ready();
    return app;
  };
  const publicJs = `export function GET(req, ctx) {
  if (req.path === '/go') return ctx.status(302, null, { Location: '/x', 'Set-Cookie': 'a=b', 'Content-Length': '1', 'X-Evil': '1' });
  if (req.path === '/page') return ctx.status(200, '<!doctype html><p>ok</p>', { 'Content-Type': 'text/html; charset=utf-8' });
  if (req.path === '/crlf') return ctx.status(200, { ok: true }, { 'Cache-Control': 'a\\r\\nSet-Cookie: x=1' });
  return { plain: true };
}`;

  it('applies allowed headers on public and authenticated routes, ignores the others', async () => {
    store.create('a1', { id: 'hdr', name: 'hdr' });
    await store.writeFiles('hdr', 'a1', [{ path: 'src/main.tsx', content: MAIN }, { path: 'server/public.js', content: publicJs }, { path: 'server/index.js', content: publicJs }]);
    const app = await server();
    const go = await app.inject({ method: 'GET', url: '/public/hdr/go' });
    expect(go.statusCode).toBe(302);
    expect(go.headers.location).toBe('/x');
    expect(go.headers['set-cookie']).toBeUndefined();
    expect(go.headers['x-evil']).toBeUndefined();
    expect((await app.inject({ method: 'GET', url: '/api/miniapps/hdr/x/go' })).headers.location).toBe('/x'); // authenticated route too

    const page = await app.inject({ method: 'GET', url: '/public/hdr/page' });
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.body).toBe('<!doctype html><p>ok</p>');
    expect(page.headers['content-security-policy']).toMatch(/^sandbox/);

    const bad = await app.inject({ method: 'GET', url: '/public/hdr/crlf' });
    expect(bad.statusCode).toBe(200);
    expect(bad.headers['cache-control']).toBeUndefined();
    expect(bad.headers['set-cookie']).toBeUndefined();

    const plain = await app.inject({ method: 'GET', url: '/public/hdr/other' });
    expect(plain.json()).toEqual({ plain: true });
    expect(plain.headers.location).toBeUndefined();
    await app.close();
  });

  it('validates headers on the host', () => {
    const logs: string[] = [];
    expect(sanitizeHeaders({ Location: '/a', 'Retry-After': '5', 'set-cookie': 'x', 'content-length': '1', 'transfer-encoding': 'chunked' }, (l) => logs.push(l))).toEqual({ location: '/a', 'retry-after': '5' });
    expect(logs.length).toBe(3);
    expect(sanitizeHeaders(['location'])).toBeUndefined();
    expect(sanitizeHeaders({ location: 'a\nb' })).toBeUndefined();
    expect(sanitizeHeaders({ location: 'x'.repeat(1025) })).toBeUndefined();
    expect(sanitizeHeaders({ location: 1 })).toBeUndefined();
    expect(sanitizeHeaders(undefined)).toBeUndefined();
  });
});

describe('ctx.crypto', () => {
  it('hashes, signs, compares and generates randomness', async () => {
    store.create('a1', { id: 'cry', name: 'cry' });
    const js = `export function GET(req, ctx) { return {
      sha: ctx.crypto.hash('sha256', 'abc'),
      b64: ctx.crypto.hmac('sha256', 'k', 'msg', 'base64url'),
      global: crypto === ctx.crypto,
      eq: [ctx.crypto.timingSafeEqual('a', 'a'), ctx.crypto.timingSafeEqual('a', 'b'), ctx.crypto.timingSafeEqual('a', 'ab')],
      rnd: ctx.crypto.randomBytes(8).length,
      uuid: ctx.crypto.randomUUID().length,
      bad: (() => { try { ctx.crypto.hash('whirlpool', 'x'); return 'no error'; } catch (e) { return e.message; } })(),
    }; }`;
    await store.writeFiles('cry', 'a1', [{ path: 'src/main.tsx', content: MAIN }, { path: 'server/index.js', content: js }]);
    const r = await call('cry', 'index', 'GET');
    const b = r.body as any;
    expect(b.sha).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(b.b64).toBe(createHmac('sha256', 'k').update('msg').digest('base64url'));
    expect(b.global).toBe(true);
    expect(b.eq).toEqual([true, false, false]);
    expect(b.rnd).toBe(16);
    expect(b.uuid).toBe(36);
    expect(b.bad).toMatch(/algorithm must be one of/);
  });
});

describe('ctx.crypto signatures', () => {
  it('signs RS256 / ES256 and verifies', async () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    store.create('a1', { id: 'sig', name: 'sig' });
    const js = `export function POST(req, ctx) {
      const { rsa, ec } = req.body;
      const s = ctx.crypto.sign('RS256', rsa.priv, 'a.b');
      const e = ctx.crypto.sign('ES256', ec.priv, 'a.b');
      const ps = ctx.crypto.sign('PS256', rsa.priv, 'a.b');
      return { s, e, ok: [ctx.crypto.verify('RS256', rsa.pub, 'a.b', s), ctx.crypto.verify('ES256', ec.pub, 'a.b', e), ctx.crypto.verify('PS256', rsa.pub, 'a.b', ps), ctx.crypto.verify('RS256', rsa.pub, 'a.c', s)],
        b64: ctx.crypto.base64url('{"a":"é"}'), back: ctx.crypto.fromBase64url(ctx.crypto.base64url('{"a":"é"}')),
        badKey: (() => { try { ctx.crypto.sign('RS256', 'nope', 'x'); return 'no error'; } catch (err) { return err.message; } })(),
        badAlg: (() => { try { ctx.crypto.sign('none', rsa.priv, 'x'); return 'no error'; } catch (err) { return err.message; } })() };
    }`;
    await store.writeFiles('sig', 'a1', [{ path: 'src/main.tsx', content: MAIN }, { path: 'server/index.js', content: js }]);
    const r = await call('sig', 'index', 'POST', { rsa: { priv: rsa.privateKey, pub: rsa.publicKey }, ec: { priv: ec.privateKey, pub: ec.publicKey } });
    const b = r.body as any;
    expect(r.status).toBe(200);
    expect(createVerify('RSA-SHA256').update('a.b').verify(rsa.publicKey, Buffer.from(b.s, 'base64url'))).toBe(true); // a standard verifier accepts it
    expect(b.ok).toEqual([true, true, true, false]);
    expect(b.b64).toBe(Buffer.from('{"a":"é"}').toString('base64url'));
    expect(b.back).toBe('{"a":"é"}');
    expect(b.badKey).toMatch(/PEM/);
    expect(b.badAlg).toMatch(/must be one of/);
  });
});

describe('widgets (agentui_widget_custom)', () => {
  it('compiles in a sandbox: only the runtime modules, cached by hash', async () => {
    const w = new WidgetStore(dir);
    const code = "import { Card, Text } from '@agentui/ui'; import { useState } from 'react'; export default function W() { const [n] = useState(1); return <Card><Text>{n}</Text></Card>; }";
    const r = await w.compile(code);
    expect(r.ok).toBe(true);
    if (r.ok) expect(w.file(r.hash)).toBeTruthy();
    expect(await w.compile(code)).toEqual(r);
    const bad = await w.compile("import x from 'lodash'; export default () => <div>{x}</div>");
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.errors[0]?.message).toMatch(/Cannot import "lodash"/);
    expect((await w.compile("import L from 'leaflet'; export default () => <div>{String(L.version)}</div>")).ok).toBe(true);
    expect((await w.compile('export default () => <div>')).ok).toBe(false);
    await expect(w.compile('x'.repeat(70 * 1024))).rejects.toBeInstanceOf(AppError);
  });

  it('serves the iframe only with a valid token', async () => {
    const widgets = new WidgetStore(dir);
    const app = Fastify();
    registerMiniApps(app, { store, widgets, attachments: new AttachmentStore(db, dir), data, secret: 's', userOf: () => ({ id: 1, username: 'u' }) as never, userById: () => null, runtimeDir: dir });
    const r = await widgets.compile('export default () => <div>hi</div>');
    if (!r.ok) throw new Error('build');
    const base = `/w/${r.hash}/${signAppToken('s', 1, `widget-${r.hash}`)}/`;
    expect((await app.inject(base)).statusCode).toBe(200);
    expect((await app.inject(`${base}app.js`)).statusCode).toBe(200);
    expect((await app.inject(`/w/${r.hash}/bad.token.x/app.js`)).statusCode).toBe(403);
  });
});

describe('hardening of the file routes', () => {
  it('distFile refuses "..", hidden names and anything with a separator', () => {
    store.create('a1', { id: 'dist', name: 'dist' });
    mkdirSync(join(dir, 'miniapps', 'dist', 'dist'), { recursive: true });
    writeFileSync(join(dir, 'miniapps', 'dist', 'dist', 'app.js'), 'x');
    writeFileSync(join(dir, 'miniapps', 'dist', 'dist', '.hidden'), 'x');
    expect(store.distFile('dist', 'app.js')).toBeTruthy();
    for (const bad of ['..', '.', '.hidden', '../app.js', 'a/b', '']) expect(store.distFile('dist', bad)).toBeUndefined();
  });

  it('the widget and miniapp file routes are rate limited per client', async () => {
    const app = Fastify();
    await app.register(fastifyRateLimit, { global: false });
    registerMiniApps(app, { store, widgets: new WidgetStore(dir), attachments: new AttachmentStore(db, dir), data, secret: 's', userOf: () => null, userById: () => null, runtimeDir: dir });
    await app.ready();
    const statuses = new Set<number>();
    for (let i = 0; i < FILE_RATE_LIMIT.max + 5; i++) statuses.add((await app.inject({ url: '/w/0123456789abcdef01234567/bad/app.js' })).statusCode);
    expect(statuses.has(403)).toBe(true); // refused by the token check while under the limit
    expect(statuses.has(429)).toBe(true); // then by the limiter
    await app.close();
  });
});

describe('media served to the iframes', () => {
  const MP4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(200)]);
  it('streams assets with byte ranges and refuses a bad token, a missing asset and anything that is not media', async () => {
    store.create('a1', { id: 'gal', name: 'Gallery' });
    store.writeAsset('gal', 'a1', 'clip.mp4', MP4);
    const app = Fastify();
    registerMiniApps(app, { store, widgets: new WidgetStore(dir), attachments: new AttachmentStore(db, dir), data, secret: 's', userOf: () => null, userById: () => null, runtimeDir: dir });
    const url = `/m/gal/${signAppToken('s', 1, 'gal')}/assets/clip.mp4`;
    const full = await app.inject({ url });
    expect(full.statusCode).toBe(200);
    expect(full.headers['content-type']).toBe('video/mp4');
    expect(full.headers['accept-ranges']).toBe('bytes');
    const part = await app.inject({ url, headers: { range: 'bytes=0-9' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 0-9/${MP4.length}`);
    expect(part.rawPayload.length).toBe(10);
    expect((await app.inject({ url: `/m/gal/bad.token/assets/clip.mp4` })).statusCode).toBe(403);
    expect((await app.inject({ url: url.replace('clip.mp4', 'nope.mp4') })).statusCode).toBe(404);
    expect((await app.inject({ url: url.replace('clip.mp4', '..%2Fsrc') })).statusCode).toBe(404);
  });
});

describe('preview for the agent (agentui_miniapp_open)', () => {
  const HOUR = 3600 * 1000;
  const server = async () => {
    const app = Fastify();
    registerMiniApps(app, { store, widgets: new WidgetStore(dir), attachments: new AttachmentStore(db, dir), data, secret: 's', userOf: () => null, userById: (id) => (id === 1 ? { id: 1, username: 'jose' } : null), runtimeDir: dir });
    await app.ready();
    return app;
  };
  const link = (appId: string, uid = 1, ttl = HOUR) => `/preview/${appId}/${signPreviewToken('s', uid, appId, ttl).token}`;

  it('the token is bound to one miniapp, one secret and a deadline, and is not an iframe token', () => {
    const { token } = signPreviewToken('s', 1, 'a', HOUR);
    expect(verifyPreviewToken('s', 'a', token)).toBe(1);
    expect(verifyPreviewToken('s', 'b', token)).toBeUndefined();
    expect(verifyPreviewToken('other', 'a', token)).toBeUndefined();
    expect(verifyPreviewToken('s', 'a', signPreviewToken('s', 1, 'a', HOUR, Date.now() - 2 * HOUR).token)).toBeUndefined();
    expect(verifyPreviewToken('s', 'a', signAppToken('s', 1, 'a'))).toBeUndefined(); // the 12 h iframe token does not open a preview
    expect(verifyAppToken('s', 'a', token)).toBe(false); // and the other way round
    expect(verifyPreviewToken('s', 'a', 'x.y.z')).toBeUndefined();
  });

  it('serves the host page, the state and the handlers with the link only, and refuses anything else', async () => {
    store.create('a1', { id: 'trk', name: 'Tracker' });
    store.create('a1', { id: 'other', name: 'Other' });
    await store.writeFiles('trk', 'a1', [{ path: 'src/main.tsx', content: MAIN }, { path: 'server/index.js', content: `export function GET(req, ctx) { return { who: ctx.user.username, path: req.path }; }` }]);
    const app = await server();
    const page = await app.inject({ url: link('trk') });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-security-policy']).toContain("frame-src 'self'");
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.body).toContain('data-state="loading"');
    expect(page.body).toContain('id="agentui-errors"');
    expect(page.body).toMatch(/\/m\/trk\/1\.\d+\./); // the iframe is the usual sandboxed miniapp
    expect(JSON.parse((await app.inject({ url: `${link('trk')}/state` })).body)).toEqual({ version: store.get('trk')!.version, seq: 0 });
    const res = await app.inject({ url: `${link('trk')}/x/items` });
    expect(res.json()).toEqual({ who: 'jose', path: '/items' });

    const token = link('trk').split('/')[3]!;
    expect((await app.inject({ url: `/preview/other/${token}` })).statusCode).toBe(403); // another miniapp
    expect((await app.inject({ url: `/preview/trk/bad.token` })).statusCode).toBe(403);
    expect((await app.inject({ url: link('trk', 2) })).statusCode).toBe(403); // a user that does not exist
    expect((await app.inject({ url: link('trk', 1, -1000) })).statusCode).toBe(403); // expired
    expect((await app.inject({ url: `${link('trk', 1, -1000)}/x/items` })).statusCode).toBe(403);
    store.dataChanged('trk');
    expect(JSON.parse((await app.inject({ url: `${link('trk')}/state` })).body).seq).toBe(1);
    await store.destroy('trk', 'a1');
    expect((await app.inject({ url: link('trk') })).statusCode).toBe(404);
    await app.close();
  });

  it('the open operation only serves the owner agent, with a link that opens', async () => {
    store.create('a1', { id: 'trk', name: 'Tracker' });
    const ctx = { widgets: new WidgetStore(dir), preview: (id: string, ttlS: number) => { const p = signPreviewToken('s', 1, id, ttlS * 1000); return { url: `https://x.test/preview/${id}/${p.token}`, expiresAt: p.expiresAt }; } };
    const r = (await handleAppOp(store, data, 'a1', 'open', { id: 'trk', ttl_s: 120 }, ctx)) as { url: string; expiresAt: string };
    expect(r.url).toMatch(/^https:\/\/x\.test\/preview\/trk\/1\.\d+\./);
    expect(new Date(r.expiresAt).getTime()).toBeGreaterThan(Date.now());
    await expect(handleAppOp(store, data, 'a2', 'open', { id: 'trk' }, ctx)).rejects.toThrow();
    await expect(handleAppOp(store, data, 'a1', 'open', { id: 'trk', ttl_s: 99999 }, ctx)).rejects.toThrow(); // above the maximum
  });

  it('previews a custom widget: compiled, in a column of the asked width, with no handlers', async () => {
    const code = `export default function W() { return <div>hello</div>; }`;
    const widgets = new WidgetStore(dir);
    const ctx = { widgets, preview: (id: string, ttlS: number) => { const p = signPreviewToken('s', 1, id, ttlS * 1000); return { url: `/preview/${id}/${p.token}`, expiresAt: p.expiresAt }; } };
    const bad = (await handleAppOp(store, data, 'a1', 'widget_open', { code: 'export default function W() { return <div>; }' }, ctx)) as { ok: boolean; errors: unknown[] };
    expect(bad.ok).toBe(false);
    expect(bad.errors.length).toBeGreaterThan(0);
    const r = (await handleAppOp(store, data, 'a1', 'widget_open', { code, width: 280 }, ctx)) as { ok: boolean; url: string };
    expect(r.ok).toBe(true);
    expect(r.url).toMatch(/^\/preview\/widget-[0-9a-f]{24}\/1\.\d+\.[^?]+\?w=280$/);
    await expect(handleAppOp(store, data, 'a1', 'widget_open', { code, width: 50 }, ctx)).rejects.toThrow();

    const app = Fastify();
    registerMiniApps(app, { store, widgets, attachments: new AttachmentStore(db, dir), data, secret: 's', userOf: () => null, userById: (id) => (id === 1 ? { id: 1, username: 'jose' } : null), runtimeDir: dir });
    await app.ready();
    const page = await app.inject({ url: r.url });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('width:280px');
    expect(page.body).toContain('id="agentui-errors"');
    expect(page.body).toMatch(/\/w\/[0-9a-f]{24}\/1\.\d+\./); // the usual widget iframe
    const path = r.url.split('?')[0]!;
    expect((await app.inject({ url: `${path}/state` })).statusCode).toBe(404);
    expect((await app.inject({ url: `${path}/x/items` })).statusCode).toBe(404);
    const other = signPreviewToken('s', 1, 'widget-' + '0'.repeat(24), HOUR).token;
    expect((await app.inject({ url: `/preview/widget-${'0'.repeat(24)}/${other}` })).statusCode).toBe(404); // never compiled
    expect((await app.inject({ url: path.replace(/\/[^/]+$/, '/bad.token') })).statusCode).toBe(403);
    await app.close();
  });
});
