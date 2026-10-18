// Browser E2E (system Chromium). Usage: node e2e/front.mjs <baseUrl> <screenshots-folder>
import { chromium } from 'playwright-core';
import { readFileSync, mkdirSync } from 'node:fs';
const [base, shots] = [process.argv[2], process.argv[3]];
mkdirSync(shots, { recursive: true });
const env = Object.fromEntries(readFileSync('.env', 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const MSG = "Run the shell command 'echo pong' then answer only with the word: PONG";

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });
const errors = [];
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !/favicon|401/.test(m.text()) && errors.push(m.text()));

// 1. Login
await page.goto(base);
await page.getByLabel('Username').waitFor();
await page.screenshot({ path: `${shots}/1-login.png` });
await page.getByLabel('Username').fill('wrong');
await page.getByLabel('Password').fill('wrong-password');
await page.getByRole('button', { name: 'Se connecter' }).click();
check('login refused with wrong credentials', await page.getByText('Invalid credentials').waitFor({ timeout: 5000 }).then(() => true, () => false));
await page.screenshot({ path: `${shots}/1b-login-refuse.png` });
await page.getByLabel('Username').fill(env.ADMIN_USER);
await page.getByLabel('Password').fill(env.ADMIN_PASSWORD);
await page.getByRole('button', { name: 'Se connecter' }).click();
await page.getByText('New conversation').first().waitFor({ timeout: 10000 });
check('login accepted', true);

// 2. Agents visible + connected
await page.getByText('OpenClaw').first().waitFor();
await page.getByText('Hermes').first().waitFor();
check('the 2 agents are listed', true);
await page.screenshot({ path: `${shots}/2-accueil.png` });

// 3. OpenClaw chat with tools
async function chat(agent) {
  await page.getByRole('button', { name: new RegExp(`^${agent}`) }).first().click();
  await page.getByRole('button', { name: 'New conversation' }).click();
  const box = page.getByPlaceholder(`Message ${agent}`);
  await box.fill(MSG);
  await box.press('Enter');
  await page.getByText(/\d+ tools?/).first().waitFor({ timeout: 90000 }).catch(() => {});
  await page.locator('[aria-label="Stop"]').waitFor({ state: 'detached', timeout: 120000 }).catch(() => {});
}
await chat('OpenClaw');
const lastAssistant = () => page.locator('[data-role=assistant]').last().innerText().catch(() => '');
const ocText = await lastAssistant();
check('OpenClaw: agent reply', /PONG/i.test(ocText), JSON.stringify(ocText.slice(-80)));
check('OpenClaw: activity line "N tools"', await page.getByText(/\d+ tools?/).first().waitFor({ timeout: 5000 }).then(() => true, () => false));
await page.getByText(/\d+ tools?/).first().click();
await page.getByText('exec').first().waitFor({ timeout: 5000 }).catch(() => {});
await page.getByText('exec').first().click().catch(() => {});
await page.waitForTimeout(800);
await page.screenshot({ path: `${shots}/3-openclaw-outils.png` });

// 4. Chat Hermes
await chat('Hermes');
const hText = await lastAssistant();
check('Hermes: agent reply', /PONG/i.test(hText), JSON.stringify(hText.slice(-80)));
check('Hermes: tools card', await page.getByText(/\d+ tools?/).first().waitFor({ timeout: 5000 }).then(() => true, () => false));
await page.getByText(/\d+ tools?/).first().click();
await page.waitForTimeout(800);
await page.screenshot({ path: `${shots}/4-hermes.png` });

// 5. Agents / skills / tasks panel
await page.getByRole('button', { name: 'Agents, skills and tasks' }).click();
await page.getByRole('tab', { name: 'Skills' }).click();
await page.getByText('claude-code').first().waitFor({ timeout: 10000 }).catch(() => {});
check('Hermes: skills listed', await page.getByText('claude-code').first().isVisible());
await page.getByRole('tab', { name: 'Tasks' }).click();
await page.getByText('daily-docker-report').waitFor({ timeout: 10000 }).catch(() => {});
check('Hermes: tasks listed', await page.getByText('daily-docker-report').isVisible().catch(() => false));
await page.screenshot({ path: `${shots}/5-taches-hermes.png` });
await page.keyboard.press('Escape');

// 6. Closing the tab mid-run → the result must be there on return
const p2 = await ctx.newPage();
await p2.goto(base);
await p2.getByRole('button', { name: /^OpenClaw/ }).first().click();
await p2.getByRole('button', { name: 'New conversation' }).click();
const box2 = p2.getByPlaceholder('Message OpenClaw');
await box2.fill("Answer only: PERSISTENT");
await box2.press('Enter');
await p2.waitForTimeout(700);
await p2.close(); // immediate close during the run
await page.waitForTimeout(15000);
await page.reload();
await page.getByText('Answer only: PERSISTENT').first().click();
await page.locator('[data-role=assistant]').last().waitFor({ timeout: 10000 }).catch(() => {});
const back = await lastAssistant();
check('run finished after closing the tab', /PERSISTENT/i.test(back), JSON.stringify(back.slice(-60)));
await page.screenshot({ path: `${shots}/6-persistence.png` });

// 6b. Deleting a conversation from the interface
const countBefore = await page.getByRole('button', { name: 'Delete', exact: true }).count();
page.once('dialog', (d) => d.accept());
await page.getByRole('button', { name: 'Delete', exact: true }).first().click();
await page.waitForTimeout(1000);
check('conversation deletion', (await page.getByRole('button', { name: 'Delete', exact: true }).count()) === countBefore - 1);

// 7. PWA : manifest + service worker
const man = await page.evaluate(() => fetch('/manifest.webmanifest').then((r) => r.json()));
check('PWA : manifest', man.name === 'AgentUI' && man.display === 'standalone');
const sw = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.state ?? 'none');
check('PWA : service worker actif', sw === 'activated', sw);

// 8. Mobile
const m = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
const mp = await m.newPage();
await mp.goto(base);
await mp.getByRole('button', { name: 'Menu' }).waitFor();
await mp.screenshot({ path: `${shots}/7-mobile.png` });
await mp.getByRole('button', { name: 'Menu' }).click();
await mp.waitForTimeout(500);
await mp.screenshot({ path: `${shots}/8-mobile-menu.png` });
const overflow = await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
check('mobile: no horizontal scrolling', !overflow);

check('no JS console error', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} checks OK`);
process.exit(results.every(Boolean) ? 0 : 1);
