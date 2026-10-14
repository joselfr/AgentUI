// Liste (ou supprime avec --delete) les sessions OpenClaw créées par AgentUI (clé agent:*:agentui:*).
// Usage : node scripts/openclaw-cleanup.mjs wss://hote [--delete] [--except=<clé>,<clé>]
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync('.env', 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const token = env.OPENCLAW_TOKEN, b64u = (b) => Buffer.from(b).toString('base64url');
const doDelete = process.argv.includes('--delete');
const except = (process.argv.find((a) => a.startsWith('--except=')) ?? '').slice(9).split(',').filter(Boolean);
const PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const { publicKeyPem, privateKeyPem } = JSON.parse(readFileSync('data/openclaw-device.json', 'utf8'));
const raw = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' }).subarray(PREFIX.length);
const deviceId = crypto.createHash('sha256').update(raw).digest('hex');
const C = { id: 'cli', mode: 'cli', platform: 'linux', version: '0.1.0' }, SC = ['operator.read', 'operator.write', 'operator.admin'];
const ws = new WebSocket(process.argv[2]); let n = 1; const pend = new Map();
const rpc = (method, params = {}) => new Promise((r) => { const id = String(++n); pend.set(id, r); ws.send(JSON.stringify({ type: 'req', id, method, params })); });
ws.onmessage = async (m) => {
  const f = JSON.parse(m.data);
  if (f.event === 'connect.challenge') {
    const at = Date.now(), nonce = f.payload.nonce;
    const pl = ['v3', deviceId, C.id, C.mode, 'operator', SC.join(','), String(at), token, nonce, C.platform, ''].join('|');
    ws.send(JSON.stringify({ type: 'req', id: 'c', method: 'connect', params: { minProtocol: 4, maxProtocol: 4, client: C, role: 'operator', scopes: SC, auth: { token },
      device: { id: deviceId, publicKey: b64u(raw), signature: b64u(crypto.sign(null, Buffer.from(pl), crypto.createPrivateKey(privateKeyPem))), signedAt: at, nonce } } }));
  } else if (f.id === 'c') {
    if (!f.ok) { console.log('connect KO', f.error?.message); process.exit(1); }
    const r = await rpc('sessions.list', { limit: 1000 });
    const all = r.payload.sessions ?? [];
    const mine = all.filter((s) => /^agent:[^:]+:agentui:/.test(s.key));
    console.log(`${all.length} sessions au total, ${mine.length} créées par AgentUI`);
    for (const s of mine) {
      const skip = except.includes(s.key);
      const when = new Date(s.updatedAt ?? 0).toLocaleTimeString("fr-FR"); let line = `${when} ${skip ? 'GARDE   ' : doDelete ? 'SUPPRIME' : 'trouvée '} ${s.key.slice(-12)} | ${(s.displayName ?? '').slice(0, 55)}`;
      if (doDelete && !skip) { const d = await rpc('sessions.delete', { key: s.key, deleteTranscript: true }); line += d.ok ? ' ✓' : ` ✗ ${d.error?.message}`; }
      console.log(line);
    }
    process.exit(0);
  } else if (pend.has(f.id)) { pend.get(f.id)(f); pend.delete(f.id); }
};
setTimeout(() => { console.log('timeout'); process.exit(1); }, 60000);
