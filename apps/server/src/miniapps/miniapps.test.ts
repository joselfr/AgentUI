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
