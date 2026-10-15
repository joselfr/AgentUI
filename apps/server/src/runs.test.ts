import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { openDb } from './db.js';
import { HermesAdapter } from './agents/hermes.js';
import type { AgentAdapter } from './agents/types.js';
import { RunManager } from './runs.js';
import { hashPassword, verifyPassword } from './auth.js';

let server: Server;
let url = '';

// Format réel de Hermes v0.21 : pas de ligne `event:`, le nom est dans le JSON.
const sse = (res: import('node:http').ServerResponse, name: string, data: object) =>
  res.write(`data: ${JSON.stringify({ event: name, run_id: 'r1', ...data })}\n\n`);

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer k') return void res.writeHead(401).end();
    if (req.url === '/health') return void res.end('{"status":"ok"}');
    if (req.url === '/v1/runs' && req.method === 'POST') {
      res.setHeader('content-type', 'application/json');
      return void res.end('{"run_id":"r1","status":"started"}');
    }
    if (req.url === '/v1/runs/r1/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      sse(res, 'tool.started', { tool: 'terminal', preview: 'ls' });
      sse(res, 'tool.completed', { tool: 'terminal', duration: 0.2, error: false });
      sse(res, 'message.delta', { delta: 'Bon' });
      sse(res, 'message.delta', { delta: 'jour' });
      sse(res, 'run.completed', {});
      return void res.end();
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => void server.close());

test('run Hermes : persistance du texte et des outils, événements rejouables', async () => {
  const db = openDb(mkdtempSync(join(tmpdir(), 'agentui-')));
  const adapter = new HermesAdapter({ id: 'h', type: 'hermes', name: 'H', url, apiKey: 'k', profiles: ['default'] });
  const runs = new RunManager(db, new Map([['h', adapter]]));
  const finished = new Promise<string>((r) => (runs.onRunFinished = (_c, o) => r(o)));

  const conv = runs.createConversation('h');
  await runs.start(conv.id, 'salut');
  expect(await finished).toBe('completed');

  const msgs = runs.getMessages(conv.id);
  expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
  expect(msgs[1]!.text).toBe('Bonjour');
  expect(msgs[1]!.status).toBe('done');
  expect(msgs[1]!.toolCalls).toMatchObject([{ name: 'terminal', status: 'done', args: 'ls' }]);
  expect(runs.eventsSince(0).length).toBe(5);
  expect(runs.isRunning(conv.id)).toBe(false);
});

test('mots de passe scrypt', () => {
  const h = hashPassword('secret123');
  expect(verifyPassword('secret123', h)).toBe(true);
  expect(verifyPassword('nope', h)).toBe(false);
});

test('recover : un run « streaming » est repris, ou marqué interrompu si la reprise est impossible', async () => {
  const db = openDb(mkdtempSync(join(tmpdir(), 'agentui-')));
  const mk = (resume: unknown) =>
    ({ id: 'a', name: 'A', type: 'fake', resume, abort: async () => {} }) as unknown as import('./agents/types.js').AgentAdapter;
  const events = async function* () {
    yield { type: 'message.final' as const, text: 'repris !' };
    yield { type: 'run.completed' as const };
  };
  const seed = (runs: RunManager) => {
    const conv = runs.createConversation('a', undefined, 't', 'sess');
    db.prepare("INSERT INTO messages (id, conversation_id, role, text, run_id, status, created_at) VALUES ('m-' || ?, ?, 'assistant', 'début', 'r', 'streaming', 1)").run(conv.id, conv.id);
    return conv.id;
  };

  const ok = new RunManager(db, new Map([['a', mk(async () => ({ runId: 'r', sessionId: 'sess', events: events() }))]]));
  const c1 = seed(ok);
  const done = new Promise((r) => (ok.onRunFinished = () => r(0)));
  expect(await ok.recover()).toBe(1);
  await done;
  expect(ok.getMessages(c1)[0]).toMatchObject({ status: 'done', text: 'repris !' });

  const ko = new RunManager(db, new Map([['a', mk(undefined)]]));
  const c2 = seed(ko);
  expect(await ko.recover()).toBe(0);
  expect(ko.getMessages(c2)[0]).toMatchObject({ status: 'failed' });
  expect(ko.getMessages(c2)[0]!.text).toContain('interrompu');
});

test('suppression : la session de plateforme est supprimée avant la discussion', async () => {
  const db = openDb(mkdtempSync(join(tmpdir(), 'agentui-')));
  const calls: string[] = [];
  const adapter = {
    id: 'a',
    name: 'A',
    type: 'fake',
    async deleteSession(sessionId: string) {
      calls.push(`delete:${sessionId}`);
    },
  } as unknown as AgentAdapter;
  const runs = new RunManager(db, new Map([['a', adapter]]));
  const conv = runs.createConversation('a', undefined, 't', 'sess-1');
  db.prepare("INSERT INTO messages (id, conversation_id, role, text, status, created_at) VALUES ('m1', ?, 'user', 'salut', 'done', 1)").run(conv.id);

  await runs.deleteConversation(conv.id);
  expect(calls).toEqual(['delete:sess-1']);
  expect(runs.getConversation(conv.id)).toBeUndefined();
  expect(runs.getMessages(conv.id)).toEqual([]);
  await runs.deleteConversation(conv.id); // discussion déjà absente : sans effet, sans nouvel appel
  expect(calls).toEqual(['delete:sess-1']);
});

test('suppression : refus du plugin ou agent sans suppression → la discussion est conservée', async () => {
  const db = openDb(mkdtempSync(join(tmpdir(), 'agentui-')));
  const keep = (runs: RunManager, conv: string) => {
    expect(runs.getConversation(conv)).toBeTruthy();
    expect(runs.getMessages(conv)).toHaveLength(1);
  };
  const seed = (runs: RunManager) => {
    const conv = runs.createConversation('a', undefined, 't', 'sess-1');
    db.prepare("INSERT INTO messages (id, conversation_id, role, text, status, created_at) VALUES (?, ?, 'user', 'salut', 'done', 1)").run(`m-${conv.id}`, conv.id);
    return conv.id;
  };

  const refusing = {
    id: 'a',
    name: 'Agent',
    type: 'fake',
    async deleteSession() {
      throw Object.assign(new Error('Agent : session active'), { statusCode: 502 });
    },
  } as unknown as AgentAdapter;
  const runs = new RunManager(db, new Map([['a', refusing]]));
  const c1 = seed(runs);
  await expect(runs.deleteConversation(c1)).rejects.toThrow('session active');
  keep(runs, c1);

  const silent = { id: 'a', name: 'Agent', type: 'fake' } as unknown as AgentAdapter;
  const runs2 = new RunManager(db, new Map([['a', silent]]));
  const c2 = seed(runs2);
  await expect(runs2.deleteConversation(c2)).rejects.toThrow(/n’est pas supportée/);
  keep(runs2, c2);
});

test('suppression : discussion « maison » ou sans session distante → suppression locale seule', async () => {
  const db = openDb(mkdtempSync(join(tmpdir(), 'agentui-')));
  const calls: string[] = [];
  const adapter = {
    id: 'a',
    name: 'A',
    type: 'fake',
    async deleteSession(sessionId: string) {
      calls.push(`delete:${sessionId}`);
    },
  } as unknown as AgentAdapter;
  const runs = new RunManager(db, new Map([['a', adapter]]));

  const home = runs.deliver('a', undefined, 'Rappel', [], 'A'); // messages proactifs : session « home »
  expect(home.remote_session_id).toBe('home');
  await runs.deleteConversation(home.id);
  expect(runs.getConversation(home.id)).toBeUndefined();

  const bare = runs.createConversation('a'); // jamais utilisée : aucune session côté agent
  await runs.deleteConversation(bare.id);
  expect(runs.getConversation(bare.id)).toBeUndefined();
  expect(calls).toEqual([]);
});

test('suppression : un run en cours est arrêté avant la suppression', async () => {
  const db = openDb(mkdtempSync(join(tmpdir(), 'agentui-')));
  const ctrl = new AbortController();
  const calls: string[] = [];
  const adapter = {
    id: 'a',
    name: 'A',
    type: 'fake',
    capabilities: () => ({ attachments: { images: true, files: true, maxBytes: 1024 } }),
    async send() {
      const events = (async function* () {
        await new Promise<void>((r) => ctrl.signal.addEventListener('abort', () => r(), { once: true }));
        yield { type: 'run.aborted' as const };
      })();
      return { runId: 'r1', sessionId: 'sess-1', events };
    },
    async abort() {
      calls.push('abort');
      ctrl.abort();
    },
    async deleteSession(sessionId: string) {
      calls.push(`delete:${sessionId}`);
    },
  } as unknown as AgentAdapter;
  const runs = new RunManager(db, new Map([['a', adapter]]));
  const conv = runs.createConversation('a');
  await runs.start(conv.id, 'salut');
  expect(runs.isRunning(conv.id)).toBe(true);

  await runs.deleteConversation(conv.id);
  expect(calls).toEqual(['abort', 'delete:sess-1']);
  expect(runs.getConversation(conv.id)).toBeUndefined();
  expect(runs.isRunning(conv.id)).toBe(false);
});

