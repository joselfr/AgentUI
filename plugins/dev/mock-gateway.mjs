#!/usr/bin/env node
// Faux AgentUI pour tester un plugin canal sans l'app (protocole : ../protocol/PROTOCOL.md).
//
//   AGENTUI_TOKEN=dev node plugins/dev/mock-gateway.mjs [--port 8790]
//
// Puis, dans le terminal :
//   <texte>                 envoie un message dans la discussion courante
//   /conv <id>              change de discussion (= nouveau fil côté agent)
//   /new                    nouvelle discussion
//   /agent [nom]            liste les agents connectés / choisit la cible
//   /attach <fichier>       joint un fichier au prochain message
//   /abort                  arrête le run en cours
//   /approve [once|session|always] | /deny   répond à la dernière demande d'approbation
//   /rpc <méthode> [json]   appel RPC (sans paramètres, deleteSession vise la discussion courante)
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
const agents = new Map(); // nom d'agent → WebSocket (comme le vrai AgentUI : une connexion par agent)
let target = null; // agent qui reçoit les messages tapés (/agent <nom>)
let conv = `c_${randomUUID().slice(0, 8)}`;
let currentRun = null;
let lastApproval = null;
let pendingAttachments = [];
let streaming = false;
const rpcs = new Map();

const current = () => agents.get(target) ?? [...agents.values()][0];
const send = (msg) => {
  const ws = current();
  ws ? ws.send(JSON.stringify(msg)) : console.log(color(31, 'aucun plugin connecté'));
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
      return console.log(`${tag} ${color(33, '⚠️  approbation ' + e.id)} ${e.description}  ${dim('(/approve ou /deny)')}`);
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
      if (msg.token !== token) return ws.close(4001, 'token invalide');
      if (msg.protocol !== 1) return ws.close(4002, 'protocole non supporté');
      authed = true;
      if (msg.mode === 'send-only') {
        ws.send(JSON.stringify({ type: 'welcome', protocol: 1 }));
        return console.log(dim(`● ${msg.agent.name} : connexion d'envoi ponctuelle`));
      }
      name = msg.agent.name;
      agents.get(name)?.close(4000, 'remplacé');
      agents.set(name, ws);
      target ??= name;
      ws.send(JSON.stringify({ type: 'welcome', protocol: 1 }));
      console.log(color(32, `● ${msg.agent.name} (${msg.agent.type} ${msg.agent.version ?? ''}) connecté`), dim(JSON.stringify(msg.capabilities)));
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
    if (name && agents.get(name) === ws) agents.delete(name), console.log(color(31, `● ${name} déconnecté (${code} ${reason})`));
  });
});
setInterval(() => agents.forEach((ws) => ws.send(JSON.stringify({ type: 'ping' }))), 30_000).unref();

console.log(`Faux AgentUI sur ws://127.0.0.1:${port}/gateway (token « ${token} »). Discussion courante : ${conv}`);
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
  if (cmd === '/new') return (conv = `c_${randomUUID().slice(0, 8)}`), console.log(`discussion ${conv}`);
  if (cmd === '/conv') return (conv = arg || conv), console.log(`discussion ${conv}`);
  if (cmd === '/attach') {
    const data = readFileSync(arg);
    const mimeType = /\.png$/i.test(arg) ? 'image/png' : /\.jpe?g$/i.test(arg) ? 'image/jpeg' : /\.pdf$/i.test(arg) ? 'application/pdf' : 'text/plain';
    pendingAttachments.push({ name: basename(arg), mimeType, data: data.toString('base64') });
    return console.log(dim(`${basename(arg)} sera joint au prochain message`));
  }
  if (cmd === '/abort') return currentRun ? send({ type: 'abort', ...currentRun }) : console.log('aucun run');
  if (cmd === '/approve' || cmd === '/deny') {
    if (!lastApproval) return console.log('aucune approbation en attente');
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
        return console.log('paramètres JSON invalides');
      }
    } else if (method === 'deleteSession') {
      params = { conversationId: conv }; // la discussion courante, pour éprouver la suppression
    }
    const id = randomUUID();
    rpcs.set(id, method);
    return send({ type: 'rpc', id, method, ...(params ? { params } : {}) });
  }
  currentRun = { conversationId: conv, runId: `r_${randomUUID().slice(0, 8)}` };
  send({ type: 'inbound', ...currentRun, text: line, ...(pendingAttachments.length ? { attachments: pendingAttachments } : {}) });
  pendingAttachments = [];
});
