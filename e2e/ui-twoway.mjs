// E2E of live two-way dynamic widgets (demo instance, DEMO_LANG=en): the agent keeps a session open (agentui_custom_widget_wait); each click in the
// widget (reply(…, { silent: true })) reaches it as an event, it pushes a new state to the SAME widget (agentui_custom_widget update) and listens again.
// No new run, no new bubble, no hidden turn; the widget is only live while the agent listens.
//   DEMO_LANG=en e2e/demo/demo.sh up && node e2e/ui-twoway.mjs
import { chromium } from 'playwright-core';

const base = `http://localhost:${process.env.DEMO_PORT ?? 8181}`;
const ok = [];
const check = (name, pass, extra = '') => { ok.push(pass); console.log(`${pass ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' })).newPage();
try {
  await page.goto(base);
  await page.getByLabel('Username').fill('demo');
  await page.getByLabel('Password').fill('demo-pass-123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.getByRole('button', { name: 'Start' }).click({ timeout: 3000 }).catch(() => {});
  const box = page.getByPlaceholder(/Message|answer/i);
  await box.fill('Play tic-tac-toe with me');
  await box.press('Enter');
  const frame = page.frameLocator('iframe[title="Dynamic widget"]');
  await frame.getByText('Your turn (X)').waitFor({ timeout: 20000 });
  const live = () => frame.locator('button:not([disabled])').first().waitFor({ timeout: 10000 }); // the board is live while the agent listens
  await live();
  check('the widget is live while the agent listens (run still open)', (await page.locator('[aria-label="Stop"]').count()) === 1);

  const play = async (n, cell, answer) => {
    await page.waitForTimeout(1700); // reply() is limited to one per 1.5 s
    await frame.getByRole('button').nth(cell).click();
    await frame.getByText(`Clicks: ${n}`).waitFor({ timeout: 8000 });
    await frame.getByText(answer).waitFor({ timeout: 10000 });
    await live();
  };
  await play(1, 0, /I played 2\./);
  await play(2, 4, /I played 3\./);
  const marks = await frame.getByRole('button').allTextContents();
  check('the agent\'s moves were pushed into the same widget', marks.filter((t) => t === 'O').length === 2 && marks.filter((t) => t === 'X').length === 2, marks.join(''));
  check('the widget kept its own state (clicks counter) across the updates', (await frame.getByText('Clicks: 2').count()) === 1);
  check('a single message holds the widget: no bubble per move', (await page.locator('[data-role="assistant"]').count()) === 1);
  check('a single widget in the chat', (await page.locator('iframe[title="Dynamic widget"]').count()) === 1);
  check('the widget events are not shown in the chat', (await page.getByText(/move \d|widget-event/).count()) === 0);

  // The session survives a page reload: the board is live again with the latest state
  await page.reload();
  await frame.getByText(/I played 3\./).waitFor({ timeout: 15000 });
  await live();
  check('after a reload the widget shows the latest state and is still live', true);
  check('hidden events stay hidden after a reload', (await page.getByText(/move \d|widget-event/).count()) === 0);
  await page.waitForTimeout(1700);
  await frame.getByRole('button').nth(8).click();
  await frame.getByText(/I played 4\./).waitFor({ timeout: 10000 }).then(() => check('the session still answers after the reload', true), () => check('the session still answers after the reload', false));
} catch (e) { check('run', false, String(e).slice(0, 300)); }
await browser.close();
process.exit(ok.every(Boolean) ? 0 : 1);
