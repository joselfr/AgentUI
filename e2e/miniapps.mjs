// E2E of the miniapps: throwaway AgentUI server + fake channel plugin that creates a miniapp (front + handlers) through
// `miniapp.op` frames, then a browser checks the Miniapps tab, the themed iframe, the handler round trip and the sandbox.
//   node e2e/miniapps.mjs [screenshots-folder]      (needs: npm run build for web + app-runtime, system Chromium)
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { WebSocket } from 'ws';

const shots = process.argv[2] ?? join(tmpdir(), 'agentui-miniapps-shots');
mkdirSync(shots, { recursive: true });
const PORT = 8191, TOKEN = 'e2e-token-0123456789abcdef', base = `http://localhost:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), 'agentui-e2e-miniapps-'));
mkdirSync(join(dir, 'data'));
import { writeFileSync } from 'node:fs';
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

// ── fake plugin ──
const ws = new WebSocket(`ws://localhost:${PORT}/gateway`);
const pending = new Map();
let welcome;
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === 'welcome') welcome = m;
  if (m.type === 'miniapp.result') pending.get(m.id)?.(m);
});
await new Promise((r) => ws.on('open', r));
ws.send(JSON.stringify({ type: 'hello', protocol: 1, token: TOKEN, agent: { type: 'e2e', name: 'Atlas' }, capabilities: { sessions: true, abort: true, approvals: false, subagents: false, reasoning: false, toolDetails: false, skills: false, jobs: false, jobControl: false, attachments: { images: false, files: false, maxBytes: 0 } } }));
await new Promise((r) => { const t = setInterval(() => welcome && (clearInterval(t), r()), 50); });
let n = 0;
const op = (o, args) => new Promise((resolve) => { const id = `o${++n}`; pending.set(id, resolve); ws.send(JSON.stringify({ type: 'miniapp.op', id, op: o, args })); });
check('welcome announces miniapps support', welcome.miniapps === true);

const MAIN = `import { useState } from 'react';
import { Page, Card, Stack, Row, Button, TextField, List, ListItem, IconButton, Spinner, EmptyState, Chart, Chip, useApi, api, useTheme } from '@agentui/ui';
export default function App() {
  const todos = useApi('todos');
  const [title, setTitle] = useState('');
  const { mode } = useTheme();
  const add = async () => { if (!title.trim()) return; await api.post('todos', { title }); setTitle(''); todos.reload(); };
  return (
    <Page title="Todos" actions={<Chip label={mode} color="primary" />}>
      <Stack>
        <Row><TextField style={{ flex: 1 }} placeholder="New task" value={title} onChange={setTitle} onEnter={add} /><Button icon="add" onClick={add}>Add</Button></Row>
        {todos.loading && <Spinner center />}
        {todos.data?.length === 0 && <EmptyState icon="checklist" title="Nothing to do" />}
        <Card padding={4}><List>{todos.data?.map((t) => <ListItem key={t.id} primary={t.title} trailing={<IconButton icon="delete" label="Delete" onClick={async () => { await api.delete('todos/' + t.id); todos.reload(); }} />} />)}</List></Card>
        <Card><Chart type="bar" labels={['a', 'b', 'c']} series={[{ name: 's', data: [1, 3, 2] }]} height={160} /></Card>
        <button id="probe" onClick={async () => { try { await fetch('/api/miniapps'); document.title = 'leak'; } catch { document.title = 'blocked'; } }}>probe</button>
      </Stack>
    </Page>
  );
}`;
const SERVER = `export function GET(req, ctx) { return ctx.db.collection('todos').find(); }
export function POST(req, ctx) { return ctx.db.collection('todos').insert({ title: String(req.body.title) }); }
export function DELETE(req, ctx) { ctx.db.collection('todos').remove(req.path.slice(1)); return { ok: true }; }`;

const created = await op('create', { id: 'todo', name: 'Todo', icon: 'checklist', description: 'Simple tasks' });
check('create', created.ok === true);
const bad = await op('write', { id: 'todo', files: [{ path: 'src/main.tsx', content: 'export default () => <div>' }] });
check('write with a syntax error reports it', bad.ok && bad.result.ok === false && bad.result.errors[0].line === 1, JSON.stringify(bad.result?.errors?.[0]));
const good = await op('write', { id: 'todo', files: [{ path: 'src/main.tsx', content: MAIN }, { path: 'server/todos.js', content: SERVER }] });
check('write builds', good.ok && good.result.ok === true, JSON.stringify(good.result));
check('foreign path refused', (await op('write', { id: 'todo', files: [{ path: '../x.js', content: '' }] })).ok === false);

// ── browser ──
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });
const page = await ctx.newPage();
const errors = [];
if (process.env.DEBUG) { page.on('requestfailed', (r) => console.log('REQFAIL', r.url(), r.failure()?.errorText)); page.on('response', (r) => r.url().includes('/m/') && console.log('RESP', r.status(), r.url())); page.on('console', (m) => console.log('CONSOLE', m.type(), m.text())); }
page.on('pageerror', (e) => !/Content Security Policy/.test(e.message) && errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !/favicon|401|403|Content Security Policy/.test(m.text()) && errors.push(m.text()));
try {
  await page.goto(base);
  await page.getByLabel('Username').fill('demo');
  await page.getByLabel('Password').fill('demo-pass-123');
  await page.getByRole('button', { name: /Sign in|Se connecter/ }).click();
  await page.getByRole('link', { name: 'Miniapps' }).or(page.getByRole('button', { name: 'Miniapps' })).first().click();
  await page.getByText('Simple tasks').waitFor({ timeout: 10000 });
  // theme follows the system, so it can be flipped later while the miniapp is open (the nav rail is hidden there)
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.getByRole('button', { name: 'Settings' }).or(page.getByLabel('Settings')).first().click();
  await page.getByRole('combobox').first().click();
  await page.getByRole('option', { name: 'System' }).click();
  await page.keyboard.press('Escape');
  check('Miniapps tab lists the miniapp', true);
  await page.screenshot({ path: join(shots, 'apps-list.png') });
  await page.getByText('Simple tasks').click();
  if (process.env.DEBUG) { await page.waitForTimeout(2500); for (const f of page.frames()) if (f.url().includes('/m/todo/')) console.log('IMPORT', await f.evaluate(async () => { try { const m = await import(window.__AGENTUI.entry); return 'ok ' + Object.keys(m); } catch (e) { return 'ERR ' + e.message; } })); }
  const frame = page.frameLocator('iframe[title="Todo"]');
  await frame.getByText('Nothing to do').waitFor({ timeout: 10000 });
  check('miniapp renders in the sandboxed iframe (components + handler GET)', true);
  await frame.getByPlaceholder('New task').fill('Buy milk');
  await frame.getByRole('button', { name: 'Add' }).click();
  await frame.getByText('Buy milk').waitFor({ timeout: 5000 });
  check('handler round trip through the host bridge (POST then GET)', true);
  const bg = async () => frame.locator('body').evaluate((b) => getComputedStyle(b).backgroundColor);
  const dark = await bg();
  await page.screenshot({ path: join(shots, 'app-dark.png') });
  // the agent pushes data with the `data` op: the open iframe refreshes by itself
  const pushed = await op('data', { id: 'todo', action: 'insert', collection: 'todos', doc: { title: 'From the agent' } });
  check('agent data op inserts', pushed.ok === true && pushed.result.title === 'From the agent', JSON.stringify(pushed).slice(0, 120));
  await frame.getByText('From the agent').waitFor({ timeout: 5000 }).then(() => check('open iframe refreshes after an agent data push', true), () => check('open iframe refreshes after an agent data push', false));
  check('agent data op: other agent refused / unknown app', (await op('data', { id: 'nope', action: 'find', collection: 'todos' })).ok === false);
  // theme switch from the host (system scheme flips while the miniapp is open)
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForTimeout(500);
  const light = await bg();
  check('theme change reaches the iframe', dark !== light, `${dark} → ${light}`);
  await page.screenshot({ path: join(shots, 'app-light.png') });
  // sandbox: direct fetch to /api from the app is blocked (CSP connect-src none)
  await frame.locator('#probe').click();
  await page.waitForTimeout(500);
  const title = await page.frames().find((f) => f.url().includes('/m/todo/'))?.evaluate(() => document.title);
  check('miniapp cannot call /api directly', title === 'blocked', String(title));
  // without cookie: the static route needs a valid token and the backend needs the session
  const anon = await fetch(`${base}/api/miniapps/todo/x/todos`);
  check('handlers refuse unauthenticated calls', anon.status === 401);
  const anonFile = await fetch(`${base}/m/todo/bad.token/app.js`);
  check('static files refuse a bad token', anonFile.status === 403);
  // mobile
  await page.setViewportSize({ width: 390, height: 780 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(shots, 'app-mobile.png') });
  check('no browser errors', errors.length === 0, errors.join(' | ').slice(0, 300));
} catch (e) {
  check('browser flow', false, String(e).split('\n')[0]);
  await page.screenshot({ path: join(shots, 'failure.png') }).catch(() => {});
}
await browser.close();
ws.close();
cleanup();
console.log(`screenshots: ${shots}`);
process.exit(results.every(Boolean) ? 0 : 1);
