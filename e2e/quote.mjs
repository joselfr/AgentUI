// E2E: reply to a message / to a selected text (quote in the composer, rendered in the bubble) and copy still works.
//   DEMO_LANG=en e2e/demo/demo.sh up && node e2e/quote.mjs [screenshots-folder]
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const base = `http://localhost:${process.env.DEMO_PORT ?? 8181}`;
const shots = process.argv[2] ?? join(tmpdir(), 'agentui-quote-shots');
mkdirSync(shots, { recursive: true });
const ok = [];
const check = (name, pass, extra = '') => { ok.push(pass); console.log(`${pass ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US', permissions: ['clipboard-read', 'clipboard-write'] });
const page = await ctx.newPage();
try {
  await page.goto(base);
  await page.getByLabel('Username').fill('demo');
  await page.getByLabel('Password').fill('demo-pass-123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.getByRole('button', { name: 'Start' }).click({ timeout: 3000 }).catch(() => {});
  const box = page.getByPlaceholder(/Message/);
  await box.fill('Show me the sales trend');
  await box.press('Enter');
  const answer = page.getByText('Here is the revenue trend, compared with last year.');
  await answer.waitFor({ timeout: 20000 });
  await page.locator('[aria-label="Stop"]').waitFor({ state: 'detached', timeout: 20000 }).catch(() => {});

  // 1. select a sentence → toolbar → Reply
  await answer.click({ clickCount: 3 });
  const bar = page.getByTestId('selection-quote');
  await bar.waitFor({ timeout: 3000 });
  check('selecting text shows the Reply / Copy toolbar', true);
  const selected = await page.evaluate(() => window.getSelection().toString().trim());
  await bar.getByRole('button', { name: 'Copy', exact: true }).click();
  await page.waitForTimeout(200);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check('Copy puts the selection in the clipboard', clip.trim() === selected && selected.length > 10, clip.slice(0, 40));
  check('the selection is still there after Copy (native copy keeps working)', (await page.evaluate(() => window.getSelection().toString().trim())) === selected);
  await bar.getByRole('button', { name: 'Reply' }).click();
  const chip = page.getByTestId('composer-quote');
  await chip.waitFor({ timeout: 3000 });
  check('Reply quotes the selection above the composer', (await chip.innerText()).includes('Here is the revenue trend'));
  await page.screenshot({ path: join(shots, 'quote-composer.png') });
  await box.fill('Why this trend?');
  await box.press('Enter');
  await page.getByTestId('bubble-quote').first().waitFor({ timeout: 8000 });
  const q = await page.getByTestId('bubble-quote').first().innerText();
  check('the sent message shows the quote and the text', q.includes('Here is the revenue trend') && (await page.getByText('Why this trend?').count()) > 0);
  await page.getByTestId('composer-quote').waitFor({ state: 'detached', timeout: 5000 }).then(() => check('the composer quote is cleared after sending', true), () => check('the composer quote is cleared after sending', false));
  await page.locator('[aria-label="Stop"]').waitFor({ state: 'detached', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(shots, 'quote-sent.png') });

  // 2. whole message: right click (menu), or the discreet ⋯ on hover — no permanent buttons
  const bubble = page.locator('[data-bubble][data-role="assistant"]').first();
  const more = bubble.getByRole('button', { name: 'More actions' });
  await page.mouse.move(5, 5);
  await page.waitForTimeout(400); // opacity transition
  check('no button is visible on a message at rest', (await more.evaluate((e) => getComputedStyle(e).opacity)) === '0');
  await answer.first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Reply' }).click();
  await chip.waitFor({ timeout: 3000 });
  check('right click → Reply quotes the whole message', (await chip.innerText()).includes('Here is the revenue trend'));
  await chip.getByRole('button', { name: 'Remove the quote' }).click();
  await bubble.hover();
  await more.click();
  await page.getByRole('menuitem', { name: 'Reply' }).waitFor();
  check('the ⋯ button opens the same menu', true);
  await page.getByRole('menuitem', { name: 'Copy' }).click();
  await page.waitForTimeout(200);
  check('menu → Copy copies the message text', (await page.evaluate(() => navigator.clipboard.readText())).includes('Here is the revenue trend'));
  // right click on a selection keeps the browser's own menu (copy stays native)
  await answer.first().click({ clickCount: 3 });
  await answer.first().click({ button: 'right' });
  await page.waitForTimeout(300);
  check('right click on a selection does not open our menu', (await page.getByRole('menuitem', { name: 'Reply' }).count()) === 0);
  await page.keyboard.press('Escape');

  // 3. mobile: nothing visible at rest, the selection bar is docked at the bottom (the system menu shows above the selection)
  const mctx = await browser.newContext({ viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true, locale: 'en-US' });
  const m = await mctx.newPage();
  await m.goto(base);
  await m.getByLabel('Username').fill('demo');
  await m.getByLabel('Password').fill('demo-pass-123');
  await m.getByRole('button', { name: 'Sign in' }).click();
  await m.waitForTimeout(1500);
  await m.goto(page.url());
  const mtext = m.getByText('Here is the revenue trend, compared with last year.').first();
  await mtext.waitFor({ timeout: 15000 });
  check('mobile: the ⋯ button is not shown', (await m.locator('.bubble-more').first().evaluate((e) => getComputedStyle(e).display)) === 'none');
  check('mobile: no Reply / Copy buttons on messages', (await m.getByRole('button', { name: 'Reply', exact: true }).count()) === 0);
  await m.evaluate(() => { const el = [...document.querySelectorAll('p')].find((p) => p.textContent.startsWith('Here is the revenue')); const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
  const mbar = m.getByTestId('selection-quote');
  await mbar.waitFor({ timeout: 3000 });
  const pos = await mbar.boundingBox();
  const textPos = await mtext.boundingBox();
  check('mobile: the selection bar is docked at the bottom, away from the selection', pos.y > textPos.y + textPos.height + 40 && pos.y + pos.height < 780, `bar y=${Math.round(pos.y)} text y=${Math.round(textPos.y)}`);
  await m.screenshot({ path: join(shots, 'quote-mobile.png') });
  await mbar.getByRole('button', { name: 'Message', exact: true }).click();
  await m.getByTestId('composer-quote').waitFor({ timeout: 3000 });
  check('mobile: Message button quotes the full message', true);
} catch (e) { check('run', false, String(e).slice(0, 300)); await page.screenshot({ path: join(shots, 'fail.png') }); }
await browser.close();
process.exit(ok.every(Boolean) ? 0 : 1);
