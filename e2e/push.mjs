// E2E push. Le navigateur automatisé n'a pas accès au service push de Google : on simule
//  (1) le service push par un serveur HTTPS local qui reçoit la VRAIE requête de web-push,
//  (2) la livraison au service worker via CDP (ServiceWorker.deliverPushMessage).
// Usage : PUSH_CERT=c.pem PUSH_KEY=k.pem node e2e/push.mjs <baseUrl>   (serveur lancé avec NODE_TLS_REJECT_UNAUTHORIZED=0)
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import crypto from 'node:crypto';
const base = process.argv[2];
const env = Object.fromEntries(readFileSync('.env', 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const ok = [];
const check = (n, v, x = '') => { ok.push(v); console.log(`${v ? 'OK  ' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const b64u = (b) => Buffer.from(b).toString('base64url');

// (1) faux service push
const received = [];
const fake = createServer({ cert: readFileSync(process.env.PUSH_CERT), key: readFileSync(process.env.PUSH_KEY) }, (req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c));
  req.on('end', () => { received.push({ url: req.url, headers: req.headers, size: Buffer.concat(chunks).length }); res.writeHead(201).end(); });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const endpoint = `https://127.0.0.1:${fake.address().port}/push/abc`;
const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
const sub = { endpoint, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(crypto.randomBytes(16)) } };

const browser = await chromium.launch({ executablePath: process.env.BROWSER ?? '/usr/bin/chromium', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ permissions: ['notifications'], baseURL: base, locale: 'fr-FR' });
// Le navigateur de test ne peut pas créer d'abonnement réel : on fournit un abonnement vers le faux service.
await ctx.addInitScript((s) => {
  let current = null;
  PushManager.prototype.subscribe = async () => (current = { endpoint: s.endpoint, toJSON: () => s, unsubscribe: async () => ((current = null), true) });
  PushManager.prototype.getSubscription = async () => current;
}, sub);
const page = await ctx.newPage();
await page.goto('/');
await page.getByLabel('Utilisateur').fill(env.ADMIN_USER);
await page.getByLabel('Mot de passe').fill(env.ADMIN_PASSWORD);
await page.getByRole('button', { name: 'Se connecter' }).click();
await page.getByText('Nouvelle conversation').first().waitFor();

await page.getByRole('button', { name: 'Réglages' }).click();
await page.getByLabel('Notifications quand un agent répond').click();
await page.waitForFunction(() => [...document.querySelectorAll('.MuiSwitch-input')].some((i) => i.checked), null, { timeout: 15000 })
  .then(() => check('interrupteur de notifications activé (abonnement enregistré)', true), () => check('interrupteur de notifications activé (abonnement enregistré)', false));
await page.keyboard.press('Escape');

// (1) un run termine → le serveur envoie une vraie requête Web Push au faux service
const api = ctx.request, H = { 'X-Requested-With': 'agentui' };
await api.post('/api/auth/login', { headers: H, data: { username: env.ADMIN_USER, password: env.ADMIN_PASSWORD } });
const conv = await (await api.post('/api/conversations', { headers: H, data: { agentId: 'hermes' } })).json();
await api.post(`/api/conversations/${conv.id}/send`, { headers: H, data: { text: 'Réponds uniquement le mot: NOTIFIE' } });
for (let i = 0; i < 90 && !received.length; i++) await new Promise((r) => setTimeout(r, 1000));
const req = received[0];
check('le serveur envoie une requête Web Push à la fin du run', !!req, req?.url);
check('requête chiffrée (aes128gcm) et signée VAPID', req?.headers['content-encoding'] === 'aes128gcm' && /^vapid t=.+, k=.+/.test(req?.headers.authorization ?? ''), `${req?.headers['content-encoding']} / ${req?.headers.authorization?.slice(0, 12)}…`);
check('TTL défini et corps non vide', Number(req?.headers.ttl) > 0 && req?.size > 40, `ttl=${req?.headers.ttl} taille=${req?.size}`);

// (2) livraison au service worker
const cdp = await ctx.newCDPSession(page);
const regs = new Promise((res) => cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => e.registrations.length && res(e.registrations[0])));
await cdp.send('ServiceWorker.enable');
const reg = await regs;
const payload = { title: 'Hermes a répondu', body: 'test — NOTIFIE', url: `/c/${conv.id}`, tag: conv.id };
const deliver = () => cdp.send('ServiceWorker.deliverPushMessage', { origin: new URL(base).origin, registrationId: reg.registrationId, data: JSON.stringify(payload) });
const count = () => page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).length);

await deliver(); await page.waitForTimeout(1500);
check('app au premier plan → pas de notification (évite le doublon)', (await count()) === 0);

await page.goto('about:blank'); // l'application n'est plus ouverte
await deliver(); await page.waitForTimeout(1500);
const p2 = await ctx.newPage(); await p2.goto('/');
const notifs = await p2.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => ({ title: n.title, body: n.body, tag: n.tag, url: n.data?.url })));
check('app fermée → notification affichée', notifs.length === 1 && notifs[0].title === 'Hermes a répondu', JSON.stringify(notifs[0]));
check('lien de la notification = conversation', notifs[0]?.url === `/c/${conv.id}`);

// clic : le lien ouvre la conversation (route /c/<id>) ; l'ancien lien /?c=<id> est redirigé vers elle
await p2.goto(notifs[0].url);
await p2.getByText('NOTIFIE').first().waitFor({ timeout: 15000 }).then(() => check('lien notification → conversation ouverte', true), () => check('lien notification → conversation ouverte', false));
check('URL = /c/<id>', new URL(p2.url()).pathname === `/c/${conv.id}`);
await p2.goto(`/?c=${conv.id}`);
await p2.getByText('NOTIFIE').first().waitFor({ timeout: 15000 }).then(() => check('ancien lien ?c= → conversation ouverte', true), () => check('ancien lien ?c= → conversation ouverte', false));
check('ancien lien ?c= redirigé vers /c/<id>', new URL(p2.url()).pathname === `/c/${conv.id}` && new URL(p2.url()).search === '');
await api.delete(`/api/conversations/${conv.id}`, { headers: H });

// désactivation : (ré)activer sur cette page puis désactiver, plus aucun envoi ensuite
await p2.getByRole('button', { name: 'Réglages' }).click();
const sw = p2.getByLabel('Notifications quand un agent répond');
const isOn = () => p2.evaluate(() => [...document.querySelectorAll('.MuiSwitch-input')].some((i) => i.checked));
if (!(await isOn())) { await sw.click(); await p2.waitForFunction(() => [...document.querySelectorAll('.MuiSwitch-input')].some((i) => i.checked)); }
await sw.click(); await p2.waitForTimeout(1500);
check('désactivation depuis les réglages', !(await isOn()));
const avant = received.length;
const conv2 = await (await api.post('/api/conversations', { headers: H, data: { agentId: 'hermes' } })).json();
await api.post(`/api/conversations/${conv2.id}/send`, { headers: H, data: { text: 'Réponds uniquement: FIN' } });
await new Promise((r) => setTimeout(r, 20000));
check('plus aucun envoi push après désactivation', received.length === avant, `${received.length - avant} requête(s)`);
await api.delete(`/api/conversations/${conv2.id}`, { headers: H });
await browser.close(); fake.close();
console.log(`\n${ok.filter(Boolean).length}/${ok.length} vérifications OK`);
process.exit(ok.every(Boolean) ? 0 : 1);
