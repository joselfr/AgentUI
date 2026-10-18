// E2E pièces jointes. Usage : node e2e/attachments.mjs <baseUrl> <DATA_DIR du serveur> <dossier-captures>
import { chromium } from 'playwright-core';
import { readFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
const [base, dataDir, shots] = process.argv.slice(2);
mkdirSync(shots, { recursive: true });
const env = Object.fromEntries(readFileSync('.env', 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const results = [];
const check = (n, v, x = '') => { results.push(v); console.log(`${v ? 'OK  ' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };

function png(n, [r, g, b]) {
  const chunk = (t, d) => { const h = Buffer.alloc(4); h.writeUInt32BE(d.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([Buffer.from(t), d])) >>> 0); return Buffer.concat([h, Buffer.from(t), d, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: n }, () => [r, g, b]).flat())]);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array(n).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}
const RED = png(64, [255, 0, 0]);

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'fr-FR' })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(base);
await page.getByLabel('Utilisateur').fill(env.ADMIN_USER);
await page.getByLabel('Mot de passe').fill(env.ADMIN_PASSWORD);
await page.getByRole('button', { name: 'Se connecter' }).click();
await page.getByText('Nouvelle conversation').first().waitFor();
await page.getByRole('button', { name: /^Hermes/ }).first().click();
await page.getByRole('button', { name: 'Nouvelle conversation' }).click();
const input = page.getByTestId('file-input');
const box = page.getByPlaceholder('Message à Hermes');
const waitIdle = async (ms = 120000) => {
  await page.locator('[aria-label="Arrêter"]').waitFor({ state: 'attached', timeout: 15000 }).catch(() => {});
  const stop = page.locator('[aria-label="Arrêter"]');
  await stop.waitFor({ state: 'detached', timeout: ms }).catch(async () => { await stop.click().catch(() => {}); });
};

// 1. PDF refusé sur Hermes (images + texte seulement)
await input.setInputFiles({ name: 'doc.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n\0binaire') });
check('PDF refusé côté client avec message clair', await page.getByText(/n'accepte que les images et les fichiers texte/).isVisible());
check('PDF : aucune pastille ajoutée', (await page.locator('.MuiChip-deletable').count()) === 0);

// 2. image par le bouton → pastille avec aperçu
await input.setInputFiles({ name: 'rouge.png', mimeType: 'image/png', buffer: RED });
check('image : pastille avec aperçu', (await page.locator('.MuiChip-deletable img').count()) === 1);
await page.screenshot({ path: `${shots}/a1-pastille.png` });
// retrait
await page.locator('.MuiChip-deletable .MuiChip-deleteIcon').click();
check('pastille retirable', (await page.locator('.MuiChip-deletable').count()) === 0);

// 3. collage d'une image (Ctrl+V) + glisser-déposer d'un fichier texte
await box.click();
await page.evaluate(async ([b64]) => {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const dt = new DataTransfer(); dt.items.add(new File([bin], 'collee.png', { type: 'image/png' }));
  document.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
}, [RED.toString('base64')]);
check('collage d\'image', (await page.locator('.MuiChip-deletable img').count()) === 1);
await page.evaluate(() => {
  const dt = new DataTransfer(); dt.items.add(new File(['Le code secret est ZEBRE-4242.\n'], 'secret.txt', { type: 'text/plain' }));
  const root = document.querySelector('textarea').closest('.MuiBox-root').parentElement;
  root.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
});
check('survol glisser-déposer : zone de dépôt visible', await page.getByText('Déposez vos fichiers ici').isVisible());
await page.screenshot({ path: `${shots}/a2-depot.png` });
await page.evaluate(() => {
  const dt = new DataTransfer(); dt.items.add(new File(['Le code secret est ZEBRE-4242.\n'], 'secret.txt', { type: 'text/plain' }));
  document.querySelector('textarea').closest('.MuiBox-root').parentElement.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
});
check('dépôt d\'un fichier texte', (await page.locator('.MuiChip-deletable').count()) === 2);
// on retire l'image collée pour que la réponse porte sur le texte (plus déterministe)
await page.locator('.MuiChip-deletable').first().locator('.MuiChip-deleteIcon').click();

// 4. envoi : texte + fichier → l'agent lit le fichier
await box.fill('Quel est le code secret du fichier joint ? Réponds seulement par le code.');
await box.press('Enter');
check('bulle utilisateur : pièce jointe affichée', await page.locator('[data-role=user] a[download]').first().waitFor({ timeout: 10000 }).then(() => true, () => false));
await waitIdle();
const ans = await page.locator('[data-role=assistant]').last().innerText();
check('l\'agent a lu le fichier texte', /ZEBRE-4242/.test(ans), JSON.stringify(ans.slice(-40)));
await page.screenshot({ path: `${shots}/a3-fichier.png` });

// 5. image seule (sans texte) → bulle avec miniature, run lancé
await input.setInputFiles({ name: 'rouge.png', mimeType: 'image/png', buffer: RED });
await page.getByRole('button', { name: 'Envoyer' }).click();
const img = page.locator('[data-role=user] img').first();
await img.waitFor({ timeout: 10000 });
await img.evaluate((i) => i.decode().catch(() => {}));
check('image envoyée sans texte : miniature dans la bulle', await img.evaluate((i) => i.complete && i.naturalWidth === 64));
await waitIdle(90000);
await page.screenshot({ path: `${shots}/a4-image.png` });

// 6. rechargement : les pièces jointes viennent du serveur
await page.reload();
await page.getByText('Quel est le code secret').first().click();
await page.locator('[data-role=user] img').first().waitFor({ timeout: 10000 });
const ok = await page.locator('[data-role=user] img').first().evaluate((i) => i.complete && i.naturalWidth === 64 && i.src.includes('/api/attachments/'));
check('après rechargement : image servie par /api/attachments', ok);
check('après rechargement : fichier texte téléchargeable', (await page.locator('[data-role=user] a[download]').count()) >= 1);
const dl = await page.evaluate(async () => { const a = document.querySelector('[data-role=user] a[download]'); const r = await fetch(a.href); return { s: r.status, ct: r.headers.get('content-type'), cd: r.headers.get('content-disposition'), t: await r.text() }; });
check('téléchargement : octet-stream + attachment + contenu intact', dl.s === 200 && dl.ct === 'application/octet-stream' && /attachment/.test(dl.cd) && dl.t.includes('ZEBRE-4242'), `${dl.ct} ${dl.cd}`);

// 7. suppression de la conversation → fichiers supprimés du disque
const upl = () => (existsSync(`${dataDir}/uploads`) ? readdirSync(`${dataDir}/uploads`).length : 0);
const avant = upl();
page.once('dialog', (d) => d.accept());
await page.getByRole('button', { name: 'Supprimer', exact: true }).first().click();
await page.waitForTimeout(1500);
check('suppression conversation : dossier d\'uploads supprimé', avant >= 1 && upl() === avant - 1, `${avant} → ${upl()}`);
check('aucune erreur JS', errors.length === 0, errors.join(' | ').slice(0, 200));
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} vérifications OK`);
process.exit(results.every(Boolean) ? 0 : 1);
