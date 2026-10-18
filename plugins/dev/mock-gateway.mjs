#!/usr/bin/env node
// Fake AgentUI to test a channel plugin without the app (protocol: ../protocol/PROTOCOL.md).
//
//   AGENTUI_TOKEN=dev node plugins/dev/mock-gateway.mjs [--port 8790]
//
// Then, in the terminal:
//   <text>                 sends a message in the current chat
//   /conv <id>              switches chat (= new thread on the agent side)
//   /new                    new chat
//   /agent [name]           lists the connected agents / picks the target
//   /attach <file>         attaches a file to the next message
//   /abort                  stops the running run
//   /approve [once|session|always] | /deny   answers the last approval request
//   /rpc <method> [json]   RPC call (without parameters, deleteSession targets the current chat)
//   /quit
import { createInterface } from 'node:readline';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';

const portArg = process.argv.indexOf('--port');
const port = Number((portArg > 0 && process.argv[portArg + 1]) || process.env.PORT || 8790);
const token = process.env.AGENTUI_TOKEN ?? 'dev';
const mediaDir = process.env.MEDIA_DIR ?? '/tmp/agentui-mock-media';
mkdirSync(mediaDir, { recursive: true });

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const color = (c, s) => `\x1b[${c}m${s}\x1b[0m`;
const agents = new Map(); // agent name → WebSocket (like the real AgentUI: one connection per agent)
let target = null; // agent that receives the typed messages (/agent <name>)
let conv = `c_${randomUUID().slice(0, 8)}`;
let currentRun = null;
let lastApproval = null;
let pendingAttachments = [];
let streaming = false;
const rpcs = new Map();

const current = () => agents.get(target) ?? [...agents.values()][0];
const send = (msg) => {
  const ws = current();
  ws ? ws.send(JSON.stringify(msg)) : console.log(color(31, 'no plugin connected'));
};
const endLine = () => streaming && (process.stdout.write('\n'), (streaming = false));

function onEvent({ conversationId, runId, event: e }) {
  const tag = dim(`[${conversationId}/${runId.slice(0, 6)}]`);
  if (e.type === 'message.delta') {
    if (!streaming) process.stdout.write(`${tag} `), (streaming = true);
    return process.stdout.write(e.text);
  }
  endLine();
  switch (e.type) {
    case 'message.final': return console.log(`${tag} ${color(1, 'final')} ${e.text}`);
    case 'reasoning.delta': return console.log(`${tag} ${dim('💭 ' + e.text)}`);
    case 'tool.started': return console.log(`${tag} ${color(36, '🔧 ' + e.name)} ${dim(JSON.stringify(e.args ?? {}).slice(0, 200))}`);
    case 'tool.completed': return console.log(`${tag} ${color(e.failed ? 31 : 32, '✓ ' + (e.name ?? e.id))} ${dim(String(e.result ?? '').slice(0, 200))}`);
    case 'message.media': {
      const file = join(mediaDir, `${Date.now()}-${basename(e.name)}`);
      writeFileSync(file, Buffer.from(e.data, 'base64'));
      return console.log(`${tag} 📎 ${e.name} (${e.mimeType}) → ${file}`);
    }
    case 'approval.request':
      lastApproval = { id: e.id, conversationId, runId };
      return console.log(`${tag} ${color(33, '⚠️  approval ' + e.id)} ${e.description}  ${dim('(/approve ou /deny)')}`);
    case 'run.completed': case 'run.failed': case 'run.aborted':
      if (currentRun?.runId === runId) currentRun = null;
      return console.log(`${tag} ${color(e.type === 'run.completed' ? 32 : 31, e.type)} ${e.error ?? ''}`);
    default: return console.log(`${tag} ${e.type} ${dim(JSON.stringify(e))}`);
  }
}

const wss = new WebSocketServer({ port, path: '/gateway' });
wss.on('connection', (ws) => {
  let authed = false;
  let name = null;
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return console.log(color(31, 'trame non JSON')); }
    if (!authed) {
      if (msg.type !== 'hello') return ws.close(4001, 'hello attendu');
      if (msg.token !== token) return ws.close(4001, 'invalid token');
      if (msg.protocol !== 1) return ws.close(4002, 'unsupported protocol');
      authed = true;
      if (msg.mode === 'send-only') {
        ws.send(JSON.stringify({ type: 'welcome', protocol: 1 }));
        return console.log(dim(`● ${msg.agent.name} : one-off send connection`));
      }
      name = msg.agent.name;
      agents.get(name)?.close(4000, 'replaced');
      agents.set(name, ws);
      target ??= name;
      ws.send(JSON.stringify({ type: 'welcome', protocol: 1 }));
      console.log(color(32, `● ${msg.agent.name} (${msg.agent.type} ${msg.agent.version ?? ''}) connected`), dim(JSON.stringify(msg.capabilities)));
      if (msg.subAgents?.length) console.log(dim(`  sous-agents : ${msg.subAgents.map((s) => s.id).join(', ')}`));
      if (msg.activeRuns?.length) console.log(dim(`  runs actifs : ${JSON.stringify(msg.activeRuns)}`));
      return;
    }
    if (msg.type === 'event') return onEvent(msg);
    if (msg.type === 'outbound') {
      endLine();
      console.log(color(35, `📨 proactif → ${msg.conversationId ?? '(maison)'}`), msg.text ?? '');
      for (const m of msg.media ?? []) onEvent({ conversationId: msg.conversationId ?? 'home', runId: 'outbound', event: { type: 'message.media', ...m } });
      return;
    }
    if (msg.type === 'rpc.result') return console.log(dim(`rpc ${rpcs.get(msg.id) ?? msg.id} →`), msg.error ?? JSON.stringify(msg.result));
    if (msg.type === 'pong') return;
    console.log(dim(`? ${JSON.stringify(msg)}`));
  });
  ws.on('close', (code, reason) => {
    if (name && agents.get(name) === ws) agents.delete(name), console.log(color(31, `● ${name} disconnected (${code} ${reason})`));
  });
});
setInterval(() => agents.forEach((ws) => ws.send(JSON.stringify({ type: 'ping' }))), 30_000).unref();

console.log(`Fake AgentUI on ws://127.0.0.1:${port}/gateway (token "${token}"). Current chat: ${conv}`);
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  const arg = rest.join(' ');
  if (!cmd) return;
  if (cmd === '/quit') process.exit(0);
  if (cmd === '/agent') {
    if (arg && agents.has(arg)) target = arg;
    return console.log(`agents : ${[...agents.keys()].map((n) => (n === (target ?? '') ? `[${n}]` : n)).join(' ')}`);
  }
  if (cmd === '/new') return (conv = `c_${randomUUID().slice(0, 8)}`), console.log(`chat ${conv}`);
  if (cmd === '/conv') return (conv = arg || conv), console.log(`chat ${conv}`);
  if (cmd === '/attach') {
    const data = readFileSync(arg);
    const mimeType = /\.png$/i.test(arg) ? 'image/png' : /\.jpe?g$/i.test(arg) ? 'image/jpeg' : /\.pdf$/i.test(arg) ? 'application/pdf' : 'text/plain';
    pendingAttachments.push({ name: basename(arg), mimeType, data: data.toString('base64') });
    return console.log(dim(`${basename(arg)} will be attached to the next message`));
  }
  if (cmd === '/abort') return currentRun ? send({ type: 'abort', ...currentRun }) : console.log('no run');
  if (cmd === '/approve' || cmd === '/deny') {
    if (!lastApproval) return console.log('no pending approval');
    send({ type: 'approval', ...lastApproval, approve: cmd === '/approve', ...(cmd === '/approve' ? { scope: arg || 'once' } : {}) });
    return (lastApproval = null);
  }
  if (cmd === '/rpc') {
    const [method, ...rest] = arg.split(/\s+/);
    let params;
    if (rest.length) {
      try {
        params = JSON.parse(rest.join(' '));
      } catch {
        return console.log('invalid JSON parameters');
      }
    } else if (method === 'deleteSession') {
      params = { conversationId: conv }; // the current chat, to exercise deletion
    }
    const id = randomUUID();
    rpcs.set(id, method);
    return send({ type: 'rpc', id, method, ...(params ? { params } : {}) });
  }
  currentRun = { conversationId: conv, runId: `r_${randomUUID().slice(0, 8)}` };
  send({ type: 'inbound', ...currentRun, text: line, ...(pendingAttachments.length ? { attachments: pendingAttachments } : {}) });
  pendingAttachments = [];
});
