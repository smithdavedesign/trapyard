#!/usr/bin/env node
// npm run screenshots: proof that the product does its job, as PNGs in docs/screenshots/.
//
// It starts the gauntlet on 127.0.0.1 (the same server `trapyard serve` runs, memory store) with
// payments pointed at a fake Stripe, also on 127.0.0.1, and waits until it answers. Then it:
//   1. opens the landing page and starts a run with its form, as a visitor would
//   2. runs the deliberately vulnerable stub agent against that run's task URL (sample data only)
//   3. opens the run's full report link: 402, the page that sells it
//   4. buys the $299 report through the real /checkout → Stripe session → return URL flow
//      (the fake marks it paid) and opens the paid report
//   5. prints the paid report to PDF with Chromium and checks the PDF
// Each page is captured at desktop size (1280×800) and on a phone (iPhone 13), viewport only.
//
// Chromium comes from CHROMIUM_PATH; no browser is ever downloaded. Not part of `npm test`.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright-core';
import { serveGauntlet } from '../src/gauntlet.js';
import { stripeCheckout } from '../src/payments.js';
import { memoryStore } from '../src/store.js';
import { startFakeStripe } from '../test/fake-stripe.js';
import { vulnerableAgent } from '../test/stubs/agents.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'screenshots');
const PDF = join(ROOT, 'test', '.tmp', 'sample-report.pdf'); // git-ignored: checked, not committed

const SIZES = {
  desktop: { viewport: { width: 1280, height: 800 } },
  mobile: { ...devices['iPhone 13'] },
};

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

if (!process.env.CHROMIUM_PATH) {
  console.error('screenshots: set CHROMIUM_PATH to a Chromium binary (no browser is downloaded)');
  process.exit(2);
}

const stripe = await startFakeStripe();
const served = await serveGauntlet({
  store: memoryStore(),
  payments: stripeCheckout({ secretKey: stripe.key, apiBase: stripe.apiBase }),
  port: 0,
});
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
try {
  await waitUntilUp(`${served.origin}/`);
  mkdirSync(OUT, { recursive: true });

  // 1–2. A visitor starts a run from the landing page; the vulnerable stub agent does the task.
  const visitor = await browser.newPage();
  await visitor.goto(`${served.origin}/`);
  await visitor.click('button[type=submit]');
  const taskUrl = await visitor.textContent('#task-url');
  const reportUrl = await visitor.getAttribute('#report-url', 'href');
  await vulnerableAgent(taskUrl);
  await visitor.close();

  // 4. Checkout through the real route; the fake Stripe stands in for the buyer paying by card.
  const runId = reportUrl.split('/report/')[1];
  const buy = await fetch(`${served.origin}/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ run: runId, tier: 'report' }).toString(),
    redirect: 'manual',
  });
  if (buy.status !== 303) throw new Error(`checkout answered ${buy.status}`);
  const sessionId = buy.headers.get('location').split('/pay/')[1];
  stripe.pay(sessionId);
  const paidUrl = stripe.session(sessionId).success_url.replace('{CHECKOUT_SESSION_ID}', sessionId);

  const shots = [
    ['home', `${served.origin}/`, 200],
    ['checkout', reportUrl, 402],
    ['report', paidUrl, 200],
  ];
  for (const [size, options] of Object.entries(SIZES)) {
    const context = await browser.newContext(options);
    const page = await context.newPage();
    for (const [name, url, status] of shots) {
      const res = await page.goto(url, { waitUntil: 'load' });
      if (res.status() !== status) throw new Error(`${name}: expected ${status}, got ${res.status()}`);
      const file = join(OUT, `${name}-${size}.png`);
      await page.screenshot({ path: file });
      console.log(`saved ${file}`);
    }
    await context.close();
  }

  // 5. The paid report printed to PDF by the browser, as a buyer would with Save as PDF.
  const printer = await browser.newPage();
  await printer.goto(paidUrl, { waitUntil: 'load' });
  const pdf = await printer.pdf({ format: 'A4', printBackground: false });
  const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  if (pdf.subarray(0, 5).toString() !== '%PDF-' || pages < 2) throw new Error(`the printed report is not a usable PDF (${pages} pages)`);
  mkdirSync(dirname(PDF), { recursive: true });
  writeFileSync(PDF, pdf);
  console.log(`printed the paid report to PDF: ${pages} A4 pages, ${pdf.length} bytes (${PDF})`);
  // The same page as the printer lays it out (print CSS), for a look without a PDF viewer.
  await printer.setViewportSize({ width: 794, height: 1123 }); // A4 at 96 dpi
  await printer.emulateMedia({ media: 'print' });
  const preview = join(dirname(PDF), 'report-print-preview.png');
  await printer.screenshot({ path: preview, fullPage: true });
  console.log(`print preview: ${preview}`);
} finally {
  await browser.close();
  await served.close();
  await stripe.close();
}
