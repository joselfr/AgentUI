// Captures for the presentation site (docs/img) from an AgentUI instance wired to e2e/demo/fake-agent.mjs.
//   node e2e/demo/capture.mjs <baseUrl> <user> <password> <output-folder>
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const [base, user, pass, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const AGENT = 'Atlas';

// Each scenario: message sent, capture name, wait for completion.
const SCENARIOS = [
  { id: 'chart', prompt: 'Montre-moi l’évolution des ventes de cette année', ready: 'canvas', blocking: false },
  { id: 'table', prompt: 'Fais-moi un comparatif des offres', ready: 'table', blocking: false },
  { id: 'map', prompt: 'Prépare l’itinéraire de ma visite de jeudi', ready: '.leaflet-container', blocking: false },
  { id: 'progress', prompt: 'Lance la migration vers la nouvelle base', ready: null, blocking: false, settle: 7000 },
  { id: 'code', prompt: 'Corrige le bug de date dans le script', ready: 'text=src/booking.ts', blocking: false },
  { id: 'confirm', prompt: 'Supprime les anciennes sauvegardes', ready: 'text=Garder', blocking: true },
  { id: 'form', prompt: 'Organise mon voyage à Lyon', ready: 'text=Lancer la recherche', blocking: true },
];

// Outside the played scenarios: chat of a cron task (created by the proactive message) and the "Tasks" page.
const EXTRA = [
  { id: 'cron', ready: 'table' },
  { id: 'jobs', ready: 'text=Sauvegarde nocturne', path: '/jobs' },
];

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });

async function login(page) {
  await page.goto(base);
  await page.getByLabel('Utilisateur').fill(user);
  await page.getByLabel('Mot de passe').fill(pass);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await page.getByText('Nouvelle conversation').first().waitFor({ timeout: 15000 });
}

const idOf = (page) => page.url().match(/\/c\/([^/?#]+)/)?.[1];
const ids = {};

const ctxOpts = (name) => ({
  deviceScaleFactor: 2, locale: 'fr-FR',
  ...(name.startsWith('mobile') ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 960 } }),
});
const themed = async (ctx, theme) => { await ctx.addInitScript((t) => localStorage.setItem('themeMode', JSON.stringify(t)), theme); return ctx; };

// 1. Dark desktop (default theme): each scenario is played (creates the chats) and captured
{
  const ctx = await themed(await browser.newContext(ctxOpts('desktop')), 'dark');
  const page = await ctx.newPage();
  await login(page);
  for (const s of SCENARIOS) {
    await page.getByRole('button', { name: 'Nouvelle conversation', exact: true }).click();
    await page.getByRole('button', { name: 'Démarrer' }).click({ timeout: 3000 }).catch(() => {}); // agent choice
    const box = page.getByPlaceholder(`Message à ${AGENT}`);
    await box.fill(s.prompt);
    await box.press('Enter');
    if (s.ready) await page.locator(s.ready).first().waitFor({ timeout: 30000 });
    if (!s.blocking) await page.locator('[aria-label="Arrêter"]').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(s.settle ?? 2500);
    ids[s.id] = idOf(page);
    if (s.blocking) { await page.reload(); await page.locator(s.ready).first().waitFor({ timeout: 30000 }); await page.waitForTimeout(1500); } // up-to-date list titles
    await page.screenshot({ path: `${out}/desktop-dark-${s.id}.png` });
    console.log('desktop-dark', s.id, ids[s.id]);
  }
  // Cron chat: "Cron tasks" section of the list, then the "Tasks" page
  await page.getByRole('button', { name: /^Tâches cron/ }).click();
  await page.getByText('⏰ Résumé du matin').first().click();
  await page.locator('table').first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(2000);
  ids.cron = idOf(page);
  await page.screenshot({ path: `${out}/desktop-dark-cron.png` });
  await page.getByRole('button', { name: /^Tâches/ }).first().click();
  await page.getByText('Sauvegarde nocturne').first().waitFor({ timeout: 15000 });
  await page.mouse.move(900, 900); // the menu tooltip must not appear
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/desktop-dark-jobs.png` });
  console.log('desktop-dark cron/jobs', ids.cron);
  await ctx.close();
}

// 2. Other variants: reopen the existing chats
for (const [name, theme, only] of [
  ['desktop-light', 'light', ['chart', 'table', 'map', 'code', 'confirm', 'form', 'progress', 'cron', 'jobs']],
  ['mobile-dark', 'dark', ['chart', 'table', 'map', 'progress', 'code', 'confirm', 'form', 'cron', 'jobs']],
  ['mobile-light', 'light', ['chart', 'table', 'progress']],
]) {
  const ctx = await themed(await browser.newContext(ctxOpts(name)), theme);
  const page = await ctx.newPage();
  await login(page);
  for (const s of [...SCENARIOS, ...EXTRA].filter((x) => only.includes(x.id))) {
    await page.goto(s.path ? `${base}${s.path}` : `${base}/c/${ids[s.id]}`);
    if (s.ready) await page.locator(s.ready).first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${out}/${name}-${s.id}.png` });
    console.log(name, s.id);
  }
  if (name === 'mobile-dark') { // chat list in a drawer
    await page.goto(`${base}/c/${ids.chart}`);
    await page.getByRole('button', { name: /discussions|menu/i }).first().click().catch(() => {});
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${out}/mobile-dark-liste.png` });
  }
  await ctx.close();
}
await browser.close();
