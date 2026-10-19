// E2E of useWidth() on a phone (demo instance, DEMO_LANG=en): the width a dynamic widget reads is the width of its iframe, so a game can fit it
// instead of a fixed 320 px that would be cut on the right.
//   DEMO_LANG=en e2e/demo/demo.sh up && node e2e/ui-width.mjs
import { chromium } from 'playwright-core';

const base = `http://localhost:${process.env.DEMO_PORT ?? 8181}`;
const ok = [];
const check = (name, pass, extra = '') => { ok.push(pass); console.log(`${pass ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
try {
  for (const w of [360, 430]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 800 }, locale: 'en-US', hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    await page.goto(base);
    await page.getByLabel('Username').fill('demo');
    await page.getByLabel('Password').fill('demo-pass-123');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForTimeout(800);
    const nc = page.getByRole('button', { name: 'New conversation', exact: true });
    if (await nc.count()) await nc.click().catch(() => {});
    await page.getByRole('button', { name: 'Start' }).click({ timeout: 2000 }).catch(() => {});
    const box = page.getByPlaceholder(/Message/);
    await box.fill('Play tic-tac-toe with me');
    await box.press('Enter');
    const iframe = page.locator('iframe[title="Dynamic widget"]');
    const frame = page.frameLocator('iframe[title="Dynamic widget"]');
    await frame.getByText(/Width: \d+/).waitFor({ timeout: 20000 });
    await page.waitForTimeout(500);
    const read = Number(/Width: (\d+)/.exec(await frame.getByText(/Width: \d+/).innerText())[1]);
    const real = Math.round((await iframe.boundingBox()).width);
    check(`phone ${w}px: useWidth() is the width of the iframe`, Math.abs(read - real) <= 1, `hook ${read}px, iframe ${real}px`);
    await ctx.close();
  }
} catch (e) { check('run', false, String(e).slice(0, 300)); }
await browser.close();
process.exit(ok.every(Boolean) ? 0 : 1);
