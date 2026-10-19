// E2E of requestFullscreen() (demo instance, DEMO_LANG=en): a custom widget opens over the whole screen without being reloaded (its own state is
// kept), the host draws a close button, Escape and the button bring it back, and a request that does not follow a click is refused.
//   DEMO_LANG=en e2e/demo/demo.sh up && node e2e/ui-fullscreen.mjs
import { chromium } from 'playwright-core';

const base = `http://localhost:${process.env.DEMO_PORT ?? 8181}`;
const ok = [];
const check = (name, pass, extra = '') => { ok.push(pass); console.log(`${pass ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const vp = { width: 390, height: 780 };
const page = await (await browser.newContext({ viewport: vp, locale: 'en-US', hasTouch: true, isMobile: true })).newPage();
try {
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
  await frame.getByText('Fullscreen: off').waitFor({ timeout: 20000 });
  await frame.locator('button:not([disabled])').first().waitFor({ timeout: 10000 });
  const small = await iframe.boundingBox();

  // 1. a request that does not follow a click in the widget is refused
  const sneaky = await frame.locator('body').evaluate(() => new Promise((res) => {
    window.addEventListener('message', (e) => e.data?.type === 'agentui:fullscreen.result' && res(e.data.ok));
    window.parent.postMessage({ type: 'agentui:fullscreen', id: 'x1', on: true }, '*');
  }));
  check('a request without a click in the widget is refused', sneaky === false);

  // 2. click on the widget's button: the same iframe covers the viewport
  await frame.getByRole('button', { name: 'Fullscreen' }).click();
  await frame.getByText(/Fullscreen: on/).waitFor({ timeout: 8000 });
  await page.waitForTimeout(400);
  const big = await iframe.boundingBox();
  check('the iframe covers the whole viewport', Math.abs(big.width - vp.width) <= 1 && Math.abs(big.height - vp.height) <= 1, `${Math.round(big.width)}x${Math.round(big.height)} (was ${Math.round(small.width)}x${Math.round(small.height)})`);
  const seen = /Fullscreen: on (\d+)x(\d+)/.exec(await frame.getByText(/Fullscreen: on/).innerText());
  check('useWidth()/useHeight() give the full screen size', Math.abs(Number(seen[1]) - vp.width) <= 1 && Math.abs(Number(seen[2]) - vp.height) <= 1, `${seen[1]}x${seen[2]}`);
  check('the host draws a close button', (await page.getByRole('button', { name: 'Exit full screen' }).count()) === 1);
  await frame.getByRole('button').nth(0).click();
  await frame.getByText('Clicks: 1').waitFor({ timeout: 8000 });

  // 3. close from the host button: back in the chat, same component (the clicks counter survived, nothing was reloaded)
  await page.getByRole('button', { name: 'Exit full screen' }).click();
  await frame.getByText('Fullscreen: off').waitFor({ timeout: 8000 });
  await page.waitForTimeout(400);
  const back = await iframe.boundingBox();
  check('back in the chat at its normal size', Math.abs(back.width - small.width) <= 1 && back.height < vp.height - 100, `${Math.round(back.width)}x${Math.round(back.height)}`);
  check('the widget was not reloaded (own state kept)', (await frame.getByText('Clicks: 1').count()) === 1);
  check('still a single widget', (await iframe.count()) === 1);

  // 4. open again, close with Escape typed inside the widget
  await frame.getByRole('button', { name: 'Fullscreen' }).click();
  await frame.getByText(/Fullscreen: on/).waitFor({ timeout: 8000 });
  await frame.locator('body').press('Escape');
  await frame.getByText('Fullscreen: off').waitFor({ timeout: 8000 }).then(() => check('Escape inside the widget closes the full screen', true), () => check('Escape inside the widget closes the full screen', false));

  // 5. open again, close from the widget itself
  await frame.getByRole('button', { name: 'Fullscreen' }).click();
  await frame.getByText(/Fullscreen: on/).waitFor({ timeout: 8000 });
  await frame.getByRole('button', { name: 'Close it' }).click();
  await frame.getByText('Fullscreen: off').waitFor({ timeout: 8000 }).then(() => check('exitFullscreen() from the widget works', true), () => check('exitFullscreen() from the widget works', false));
} catch (e) { check('run', false, String(e).slice(0, 300)); }
await browser.close();
process.exit(ok.every(Boolean) ? 0 : 1);
