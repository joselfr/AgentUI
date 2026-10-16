import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openDb } from '../db.js';
import { RunManager } from '../runs.js';
import { AttachmentStore } from '../attachments.js';
import { GatewayAdapter, type GatewaySocket } from './gateway.js';

/** Plugin simulé : capte ce qu'AgentUI lui envoie et peut lui répondre. */
class FakePlugin extends EventEmitter implements GatewaySocket {
  readyState = 1;
  sent: any[] = [];
  closed?: number;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number) {
    this.closed = code;
    this.readyState = 3;
    this.emit('close');
  }
  frame(msg: object) {
    this.emit('message', JSON.stringify(msg));
  }
  last(type: string) {
    return [...this.sent].reverse().find((m) => m.type === type);
  }
}

const CAPS = {
  sessions: true, abort: true, approvals: true, subagents: true, reasoning: true, toolDetails: true,
  skills: false, jobs: false, jobControl: false, attachments: { images: true, files: true, maxBytes: 1_000_000 },
};
const hello = (extra: object = {}) => ({ type: 'hello', protocol: 1, token: 'x'.repeat(16), agent: { type: 'hermes', name: 'Hermes', version: '0.21.0' }, capabilities: CAPS, ...extra });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'agentui-gw-'));
  const db = openDb(dir);
  const adapter = new GatewayAdapter({ id: 'gw', type: 'gateway', name: 'Hermes (canal)', token: 'x'.repeat(16) });
  const files = new AttachmentStore(db, dir);
  const runs = new RunManager(db, new Map([['gw', adapter]]), files);
  adapter.onOutbound = (m) => void runs.deliver('gw', m.conversationId, m.text, m.media, adapter.name, m.title);
  return { db, adapter, runs };
}
const tick = () => new Promise((r) => setTimeout(r, 20));

test('connexion : welcome, statut et capacités annoncées par le plugin', () => {
  const { adapter } = setup();
  expect(adapter.status().status).toBe('disconnected');
  const p = new FakePlugin();
  adapter.attach(p, hello());
  expect(p.sent[0]).toEqual({ type: 'welcome', protocol: 1 });
  expect(adapter.status()).toEqual({ status: 'connected', detail: 'hermes 0.21.0' });
  expect(adapter.capabilities().toolDetails).toBe(true);
  expect(adapter.type).toBe('hermes');
});

test('run : inbound, streaming, outil, média, fin ; même conversationId au message suivant', async () => {
  const { adapter, runs } = setup();
  const p = new FakePlugin();
  adapter.attach(p, hello());
  const conv = runs.createConversation('gw');
  const finished = new Promise<string>((r) => (runs.onRunFinished = (_c, o) => r(o)));

  await runs.start(conv.id, 'liste');
  const inbound = p.last('inbound');
  expect(inbound.text).toBe('liste');
  const ev = (event: object) => p.frame({ type: 'event', conversationId: inbound.conversationId, runId: inbound.runId, event });
  ev({ type: 'tool.started', id: 't1', name: 'terminal', args: { command: 'ls' } });
  ev({ type: 'tool.completed', id: 't1', result: 'a.txt' });
  ev({ type: 'message.delta', text: 'Deux ' });
  ev({ type: 'message.delta', text: 'fichiers' });
  ev({ type: 'message.media', name: 'chart.png', mimeType: 'image/png', data: Buffer.from('png').toString('base64') });
  ev({ type: 'run.completed' });
  expect(await finished).toBe('completed');
  await tick();

  const msg = runs.getMessages(conv.id)[1]!;
  expect(msg.text).toBe('Deux fichiers');
  expect(msg.status).toBe('done');
  expect(msg.toolCalls?.[0]).toMatchObject({ id: 't1', name: 'terminal', status: 'done', resultPreview: 'a.txt' });
  expect(msg.attachments?.[0]).toMatchObject({ name: 'chart.png', mimeType: 'image/png', size: 3 });

  // Fil conservé : la conversation AgentUI garde son identifiant côté plateforme.
  const again = new Promise<string>((r) => (runs.onRunFinished = (_c, o) => r(o)));
  await runs.start(conv.id, 'encore');
  const second = p.last('inbound');
  expect(second.conversationId).toBe(inbound.conversationId);
  p.frame({ type: 'event', conversationId: second.conversationId, runId: second.runId, event: { type: 'run.completed' } });
  expect(await again).toBe('completed');
});

test('arrêt et approbation transmis au plugin', async () => {
  const { adapter, runs } = setup();
  const p = new FakePlugin();
  adapter.attach(p, hello());
  const conv = runs.createConversation('gw');
  await runs.start(conv.id, 'long');
  const { conversationId, runId } = p.last('inbound');
  p.frame({ type: 'event', conversationId, runId, event: { type: 'approval.request', id: 'ap1', description: 'rm -rf' } });
  await tick();
  await runs.approve(conv.id, 'ap1', true);
  expect(p.last('approval')).toEqual({ type: 'approval', conversationId, runId, id: 'ap1', approve: true, scope: 'once' });
  await runs.abort(conv.id);
  expect(p.last('abort')).toEqual({ type: 'abort', conversationId, runId });
});

test('messages proactifs : discussion maison créée une fois, ou conversation existante', async () => {
  const { adapter, runs } = setup();
  const p = new FakePlugin();
  adapter.attach(p, hello());
  const notified: string[] = [];
  runs.onRunFinished = (c) => notified.push(c.title);

  p.frame({ type: 'outbound', id: 'o1', text: 'Rappel : réunion à 14 h' });
  p.frame({ type: 'outbound', id: 'o2', text: 'Second rappel' });
  await tick();
  const home = runs.listConversations('gw');
  expect(home).toHaveLength(1);
  expect(home[0]!.title).toBe('Messages de Hermes (canal)');
  expect(runs.getMessages(home[0]!.id).map((m) => m.text)).toEqual(['Rappel : réunion à 14 h', 'Second rappel']);
  expect(notified).toHaveLength(2);

  // Vers une conversation existante (identifiée par son conversationId côté plateforme)
  const conv = runs.createConversation('gw');
  await runs.start(conv.id, 'salut');
  const { conversationId, runId } = p.last('inbound');
  p.frame({ type: 'event', conversationId, runId, event: { type: 'run.completed' } });
  await tick();
  p.frame({ type: 'outbound', id: 'o3', conversationId, text: 'Tâche finie', media: [{ name: 'r.txt', mimeType: 'text/plain', data: Buffer.from('ok').toString('base64') }] });
  await tick();
  const last = runs.getMessages(conv.id).at(-1)!;
  expect(last.text).toBe('Tâche finie');
  expect(last.attachments?.[0]?.name).toBe('r.txt');
});

test('messages proactifs titrés : une discussion par tâche, titre gardé ensuite', async () => {
  const { adapter, runs } = setup();
  const p = new FakePlugin();
  adapter.attach(p, hello());
  p.frame({ type: 'outbound', id: 'a', conversationId: 'cron-rapport', title: '⏰ rapport', text: 'Lundi' });
  p.frame({ type: 'outbound', id: 'b', conversationId: 'cron-veille', title: '⏰ veille', text: 'Rien' });
  p.frame({ type: 'outbound', id: 'c', conversationId: 'cron-rapport', title: '⏰ autre titre', text: 'Mardi' });
  await tick();
  const convs = runs.listConversations('gw');
  expect(convs.map((c) => c.title).sort()).toEqual(['⏰ rapport', '⏰ veille']);
  const rapport = convs.find((c) => c.title === '⏰ rapport')!;
  expect(runs.getMessages(rapport.id).map((m) => m.text)).toEqual(['Lundi', 'Mardi']);
});

test('tâches et skills : RPC vers le plugin', async () => {
  const { adapter } = setup();
  const p = new FakePlugin();
  adapter.attach(p, hello({ capabilities: { ...CAPS, skills: true, jobs: true, jobControl: true } }));
  const reply = (result: unknown) => {
    const rpc = p.last('rpc');
    p.frame({ type: 'rpc.result', id: rpc.id, result });
    return rpc;
  };
  const jobs = adapter.listJobs();
  expect(reply([{ id: 'j1', name: 'rapport', schedule: 'every day at 10am', enabled: true }]).method).toBe('listJobs');
  expect(await jobs).toEqual([{ id: 'j1', name: 'rapport', schedule: 'every day at 10am', enabled: true }]);
  const action = adapter.jobAction('j1', 'pause');
  expect(reply({ ok: true }).params).toEqual({ jobId: 'j1', action: 'pause' });
  await action;
  const skills = adapter.listSkills();
  expect(reply([{ id: 's', name: 's' }]).method).toBe('listSkills');
  expect(await skills).toHaveLength(1);
  // Erreur côté plugin → erreur côté AgentUI
  const failing = adapter.jobAction('nope', 'run');
  p.frame({ type: 'rpc.result', id: p.last('rpc').id, error: 'tâche inconnue' });
  await expect(failing).rejects.toThrow('tâche inconnue');
});

test('tâches : liste vide sans la capacité, sans appel au plugin', async () => {
  const { adapter } = setup();
  const p = new FakePlugin();
  adapter.attach(p, hello());
  expect(await adapter.listJobs()).toEqual([]);
  expect(p.last('rpc')).toBeUndefined();
});

test('suppression de session : RPC deleteSession, erreur du plugin relayée, 501 sans la capacité', async () => {
  const { adapter } = setup();
  const p = new FakePlugin();
  adapter.attach(p, hello({ capabilities: { ...CAPS, sessionDelete: true } }));
  const ok = adapter.deleteSession('c1');
  const rpc = p.last('rpc');
  expect(rpc.method).toBe('deleteSession');
  expect(rpc.params).toEqual({ conversationId: 'c1' });
  p.frame({ type: 'rpc.result', id: rpc.id, result: { ok: true } });
  await ok;

  const failing = adapter.deleteSession('c2');
  p.frame({ type: 'rpc.result', id: p.last('rpc').id, error: 'run en cours dans cette discussion' });
  await expect(failing).rejects.toThrow('Hermes (canal) : run en cours dans cette discussion');

  const { adapter: plain } = setup();
  const p2 = new FakePlugin();
  plain.attach(p2, hello());
  await expect(plain.deleteSession('c3')).rejects.toMatchObject({ statusCode: 501 });
  expect(p2.last('rpc')).toBeUndefined();
});

test('modèle et coût : RPC listModels, setModel et sessionUsage ; sans la capacité, rien n’est appelé', async () => {
  const { adapter } = setup();
  const p = new FakePlugin();
  adapter.attach(p, hello({ capabilities: { ...CAPS, models: true } }));
  const list = adapter.listModels();
  expect(p.last('rpc').method).toBe('listModels');
  p.frame({ type: 'rpc.result', id: p.last('rpc').id, result: [{ provider: 'deepseek', providerName: 'DeepSeek', id: 'deepseek-flash' }] });
  expect(await list).toEqual([{ provider: 'deepseek', providerName: 'DeepSeek', id: 'deepseek-flash' }]);

  const set = adapter.setModel!('c1', 'deepseek-v4-pro', 'deepseek');
  expect(p.last('rpc').params).toEqual({ conversationId: 'c1', model: 'deepseek-v4-pro', provider: 'deepseek' });
  p.frame({ type: 'rpc.result', id: p.last('rpc').id, result: { model: 'deepseek-v4-pro', provider: 'deepseek', message: '✓ ok' } });
  expect(await set).toMatchObject({ model: 'deepseek-v4-pro' });

  const refused = adapter.setModel!('c1', 'inconnu');
  p.frame({ type: 'rpc.result', id: p.last('rpc').id, error: 'Modèle inconnu' });
  await expect(refused).rejects.toMatchObject({ message: 'Modèle inconnu', statusCode: 502 });

  const usage = adapter.sessionUsage!('c1');
  expect(p.last('rpc').method).toBe('sessionUsage');
  p.frame({ type: 'rpc.result', id: p.last('rpc').id, result: null });
  expect(await usage).toBeUndefined(); // session inconnue du plugin

  const { adapter: plain } = setup();
  const p2 = new FakePlugin();
  plain.attach(p2, hello());
  expect(await plain.listModels()).toEqual([]);
  await expect(plain.setModel!('c1', 'x')).rejects.toMatchObject({ statusCode: 501 });
  expect(await plain.sessionUsage!('c1')).toBeUndefined();
  expect(p2.last('rpc')).toBeUndefined();
});

test('connexion send-only : livre sans remplacer la connexion principale', async () => {
  const { adapter, runs } = setup();
  const main = new FakePlugin();
  adapter.attach(main, hello());
  const once = new FakePlugin();
  adapter.attach(once, hello({ mode: 'send-only' }));
  once.frame({ type: 'outbound', id: 'o', text: 'cron' });
  await tick();
  expect(main.closed).toBeUndefined();
  expect(adapter.status().status).toBe('connected');
  expect(runs.listConversations('gw')).toHaveLength(1);
});

test('coupure du plugin : run repris si déclaré actif à la reconnexion, sinon en échec', async () => {
  const { adapter, runs } = setup();
  const p1 = new FakePlugin();
  adapter.attach(p1, hello());
  const a = runs.createConversation('gw');
  const b = runs.createConversation('gw');
  const outcomes = new Map<string, string>();
  const done = new Promise<void>((r) => (runs.onRunFinished = (c, o) => (outcomes.set(c.id, o), outcomes.size === 2 && r())));
  await runs.start(a.id, 'A');
  const ra = p1.last('inbound');
  await runs.start(b.id, 'B');
  const rb = p1.last('inbound');

  p1.close();
  expect(adapter.status().status).toBe('disconnected');
  await expect(runs.start(runs.createConversation('gw').id, 'C')).rejects.toThrow(/non connecté/);

  const p2 = new FakePlugin();
  adapter.attach(p2, hello({ activeRuns: [{ runId: ra.runId, conversationId: ra.conversationId }] }));
  p2.frame({ type: 'event', conversationId: ra.conversationId, runId: ra.runId, event: { type: 'message.final', text: 'fini' } });
  p2.frame({ type: 'event', conversationId: ra.conversationId, runId: ra.runId, event: { type: 'run.completed' } });
  await done;
  expect(outcomes.get(a.id)).toBe('completed');
  expect(outcomes.get(b.id)).toBe('failed');
  expect(runs.getMessages(b.id)[1]!.text).toMatch(/perdu/);
  expect(rb.runId).not.toBe(ra.runId);
});
