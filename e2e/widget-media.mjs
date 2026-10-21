// E2E of the media of a custom chat widget: the agent copies a file into the chat (`message.media`), declares it in the `media` argument of
// agentui_widget_custom, and the sandboxed iframe (no cookie, strict CSP) shows it through the host bridge.
//   node e2e/widget-media.mjs      (needs: npm run build for web + app-runtime, system Chromium)
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { WebSocket } from 'ws';

const PORT = 8193, TOKEN = 'e2e-token-0123456789abcdef', base = `http://localhost:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), 'agentui-e2e-media-'));
mkdirSync(join(dir, 'data'));
writeFileSync(join(dir, 'agents.yaml'), `agents:\n  - id: atlas\n    type: gateway\n    name: Atlas\n    token: ${TOKEN}\n`);
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };

const server = spawn('npx', ['tsx', 'src/index.ts'], {
  cwd: 'apps/server', stdio: 'ignore',
  env: { ...process.env, AGENTS_CONFIG: join(dir, 'agents.yaml'), DATA_DIR: join(dir, 'data'), WEB_DIST: join(process.cwd(), 'apps/web/dist'), APP_RUNTIME_DIST: join(process.cwd(), 'packages/app-runtime/dist'), ADMIN_USER: 'demo', ADMIN_PASSWORD: 'demo-pass-123', COOKIE_SECRET: '0123456789abcdef0123456789abcdef', INSECURE_COOKIES: '1', PORT: String(PORT) },
});
const cleanup = () => { server.kill(); try { process.kill(-server.pid); } catch {} };
process.on('exit', cleanup);
for (let i = 0; i < 40; i++) { if (await fetch(base).then(() => true, () => false)) break; await new Promise((r) => setTimeout(r, 500)); }

const ws = new WebSocket(`ws://localhost:${PORT}/gateway`);
const pending = new Map();
let welcome;
ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.type === 'welcome') welcome = m; if (m.type === 'inbound') void play(m); });
await new Promise((r) => ws.on('open', r));
ws.send(JSON.stringify({ type: 'hello', protocol: 1, token: TOKEN, agent: { type: 'e2e', name: 'Atlas' }, capabilities: { sessions: true, abort: true, approvals: false, subagents: false, reasoning: false, toolDetails: false, skills: false, jobs: false, jobControl: false, attachments: { images: false, files: false, maxBytes: 0 } } }));
await new Promise((r) => { const t = setInterval(() => welcome && (clearInterval(t), r()), 50); });
let n = 0;
const op = (o, args) => new Promise((resolve) => { const id = `o${++n}`; pending.set(id, resolve); ws.send(JSON.stringify({ type: 'miniapp.op', id, op: o, args })); });

const RED = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const PATH = '/home/agent/red.png';
const CODE = `import { Media, Stack } from '@agentui/ui';
export default function W() { return <Stack><Media name="${PATH}" alt="red" /><Media name="/home/agent/ghost.png" alt="ghost" /></Stack>; }`;
const send = (o) => ws.send(JSON.stringify(o));
async function play(m) {
  const ev = (event) => send({ type: 'event', conversationId: m.conversationId, runId: m.runId, event });
  const file = `agentui-img-12345678-red.png`;
  // the widget is displayed before the copy arrives (streaming): the request must wait for it
  ev({ type: 'tool.started', id: 't1', name: 'agentui_widget_custom', args: { code: CODE, media: [PATH, '/home/agent/ghost.png'] } });
  await new Promise((r) => setTimeout(r, 600));
  ev({ type: 'message.media', name: file, mimeType: 'image/png', data: RED });
  ev({ type: 'tool.completed', id: 't1', name: 'agentui_widget_custom', result: JSON.stringify({ widget: '[[agentui:abc123]]', files: { [PATH]: file } }) });
  ev({ type: 'message.delta', text: 'Here it is\n\n[[agentui:abc123]]' });
  ev({ type: 'message.final', text: 'Here it is\n\n[[agentui:abc123]]' });
  ev({ type: 'run.completed' });
}

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1000, height: 800 }, locale: 'en-US' })).newPage();
try {
  await page.goto(base);
  await page.getByLabel('Username').fill('demo');
  await page.getByLabel('Password').fill('demo-pass-123');
  await page.getByRole('button', { name: /Sign in|Se connecter/ }).click();
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.getByRole('button', { name: 'Start' }).click({ timeout: 3000 }).catch(() => {});
  const box = page.getByPlaceholder(/Message/);
  await box.fill('show me');
  await box.press('Enter');
  const frame = page.frameLocator('iframe[title="Dynamic widget"]');
  const img = frame.locator('img[alt=red]');
  await img.waitFor({ timeout: 15000 });
  await page.waitForTimeout(300);
  check('image shows in the custom widget', (await img.getAttribute('src')).startsWith('/') && await img.evaluate((i) => i.complete && i.naturalWidth === 1));
  const px = await img.evaluate((i) => { const c = document.createElement('canvas'); c.width = c.height = 1; const g = c.getContext('2d'); g.drawImage(i, 0, 0); return [...g.getImageData(0, 0, 1, 1).data].slice(0, 3).join(); });
  check('it is the copied file', px === '255,0,0', px);
  await frame.getByText('ghost.png: ✕').waitFor({ timeout: 5000 }).then(() => check('a media that was never copied shows an error', true), () => check('a media that was never copied shows an error', false));
  check('the copy is not repeated under the message', (await page.locator('img[src^="/api/attachments/"]').count()) === 0);
} catch (e) {
  check('browser flow', false, String(e).split('\n')[0]);
  await page.screenshot({ path: join(dir, 'fail.png') }).catch(() => {});
}
await browser.close();
ws.close();
cleanup();
process.exit(results.every(Boolean) ? 0 : 1);
