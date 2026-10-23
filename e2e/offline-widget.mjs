// E2E: a widget already seen still opens offline (service worker cache, one week). Usage:
//   DEMO_LANG=en e2e/demo/demo.sh up && node e2e/offline-widget.mjs
import { chromium } from 'playwright-core';

const base = `http://localhost:${process.env.DEMO_PORT ?? 8181}`;
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
const page = await ctx.newPage();
let pass = false;
try {
  await page.goto(base);
  await page.getByLabel('Username').fill('demo');
  await page.getByLabel('Password').fill('demo-pass-123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.getByRole('button', { name: 'Start' }).click({ timeout: 3000 }).catch(() => {});
  const box = page.getByPlaceholder(/Message/);
  await box.fill('Show me the shortlist');
  await box.press('Enter');
  const frame = page.frameLocator('iframe[title]').first();
  await frame.getByText('Nimbus Pro').first().waitFor({ timeout: 20000 });
  await page.waitForFunction(() => navigator.serviceWorker?.controller);
  await page.waitForTimeout(1000); // lets the service worker finish storing the widget's files

  // A second conversation, so that the first one can be left and reopened (its messages then come from memory).
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.getByRole('button', { name: 'Start' }).click({ timeout: 3000 }).catch(() => {});
  await box.fill('Hello');
  await box.press('Enter');
  await page.getByText('Hello').first().waitFor();
  await page.waitForTimeout(1500);

  const open = (title) => page.locator('li, [role=button]').filter({ hasText: title }).first().click();
  await open('Show me the shortlist'); // reading it fills the in-memory cache of its messages
  await page.frameLocator('iframe[title]').first().getByText('Nimbus Pro').first().waitFor();
  await open('Hello');
  await page.waitForTimeout(500);

  await ctx.setOffline(true);
  await open('Show me the shortlist');
  const back = page.frameLocator('iframe[title]').first();
  pass = await back.getByText('Nimbus Pro').first().waitFor({ timeout: 10000 }).then(() => true, () => false);
  await page.screenshot({ path: '/tmp/offline-widget.png' });
} catch (e) { console.log(String(e).slice(0, 400)); }
console.log(pass ? 'OK   widget opens offline' : 'FAIL widget offline');
await browser.close();
process.exit(pass ? 0 : 1);
