// Envoie un message et journalise tous les événements reçus. Usage : node scripts/openclaw-chat-spike.mjs wss://hote "message"
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync('.env', 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const token = env.OPENCLAW_TOKEN, b64u = (b) => Buffer.from(b).toString('base64url');
const PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const { publicKeyPem, privateKeyPem } = JSON.parse(readFileSync('data/openclaw-device.json', 'utf8'));
const raw = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' }).subarray(PREFIX.length);
const deviceId = crypto.createHash('sha256').update(raw).digest('hex');
const CLIENT = { id: 'cli', mode: 'cli', platform: 'linux', version: '0.1.0' }, SCOPES = ['operator.read', 'operator.write', 'operator.admin'];
const sessionKey = `agent:main:agentui:${crypto.randomUUID()}`;
const ws = new WebSocket(process.argv[2]); const t0 = Date.now();
const mask = (s) => s.split(token).join('<TOKEN>');
ws.onclose = (e) => { console.log('CLOSE', e.code); process.exit(0); };
ws.onmessage = (m) => {
  const f = JSON.parse(m.data);
  if (f.event === 'connect.challenge') {
    const signedAt = Date.now(), nonce = f.payload.nonce;
    const payload = ['v3', deviceId, CLIENT.id, CLIENT.mode, 'operator', SCOPES.join(','), String(signedAt), token, nonce, CLIENT.platform, ''].join('|');
    ws.send(JSON.stringify({ type: 'req', id: '1', method: 'connect', params: { minProtocol: 4, maxProtocol: 4, client: CLIENT, role: 'operator', scopes: SCOPES, caps: ['tool-events'], auth: { token },
      device: { id: deviceId, publicKey: b64u(raw), signature: b64u(crypto.sign(null, Buffer.from(payload), crypto.createPrivateKey(privateKeyPem))), signedAt, nonce } } }));
    return;
  }
  if (f.id === '1') {
    if (!f.ok) { console.log('connect KO', JSON.stringify(f.error)); process.exit(1); }
    ws.send(JSON.stringify({ type: 'req', id: '2', method: 'sessions.subscribe', params: {} }));
    ws.send(JSON.stringify({ type: 'req', id: '3', method: 'sessions.messages.subscribe', params: { key: sessionKey } }));
    ws.send(JSON.stringify({ type: 'req', id: '4', method: 'chat.send', params: { sessionKey, message: process.argv[3], idempotencyKey: crypto.randomUUID() } }));
    return;
  }
  if (['tick', 'health', 'heartbeat', 'presence'].includes(f.event)) return;
  console.log(`+${Date.now() - t0}ms`, mask(JSON.stringify(f)).slice(0, 900));
};
setTimeout(() => { console.log('fin'); process.exit(0); }, 45000);
console.log('sessionKey', sessionKey);
