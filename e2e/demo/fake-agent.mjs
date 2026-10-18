// Fake channel plugin for the presentation site captures: it connects to AgentUI (/gateway) like Hermes or
// OpenClaw and plays scripted replies with real `agentui_<widget>` tool calls.
//   node e2e/demo/fake-agent.mjs ws://localhost:8080/gateway <token> [name]
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';

const [url, token, name = 'Atlas'] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = () => randomBytes(3).toString('hex');

const ws = new WebSocket(url);
const send = (o) => ws.send(JSON.stringify(o));
ws.on('open', () => send({
  type: 'hello', protocol: 1, token, agent: { type: 'demo', name, version: '1.0' },
  capabilities: { sessions: true, abort: true, approvals: false, subagents: false, reasoning: true, toolDetails: true, skills: false, jobs: true, jobControl: true, sessionDelete: false, models: false, attachments: { images: true, files: true, maxBytes: 20971520 } },
}));

import { DEMO_MINIAPPS } from './miniapps.mjs';
import * as fr from './content.fr.mjs';
import * as en from './content.en.mjs';

// DEMO_LANG=en plays the English content (captures for docs/en/); French by default.
const { JOBS, CRON_MESSAGES, SCENARIOS, FALLBACK, REASONING, ACK } = process.env.DEMO_LANG === 'en' ? en : fr;

// Miniapps: created like a real plugin does, with `miniapp.op` frames (the server answers with `miniapp.result`).
const pending = new Map();
const miniappOp = (op, args) => new Promise((resolve) => { const id = `m${hex()}${hex()}`; pending.set(id, resolve); send({ type: 'miniapp.op', id, op, args }); });
async function createMiniapps() {
  for (const a of DEMO_MINIAPPS(process.env.DEMO_LANG)) {
    const c = await miniappOp('create', { id: a.id, name: a.name, icon: a.icon, description: a.description });
    const w = await miniappOp('write', { id: a.id, files: a.files });
    if (!c.ok || !w.ok || w.result?.ok === false) console.error('miniapp', a.id, JSON.stringify(c.error ?? w.error ?? w.result?.errors));
    for (const d of a.seed) await miniappOp('data', { id: a.id, action: 'insert', ...d });
  }
}

const widgetText = (type, args) => `\n\n\`\`\`widget\n${JSON.stringify({ type, arguments: args })}\n\`\`\`\n`;

async function play(conversationId, runId, text) {
  const ev = (event) => send({ type: 'event', conversationId, runId, event });
  const sc = SCENARIOS.find((s) => s.match.test(text)) ?? FALLBACK;
  ev({ type: 'reasoning.delta', text: REASONING });
  await sleep(300);
  let out = '';
  const say = async (t) => { for (const w of t.split(/(?<= )/)) { out += w; ev({ type: 'message.delta', text: w }); await sleep(12); } };
  await say(sc.intro);
  for (const [kind, args] of sc.tools ?? []) {
    const id = `t${hex()}`; const tok = `[[agentui:${hex()}]]`;
    ev({ type: 'tool.started', id, name: `agentui_${kind}`, args });
    await sleep(250);
    ev({ type: 'tool.completed', id, name: `agentui_${kind}`, result: JSON.stringify({ widget: tok }) });
    await say(`\n\n${tok}`);
  }
  if (sc.progress) {
    const id = `t${hex()}`; const tok = `[[agentui:${hex()}]]`;
    const steps = (done, detail) => sc.progress.steps.map(([label, d], i) => ({ label, status: i < done ? 'done' : i === done ? 'running' : 'pending', ...((i === done ? detail ?? d : d) ? { detail: i === done ? detail ?? d : d } : {}) }));
    ev({ type: 'tool.started', id, name: 'agentui_progress', args: { title: sc.progress.title, steps: steps(0) } });
    await sleep(150);
    ev({ type: 'tool.completed', id, name: 'agentui_progress', result: JSON.stringify({ widget: tok }) });
    await say(`\n\n${tok}\n\n`);
    for (let i = 1; i <= sc.progress.steps.length; i++) {
      await sleep(i === 3 ? 2200 : 900);
      const uid = `t${hex()}`;
      const args = { title: sc.progress.title, update: tok, steps: i === sc.progress.steps.length ? steps(i) : steps(i) };
      ev({ type: 'tool.started', id: uid, name: 'agentui_progress', args });
      ev({ type: 'tool.completed', id: uid, name: 'agentui_progress', result: JSON.stringify({ widget: tok, updated: true }) });
    }
  }
  if (sc.blocking) {
    const qid = `q${hex()}`;
    ev({ type: 'question.requested', id: qid });
    out += widgetText(...sc.blocking);
    ev({ type: 'message.delta', text: widgetText(...sc.blocking) });
    ev({ type: 'message.final', text: out });
    return; // the run stays open: the capture happens while waiting for the answer
  }
  if (sc.outro) await say(`\n\n${sc.outro}`);
  ev({ type: 'message.final', text: out });
  ev({ type: 'run.completed' });
}

ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === 'miniapp.result') pending.get(m.id)?.(m);
  else if (m.type === 'welcome') { void createMiniapps(); CRON_MESSAGES.forEach((c, i) => setTimeout(() => send({ type: 'outbound', id: `o${hex()}`, ...c }), 600 + i * 400)); }
  else if (m.type === 'ping') send({ type: 'pong' });
  else if (m.type === 'inbound') void play(m.conversationId, m.runId, m.text);
  else if (m.type === 'reply') { send({ type: 'event', conversationId: m.conversationId, runId: m.runId, event: { type: 'message.final', text: ACK } }); send({ type: 'event', conversationId: m.conversationId, runId: m.runId, event: { type: 'run.completed' } }); }
  else if (m.type === 'rpc') send(m.method === 'listJobs' ? { type: 'rpc.result', id: m.id, result: JOBS } : { type: 'rpc.result', id: m.id, error: 'not supported' });
});
ws.on('close', () => process.exit(0));
