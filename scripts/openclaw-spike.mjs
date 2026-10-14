// Spike protocole OpenClaw : handshake + appels de lecture. Usage : node scripts/openclaw-spike.mjs wss://hote [methode ...]
import crypto from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
const env = Object.fromEntries(readFileSync('.env', 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const token = env.OPENCLAW_TOKEN;
const b64u = (b) => Buffer.from(b).toString('base64url');
const PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

mkdirSync('data', { recursive: true });
const idFile = 'data/openclaw-device.json';
if (!existsSync(idFile)) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  writeFileSync(idFile, JSON.stringify({ publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }), privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) }), { mode: 0o600 });
}
const { publicKeyPem, privateKeyPem } = JSON.parse(readFileSync(idFile, 'utf8'));
const raw = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' }).subarray(PREFIX.length);
const deviceId = crypto.createHash('sha256').update(raw).digest('hex');

const CLIENT = { id: 'cli', mode: 'cli', platform: 'linux', version: '0.1.0' };
const ROLE = 'operator', SCOPES = ['operator.read', 'operator.write', 'operator.admin'];
const methods = process.argv.slice(3);
const mask = (s) => (token ? s.split(token).join('<TOKEN>') : s);
const ws = new WebSocket(process.argv[2]);
let n = 1; const pending = new Map();
const rpc = (method, params = {}) => new Promise((res) => { const id = String(++n); pending.set(id, res); ws.send(JSON.stringify({ type: 'req', id, method, params })); });
const show = (label, v) => console.log(`\n### ${label}\n` + mask(JSON.stringify(v, null, 1)).slice(0, 6000));

ws.onclose = (e) => { console.log('CLOSE', e.code, e.reason); process.exit(0); };
ws.onmessage = async (m) => {
  const f = JSON.parse(m.data);
  if (f.type === 'event' && f.event === 'connect.challenge') {
    const signedAt = Date.now(), nonce = f.payload.nonce;
    const payload = ['v3', deviceId, CLIENT.id, CLIENT.mode, ROLE, SCOPES.join(','), String(signedAt), token, nonce, CLIENT.platform, ''].join('|');
    const signature = b64u(crypto.sign(null, Buffer.from(payload), crypto.createPrivateKey(privateKeyPem)));
    ws.send(JSON.stringify({ type: 'req', id: '1', method: 'connect', params: { minProtocol: 4, maxProtocol: 4, client: CLIENT, role: ROLE, scopes: SCOPES, auth: { token },
      device: { id: deviceId, publicKey: b64u(raw), signature, signedAt, nonce }, caps: ['tool-events'], locale: 'fr-FR', userAgent: 'agentui-spike' } }));
  } else if (f.type === 'res' && f.id === '1') {
    if (process.env.FEATURES) { console.log(JSON.stringify(f.payload?.features)); process.exit(0); } show('connect', f);
    if (!f.ok) return;
    for (const meth of methods) show(meth, await rpc(meth.split(':')[0], meth.includes(':') ? JSON.parse(meth.slice(meth.indexOf(':') + 1)) : {}));
    process.exit(0);
  } else if (f.type === 'res' && pending.has(f.id)) { pending.get(f.id)(f); pending.delete(f.id); }
  else if (f.type === 'event' && process.env.EVENTS) console.log('event', f.event);
};
setTimeout(() => { console.log('timeout'); process.exit(0); }, 30000);
