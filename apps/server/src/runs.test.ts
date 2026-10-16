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
    // Messages texte : flux « session chat » (événements nommés via `event:`), seul à intégrer les images MEDIA.
    if (req.url === '/api/sessions' && req.method === 'POST') {
      res.setHeader('content-type', 'application/json');
      return void res.end('{"object":"hermes.session"}');
    }
    if (req.url?.endsWith('/chat/stream') && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (name: string, data: object) => res.write(`event: ${name}\ndata: ${JSON.stringify({ run_id: 'r1', ...data })}\n\n`);
      ev('run.started', {});
      ev('tool.started', { tool_name: 'terminal', preview: 'ls', args: 'ls' });
      ev('tool.completed', { tool_name: 'terminal' });
      ev('assistant.delta', { delta: 'Bon' });
      ev('assistant.delta', { delta: 'jour' });
      ev('assistant.completed', { content: 'Bonjour' });
      ev('run.completed', {});
      ev('done', {});
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
  expect(runs.eventsSince(0).length).toBe(6);
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

test('non lu : un message d’agent terminé plus récent que la dernière lecture', () => {
  const db = openDb(mkdtempSync(join(tmpdir(), 'agentui-')));
  const runs = new RunManager(db, new Map());
  const unread = (id: string) => !!runs.getConversation(id)!.unread;
  const pushes: string[] = [];
  runs.subscribe((p) => p.type === 'conversation.read' && pushes.push(p.conversationId));

  // Une discussion que l'utilisateur vient de créer n'est pas non lue
  const mine = runs.createConversation('a');
  expect(unread(mine.id)).toBe(false);
  db.prepare('UPDATE conversations SET last_read_at = 1000 WHERE id = ?').run(mine.id); // lue il y a longtemps

  // Réponse en cours de streaming : pas encore non lue ; terminée : non lue
  const add = (conv: string, role: string, status: string, at: number) =>
    db.prepare('INSERT INTO messages (id, conversation_id, role, text, status, created_at) VALUES (?,?,?,?,?,?)').run(`m${at}${role}`, conv, role, 'x', status, at);
  const t = 2000;
  add(mine.id, 'user', 'done', t);
  add(mine.id, 'assistant', 'streaming', t + 1);
  expect(unread(mine.id)).toBe(false);
  db.prepare("UPDATE messages SET status = 'done' WHERE id = ?").run(`m${t + 1}assistant`);
  expect(unread(mine.id)).toBe(true);
  expect(runs.listConversations('a').find((c) => c.id === mine.id)!.unread).toBe(1);

  // Les messages de l'utilisateur ne comptent pas
  const other = runs.createConversation('a');
  db.prepare('UPDATE conversations SET last_read_at = 1000 WHERE id = ?').run(other.id);
  add(other.id, 'user', 'done', t + 5);
  expect(unread(other.id)).toBe(false);

  // Marquer lu : plus de non lu, et les autres appareils sont prévenus
  runs.markRead(mine.id);
  expect(unread(mine.id)).toBe(false);
  expect(pushes).toEqual([mine.id]);
});

test('non lu : message proactif dans une discussion existante ou créée par l’agent', async () => {
  const db = openDb(mkdtempSync(join(tmpdir(), 'agentui-')));
  const runs = new RunManager(db, new Map());
  const first = runs.deliver('a', 'cron-x', 'Résultat 1', [], 'A', '⏰ x');
  expect(!!runs.getConversation(first.id)!.unread).toBe(true); // créée par l'agent : non lue d'emblée
  runs.markRead(first.id);
  expect(!!runs.getConversation(first.id)!.unread).toBe(false);
  await new Promise((r) => setTimeout(r, 5));
  runs.deliver('a', 'cron-x', 'Résultat 2', [], 'A', '⏰ x');
  expect(!!runs.getConversation(first.id)!.unread).toBe(true); // nouveau message après la lecture
  expect(runs.listConversations('a')).toHaveLength(1);
});

test('recherche : titres et messages, sans casse ni accents, tous les mots requis, extrait surligné', () => {
  const db = openDb(mkdtempSync(join(tmpdir(), 'agentui-')));
  const runs = new RunManager(db, new Map());
  const a = runs.deliver('a', 's1', 'On se voit cet été à Lisbonne pour le déjeuner', [], 'A', 'Vacances');
  const b = runs.deliver('a', 's2', 'Rien à voir avec le sujet', [], 'A', 'Été au Portugal');
  runs.deliver('a', 's3', 'Un sujet sans rapport', [], 'A', 'Autre');
  // accents et casse ignorés ; le titre passe avant les messages
  expect(runs.search('ETE').map((h) => h.id)).toEqual([b.id, a.id]);
  const inTitle = runs.search('ete')[0]!;
  expect(inTitle.inTitle).toBe(true);
  // tous les mots doivent figurer (dans le titre, ou dans un même message)
  expect(runs.search('ete lisbonne').map((h) => h.id)).toEqual([a.id]);
  expect(runs.search('lisbonne portugal')).toEqual([]);
  // extrait autour du mot trouvé, plages à surligner dans l'extrait
  const hit = runs.search('lisbonne')[0]!;
  expect(hit.inTitle).toBe(false);
  expect(hit.snippet).toContain('Lisbonne');
  expect(hit.marks!.map(([i, n]) => hit.snippet!.slice(i, i + n))).toEqual(['Lisbonne']);
  // requête trop courte ou vide
  expect(runs.search('e')).toEqual([]);
  expect(runs.search('   ')).toEqual([]);
});

test('archivage : le drapeau est enregistré, conservé et restitué avec les discussions', () => {
  const db = openDb(mkdtempSync(join(tmpdir(), 'agentui-')));
  const runs = new RunManager(db, new Map());
  const c = runs.deliver('a', 's1', 'Bonjour archive', [], 'A', 'À ranger');
  expect(!!runs.getConversation(c.id)!.archived).toBe(false);
  runs.setArchived(c.id, true);
  expect(!!runs.getConversation(c.id)!.archived).toBe(true);
  expect(runs.listConversations('a').find((x) => x.id === c.id)!.archived).toBe(1);
  expect(runs.search('archive')[0]!.archived).toBe(true); // retrouvée par la recherche, signalée archivée
  runs.setArchived(c.id, false);
  expect(!!runs.getConversation(c.id)!.archived).toBe(false);
});

test('consommation : l’événement usage est mémorisé, rediffusé et ne perturbe pas le message', async () => {
  const db = openDb(mkdtempSync(join(tmpdir(), 'agentui-')));
  const usage = { model: 'deepseek-flash', provider: 'deepseek', inputTokens: 1200, outputTokens: 340, costUsd: 0.0123, costEstimated: true };
  const adapter = {
    id: 'a', name: 'A', capabilities: () => ({}),
    send: async () => ({
      runId: 'r1', sessionId: 's1',
      events: (async function* () {
        yield { type: 'message.final', text: 'Bonjour' } as const;
        yield { type: 'usage', usage } as const;
        yield { type: 'run.completed' } as const;
      })(),
    }),
  } as unknown as AgentAdapter;
  const runs = new RunManager(db, new Map([['a', adapter]]));
  const pushes: any[] = [];
  runs.subscribe((p) => pushes.push(p));
  const conv = runs.createConversation('a');
  const finished = new Promise<string>((r) => (runs.onRunFinished = (_c, o) => r(o)));
  await runs.start(conv.id, 'salut');
  expect(await finished).toBe('completed');
  expect(JSON.parse(runs.getConversation(conv.id)!.usage!)).toEqual(usage);
  expect(runs.getMessages(conv.id).at(-1)).toMatchObject({ role: 'assistant', text: 'Bonjour', status: 'done' });
  expect(pushes.filter((p) => p.type === 'event').map((p) => p.event.type)).toEqual(['message.final', 'usage', 'run.completed']);
  // identifiant de session distante créé à la demande (choix du modèle avant le premier message), puis conservé
  const fresh = runs.createConversation('a');
  const sid = runs.ensureRemoteSession(fresh.id);
  expect(sid).toBeTruthy();
  expect(runs.ensureRemoteSession(fresh.id)).toBe(sid);
});
