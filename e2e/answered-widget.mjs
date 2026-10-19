// E2E: an interactive widget (confirm) must stay a widget after the user's answer while the run goes on (not raw JSON until the end).
//   DEMO_LANG=en DEMO_REPLY_DELAY=4000 e2e/demo/demo.sh up && node e2e/answered-widget.mjs
import { chromium } from 'playwright-core';

const base = `http://localhost:${process.env.DEMO_PORT ?? 8181}`;
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' })).newPage();
let pass = false;
try {
  await page.goto(base);
  await page.getByLabel('Username').fill('demo');
  await page.getByLabel('Password').fill('demo-pass-123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.getByRole('button', { name: 'Start' }).click({ timeout: 3000 }).catch(() => {});
  const box = page.getByPlaceholder(/Message/);
  await box.fill('Delete the old backups');
  await box.press('Enter');
  await page.getByRole('button', { name: 'Keep' }).click({ timeout: 20000 });
  await page.waitForTimeout(1500); // the run is still going (DEMO_REPLY_DELAY)
  const running = await page.locator('[aria-label="Stop"]').count();
  const raw = await page.locator('pre', { hasText: '"type":"confirm"' }).count();
  const card = await page.getByText('Delete 14 backups older than 90 days?').count();
  console.log({ running, raw, card });
  pass = running > 0 && raw === 0 && card > 0;
} catch (e) { console.log(String(e).slice(0, 300)); }
console.log(pass ? 'OK   answered widget stays a widget while the run continues' : 'FAIL answered widget');
await browser.close();
process.exit(pass ? 0 : 1);
