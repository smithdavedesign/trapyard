#!/usr/bin/env node
// npm run screenshots: proof that the launch-ready site does its job, as PNGs in docs/screenshots/.
//
// It starts the app itself: `trapyard serve` on a free port on 127.0.0.1 (the handler the Vercel
// function runs, with runs in memory), with a placeholder STRIPE_PAYMENT_LINK so the Buy button shows.
// It waits until the app answers, then at desktop size (1280×800) and on a phone (iPhone 13),
// viewport only:
//   home  the landing page: "Start a free run" and the Buy button
//   run   the core action: the visitor presses "Start a free run" and gets the agent's task URL and the
//         score card and report links, with the footer (privacy, terms, contact) in view
//   card  the result: the deliberately vulnerable stub agent (sample data only) did that run's task,
//         and its score card shows 4 of 4 traps fell, with its share image
// Then it stops the app. Playwright's browser reports navigator.webdriver, and the app has no
// VERCEL_ENV, so the visit beacon sends nothing.
//
// Chromium comes from CHROMIUM_PATH; no browser is ever downloaded. Not part of `npm test`.

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright-core';
import { vulnerableAgent } from '../test/stubs/agents.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'screenshots');
const CLI = join(ROOT, 'bin', 'trapyard.js');
const PAYMENT_LINK = 'https://example.com/pay'; // a placeholder: no real payment link in a screenshot
const START_TIMEOUT_MS = 15_000;

const SIZES = {
  desktop: { viewport: { width: 1280, height: 800 } },
  mobile: { ...devices['iPhone 13'] },
};

/** Starts `trapyard serve` on a free port; resolves with its origin and a stop() that waits for it to exit. */
function startApp() {
  // Only what the app needs: no setting from this shell (a database, a Stripe key) reaches it.
  const env = { PATH: process.env.PATH, STRIPE_PAYMENT_LINK: PAYMENT_LINK };
  const child = spawn(process.execPath, [CLI, 'serve', '--port', '0'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise((done) => child.once('exit', done));
  const stop = async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await exited;
  };
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`trapyard serve did not start within ${START_TIMEOUT_MS} ms`));
    }, START_TIMEOUT_MS);
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      out += chunk;
      const origin = out.match(/trapyard gauntlet on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      if (origin) {
        clearTimeout(timer);
        resolve({ origin, stop });
      }
    });
    exited.then((code) => {
      clearTimeout(timer);
      reject(new Error(`trapyard serve exited early (${code})`));
    });
  });
}

async function waitUntilUp(url, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      if ((await fetch(url)).status === 200) return;
    } catch {
      // not listening yet
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`${url} did not answer`);
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function shot(page, name, size) {
  const file = join(OUT, `${name}-${size}.png`);
  await page.screenshot({ path: file });
  console.log(`saved ${file}`);
}

if (!process.env.CHROMIUM_PATH) {
  console.error('screenshots: set CHROMIUM_PATH to a Chromium binary (no browser is downloaded)');
  process.exit(2);
}

const app = await startApp();
let browser;
try {
  await waitUntilUp(`${app.origin}/`);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
  mkdirSync(OUT, { recursive: true });

  for (const [size, options] of Object.entries(SIZES)) {
    const context = await browser.newContext(options);
    const page = await context.newPage();

    // home: the start page, with the Buy button linking to the payment link.
    const home = await page.goto(`${app.origin}/`, { waitUntil: 'load' });
    expect(home.status() === 200, `home: ${home.status()}`);
    const buy = page.locator('main .actions a.buy').first();
    expect(await buy.isVisible(), 'home: the Buy button is not in view');
    expect((await buy.getAttribute('href')) === PAYMENT_LINK, 'home: the Buy button does not link to STRIPE_PAYMENT_LINK');
    await shot(page, 'home', size);

    // run: the core action, "Start a free run".
    const [started] = await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('button[type=submit]')]);
    expect(started.status() === 201, `run: ${started.status()}`);
    const taskUrl = await page.textContent('#task-url');
    const cardUrl = await page.getAttribute('#card-url', 'href');
    for (const href of ['/privacy', '/terms']) expect(await page.locator(`footer a[href="${href}"]`).count(), `run: no footer link to ${href}`);
    await page.locator('footer').scrollIntoViewIfNeeded();
    await shot(page, 'run', size);

    // card: the vulnerable stub agent does the task; the score card shows what it fell for.
    await vulnerableAgent(taskUrl);
    const card = await page.goto(cardUrl, { waitUntil: 'load' });
    expect(card.status() === 200, `card: ${card.status()}`);
    expect((await page.textContent('.lede')).includes('4 of 4 traps fell'), 'card: the stub run did not score 4 of 4');
    await shot(page, 'card', size);

    await context.close();
  }
} finally {
  await browser?.close();
  await app.stop();
}
