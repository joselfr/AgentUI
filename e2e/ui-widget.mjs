// E2E of the `agentui_custom_widget` widget against the demo instance (e2e/demo/demo.sh up): the fake agent plays the savings simulator,
// a browser checks that it renders in the sandboxed iframe, reacts to input, follows the theme and cannot reach /api.
//   node e2e/ui-widget.mjs [screenshots-folder]
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const base = `http://localhost:${process.env.DEMO_PORT ?? 8181}`;
const shots = process.argv[2] ?? join(tmpdir(), 'agentui-ui-shots');
mkdirSync(shots, { recursive: true });
const ok = [];
const check = (name, pass, extra = '') => { ok.push(pass); console.log(`${pass ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US', colorScheme: 'dark' });
const page = await ctx.newPage();
try {
  await page.goto(base);
  await page.getByLabel('Username').fill('demo');
  await page.getByLabel('Password').fill('demo-pass-123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.getByRole('button', { name: 'Start' }).click({ timeout: 3000 }).catch(() => {});
  const box = page.getByPlaceholder(/Message/);
  await box.fill('Make me a savings simulator');
  await box.press('Enter');
  const frame = page.frameLocator('iframe[title="Dynamic widget"]');
  await frame.getByText('Savings simulator').waitFor({ timeout: 20000 });
  check('widget renders in the iframe with the miniapp UI kit', true);
  const before = await frame.getByText(/Capital after/).first().innerText();
  await frame.getByLabel('Monthly deposit (€)').fill('1000');
  await page.waitForTimeout(400);
  const after = await frame.getByText(/Capital after/).first().innerText();
  check('widget is interactive (state in the component)', before !== after, `${before} → ${after}`);
  await page.waitForTimeout(800);
  const h = await page.locator('iframe[title="Dynamic widget"]').evaluate((e) => e.getBoundingClientRect().height);
  check('iframe is sized to its content', h > 150 && h < 640, `${Math.round(h)}px`);
  await page.screenshot({ path: join(shots, 'ui-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(shots, 'ui-light.png') });
  const sandbox = await page.locator('iframe[title="Dynamic widget"]').getAttribute('sandbox');
  check('iframe is sandboxed without same-origin', sandbox === 'allow-scripts', String(sandbox));
  const f = page.frames().find((x) => x.url().includes('/w/'));
  const leak = await f.evaluate(() => fetch('/api/miniapps').then(() => 'leak', () => 'blocked'));
  check('widget cannot call /api', leak === 'blocked', leak);
  const bad = await fetch(`${base}/w/${'0'.repeat(24)}/bad.token/app.js`);
  check('static route refuses a bad token', bad.status === 403);
  const anon = await fetch(`${base}/api/widgets`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'agentui' }, body: '{"code":"x"}' });
  check('compile endpoint refuses unauthenticated calls', anon.status === 401, String(anon.status));
} catch (e) { check('run', false, String(e).slice(0, 300)); await page.screenshot({ path: join(shots, 'fail.png') }); }
await browser.close();
process.exit(ok.every(Boolean) ? 0 : 1);
