// Captures for the presentation site (docs/img) from an AgentUI instance wired to e2e/demo/fake-agent.mjs.
//   node e2e/demo/capture.mjs <baseUrl> <user> <password> <output-folder> [fr|en]
//   (en: English interface and content; the fake agent must be started with DEMO_LANG=en)
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const [base, user, pass, out, lang = 'fr'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const AGENT = 'Atlas';

const TEXT = {
  fr: {
    locale: 'fr-FR', username: 'Utilisateur', password: 'Mot de passe', signIn: 'Se connecter', newChat: 'Nouvelle conversation', start: 'Démarrer',
    composer: (a) => `Message à ${a}`, stop: 'Arrêter', cronSection: /^Tâches cron/, jobsNav: /^Tâches/, chats: /discussions|menu/i,
    morning: '⏰ Résumé du matin', backup: 'Sauvegarde nocturne', expenses: 'Dépenses', byCategory: 'Par catégorie',
    prompts: { offers: 'Fais-moi une sélection d’offres', ui: 'Fais-moi un simulateur d’épargne', chart: 'Montre-moi l’évolution des ventes de cette année', table: 'Fais-moi un comparatif des offres', map: 'Prépare l’itinéraire de ma visite de jeudi', progress: 'Lance la migration vers la nouvelle base', code: 'Corrige le bug de date dans le script', confirm: 'Supprime les anciennes sauvegardes', form: 'Organise mon voyage à Lyon' },
    ready: { confirm: 'text=Garder', form: 'text=Lancer la recherche' },
  },
  en: {
    locale: 'en-US', username: 'Username', password: 'Password', signIn: 'Sign in', newChat: 'New conversation', start: 'Start',
    composer: (a) => `Message ${a}`, stop: 'Stop', cronSection: /^Cron tasks/, jobsNav: /^Tasks/, chats: /chats|menu/i,
    morning: '⏰ Morning briefing', backup: 'Nightly backup', expenses: 'Expenses', byCategory: 'By category',
    prompts: { offers: 'Make me a shortlist of plans', ui: 'Make me a savings simulator', chart: 'Show me this year’s sales trend', table: 'Make me a comparison of the plans', map: 'Plan the route for my Thursday visit', progress: 'Start the migration to the new database', code: 'Fix the date bug in the script', confirm: 'Delete the old backups', form: 'Organize my trip to Lyon' },
    ready: { confirm: 'text=Keep', form: 'text=Start the search' },
  },
}[lang];

// Each scenario: message sent, capture name, wait for completion.
const SCENARIOS = [
  { id: 'chart', prompt: TEXT.prompts.chart, ready: 'canvas', blocking: false },
  { id: 'table', prompt: TEXT.prompts.table, ready: 'table', blocking: false },
  { id: 'map', prompt: TEXT.prompts.map, ready: '.leaflet-container', blocking: false },
  { id: 'progress', prompt: TEXT.prompts.progress, ready: null, blocking: false, settle: 7000 },
  { id: 'code', prompt: TEXT.prompts.code, ready: 'text=src/booking.ts', blocking: false },
  { id: 'confirm', prompt: TEXT.prompts.confirm, ready: TEXT.ready.confirm, blocking: true },
  { id: 'form', prompt: TEXT.prompts.form, ready: TEXT.ready.form, blocking: true },
  { id: 'ui', prompt: TEXT.prompts.ui, ready: 'iframe[src*="/w/"]', blocking: false, settle: 4000 },
  { id: 'offers', prompt: TEXT.prompts.offers, ready: 'iframe[src*="/w/"]', blocking: false, settle: 4000 },
];

// Outside the played scenarios: chat of a cron task (created by the proactive message) and the "Tasks" page.
const EXTRA = [
  { id: 'cron', ready: 'table' },
  { id: 'jobs', ready: `text=${TEXT.backup}`, path: '/jobs' },
  // Miniapps (created by the fake agent at connection): the list, then one miniapp rendered in its iframe
  { id: 'miniapps', ready: `text=${TEXT.expenses}`, path: '/miniapps' },
  { id: 'miniapp', ready: `text=${TEXT.byCategory}`, path: '/miniapps/expenses', frame: true },
];
const waitReady = (page, s) => (s.frame ? page.frameLocator('iframe').locator(s.ready) : page.locator(s.ready)).first().waitFor({ timeout: 30000 });

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });

async function login(page) {
  await page.goto(base);
  await page.getByLabel(TEXT.username).fill(user);
  await page.getByLabel(TEXT.password).fill(pass);
  await page.getByRole('button', { name: TEXT.signIn }).click();
  await page.getByText(TEXT.newChat).first().waitFor({ timeout: 15000 });
}

const idOf = (page) => page.url().match(/\/c\/([^/?#]+)/)?.[1];
const ids = {};

const ctxOpts = (name) => ({
  deviceScaleFactor: 2, locale: TEXT.locale,
  ...(name.startsWith('mobile') ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 960 } }),
});
const themed = async (ctx, theme) => { await ctx.addInitScript((t) => localStorage.setItem('themeMode', JSON.stringify(t)), theme); return ctx; };

// 1. Dark desktop (default theme): each scenario is played (creates the chats) and captured
{
  const ctx = await themed(await browser.newContext(ctxOpts('desktop')), 'dark');
  const page = await ctx.newPage();
  await login(page);
  for (const s of SCENARIOS) {
    await page.getByRole('button', { name: TEXT.newChat, exact: true }).click();
    await page.getByRole('button', { name: TEXT.start }).click({ timeout: 3000 }).catch(() => {}); // agent choice
    const box = page.getByPlaceholder(TEXT.composer(AGENT));
    await box.fill(s.prompt);
    await box.press('Enter');
    if (s.ready) await page.locator(s.ready).first().waitFor({ timeout: 30000 });
    if (!s.blocking) await page.locator(`[aria-label="${TEXT.stop}"]`).waitFor({ state: 'detached', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(s.settle ?? 2500);
    ids[s.id] = idOf(page);
    if (s.blocking) { await page.reload(); await page.locator(s.ready).first().waitFor({ timeout: 30000 }); await page.waitForTimeout(1500); } // up-to-date list titles
    await page.screenshot({ path: `${out}/desktop-dark-${s.id}.png` });
    console.log('desktop-dark', s.id, ids[s.id]);
  }
  // Cron chat: "Cron tasks" section of the list, then the "Tasks" page
  await page.getByRole('button', { name: TEXT.cronSection }).click();
  await page.getByText(TEXT.morning).first().click();
  await page.locator('table').first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(2000);
  ids.cron = idOf(page);
  await page.screenshot({ path: `${out}/desktop-dark-cron.png` });
  await page.getByRole('button', { name: TEXT.jobsNav }).first().click();
  await page.getByText(TEXT.backup).first().waitFor({ timeout: 15000 });
  await page.mouse.move(900, 900); // the menu tooltip must not appear
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/desktop-dark-jobs.png` });
  console.log('desktop-dark cron/jobs', ids.cron);
  for (const s of EXTRA.filter((x) => ['miniapps', 'miniapp'].includes(x.id))) {
    await page.goto(`${base}${s.path}`);
    await waitReady(page, s);
    await page.waitForTimeout(2500); // chart animation
    await page.screenshot({ path: `${out}/desktop-dark-${s.id}.png` });
    console.log('desktop-dark', s.id);
  }
  await ctx.close();
}

// 2. Other variants: reopen the existing chats
for (const [name, theme, only] of [
  ['desktop-light', 'light', ['chart', 'table', 'map', 'code', 'confirm', 'form', 'ui', 'offers', 'progress', 'cron', 'jobs', 'miniapps', 'miniapp']],
  ['mobile-dark', 'dark', ['chart', 'table', 'map', 'progress', 'code', 'confirm', 'form', 'ui', 'offers', 'cron', 'jobs', 'miniapps', 'miniapp']],
  ['mobile-light', 'light', ['chart', 'table', 'progress']],
]) {
  const ctx = await themed(await browser.newContext(ctxOpts(name)), theme);
  const page = await ctx.newPage();
  await login(page);
  for (const s of [...SCENARIOS, ...EXTRA].filter((x) => only.includes(x.id))) {
    await page.goto(s.path ? `${base}${s.path}` : `${base}/c/${ids[s.id]}`);
    if (s.ready) await waitReady(page, s);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${out}/${name}-${s.id}.png` });
    console.log(name, s.id);
  }
  if (name === 'mobile-dark') { // chat list in a drawer
    await page.goto(`${base}/c/${ids.chart}`);
    await page.getByRole('button', { name: TEXT.chats }).first().click().catch(() => {});
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${out}/mobile-dark-liste.png` });
  }
  await ctx.close();
}
await browser.close();
