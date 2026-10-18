// Test of the compiled plugin (dist/) with a simulated OpenClaw runtime and a fake AgentUI.
//   npm run build:test && node --test --experimental-test-module-mocks test/
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';

// Only SDK surfaces loaded at runtime by the plugin.
mock.module('openclaw/plugin-sdk/channel-core', { namedExports: { createChatChannelPlugin: (p) => p, defineChannelPluginEntry: (e) => e, defineSetupPluginEntry: (p) => ({ plugin: p }) } });
mock.module('openclaw/plugin-sdk/channel-inbound', { namedExports: { toInboundMediaFacts: (m) => m } });
// Answers to ask_user questions: the plugin resolves the question through the gateway (question.get then question.resolve).
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
// Session deletion: the plugin goes through the SDK; the erased keys are recorded.
const deletedKeys = [];
// Simulated sessions: `${agentId}|${sessionKey}` → entry (model, tokens…), fed by the fake runtime.
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

// ── Simulated OpenClaw runtime ──────────────────────────────────────────────────
const listeners = new Set();
const turns = [];
const routes = [];
let pendingAnswer; // pending ask_user question: the session's next text message resolves it (like the core)
const answers = [];
const toolRuns = []; // results of the interactive tools
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
            ? [{ id: 'color', header: 'Color', question: 'Which color? (red: bright)', options: [{ label: 'Red' }, { label: 'Blue' }] }, { id: 'size', header: 'Size', question: 'Which size?' }]
            : [{ id: 'q', header: 'Test', question: 'What do you want to answer?', options: [{ label: 'Option A', description: 'First' }, { label: 'Option B' }], isOther: true }];
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
        if (input.rawText.startsWith('tool-')) {
          // Interactive tool agentui_ask / confirm / form: runs in the gateway and blocks until the answer.
          const entry = (await import('../dist/index.js')).default;
          let factory;
          entry.registerFull({ registerService: () => {}, registerTool: (f) => (factory = f) });
          const tools = factory({ messageChannel: 'agentui', sessionKey: plan.route.sessionKey });
          const key = input.rawText.slice(5);
          const args = key === 'ask' ? { question: 'Which color?', options: ['Red', 'Blue'] } : key === 'confirm' ? { title: 'Delete?', danger: true } : { fields: [{ name: 'a', label: 'A' }, { name: 'a', label: 'B' }] };
          ro.onAgentRunStart?.('oc-run');
          await ro.onPartialReply({ delta: 'Je demande. ' });
          toolRuns.push(await tools.find((t) => t.name === `agentui_${key}`).execute('tc1', args, ro.abortSignal).then((r) => JSON.parse(r.content[0].text), (e) => ({ error: e.message })));
          await ro.onPartialReply({ delta: 'Merci.' });
          ro.onAgentRunTerminalOutcome?.('completed');
          return { dispatched: true };
        }
        if (input.rawText === 'img-widget') {
          // agentui_image tool: copies a local file into the chat (message.media) and returns the path → attachment mapping.
          const entry = (await import('../dist/index.js')).default;
          let factory;
          entry.registerFull({ registerService: () => {}, registerTool: (f) => (factory = f) });
          const tool = factory({ messageChannel: 'agentui', sessionKey: plan.route.sessionKey }).find((t) => t.name === 'agentui_image');
          ro.onAgentRunStart?.('oc-run');
          const run = (images) => tool.execute('ti', { images }).then((r) => JSON.parse(r.content[0].text), (e) => ({ error: e.message }));
          const text = join(imgDir, 'not-an-image.png');
          writeFileSync(text, 'this is text');
          const png = join(imgDir, 'vrai.png');
          writeFileSync(png, Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32)]));
          toolRuns.push(
            await run([{ src: 'https://exemple.org/a.jpg', caption: 'Externe' }, { src: png }, { src: png }]),
            await run([{ src: text }]),
            await run([{ src: '/does/not/exist.png' }]),
            await run([{ src: 'relatif/a.png' }]),
            await run([{ src: 'javascript:alert(1)' }]),
          );
          ro.onAgentRunTerminalOutcome?.('completed');
          return { dispatched: true };
        }
        if (input.rawText.startsWith('/approve')) return { dispatched: true };
        const key = `${plan.route.agentId}|${plan.route.sessionKey}`;
        if (input.rawText.startsWith('/model')) {
          // Control command: the gateway replies with a text, and sets the model choice on the session
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
        emitAgent({ runId: 'oc-run', stream: 'thinking', data: { delta: 'I am thinking' } });
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
    const t = setTimeout(() => reject(new Error(`timed out; frames: ${JSON.stringify(frames.slice(-5))}`)), ms);
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

// ── Account start (real gateway.startAccount) ──────────────────────────
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

test('full run: streaming, tools (agent events), reasoning, final, media, end', async () => {
  send({ type: 'inbound', conversationId: 'c1', runId: 'r1', text: 'liste' });
  const ev = eventsOf(await until(isTerminal('r1')), 'r1');
  const types = ev.map((e) => e.type);
  assert.deepEqual(types.slice(0, 3), ['message.delta', 'message.delta', 'message.delta']);
  assert.deepEqual(ev.find((e) => e.type === 'tool.started'), { type: 'tool.started', id: 't1', name: 'exec', args: { command: 'ls' } });
  assert.ok(!ev.some((e) => e.id === 'zz'), 'event of another run ignored');
  assert.equal(ev.find((e) => e.type === 'tool.completed').result, 'a.txt');
  assert.equal(ev.find((e) => e.type === 'reasoning.delta').text, 'I am thinking');
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

test('multiple threads: one conversationId = one direct peer = one session', async () => {
  send({ type: 'inbound', conversationId: 'c2', runId: 'r2', text: 'liste' });
  await until(isTerminal('r2'));
  // turn routes (no agent imposed): reading the consumption at the end of a run resolves others, per agent
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

test('approval: approval.request then /approve <id> allow-always', async () => {
  send({ type: 'inbound', conversationId: 'c3', runId: 'r3', text: 'approve' });
  const fs = await until(isTerminal('r3'));
  const req = eventsOf(fs, 'r3').find((e) => e.type === 'approval.request');
  assert.equal(req.id, 'ap1');
  assert.match(req.description, /rm -rf build/);
  send({ type: 'approval', conversationId: 'c3', runId: 'r3', id: 'ap1', approve: true, scope: 'always' });
  for (let i = 0; i < 100 && turns.at(-1).input.rawText !== '/approve ap1 allow-always'; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(turns.at(-1).input.rawText, '/approve ap1 allow-always');
  assert.equal(routes.at(-1).peer.id, 'c3', 'command sent in the same chat');
});

test('ask_user: ask widget, the reply answer unblocks the tool in the running run', async () => {
  send({ type: 'inbound', conversationId: 'ca', runId: 'ra', text: 'ask' });
  const fs = await until((f) => f.type === 'event' && f.runId === 'ra' && f.event.type === 'message.final');
  const text = eventsOf(fs, 'ra').find((e) => e.type === 'message.final').text;
  const asked = eventsOf(fs, 'ra').filter((e) => e.type === 'question.requested');
  assert.deepEqual(asked, [{ type: 'question.requested', id: `ask_${'a'.repeat(32)}` }], 'announced before the prompt');
  assert.doesNotMatch(text, /Reply with the number/);
  const w = JSON.parse(/```widget\n(.*)\n```/s.exec(text)[1]);
  assert.equal(w.type, 'ask');
  assert.deepEqual(w.arguments.options, ['Option A', 'Option B']);
  assert.match(w.arguments.question, /What do you want to answer/);
  assert.match(w.arguments.question, /\*\*Option A\*\* — First/); // option description
  const turnsBefore = turns.length;
  send({ type: 'reply', conversationId: 'ca', runId: 'ra', text: '2' });
  const ev = eventsOf(await until(isTerminal('ra')), 'ra');
  assert.deepEqual(ev.filter((e) => e.type === 'question.resolved'), [{ type: 'question.resolved', id: `ask_${'a'.repeat(32)}` }], 'only once (answer then end of the tool)');
  assert.deepEqual(answers.at(-1), { answers: { q: ['Option B'] } }); // "2" → the 2nd option
  assert.equal(ev.at(-1).type, 'run.completed');
  assert.deepEqual(gatewayCalls.slice(-2).map((c) => [c.method, c.params.id]), [['question.get', `ask_${'a'.repeat(32)}`], ['question.resolve', `ask_${'a'.repeat(32)}`]]);
  assert.equal(turns.length, turnsBefore, 'the question is resolved by the gateway: no message injected into the session');
});

test('ask_user with several questions: form, answers renumbered for the core', async () => {
  send({ type: 'inbound', conversationId: 'cm', runId: 'rm', text: 'ask-multi' });
  const fs = await until((f) => f.type === 'event' && f.runId === 'rm' && f.event.type === 'message.final');
  const text = eventsOf(fs, 'rm').find((e) => e.type === 'message.final').text;
  const w = JSON.parse(/```widget\n(.*)\n```/s.exec(text)[1]);
  assert.equal(w.type, 'form');
  assert.deepEqual(w.arguments.fields.map((f) => [f.label, f.kind]), [['Which color? (red: bright)', 'select'], ['Which size?', 'text']]);
  send({ type: 'reply', conversationId: 'cm', runId: 'rm', text: 'Which color? (red: bright): Blue\nWhich size?: —' });
  await until(isTerminal('rm'));
  assert.deepEqual(answers.at(-1), { answers: { color: ['Blue'], size: [] } });
});

test('ask_user: answer conversion (number, label, free text, multi-select, invalid)', async () => {
  const { buildQuestionAnswers } = await import('../dist/src/question.js');
  const opts = [{ label: 'Red' }, { label: 'Blue' }];
  const one = (q, text) => buildQuestionAnswers([{ questionId: 'q', ...q }], text).answers.q;
  assert.deepEqual(one({ options: opts }, '2'), ['Blue']);
  assert.deepEqual(one({ options: opts }, 'red'), ['Red']);
  assert.deepEqual(one({ options: opts, isOther: true }, 'Green'), ['Green']);
  assert.throws(() => one({ options: opts }, 'Green'), /any option/);
  assert.deepEqual(one({}, 'texte libre'), ['texte libre']);
  assert.deepEqual(one({ options: opts, multiSelect: true }, '1, blue, 1'), ['Red', 'Blue']);
  assert.deepEqual(buildQuestionAnswers([{ questionId: 'a', options: opts }, { questionId: 'b' }], '1: Blue\n2: ').answers, { a: ['Blue'], b: [] });
});

test('abort: abortSignal triggered, run.aborted', async () => {
  send({ type: 'inbound', conversationId: 'c4', runId: 'r4', text: 'long' });
  await new Promise((r) => setTimeout(r, 100));
  send({ type: 'abort', conversationId: 'c4', runId: 'r4' });
  const ev = eventsOf(await until(isTerminal('r4')), 'r4');
  assert.equal(ev.at(-1).type, 'run.aborted');
  assert.equal(turns.at(-1).plan.replyOptions.abortSignal.aborted, true);
});

test('proactive messages: outbound.sendText / sendMedia', async () => {
  const send = agentUIPlugin.outbound.attachedResults;
  await send.sendText({ cfg, to: 'home', text: 'Reminder: meeting at 2 pm', accountId: 'default' });
  await send.sendMedia({ cfg, to: 'c1', text: 'Le graphique', mediaUrl: imgPath, accountId: 'default' });
  const fs = await until((f) => f.type === 'outbound' && f.conversationId === 'c1');
  const outs = fs.filter((f) => f.type === 'outbound');
  assert.equal(outs[0].text, 'Reminder: meeting at 2 pm');
  assert.equal(outs[0].conversationId, undefined);
  assert.equal(outs[1].media[0].name, 'chart.png');
});

test('cron tasks: scheduler service + listJobs / jobAction RPCs', async () => {
  const entry = (await import('../dist/index.js')).default;
  let service;
  entry.registerFull({ registerService: (svc) => (service = svc), registerTool: () => {} });
  const calls = [];
  const jobs = [{ id: 'j1', name: 'report', enabled: true, schedule: { kind: 'every', everyMs: 3_600_000 }, payload: { message: 'Do the report' }, state: { nextRunAtMs: 1, lastStatus: 'ok' } }];
  service.start({
    getCron: () => ({
      list: async (opts) => (calls.push(['list', opts]), jobs),
      update: async (id, patch) => calls.push(['update', id, patch]),
      remove: async (id) => calls.push(['remove', id]),
      enqueueRun: async (id, mode) => calls.push(['run', id, mode]),
    }),
  });
  const list = await rpc('listJobs', {});
  assert.deepEqual(list.result, [{ id: 'j1', name: 'report', schedule: 'every 1 h', mode: 'agent', prompt: 'Do the report', enabled: true, nextRunAt: 1, lastStatus: 'ok', running: false, queued: false }]);
  assert.deepEqual((await rpc('jobAction', { jobId: 'j1', action: 'pause' })).result, { ok: true });
  await rpc('jobAction', { jobId: 'j1', action: 'run' });
  await rpc('jobAction', { jobId: 'j1', action: 'delete' });
  assert.deepEqual(calls.slice(1), [['update', 'j1', { enabled: false }], ['run', 'j1', 'force'], ['remove', 'j1']]);
  assert.match((await rpc('jobAction', { jobId: 'j1', action: 'bogus' })).error, /unknown action/);
  service.stop();
  assert.match((await rpc('listJobs', {})).error, /unavailable/);
  assert.equal(hello.capabilities.jobs, true);
});

test('interactive tools: widget before the answer, reply → tool result, run continued', async () => {
  send({ type: 'inbound', conversationId: 'ct', runId: 'rt', text: 'tool-ask' });
  const fs = await until((f) => f.type === 'event' && f.runId === 'rt' && f.event.type === 'question.requested');
  const id = eventsOf(fs, 'rt').find((e) => e.type === 'question.requested').id;
  const more = await until((f) => f.type === 'event' && f.runId === 'rt' && f.event.type === 'message.delta' && f.event.text.includes('```widget'));
  const text = eventsOf(more, 'rt').find((e) => e.text?.includes('```widget')).text;
  const w = JSON.parse(/```widget\n(.*)\n```/s.exec(text)[1]);
  assert.deepEqual(w, { type: 'ask', arguments: { question: 'Which color?', options: ['Red', 'Blue'] } });
  assert.ok(text.startsWith('\n\n'), 'separated from the text already written');
  send({ type: 'reply', conversationId: 'ct', runId: 'rt', text: 'Blue' });
  const ev = eventsOf(await until(isTerminal('rt')), 'rt');
  assert.deepEqual(ev.filter((e) => e.type === 'question.resolved'), [{ type: 'question.resolved', id }]);
  assert.deepEqual(toolRuns.at(-1), { answer: 'Blue' });
  assert.equal(ev.at(-1).type, 'run.completed');
  assert.equal(ev.find((e) => e.type === 'message.final')?.text.includes('Merci.'), true);
});

test('interactive tools: stop while waiting, invalid arguments', async () => {
  send({ type: 'inbound', conversationId: 'cu', runId: 'ru', text: 'tool-confirm' });
  await until((f) => f.type === 'event' && f.runId === 'ru' && f.event.type === 'question.requested');
  send({ type: 'abort', conversationId: 'cu', runId: 'ru' });
  await until(isTerminal('ru'));
  assert.match(toolRuns.at(-1).error, /interrupted/);
  send({ type: 'inbound', conversationId: 'cv', runId: 'rv', text: 'tool-form' });
  await until(isTerminal('rv'));
  assert.match(toolRuns.at(-1).error, /twice/);
});

test('agentui_image: copies a local file into message.media, mapping in the result, readable rejections', async () => {
  send({ type: 'inbound', conversationId: 'ci', runId: 'ri', text: 'img-widget' });
  const ev = eventsOf(await until(isTerminal('ri')), 'ri');
  const media = ev.filter((e) => e.type === 'message.media');
  assert.equal(media.length, 1, 'the same file cited twice is copied only once; the external URL is not copied');
  assert.match(media[0].name, /^agentui-img-[0-9a-f]{8}-/);
  assert.equal(media[0].mimeType, 'image/png');
  const [ok, notImage, missing, relative, scheme] = toolRuns.slice(-5);
  assert.deepEqual(Object.values(ok.files), [media[0].name]);
  assert.match(ok.widget, /^\[\[agentui:[0-9a-f]{6}\]\]$/);
  assert.match(notImage.error, /is not a png, jpeg, gif or webp image/);
  assert.match(missing.error, /not found/);
  assert.match(relative.error, /absolute path/);
  assert.match(scheme.error, /absolute path/);
});

test('widget tools: agentui_chart / map / code, reserved for AgentUI runs', async () => {
  const entry = (await import('../dist/index.js')).default;
  let factory, opts;
  entry.registerFull({ registerService: () => {}, registerTool: (f, o) => ((factory = f), (opts = o)) });
  assert.deepEqual(opts.names, ['agentui_chart', 'agentui_map', 'agentui_code', 'agentui_table', 'agentui_progress', 'agentui_image', 'agentui_ask', 'agentui_confirm', 'agentui_form', ...['guide', 'create', 'write', 'read', 'list', 'delete_file', 'remove', 'logs', 'data'].map((k) => `agentui_app_${k}`)]);
  // The manifest declares exactly these tools (contracts.tools), otherwise OpenClaw warns at load
  assert.deepEqual(JSON.parse(readFileSync(new URL('../openclaw.plugin.json', import.meta.url), 'utf8')).contracts.tools, opts.names);
  assert.equal(factory({ messageChannel: 'telegram' }), null);
  const tools = factory({ messageChannel: 'agentui' });
  assert.deepEqual(tools.map((t) => t.name), opts.names);
  assert.deepEqual(tools[0].parameters.required, ['kind', 'x', 'series']);
  const ok = await tools[0].execute('t1', { kind: 'bar', x: ['a', 'b'], series: [{ name: 's', y: [1, 2] }] });
  const token = ok.details.token;
  assert.match(token, /^\[\[agentui:[0-9a-f]{6}\]\]$/);
  assert.equal(JSON.parse(ok.content[0].text).widget, token);
  await assert.rejects(tools[0].execute('t2', { kind: 'bar', x: ['a', 'b'], series: [{ name: 's', y: [1] }] }), /must have 2 values/);
  await assert.rejects(tools[0].execute('t3', { kind: 'pie', x: ['a'], series: [{ name: 's', y: [1] }, { name: 't', y: [2] }] }), /pie chart/);
  await assert.rejects(tools[1].execute('t4', { points: [] }), /At least one point/);
  await assert.rejects(tools[2].execute('t5', { code: ' ' }), /empty/);
  const table = tools.find((t) => t.name === 'agentui_table');
  const okTable = await table.execute('t6', { columns: [{ label: 'A' }, { label: 'B', kind: 'number' }], rows: [['x', 1], ['y', null]] });
  assert.match(okTable.details.token, /^\[\[agentui:[0-9a-f]{6}\]\]$/);
  await assert.rejects(table.execute('t7', { columns: [{ label: 'A' }, { label: 'B' }], rows: [['x']] }), /Row 1 has 1 values, 2 are needed/);
  const progress = tools.find((t) => t.name === 'agentui_progress');
  const steps = [{ label: 'A', status: 'running' }, { label: 'B', status: 'pending' }];
  const created = await progress.execute('t9', { steps });
  const pToken = created.details.token;
  assert.match(pToken, /^\[\[agentui:[0-9a-f]{6}\]\]$/);
  const updated = JSON.parse((await progress.execute('t10', { update: pToken, steps: [{ label: 'A', status: 'done' }, { label: 'B', status: 'running' }] })).content[0].text);
  assert.deepEqual([updated.widget, updated.updated], [pToken, true], 'an update returns the same token');
  await assert.rejects(progress.execute('t11', { update: 'abc', steps }), /must be the/);
  await assert.rejects(table.execute('t8', { columns: [{ label: 'A' }], rows: [[{ a: 1 }]] }), /neither text/);
});

test('app tools: guide is local, other operations go through app.op / app.result', async () => {
  const entry = (await import('../dist/index.js')).default;
  let factory;
  entry.registerFull({ registerService: () => {}, registerTool: (f) => (factory = f) });
  const tools = factory({ messageChannel: 'agentui' });
  const byName = (n) => tools.find((t) => t.name === `agentui_app_${n}`);
  const guide = JSON.parse((await byName('guide').execute('g1', {})).content[0].text).guide;
  assert.match(guide, /Building apps for AgentUI/);
  const call = byName('write').execute('w1', { id: 'todo', files: [{ path: 'src/main.tsx', content: 'x' }] });
  const [frame] = (await until((f) => f.type === 'app.op')).slice(-1);
  assert.deepEqual([frame.op, frame.args.id], ['write', 'todo']);
  send({ type: 'app.result', id: frame.id, ok: true, result: { ok: false, errors: [{ file: 'src/main.tsx', line: 1, message: 'boom' }] } });
  assert.equal(JSON.parse((await call).content[0].text).errors[0].message, 'boom');
  const failing = byName('remove').execute('r1', { id: 'todo' });
  const [f2] = (await until((f) => f.type === 'app.op')).slice(-1);
  send({ type: 'app.result', id: f2.id, ok: false, error: 'Unknown app "todo".' });
  await assert.rejects(failing, /Unknown app/);
});

test('deletion: deleteSession erases the session of each agent (one chat = one direct peer)', async () => {
  assert.equal(hello.capabilities.sessionDelete, true);
  deletedKeys.length = 0;
  // Sessions cannot be listed by a channel: the candidate keys resolved for the chat are erased.
  assert.deepEqual((await rpc('deleteSession', { conversationId: 'c7' })).result, { ok: true });
  assert.deepEqual(deletedKeys, ['agent:main:agentui:direct:c7', 'agent:coder:agentui:direct:c7']);
});

test('deletion: refused while a run is in progress in the chat', async () => {
  send({ type: 'inbound', conversationId: 'c8', runId: 'r8', text: 'long' });
  await new Promise((r) => setTimeout(r, 100));
  deletedKeys.length = 0;
  assert.match((await rpc('deleteSession', { conversationId: 'c8' })).error, /run is in progress/);
  assert.deepEqual(deletedKeys, []);
  send({ type: 'abort', conversationId: 'c8', runId: 'r8' });
  await until(isTerminal('r8'));
});

test('model: list, consumption, change via /model -s, refusal, run in progress', async () => {
  assert.equal(hello.capabilities.models, true);
  // provider models + allow list + agents' default models, without duplicates
  const models = (await rpc('listModels', {})).result;
  assert.deepEqual(models.map((m) => `${m.provider}/${m.id}`).sort(), ['anthropic/claude', 'deepseek/deepseek-flash', 'deepseek/deepseek-v4-pro']);
  assert.deepEqual(models.find((m) => m.id === 'deepseek-flash'), { provider: 'deepseek', providerName: 'Deepseek', id: 'deepseek-flash' });

  // end of run: the session's consumption precedes run.completed
  send({ type: 'inbound', conversationId: 'cm', runId: 'rm', text: 'liste' });
  const kinds = eventsOf(await until(isTerminal('rm')), 'rm').map((e) => e.type);
  assert.ok(kinds.includes('usage') && kinds.indexOf('usage') < kinds.indexOf('run.completed'), kinds.join());
  assert.deepEqual((await rpc('sessionUsage', { conversationId: 'cm' })).result, { inputTokens: 1200, outputTokens: 340, model: 'deepseek-flash', provider: 'deepseek' });
  assert.equal((await rpc('sessionUsage', { conversationId: 'unknown' })).result, null);
  assert.equal((await rpc('sessionUsage', { conversationId: 'cm', subAgentId: 'coder' })).result, null, 'session of another agent');

  // model change: /model <provider/model> -s command, reply collected (not displayed), state re-read
  const set = (await rpc('setModel', { conversationId: 'cm', model: 'deepseek-v4-pro', provider: 'deepseek' })).result;
  assert.deepEqual(set, { model: 'deepseek-v4-pro', provider: 'deepseek', message: 'Model set to deepseek/deepseek-v4-pro (session only)' });
  assert.equal(turns.at(-1).input.rawText, '/model deepseek/deepseek-v4-pro -s');
  assert.equal((await rpc('sessionUsage', { conversationId: 'cm' })).result.model, 'deepseek-v4-pro');
  // refusal: OpenClaw's text is relayed, the session keeps its model
  assert.match((await rpc('setModel', { conversationId: 'cm', model: 'refuse-me' })).error, /Model not allowed/);
  assert.equal((await rpc('sessionUsage', { conversationId: 'cm' })).result.model, 'deepseek-v4-pro');
  assert.ok((await rpc('setModel', { conversationId: 'cm' })).error, 'missing parameters');
  // no change during a reply
  send({ type: 'inbound', conversationId: 'cl', runId: 'rl', text: 'long' });
  await new Promise((r) => setTimeout(r, 100));
  assert.match((await rpc('setModel', { conversationId: 'cl', model: 'deepseek-flash' })).error, /run is in progress/);
  send({ type: 'abort', conversationId: 'cl', runId: 'rl' });
  await until(isTerminal('rl'));
});

test('account shutdown', async () => {
  abort.abort();
  await started;
});

test('send outside the gateway (CLI, isolated cron): one-off send-only connection', async () => {
  await agentUIPlugin.outbound.attachedResults.sendText({ cfg, to: 'c9', text: 'From the CLI', accountId: 'default' });
  const fs = await until((f) => f.type === 'outbound' && f.conversationId === 'c9');
  assert.equal(fs.at(-1).text, 'From the CLI');
  assert.equal(hello.mode, 'send-only');
  wss.close();
});
