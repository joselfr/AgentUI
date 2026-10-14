// E2E navigateur (Chromium système). Usage : node e2e/front.mjs <baseUrl> <dossier-captures>
import { chromium } from 'playwright-core';
import { readFileSync, mkdirSync } from 'node:fs';
const [base, shots] = [process.argv[2], process.argv[3]];
mkdirSync(shots, { recursive: true });
const env = Object.fromEntries(readFileSync('.env', 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const MSG = "Exécute la commande shell 'echo pong' puis réponds uniquement le mot: PONG";

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'fr-FR' });
const errors = [];
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !/favicon|401/.test(m.text()) && errors.push(m.text()));

// 1. Login
await page.goto(base);
await page.getByLabel('Utilisateur').waitFor();
await page.screenshot({ path: `${shots}/1-login.png` });
await page.getByLabel('Utilisateur').fill('mauvais');
await page.getByLabel('Mot de passe').fill('mauvais-mdp');
await page.getByRole('button', { name: 'Se connecter' }).click();
check('login refusé avec mauvais identifiants', await page.getByText('Identifiants invalides').waitFor({ timeout: 5000 }).then(() => true, () => false));
await page.screenshot({ path: `${shots}/1b-login-refuse.png` });
await page.getByLabel('Utilisateur').fill(env.ADMIN_USER);
await page.getByLabel('Mot de passe').fill(env.ADMIN_PASSWORD);
await page.getByRole('button', { name: 'Se connecter' }).click();
await page.getByText('Nouvelle conversation').first().waitFor({ timeout: 10000 });
check('login accepté', true);

// 2. Agents visibles + connectés
await page.getByText('OpenClaw').first().waitFor();
await page.getByText('Hermes').first().waitFor();
check('les 2 agents sont listés', true);
await page.screenshot({ path: `${shots}/2-accueil.png` });

// 3. Chat OpenClaw avec outils
async function chat(agent) {
  await page.getByRole('button', { name: new RegExp(`^${agent}`) }).first().click();
  await page.getByRole('button', { name: 'Nouvelle conversation' }).click();
  const box = page.getByPlaceholder(`Message à ${agent}`);
  await box.fill(MSG);
  await box.press('Enter');
  await page.getByText(/outils? utilisés?/).first().waitFor({ timeout: 90000 }).catch(() => {});
  await page.locator('[aria-label="Arrêter"]').waitFor({ state: 'detached', timeout: 120000 }).catch(() => {});
}
await chat('OpenClaw');
const lastAssistant = () => page.locator('[data-role=assistant]').last().innerText().catch(() => '');
const ocText = await lastAssistant();
check('OpenClaw : réponse de l\'agent', /PONG/i.test(ocText), JSON.stringify(ocText.slice(-80)));
check('OpenClaw : carte « outils utilisés »', await page.getByText(/outils? utilisés?/).first().waitFor({ timeout: 5000 }).then(() => true, () => false));
await page.getByText(/outils? utilisés?/).first().click();
await page.getByText('exec').first().waitFor({ timeout: 5000 }).catch(() => {});
await page.getByText('exec').first().click().catch(() => {});
await page.waitForTimeout(800);
await page.screenshot({ path: `${shots}/3-openclaw-outils.png` });

// 4. Chat Hermes
await chat('Hermes');
const hText = await lastAssistant();
check('Hermes : réponse de l\'agent', /PONG/i.test(hText), JSON.stringify(hText.slice(-80)));
check('Hermes : carte outils', await page.getByText(/outils? utilisés?/).first().waitFor({ timeout: 5000 }).then(() => true, () => false));
await page.getByText(/outils? utilisés?/).first().click();
await page.waitForTimeout(800);
await page.screenshot({ path: `${shots}/4-hermes.png` });

// 5. Panneau agents / skills / tâches
await page.getByRole('button', { name: 'Agents, skills et tâches' }).click();
await page.getByRole('tab', { name: 'Skills' }).click();
await page.getByText('claude-code').first().waitFor({ timeout: 10000 }).catch(() => {});
check('Hermes : skills listés', await page.getByText('claude-code').first().isVisible());
await page.getByRole('tab', { name: 'Tâches' }).click();
await page.getByText('rapport-docker-quotidien').waitFor({ timeout: 10000 }).catch(() => {});
check('Hermes : tâches listées', await page.getByText('rapport-docker-quotidien').isVisible().catch(() => false));
await page.screenshot({ path: `${shots}/5-taches-hermes.png` });
await page.keyboard.press('Escape');

// 6. Fermeture d'onglet en plein run → le résultat doit être là au retour
const p2 = await ctx.newPage();
await p2.goto(base);
await p2.getByRole('button', { name: /^OpenClaw/ }).first().click();
await p2.getByRole('button', { name: 'Nouvelle conversation' }).click();
const box2 = p2.getByPlaceholder('Message à OpenClaw');
await box2.fill("Réponds uniquement: PERSISTANT");
await box2.press('Enter');
await p2.waitForTimeout(700);
await p2.close(); // fermeture immédiate pendant le run
await page.waitForTimeout(15000);
await page.reload();
await page.getByText('Réponds uniquement: PERSISTANT').first().click();
await page.locator('[data-role=assistant]').last().waitFor({ timeout: 10000 }).catch(() => {});
const back = await lastAssistant();
check('run terminé après fermeture de l\'onglet', /PERSISTANT/i.test(back), JSON.stringify(back.slice(-60)));
await page.screenshot({ path: `${shots}/6-persistance.png` });

// 6b. Suppression d'une conversation depuis l'interface
const nbAvant = await page.getByRole('button', { name: 'Supprimer', exact: true }).count();
page.once('dialog', (d) => d.accept());
await page.getByRole('button', { name: 'Supprimer', exact: true }).first().click();
await page.waitForTimeout(1000);
check('suppression de conversation', (await page.getByRole('button', { name: 'Supprimer', exact: true }).count()) === nbAvant - 1);

// 7. PWA : manifest + service worker
const man = await page.evaluate(() => fetch('/manifest.webmanifest').then((r) => r.json()));
check('PWA : manifest', man.name === 'AgentUI' && man.display === 'standalone');
const sw = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.state ?? 'aucun');
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
check('mobile : pas de défilement horizontal', !overflow);

check('aucune erreur JS console', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} vérifications OK`);
process.exit(results.every(Boolean) ? 0 : 1);
