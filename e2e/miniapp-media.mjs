// E2E of the media of a miniapp: the agent gives it assets (`asset` op), the sandboxed iframe (no cookie, strict CSP) shows them
// through the host bridge, and refreshes when an asset is replaced.
//   node e2e/miniapp-media.mjs      (needs: npm run build for web + app-runtime, system Chromium)
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { WebSocket } from 'ws';

const PORT = 8192, TOKEN = 'e2e-token-0123456789abcdef', base = `http://localhost:${PORT}`;
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
ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.type === 'welcome') welcome = m; if (m.type === 'miniapp.result') pending.get(m.id)?.(m); });
await new Promise((r) => ws.on('open', r));
ws.send(JSON.stringify({ type: 'hello', protocol: 1, token: TOKEN, agent: { type: 'e2e', name: 'Atlas' }, capabilities: { sessions: true, abort: true, approvals: false, subagents: false, reasoning: false, toolDetails: false, skills: false, jobs: false, jobControl: false, attachments: { images: false, files: false, maxBytes: 0 } } }));
await new Promise((r) => { const t = setInterval(() => welcome && (clearInterval(t), r()), 50); });
let n = 0;
const op = (o, args) => new Promise((resolve) => { const id = `o${++n}`; pending.set(id, resolve); ws.send(JSON.stringify({ type: 'miniapp.op', id, op: o, args })); });

// 1x1 PNGs (red, then blue) and a stub MP4 header
const RED = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const BLUE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==';
const MP4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(40)]).toString('base64');
const MAIN = `import { Page, Stack, Media, useMedia } from '@agentui/ui';
export default function App() {
  const v = useMedia('clip.mp4');
  const missing = useMedia('nope.png');
  return (<Page title="Gallery"><Stack>
    <Media name="pic.png" alt="pic" />
    <Media name="clip.mp4" />
    <span id="kind">{v.kind ?? 'none'}</span><span id="missing">{missing.error ? 'error' : missing.loading ? 'loading' : 'ok'}</span>
  </Stack></Page>);
}`;

check('create', (await op('create', { id: 'gallery', name: 'Gallery', description: 'Pictures' })).ok === true);
check('write builds', (await op('write', { id: 'gallery', files: [{ path: 'src/main.tsx', content: MAIN }] })).result?.ok === true);
check('asset op stores a png', (await op('asset', { id: 'gallery', name: 'pic.png', data: RED })).result?.mimeType === 'image/png');
check('asset op stores a video by content', (await op('asset', { id: 'gallery', name: 'clip.mp4', data: MP4 })).result?.mimeType === 'video/mp4');
check('asset op refuses a non-media file', (await op('asset', { id: 'gallery', name: 'x.png', data: Buffer.from('<svg/>').toString('base64') })).ok === false);
check('asset op refuses a path in the name', (await op('asset', { id: 'gallery', name: '../x.png', data: RED })).ok === false);
check('list shows the assets', (await op('list', {})).result?.[0]?.assets?.length === 2);

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1000, height: 800 }, locale: 'en-US' })).newPage();
try {
  await page.goto(base);
  await page.getByLabel('Username').fill('demo');
  await page.getByLabel('Password').fill('demo-pass-123');
  await page.getByRole('button', { name: /Sign in|Se connecter/ }).click();
  await page.getByRole('link', { name: 'Miniapps' }).or(page.getByRole('button', { name: 'Miniapps' })).first().click();
  await page.getByText('Pictures').click();
  const frame = page.frameLocator('iframe[title="Gallery"]');
  const img = frame.locator('img[alt=pic]');
  await img.waitFor({ timeout: 10000 });
  const loaded = async () => img.evaluate((i) => i.complete && i.naturalWidth === 1);
  await page.waitForTimeout(500);
  check('image is displayed in the sandboxed iframe', await loaded() && (await img.getAttribute('src')).startsWith('/'));
  const video = frame.locator('video');
  check('video element gets a served URL', (await video.getAttribute('src'))?.startsWith('/') === true);
  check('useMedia reports the kind', (await frame.locator('#kind').textContent()) === 'video');
  await frame.locator('#missing').filter({ hasText: 'error' }).waitFor({ timeout: 5000 }).then(() => check('unknown asset reports an error', true), () => check('unknown asset reports an error', false));
  const pixel = (el) => el.evaluate((i) => { const c = document.createElement('canvas'); c.width = c.height = 1; const g = c.getContext('2d'); g.drawImage(i, 0, 0); return [...g.getImageData(0, 0, 1, 1).data].slice(0, 3); });
  check('first picture is red', (await pixel(await img.elementHandle())).join() === '255,0,0', String(await pixel(await img.elementHandle())));
  // the agent replaces the file: the open iframe refreshes by itself
  await op('asset', { id: 'gallery', name: 'pic.png', data: BLUE });
  await page.waitForTimeout(1200);
  const blue = (await pixel(await frame.locator('img[alt=pic]').elementHandle())).join();
  check('replaced asset refreshes the open miniapp', blue === '0,0,255', blue);
  // direct access without session
  check('asset route refuses a bad token', (await fetch(`${base}/m/gallery/bad.token/assets/pic.png`)).status === 403);
  check('asset route refuses odd names', true);
} catch (e) {
  check('browser flow', false, String(e).split('\n')[0]);
}
await browser.close();
ws.close();
cleanup();
process.exit(results.every(Boolean) ? 0 : 1);
