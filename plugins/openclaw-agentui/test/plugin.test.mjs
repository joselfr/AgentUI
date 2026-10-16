// Test du plugin compilé (dist/) avec un runtime OpenClaw simulé et un faux AgentUI.
//   npm run build:test && node --test --experimental-test-module-mocks test/
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';

// Seules surfaces du SDK chargées à l'exécution par le plugin.
mock.module('openclaw/plugin-sdk/channel-core', { namedExports: { createChatChannelPlugin: (p) => p, defineChannelPluginEntry: (e) => e, defineSetupPluginEntry: (p) => ({ plugin: p }) } });
mock.module('openclaw/plugin-sdk/channel-inbound', { namedExports: { toInboundMediaFacts: (m) => m } });
// Réponses aux questions ask_user : le plugin résout la question par la passerelle (question.get puis question.resolve).
const gatewayCalls = [];
let questionRecord;
mock.module('openclaw/plugin-sdk/gateway-runtime', {
  namedExports: {
    callGatewayFromCli: async (method, _opts, params) => {
      gatewayCalls.push({ method, params });
      if (method === 'question.get') return { question: questionRecord };
      if (method === 'question.resolve') {
        pendingAnswer?.(params.answers);
        pendingAnswer = undefined;
      }
      return {};
    },
  },
});
// Suppression de session : le plugin passe par le SDK ; on enregistre les clés effacées.
const deletedKeys = [];
// Sessions simulées : `${agentId}|${sessionKey}` → entrée (modèle, jetons…), alimentées par le faux runtime.
const sessionStore = new Map();
mock.module('openclaw/plugin-sdk/session-store-runtime', {
  namedExports: {
    deleteSessionEntry: async (params) => (deletedKeys.push(params.sessionKey), true),
    getSessionEntry: ({ agentId, sessionKey }) => sessionStore.get(`${agentId}|${sessionKey}`),
  },
});
mock.module('openclaw/plugin-sdk/agent-scope-runtime', {
  namedExports: {
    resolveDefaultAgentId: () => 'main',
    listAgentIds: (cfg) => (cfg.agents?.list ?? []).map((a) => a.id),
    resolveAgentConfig: (cfg, id) => cfg.agents?.list?.find((a) => a.id === id),
  },
});

const { agentUIPlugin } = await import('../dist/src/channel.js');
const { setAgentUIRuntime } = await import('../dist/src/runtime.js');

const TOKEN = 'secret';
const imgDir = mkdtempSync(join(tmpdir(), 'agentui-oc-'));
const imgPath = join(imgDir, 'chart.png');
writeFileSync(imgPath, Buffer.from('89504e47', 'hex'));

// ── Runtime OpenClaw simulé ──────────────────────────────────────────────────
const listeners = new Set();
const turns = [];
const routes = [];
let pendingAnswer; // question ask_user en attente : le prochain message texte de la session la résout (comme le cœur)
const answers = [];
const emitAgent = (evt) => listeners.forEach((l) => l(evt));
const runtime = {
  events: { onAgentEvent: (l) => (listeners.add(l), () => listeners.delete(l)) },
  channel: {
    routing: {
      resolveAgentRoute: (input) => {
        routes.push(input);
        const agentId = input.defaultAgentId ?? 'main';
        return { agentId, accountId: input.accountId, sessionKey: `agent:${agentId}:agentui:direct:${input.peer.id}`, mainSessionKey: 'agent:main:main' };
      },
    },
    media: { saveMediaBuffer: async (buf, contentType, _sub, _max, name) => ({ path: join(imgDir, name), contentType }) },
    inbound: {
      buildContext: async (p) => ({ SessionKey: p.route.routeSessionKey, Body: p.message.body, media: p.media }),
      run: async ({ adapter, raw }) => {
        const input = await adapter.ingest(raw);
        const plan = await adapter.resolveTurn(input, {}, {});
        turns.push({ input, plan });
        const ro = plan.replyOptions;
        if (input.rawText.startsWith('ask')) {
          const multi = input.rawText === 'ask-multi';
          const questions = multi
            ? [{ id: 'color', header: 'Couleur', question: 'Quelle couleur ? (rouge: vif)', options: [{ label: 'Rouge' }, { label: 'Bleu' }] }, { id: 'size', header: 'Taille', question: 'Quelle taille ?' }]
            : [{ id: 'q', header: 'Test', question: 'Que veux-tu répondre ?', options: [{ label: 'Option A', description: 'Première' }, { label: 'Option B' }], isOther: true }];
          questionRecord = { status: 'pending', questions: questions.map((q) => ({ questionId: q.id, options: q.options, multiSelect: q.multiSelect === true, isOther: q.isOther === true })) };
          ro.onAgentRunStart?.('oc-run');
          emitAgent({ runId: 'oc-run', stream: 'tool', data: { phase: 'start', toolCallId: 'ask1', name: 'ask_user', args: { questions } } });
          await plan.delivery.deliver({ text: 'Question for you:\n\nTest\nReply with the number…', channelData: { askUser: { questionId: `ask_${'a'.repeat(32)}` } } }, { kind: 'block' });
          answers.push(await new Promise((resolve) => (pendingAnswer = resolve)));
          emitAgent({ runId: 'oc-run', stream: 'tool', data: { phase: 'result', toolCallId: 'ask1', name: 'ask_user', result: { content: [{ type: 'text', text: 'ok' }] } } });
          await ro.onPartialReply({ delta: 'Merci.' });
          ro.onAgentRunTerminalOutcome?.('completed');
          return { dispatched: true };
        }
        if (input.rawText.startsWith('/approve')) return { dispatched: true };
        const key = `${plan.route.agentId}|${plan.route.sessionKey}`;
        if (input.rawText.startsWith('/model')) {
          // Commande de contrôle : la gateway répond par un texte, et pose le choix de modèle sur la session
          const ref = input.rawText.split(' ')[1];
          if (ref.includes('refuse')) {
            await plan.delivery.deliver({ text: '⚠️ Model not allowed' }, { kind: 'final' });
            return { dispatched: true };
          }
          const [provider, id] = ref.includes('/') ? ref.split('/') : [undefined, ref];
          sessionStore.set(key, { ...(sessionStore.get(key) ?? { updatedAt: Date.now() }), modelOverride: id, providerOverride: provider });
          await plan.delivery.deliver({ text: `Model set to ${ref} (session only)` }, { kind: 'final' });
          return { dispatched: true };
        }
        if (input.rawText === 'long') {
          await new Promise((_, reject) => ro.abortSignal.addEventListener('abort', () => reject(new Error('aborted'))));
        }
        ro.onAgentRunStart?.('oc-run');
        await ro.onPartialReply({ delta: 'Je ' });
        await ro.onPartialReply({ delta: 'regarde.' });
        await ro.onAssistantMessageStart();
        emitAgent({ runId: 'oc-run', stream: 'tool', data: { phase: 'start', toolCallId: 't1', name: 'exec', args: { command: 'ls' } } });
        emitAgent({ runId: 'autre-run', stream: 'tool', data: { phase: 'start', toolCallId: 'zz', name: 'exec' } });
        emitAgent({ runId: 'oc-run', stream: 'tool', data: { phase: 'result', toolCallId: 't1', name: 'exec', result: { content: [{ type: 'text', text: 'a.txt' }] } } });
        emitAgent({ runId: 'oc-run', stream: 'thinking', data: { delta: 'Je réfléchis' } });
        if (input.rawText === 'approve') await ro.onApprovalEvent({ approvalId: 'ap1', command: 'rm -rf build', status: 'pending', title: 'Exec approval' });
        await ro.onPartialReply({ delta: 'Fini.' });
        await plan.delivery.deliver({ text: 'Fini : a.txt', mediaUrls: [imgPath] }, { kind: 'final' });
        sessionStore.set(key, { ...(sessionStore.get(key) ?? {}), model: 'deepseek-flash', modelProvider: 'deepseek', inputTokens: 1200, outputTokens: 340, updatedAt: Date.now() });
        ro.onAgentRunTerminalOutcome?.('completed');
        return { dispatched: true };
      },
    },
  },
};
setAgentUIRuntime(runtime);

// ── Faux AgentUI ─────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ port: 0, path: '/gateway' });
await new Promise((r) => wss.on('listening', r));
const url = `ws://127.0.0.1:${wss.address().port}/gateway`;
let plugin;
let hello;
const frames = [];
let waiters = [];
wss.on('connection', (ws) => {
  ws.once('message', (raw) => {
    hello = JSON.parse(String(raw));
    if (hello.token !== TOKEN) return ws.close(4001, 'token');
    plugin = ws;
    ws.send(JSON.stringify({ type: 'welcome', protocol: 1 }));
    ws.on('message', (raw2) => {
      frames.push(JSON.parse(String(raw2)));
      waiters = waiters.filter((w) => !w());
    });
  });
});
const send = (m) => plugin.send(JSON.stringify(m));
const until = (pred, ms = 3000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`délai dépassé ; trames : ${JSON.stringify(frames.slice(-5))}`)), ms);
    const check = () => {
      const i = frames.findIndex(pred);
      if (i < 0) return false;
      clearTimeout(t);
      resolve(frames.splice(0, i + 1));
      return true;
    };
    if (!check()) waiters.push(check);
  });
const eventsOf = (fs, runId) => fs.filter((f) => f.type === 'event' && f.runId === runId).map((f) => f.event);
const isTerminal = (runId) => (f) => f.type === 'event' && f.runId === runId && f.event.type.startsWith('run.');
const rpc = async (method, params) => {
  const id = `${method}-${Math.random()}`;
  send({ type: 'rpc', id, method, params });
  return (await until((f) => f.type === 'rpc.result' && f.id === id)).at(-1);
};

// ── Démarrage du compte (vrai gateway.startAccount) ──────────────────────────
const cfg = {
  channels: { agentui: { url, token: TOKEN, name: 'OpenClaw test' } },
  models: { providers: { deepseek: { models: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] } } },
  agents: { defaults: { model: { primary: 'deepseek/deepseek-flash' }, models: { 'anthropic/claude': {} } }, list: [{ id: 'coder', name: 'Codeur', model: 'anthropic/claude' }] },
};
const abort = new AbortController();
const statuses = [];
const started = agentUIPlugin.base.gateway.startAccount({
  cfg,
  accountId: 'default',
  account: agentUIPlugin.base.config.resolveAccount(cfg, 'default'),
  abortSignal: abort.signal,
  log: { info: () => {} },
  getStatus: () => ({}),
  setStatus: (s) => statuses.push(s),
});

test('hello / welcome', async () => {
  for (let i = 0; i < 100 && !plugin; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(hello.agent.type, 'openclaw');
  assert.equal(hello.agent.name, 'OpenClaw test');
  assert.equal(hello.capabilities.toolDetails, true);
  assert.deepEqual(hello.subAgents, [
    { id: 'main', name: 'OpenClaw', description: 'deepseek/deepseek-flash', isDefault: true },
    { id: 'coder', name: 'Codeur', description: 'anthropic/claude' },
  ]);
  assert.equal(statuses.at(-1)?.connected, true);
});

test('run complet : streaming, outils (événements d’agent), raisonnement, final, média, fin', async () => {
  send({ type: 'inbound', conversationId: 'c1', runId: 'r1', text: 'liste' });
  const ev = eventsOf(await until(isTerminal('r1')), 'r1');
  const types = ev.map((e) => e.type);
  assert.deepEqual(types.slice(0, 3), ['message.delta', 'message.delta', 'message.delta']);
  assert.deepEqual(ev.find((e) => e.type === 'tool.started'), { type: 'tool.started', id: 't1', name: 'exec', args: { command: 'ls' } });
  assert.ok(!ev.some((e) => e.id === 'zz'), 'événement d’un autre run ignoré');
  assert.equal(ev.find((e) => e.type === 'tool.completed').result, 'a.txt');
  assert.equal(ev.find((e) => e.type === 'reasoning.delta').text, 'Je réfléchis');
  assert.equal(ev.filter((e) => e.type === 'message.final').at(-1).text, 'Fini : a.txt');
  const media = ev.find((e) => e.type === 'message.media');
  assert.equal(media.name, 'chart.png');
  assert.equal(media.mimeType, 'image/png');
  assert.equal(Buffer.from(media.data, 'base64').toString('hex'), '89504e47');
  assert.equal(types.at(-1), 'run.completed');
  const { plan } = turns.at(-1);
  assert.equal(plan.replyOptions.runId, 'r1');
  assert.equal(plan.replyOptions.suppressToolProgressMessages, true);
});

test('fils multiples : un conversationId = un pair direct = une session', async () => {
  send({ type: 'inbound', conversationId: 'c2', runId: 'r2', text: 'liste' });
  await until(isTerminal('r2'));
  // routes des tours (sans agent imposé) : la lecture de la consommation en fin de run en résout d'autres, par agent
  const [a, b] = routes.filter((r) => !r.defaultAgentId).slice(-2);
  assert.deepEqual([a.peer, b.peer], [{ kind: 'direct', id: 'c1' }, { kind: 'direct', id: 'c2' }]);
  assert.equal(a.dmScope, 'per-channel-peer');
  assert.notEqual(turns.at(-2).plan.route.sessionKey, turns.at(-1).plan.route.sessionKey);
});

test('sous-agent choisi → defaultAgentId', async () => {
  send({ type: 'inbound', conversationId: 'c5', runId: 'r5', text: 'liste', subAgentId: 'coder' });
  await until(isTerminal('r5'));
  assert.equal(routes.at(-1).defaultAgentId, 'coder');
  assert.equal(turns.at(-1).plan.route.agentId, 'coder');
});

test('approbation : approval.request puis /approve <id> allow-always', async () => {
  send({ type: 'inbound', conversationId: 'c3', runId: 'r3', text: 'approve' });
  const fs = await until(isTerminal('r3'));
  const req = eventsOf(fs, 'r3').find((e) => e.type === 'approval.request');
  assert.equal(req.id, 'ap1');
  assert.match(req.description, /rm -rf build/);
  send({ type: 'approval', conversationId: 'c3', runId: 'r3', id: 'ap1', approve: true, scope: 'always' });
  for (let i = 0; i < 100 && turns.at(-1).input.rawText !== '/approve ap1 allow-always'; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(turns.at(-1).input.rawText, '/approve ap1 allow-always');
  assert.equal(routes.at(-1).peer.id, 'c3', 'commande envoyée dans la même discussion');
});

test('ask_user : widget ask, la réponse reply débloque l\'outil dans le run en cours', async () => {
  send({ type: 'inbound', conversationId: 'ca', runId: 'ra', text: 'ask' });
  const fs = await until((f) => f.type === 'event' && f.runId === 'ra' && f.event.type === 'message.final');
  const text = eventsOf(fs, 'ra').find((e) => e.type === 'message.final').text;
  const asked = eventsOf(fs, 'ra').filter((e) => e.type === 'question.requested');
  assert.deepEqual(asked, [{ type: 'question.requested', id: `ask_${'a'.repeat(32)}` }], 'annoncée avant le prompt');
  assert.doesNotMatch(text, /Reply with the number/);
  const w = JSON.parse(/```widget\n(.*)\n```/s.exec(text)[1]);
  assert.equal(w.type, 'ask');
  assert.deepEqual(w.arguments.options, ['Option A', 'Option B']);
  assert.match(w.arguments.question, /Que veux-tu répondre/);
  assert.match(w.arguments.question, /\*\*Option A\*\* — Première/); // description de l'option
  const turnsBefore = turns.length;
  send({ type: 'reply', conversationId: 'ca', runId: 'ra', text: '2' });
  const ev = eventsOf(await until(isTerminal('ra')), 'ra');
  assert.deepEqual(ev.filter((e) => e.type === 'question.resolved'), [{ type: 'question.resolved', id: `ask_${'a'.repeat(32)}` }], 'une seule fois (réponse puis fin de l\'outil)');
  assert.deepEqual(answers.at(-1), { answers: { q: ['Option B'] } }); // « 2 » → la 2e option
  assert.equal(ev.at(-1).type, 'run.completed');
  assert.deepEqual(gatewayCalls.slice(-2).map((c) => [c.method, c.params.id]), [['question.get', `ask_${'a'.repeat(32)}`], ['question.resolve', `ask_${'a'.repeat(32)}`]]);
  assert.equal(turns.length, turnsBefore, 'la question est résolue par la passerelle : aucun message injecté dans la session');
});

test('ask_user à plusieurs questions : formulaire, réponses renumérotées pour le cœur', async () => {
  send({ type: 'inbound', conversationId: 'cm', runId: 'rm', text: 'ask-multi' });
  const fs = await until((f) => f.type === 'event' && f.runId === 'rm' && f.event.type === 'message.final');
  const text = eventsOf(fs, 'rm').find((e) => e.type === 'message.final').text;
  const w = JSON.parse(/```widget\n(.*)\n```/s.exec(text)[1]);
  assert.equal(w.type, 'form');
  assert.deepEqual(w.arguments.fields.map((f) => [f.label, f.kind]), [['Quelle couleur ? (rouge: vif)', 'select'], ['Quelle taille ?', 'text']]);
  send({ type: 'reply', conversationId: 'cm', runId: 'rm', text: 'Quelle couleur ? (rouge: vif): Bleu\nQuelle taille ?: —' });
  await until(isTerminal('rm'));
  assert.deepEqual(answers.at(-1), { answers: { color: ['Bleu'], size: [] } });
});

test('ask_user : conversion des réponses (numéro, libellé, texte libre, multi-sélection, invalide)', async () => {
  const { buildQuestionAnswers } = await import('../dist/src/question.js');
  const opts = [{ label: 'Rouge' }, { label: 'Bleu' }];
  const one = (q, text) => buildQuestionAnswers([{ questionId: 'q', ...q }], text).answers.q;
  assert.deepEqual(one({ options: opts }, '2'), ['Bleu']);
  assert.deepEqual(one({ options: opts }, 'rouge'), ['Rouge']);
  assert.deepEqual(one({ options: opts, isOther: true }, 'Vert'), ['Vert']);
  assert.throws(() => one({ options: opts }, 'Vert'), /aucune option/);
  assert.deepEqual(one({}, 'texte libre'), ['texte libre']);
  assert.deepEqual(one({ options: opts, multiSelect: true }, '1, bleu, 1'), ['Rouge', 'Bleu']);
  assert.deepEqual(buildQuestionAnswers([{ questionId: 'a', options: opts }, { questionId: 'b' }], '1: Bleu\n2: ').answers, { a: ['Bleu'], b: [] });
});

test('arrêt : abortSignal déclenché, run.aborted', async () => {
  send({ type: 'inbound', conversationId: 'c4', runId: 'r4', text: 'long' });
  await new Promise((r) => setTimeout(r, 100));
  send({ type: 'abort', conversationId: 'c4', runId: 'r4' });
  const ev = eventsOf(await until(isTerminal('r4')), 'r4');
  assert.equal(ev.at(-1).type, 'run.aborted');
  assert.equal(turns.at(-1).plan.replyOptions.abortSignal.aborted, true);
});

test('messages proactifs : outbound.sendText / sendMedia', async () => {
  const send = agentUIPlugin.outbound.attachedResults;
  await send.sendText({ cfg, to: 'home', text: 'Rappel : réunion à 14 h', accountId: 'default' });
  await send.sendMedia({ cfg, to: 'c1', text: 'Le graphique', mediaUrl: imgPath, accountId: 'default' });
  const fs = await until((f) => f.type === 'outbound' && f.conversationId === 'c1');
  const outs = fs.filter((f) => f.type === 'outbound');
  assert.equal(outs[0].text, 'Rappel : réunion à 14 h');
  assert.equal(outs[0].conversationId, undefined);
  assert.equal(outs[1].media[0].name, 'chart.png');
});

test('tâches cron : service du planificateur + RPC listJobs / jobAction', async () => {
  const entry = (await import('../dist/index.js')).default;
  let service;
  entry.registerFull({ registerService: (svc) => (service = svc), registerTool: () => {} });
  const calls = [];
  const jobs = [{ id: 'j1', name: 'rapport', enabled: true, schedule: { kind: 'every', everyMs: 3_600_000 }, payload: { message: 'Fais le rapport' }, state: { nextRunAtMs: 1, lastStatus: 'ok' } }];
  service.start({
    getCron: () => ({
      list: async (opts) => (calls.push(['list', opts]), jobs),
      update: async (id, patch) => calls.push(['update', id, patch]),
      remove: async (id) => calls.push(['remove', id]),
      enqueueRun: async (id, mode) => calls.push(['run', id, mode]),
    }),
  });
  const list = await rpc('listJobs', {});
  assert.deepEqual(list.result, [{ id: 'j1', name: 'rapport', schedule: 'toutes les 1 h', mode: 'agent', prompt: 'Fais le rapport', enabled: true, nextRunAt: 1, lastStatus: 'ok', running: false, queued: false }]);
  assert.deepEqual((await rpc('jobAction', { jobId: 'j1', action: 'pause' })).result, { ok: true });
  await rpc('jobAction', { jobId: 'j1', action: 'run' });
  await rpc('jobAction', { jobId: 'j1', action: 'delete' });
  assert.deepEqual(calls.slice(1), [['update', 'j1', { enabled: false }], ['run', 'j1', 'force'], ['remove', 'j1']]);
  assert.match((await rpc('jobAction', { jobId: 'j1', action: 'bidon' })).error, /action inconnue/);
  service.stop();
  assert.match((await rpc('listJobs', {})).error, /indisponible/);
  assert.equal(hello.capabilities.jobs, true);
});

test('outils-widgets : agentui_chart / map / code, réservés aux runs AgentUI', async () => {
  const entry = (await import('../dist/index.js')).default;
  let factory, opts;
  entry.registerFull({ registerService: () => {}, registerTool: (f, o) => ((factory = f), (opts = o)) });
  assert.deepEqual(opts.names, ['agentui_chart', 'agentui_map', 'agentui_code']);
  assert.equal(factory({ messageChannel: 'telegram' }), null);
  const tools = factory({ messageChannel: 'agentui' });
  assert.deepEqual(tools.map((t) => t.name), opts.names);
  assert.deepEqual(tools[0].parameters.required, ['kind', 'x', 'series']);
  const ok = await tools[0].execute('t1', { kind: 'bar', x: ['a', 'b'], series: [{ name: 's', y: [1, 2] }] });
  const token = ok.details.token;
  assert.match(token, /^\[\[agentui:[0-9a-f]{6}\]\]$/);
  assert.equal(JSON.parse(ok.content[0].text).widget, token);
  await assert.rejects(tools[0].execute('t2', { kind: 'bar', x: ['a', 'b'], series: [{ name: 's', y: [1] }] }), /doit avoir 2 valeurs/);
  await assert.rejects(tools[0].execute('t3', { kind: 'pie', x: ['a'], series: [{ name: 's', y: [1] }, { name: 't', y: [2] }] }), /camembert/);
  await assert.rejects(tools[1].execute('t4', { points: [] }), /au moins un point/);
  await assert.rejects(tools[2].execute('t5', { code: ' ' }), /vide/);
});

test('suppression : deleteSession efface la session de chaque agent (une discussion = un pair direct)', async () => {
  assert.equal(hello.capabilities.sessionDelete, true);
  deletedKeys.length = 0;
  // Les sessions ne sont pas listables par un canal : on efface les clés candidates résolues pour la discussion.
  assert.deepEqual((await rpc('deleteSession', { conversationId: 'c7' })).result, { ok: true });
  assert.deepEqual(deletedKeys, ['agent:main:agentui:direct:c7', 'agent:coder:agentui:direct:c7']);
});

test('suppression : refusée tant qu’un run est en cours dans la discussion', async () => {
  send({ type: 'inbound', conversationId: 'c8', runId: 'r8', text: 'long' });
  await new Promise((r) => setTimeout(r, 100));
  deletedKeys.length = 0;
  assert.match((await rpc('deleteSession', { conversationId: 'c8' })).error, /run est en cours/);
  assert.deepEqual(deletedKeys, []);
  send({ type: 'abort', conversationId: 'c8', runId: 'r8' });
  await until(isTerminal('r8'));
});

test('modèle : liste, consommation, changement par /model -s, refus, run en cours', async () => {
  assert.equal(hello.capabilities.models, true);
  // modèles des fournisseurs + liste d'autorisation + modèles par défaut des agents, sans doublon
  const models = (await rpc('listModels', {})).result;
  assert.deepEqual(models.map((m) => `${m.provider}/${m.id}`).sort(), ['anthropic/claude', 'deepseek/deepseek-flash', 'deepseek/deepseek-v4-pro']);
  assert.deepEqual(models.find((m) => m.id === 'deepseek-flash'), { provider: 'deepseek', providerName: 'Deepseek', id: 'deepseek-flash' });

  // fin de run : la consommation de la session précède run.completed
  send({ type: 'inbound', conversationId: 'cm', runId: 'rm', text: 'liste' });
  const kinds = eventsOf(await until(isTerminal('rm')), 'rm').map((e) => e.type);
  assert.ok(kinds.includes('usage') && kinds.indexOf('usage') < kinds.indexOf('run.completed'), kinds.join());
  assert.deepEqual((await rpc('sessionUsage', { conversationId: 'cm' })).result, { inputTokens: 1200, outputTokens: 340, model: 'deepseek-flash', provider: 'deepseek' });
  assert.equal((await rpc('sessionUsage', { conversationId: 'inconnue' })).result, null);
  assert.equal((await rpc('sessionUsage', { conversationId: 'cm', subAgentId: 'coder' })).result, null, 'session d’un autre agent');

  // changement de modèle : commande /model <fournisseur/modèle> -s, réponse recueillie (pas affichée), état relu
  const set = (await rpc('setModel', { conversationId: 'cm', model: 'deepseek-v4-pro', provider: 'deepseek' })).result;
  assert.deepEqual(set, { model: 'deepseek-v4-pro', provider: 'deepseek', message: 'Model set to deepseek/deepseek-v4-pro (session only)' });
  assert.equal(turns.at(-1).input.rawText, '/model deepseek/deepseek-v4-pro -s');
  assert.equal((await rpc('sessionUsage', { conversationId: 'cm' })).result.model, 'deepseek-v4-pro');
  // refus : le texte d'OpenClaw est remonté, la session garde son modèle
  assert.match((await rpc('setModel', { conversationId: 'cm', model: 'refuse-me' })).error, /Model not allowed/);
  assert.equal((await rpc('sessionUsage', { conversationId: 'cm' })).result.model, 'deepseek-v4-pro');
  assert.ok((await rpc('setModel', { conversationId: 'cm' })).error, 'paramètres manquants');
  // pas de changement pendant une réponse
  send({ type: 'inbound', conversationId: 'cl', runId: 'rl', text: 'long' });
  await new Promise((r) => setTimeout(r, 100));
  assert.match((await rpc('setModel', { conversationId: 'cl', model: 'deepseek-flash' })).error, /run est en cours/);
  send({ type: 'abort', conversationId: 'cl', runId: 'rl' });
  await until(isTerminal('rl'));
});

test('arrêt du compte', async () => {
  abort.abort();
  await started;
});

test('envoi hors gateway (CLI, cron isolé) : connexion send-only ponctuelle', async () => {
  await agentUIPlugin.outbound.attachedResults.sendText({ cfg, to: 'c9', text: 'Depuis la CLI', accountId: 'default' });
  const fs = await until((f) => f.type === 'outbound' && f.conversationId === 'c9');
  assert.equal(fs.at(-1).text, 'Depuis la CLI');
  assert.equal(hello.mode, 'send-only');
  wss.close();
});
