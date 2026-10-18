// Captures du site de présentation (docs/img) à partir d'une instance AgentUI branchée sur e2e/demo/fake-agent.mjs.
//   node e2e/demo/capture.mjs <baseUrl> <utilisateur> <mot-de-passe> <dossier-sortie>
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const [base, user, pass, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const AGENT = 'Atlas';

// Chaque scénario : message envoyé, nom de la capture, attente de fin.
const SCENARIOS = [
  { id: 'chart', prompt: 'Montre-moi l’évolution des ventes de cette année', ready: 'canvas', blocking: false },
  { id: 'table', prompt: 'Fais-moi un comparatif des offres', ready: 'table', blocking: false },
  { id: 'map', prompt: 'Prépare l’itinéraire de ma visite de jeudi', ready: '.leaflet-container', blocking: false },
  { id: 'progress', prompt: 'Lance la migration vers la nouvelle base', ready: null, blocking: false, settle: 7000 },
  { id: 'code', prompt: 'Corrige le bug de date dans le script', ready: 'text=src/booking.ts', blocking: false },
  { id: 'confirm', prompt: 'Supprime les anciennes sauvegardes', ready: 'text=Garder', blocking: true },
  { id: 'form', prompt: 'Organise mon voyage à Lyon', ready: 'text=Lancer la recherche', blocking: true },
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

// 1. Desktop sombre (thème par défaut) : on joue chaque scénario (crée les discussions) et on capture
{
  const ctx = await themed(await browser.newContext(ctxOpts('desktop')), 'dark');
  const page = await ctx.newPage();
  await login(page);
  for (const s of SCENARIOS) {
    await page.getByRole('button', { name: 'Nouvelle conversation', exact: true }).click();
    await page.getByRole('button', { name: 'Démarrer' }).click({ timeout: 3000 }).catch(() => {}); // choix de l'agent
    const box = page.getByPlaceholder(`Message à ${AGENT}`);
    await box.fill(s.prompt);
    await box.press('Enter');
    if (s.ready) await page.locator(s.ready).first().waitFor({ timeout: 30000 });
    if (!s.blocking) await page.locator('[aria-label="Arrêter"]').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(s.settle ?? 2500);
    ids[s.id] = idOf(page);
    if (s.blocking) { await page.reload(); await page.locator(s.ready).first().waitFor({ timeout: 30000 }); await page.waitForTimeout(1500); } // titres de la liste à jour
    await page.screenshot({ path: `${out}/desktop-dark-${s.id}.png` });
    console.log('desktop-dark', s.id, ids[s.id]);
  }
  await ctx.close();
}

// 2. Autres variantes : on rouvre les discussions existantes
for (const [name, theme, only] of [
  ['desktop-light', 'light', ['chart', 'table', 'map', 'code', 'confirm', 'form', 'progress']],
  ['mobile-dark', 'dark', ['chart', 'table', 'map', 'progress', 'code', 'confirm', 'form']],
  ['mobile-light', 'light', ['chart', 'table', 'progress']],
]) {
  const ctx = await themed(await browser.newContext(ctxOpts(name)), theme);
  const page = await ctx.newPage();
  await login(page);
  for (const s of SCENARIOS.filter((x) => only.includes(x.id))) {
    await page.goto(`${base}/c/${ids[s.id]}`);
    if (s.ready) await page.locator(s.ready).first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${out}/${name}-${s.id}.png` });
    console.log(name, s.id);
  }
  if (name === 'mobile-dark') { // liste des discussions en tiroir
    await page.goto(`${base}/c/${ids.chart}`);
    await page.getByRole('button', { name: /discussions|menu/i }).first().click().catch(() => {});
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${out}/mobile-dark-liste.png` });
  }
  await ctx.close();
}
await browser.close();
