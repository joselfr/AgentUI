// Attachments E2E. Usage: node e2e/attachments.mjs <baseUrl> <server DATA_DIR> <screenshots-folder>
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
await page.getByLabel('Username').fill(env.ADMIN_USER);
await page.getByLabel('Password').fill(env.ADMIN_PASSWORD);
await page.getByRole('button', { name: 'Se connecter' }).click();
await page.getByText('Nouvelle conversation').first().waitFor();
await page.getByRole('button', { name: /^Hermes/ }).first().click();
await page.getByRole('button', { name: 'Nouvelle conversation' }).click();
const input = page.getByTestId('file-input');
const box = page.getByPlaceholder('Message Hermes');
const waitIdle = async (ms = 120000) => {
  await page.locator('[aria-label="Stop"]').waitFor({ state: 'attached', timeout: 15000 }).catch(() => {});
  const stop = page.locator('[aria-label="Stop"]');
  await stop.waitFor({ state: 'detached', timeout: ms }).catch(async () => { await stop.click().catch(() => {}); });
};

// 1. PDF refused on Hermes (images + text only)
await input.setInputFiles({ name: 'doc.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n\0binaire') });
check('PDF refused client-side with a clear message', await page.getByText(/only accepts images and text files/).isVisible());
check('PDF: no chip added', (await page.locator('.MuiChip-deletable').count()) === 0);

// 2. image via the button → chip with preview
await input.setInputFiles({ name: 'rouge.png', mimeType: 'image/png', buffer: RED });
check('image: chip with preview', (await page.locator('.MuiChip-deletable img').count()) === 1);
await page.screenshot({ path: `${shots}/a1-pastille.png` });
// retrait
await page.locator('.MuiChip-deletable .MuiChip-deleteIcon').click();
check('pastille retirable', (await page.locator('.MuiChip-deletable').count()) === 0);

// 3. pasting an image (Ctrl+V) + drag-and-drop of a text file
await box.click();
await page.evaluate(async ([b64]) => {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const dt = new DataTransfer(); dt.items.add(new File([bin], 'collee.png', { type: 'image/png' }));
  document.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
}, [RED.toString('base64')]);
check('collage d\'image', (await page.locator('.MuiChip-deletable img').count()) === 1);
await page.evaluate(() => {
  const dt = new DataTransfer(); dt.items.add(new File(['The secret code is ZEBRA-4242.\n'], 'secret.txt', { type: 'text/plain' }));
  const root = document.querySelector('textarea').closest('.MuiBox-root').parentElement;
  root.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
});
check('drag hover: drop zone visible', await page.getByText('Drop your files here').isVisible());
await page.screenshot({ path: `${shots}/a2-depot.png` });
await page.evaluate(() => {
  const dt = new DataTransfer(); dt.items.add(new File(['The secret code is ZEBRA-4242.\n'], 'secret.txt', { type: 'text/plain' }));
  document.querySelector('textarea').closest('.MuiBox-root').parentElement.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
});
check('text file drop', (await page.locator('.MuiChip-deletable').count()) === 2);
// we remove the pasted image so that the answer is about the text (more deterministic)
await page.locator('.MuiChip-deletable').first().locator('.MuiChip-deleteIcon').click();

// 4. send: text + file → the agent reads the file
await box.fill('What is the secret code in the attached file? Answer only with the code.');
await box.press('Enter');
check('user bubble: attachment displayed', await page.locator('[data-role=user] a[download]').first().waitFor({ timeout: 10000 }).then(() => true, () => false));
await waitIdle();
const ans = await page.locator('[data-role=assistant]').last().innerText();
check('the agent read the text file', /ZEBRA-4242/.test(ans), JSON.stringify(ans.slice(-40)));
await page.screenshot({ path: `${shots}/a3-file.png` });

// 5. image alone (no text) → bubble with thumbnail, run started
await input.setInputFiles({ name: 'rouge.png', mimeType: 'image/png', buffer: RED });
await page.getByRole('button', { name: 'Envoyer' }).click();
const img = page.locator('[data-role=user] img').first();
await img.waitFor({ timeout: 10000 });
await img.evaluate((i) => i.decode().catch(() => {}));
check('image sent without text: thumbnail in the bubble', await img.evaluate((i) => i.complete && i.naturalWidth === 64));
await waitIdle(90000);
await page.screenshot({ path: `${shots}/a4-image.png` });

// 6. reload: attachments come from the server
await page.reload();
await page.getByText('What is the secret code').first().click();
await page.locator('[data-role=user] img').first().waitFor({ timeout: 10000 });
const ok = await page.locator('[data-role=user] img').first().evaluate((i) => i.complete && i.naturalWidth === 64 && i.src.includes('/api/attachments/'));
check('after reload: image served by /api/attachments', ok);
check('after reload: text file downloadable', (await page.locator('[data-role=user] a[download]').count()) >= 1);
const dl = await page.evaluate(async () => { const a = document.querySelector('[data-role=user] a[download]'); const r = await fetch(a.href); return { s: r.status, ct: r.headers.get('content-type'), cd: r.headers.get('content-disposition'), t: await r.text() }; });
check('download: octet-stream + attachment + content intact', dl.s === 200 && dl.ct === 'application/octet-stream' && /attachment/.test(dl.cd) && dl.t.includes('ZEBRA-4242'), `${dl.ct} ${dl.cd}`);

// 7. conversation deletion → files deleted from disk
const upl = () => (existsSync(`${dataDir}/uploads`) ? readdirSync(`${dataDir}/uploads`).length : 0);
const before = upl();
page.once('dialog', (d) => d.accept());
await page.getByRole('button', { name: 'Supprimer', exact: true }).first().click();
await page.waitForTimeout(1500);
check('conversation deletion: uploads folder removed', before >= 1 && upl() === before - 1, `${before} → ${upl()}`);
check('no JS error', errors.length === 0, errors.join(' | ').slice(0, 200));
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} checks OK`);
process.exit(results.every(Boolean) ? 0 : 1);
