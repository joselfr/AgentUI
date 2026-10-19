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

  // 2. reply to a whole message (hover action)
  const bubble = page.locator('[data-bubble][data-role="assistant"]').first();
  await bubble.hover();
  await bubble.getByRole('button', { name: 'Reply' }).click();
  await chip.waitFor({ timeout: 3000 });
  check('the Reply action of a bubble quotes the whole message', (await chip.innerText()).includes('Here is the revenue trend'));
  await chip.getByRole('button', { name: 'Remove the quote' }).click();
  check('the quote can be removed', (await page.getByTestId('composer-quote').count()) === 0);
  // 3. copy a whole message
  await bubble.hover();
  await bubble.getByRole('button', { name: 'Copy', exact: true }).click();
  await page.waitForTimeout(200);
  check('the Copy action copies the message text', (await page.evaluate(() => navigator.clipboard.readText())).includes('Here is the revenue trend'));
} catch (e) { check('run', false, String(e).slice(0, 300)); await page.screenshot({ path: join(shots, 'fail.png') }); }
await browser.close();
process.exit(ok.every(Boolean) ? 0 : 1);
