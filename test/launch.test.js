// Launch readiness: what search engines, link previews and buyers see. Titles, descriptions, canonical
// URLs, Open Graph/Twitter tags, JSON-LD, robots.txt, sitemap.xml, the 1200×630 share image, /privacy,
// /terms, the footer links, the Buy button (STRIPE_PAYMENT_LINK, hidden when unset), the visit
// beacon's script tag and CSP, and `trapyard export` (how a Buy-button purchase is delivered by hand).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { SIGNAL_URL } from '../src/beacon.js';
import { exportRun, paymentLinkConfig, vercelHandler } from '../src/gauntlet.js';
import { LAUNCH_OFFER, usd } from '../src/payments.js';
import { PUBLIC_PAGES, REPO_URL } from '../src/site.js';
import { memoryStore, postgresStore } from '../src/store.js';
import { vulnerableAgent } from './stubs/agents.js';
import { cli, pgliteDatabase, startGauntlet, startHostedRun, startPaidGauntlet } from './helpers.js';

const LINK = 'https://example.com/pay';
const ISSUES = `${REPO_URL}/issues`;
const BEACON_TAG = /<script src="\/beacon\.js"/; // the tag, not the privacy page's mention of the file

const metaContent = (html, key) => html.match(new RegExp(`<meta (?:name|property)="${key}" content="([^"]*)">`))?.[1];
const titleOf = (html) => html.match(/<title>([^<]*)<\/title>/)?.[1];
const canonicalOf = (html) => html.match(/<link rel="canonical" href="([^"]*)">/)?.[1];
const jsonLdOf = (html) => {
  const found = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  return found ? JSON.parse(found[1]) : null;
};
const unescape = (text) => text.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

async function page(url, init) {
  const res = await fetch(url, init);
  return { status: res.status, headers: res.headers, html: await res.text() };
}

/** A hosted run the vulnerable stub has finished; returns the API's answer. */
async function finishedRun(g) {
  const run = await startHostedRun(g.origin);
  await vulnerableAgent(run.taskUrl);
  return run;
}

describe('search and sharing', () => {
  test('PUBLIC_PAGES are the landing page, /privacy and /terms', () => {
    assert.deepEqual(
      PUBLIC_PAGES.map((p) => p.path),
      ['/', '/privacy', '/terms'],
    );
  });

  test('every public page has its own title and description, a canonical URL, Open Graph and Twitter tags with the 1200×630 image, and JSON-LD', async (t) => {
    const g = await startGauntlet(t, { paymentLink: LINK });
    const titles = new Set();
    const descriptions = new Set();
    for (const { path } of PUBLIC_PAGES) {
      const { status, headers, html } = await page(`${g.origin}${path}`);
      assert.equal(status, 200, path);
      assert.match(headers.get('content-type'), /^text\/html/);
      const title = titleOf(html);
      const description = metaContent(html, 'description');
      assert.ok(title, `${path} has a title`);
      assert.ok(description && description.length >= 50 && description.length <= 160, `${path}: a 50–160 character description`);
      titles.add(title);
      descriptions.add(description);
      const url = `${g.publicUrl}${path}`;
      assert.equal(canonicalOf(html), url, `${path} canonical`);
      assert.equal(metaContent(html, 'og:title'), title);
      assert.equal(metaContent(html, 'og:description'), description);
      assert.equal(metaContent(html, 'og:url'), url);
      assert.equal(metaContent(html, 'og:type'), 'website');
      assert.equal(metaContent(html, 'og:site_name'), 'trapyard');
      assert.equal(metaContent(html, 'og:image'), `${g.publicUrl}/og.png`);
      assert.equal(metaContent(html, 'og:image:width'), '1200');
      assert.equal(metaContent(html, 'og:image:height'), '630');
      assert.ok(metaContent(html, 'og:image:alt'), 'the share image has alt text');
      assert.equal(metaContent(html, 'twitter:card'), 'summary_large_image');
      assert.equal(metaContent(html, 'twitter:title'), title);
      assert.equal(metaContent(html, 'twitter:description'), description);
      assert.equal(metaContent(html, 'twitter:image'), `${g.publicUrl}/og.png`);
      const ld = jsonLdOf(html);
      assert.equal(ld['@context'], 'https://schema.org');
      assert.equal(ld['@type'], 'SoftwareApplication');
      assert.equal(ld.name, 'trapyard');
      assert.equal(ld.url, `${g.publicUrl}/`);
      assert.equal(ld.image, `${g.publicUrl}/og.png`);
      assert.ok(ld.applicationCategory && ld.operatingSystem && ld.description);
      assert.equal(ld.offers['@type'], 'Offer');
      assert.equal(ld.offers.price, '149.00');
      assert.equal(ld.offers.priceCurrency, 'USD');
      assert.match(ld.offers.description, /once/);
    }
    assert.equal(titles.size, PUBLIC_PAGES.length, 'titles are unique');
    assert.equal(descriptions.size, PUBLIC_PAGES.length, 'descriptions are unique');
  });

  test("JSON-LD can't be closed early by its own text", async (t) => {
    const g = await startGauntlet(t, { paymentLink: LINK });
    const { html } = await page(`${g.origin}/`);
    const block = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1];
    assert.ok(!block.includes('<'), 'every < in the JSON is escaped');
  });

  test('without STRIPE_PAYMENT_LINK the JSON-LD has no Offer: nothing on the page sells it for $149', async (t) => {
    const g = await startGauntlet(t);
    for (const { path } of PUBLIC_PAGES) {
      const ld = jsonLdOf((await page(`${g.origin}${path}`)).html);
      assert.equal(ld['@type'], 'SoftwareApplication');
      assert.equal(ld.offers, undefined, path);
    }
  });

  test('robots.txt allows indexing, keeps crawlers off run, report and API addresses, and points at the sitemap', async (t) => {
    const g = await startGauntlet(t);
    const res = await fetch(`${g.origin}/robots.txt`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/plain/);
    const text = await res.text();
    const lines = text.split('\n');
    assert.ok(lines.includes('User-agent: *'));
    assert.ok(lines.includes('Allow: /'));
    for (const path of ['/r/', '/report/', '/api/']) assert.ok(lines.includes(`Disallow: ${path}`), path);
    assert.ok(!lines.includes('Disallow: /'), 'never the whole site');
    assert.ok(lines.includes(`Sitemap: ${g.publicUrl}/sitemap.xml`));
    assert.equal((await fetch(`${g.origin}/robots.txt`, { method: 'HEAD' })).status, 200);
    assert.equal((await fetch(`${g.origin}/robots.txt`, { method: 'POST' })).status, 405);
  });

  test('sitemap.xml lists exactly the public pages at the public URL, and each answers 200', async (t) => {
    const g = await startGauntlet(t);
    const res = await fetch(`${g.origin}/sitemap.xml`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^application\/xml/);
    const xml = await res.text();
    assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
    assert.match(xml, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
    const locs = [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
    assert.deepEqual(locs, PUBLIC_PAGES.map((p) => `${g.publicUrl}${p.path}`));
    for (const loc of locs) assert.equal((await fetch(loc)).status, 200, loc);
  });

  test('/og.png is the 1200×630 share image, drawn by code, the same bytes every time', async (t) => {
    const g = await startGauntlet(t);
    const res = await fetch(`${g.origin}/og.png`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.match(res.headers.get('cache-control'), /public/);
    const png = Buffer.from(await res.arrayBuffer());
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(png.toString('latin1', 12, 16), 'IHDR');
    assert.equal(png.readUInt32BE(16), 1200);
    assert.equal(png.readUInt32BE(20), 630);
    const again = Buffer.from(await (await fetch(`${g.origin}/og.png`)).arrayBuffer());
    assert.ok(png.equals(again));
  });
});

describe('privacy, terms and the footer', () => {
  test('every page links /privacy, /terms and the GitHub issues in its footer', async (t) => {
    const g = await startGauntlet(t);
    const run = await finishedRun(g);
    const started = await page(`${g.origin}/runs`, { method: 'POST' });
    assert.equal(started.status, 201);
    const pages = {
      landing: (await page(`${g.origin}/`)).html,
      privacy: (await page(`${g.origin}/privacy`)).html,
      terms: (await page(`${g.origin}/terms`)).html,
      card: (await page(run.cardUrl)).html,
      runStarted: started.html,
      reportLink: (await page(run.reportUrl)).html,
      notFound: (await page(`${g.origin}/s/${'0'.repeat(32)}`)).html,
    };
    for (const [name, html] of Object.entries(pages)) {
      const footer = html.slice(html.lastIndexOf('<footer>'));
      assert.match(footer, /<a href="\/privacy">Privacy<\/a>/, `${name}: privacy`);
      assert.match(footer, /<a href="\/terms">Terms<\/a>/, `${name}: terms`);
      assert.ok(footer.includes(`href="${ISSUES}"`), `${name}: contact`);
    }
  });

  test('/privacy: what a run stores, no cookies, Stripe, the host, and the three beacon events with how to opt out', async (t) => {
    const g = await startGauntlet(t);
    const res = await fetch(`${g.origin}/privacy`);
    assert.equal(res.status, 200);
    const html = await res.text();
    for (const pattern of [
      /every request your agent makes/,
      /no cookies/i,
      /IP address/,
      /Stripe/,
      /Vercel/,
      /sessionStorage/,
      /localStorage/,
      /repohq:notrack/,
      /navigator\.webdriver/,
      /preview/,
    ]) {
      assert.match(html, pattern);
    }
    for (const kind of ['visit', 'activate', 'checkout']) assert.match(html, new RegExp(`<code>${kind}</code>`), kind);
    assert.ok(html.includes(SIGNAL_URL), 'names where the events go');
    assert.ok(html.includes(`href="${ISSUES}"`));
    assert.equal((await fetch(`${g.origin}/privacy`, { method: 'HEAD' })).status, 200);
    assert.equal((await fetch(`${g.origin}/privacy`, { method: 'POST' })).status, 405);
  });

  test('/terms with the Buy button: the $149 price, no warranty, not a certification, the refund line, contact through GitHub issues', async (t) => {
    const g = await startGauntlet(t, { paymentLink: LINK });
    const html = await (await fetch(`${g.origin}/terms`)).text();
    for (const pattern of [/\$149/, /once per agent/, /one retest/, /without warranty/i, /not a certification/, /refund/i, /14 days/, /by hand/, /listed/]) {
      assert.match(html, pattern);
    }
    assert.ok(html.includes(`href="${ISSUES}"`));
    assert.ok(html.includes('href="/privacy"'));
    assert.doesNotMatch(html, /\$299|\$999/, 'one price at a time');
  });

  test('/terms without the Buy button keeps the Checkout prices and gains the warranty and contact lines', async (t) => {
    const g = await startGauntlet(t);
    const html = await (await fetch(`${g.origin}/terms`)).text();
    for (const pattern of [/\$299/, /\$999/, /without warranty/i, /14 days/]) assert.match(html, pattern);
    assert.ok(html.includes(`href="${ISSUES}"`));
    assert.doesNotMatch(html, /\$149/);
  });
});

describe('Buy button (STRIPE_PAYMENT_LINK)', () => {
  test('hidden without the env var: no Buy link on any page, and the old copy stands', async (t) => {
    const g = await startGauntlet(t);
    const run = await finishedRun(g);
    const landing = (await page(`${g.origin}/`)).html;
    const started = (await page(`${g.origin}/runs`, { method: 'POST' })).html;
    const locked = (await page(run.reportUrl)).html;
    for (const [name, html] of Object.entries({ landing, started, locked })) {
      assert.doesNotMatch(html, /data-checkout/, name);
      assert.doesNotMatch(html, />Buy /, name);
      assert.doesNotMatch(html, /\$149/, name);
    }
    assert.match(landing, /\$299/);
    assert.match(locked, /Payments are not set up on this deployment/);
  });

  test("with the env var the landing page links it as a clear Buy button, marked for the checkout beacon, with what $149 buys", async (t) => {
    const g = await startGauntlet(t, { paymentLink: LINK });
    const html = (await page(`${g.origin}/`)).html;
    const buttons = [...html.matchAll(/<a class="button buy"[^>]*>[^<]*<\/a>/g)].map((m) => m[0]);
    assert.ok(buttons.length >= 1, 'a Buy button');
    for (const b of buttons) {
      assert.ok(b.includes(`href="${LINK}"`), b);
      assert.match(b, /data-checkout/);
      assert.match(b, />Buy[^<]*\$149</);
    }
    assert.match(html, /id="buy"/, 'the offer the JSON-LD points at');
    assert.match(html, /\$149 once per agent/);
    assert.match(html, /one retest/);
    assert.match(html, /by hand/);
    assert.doesNotMatch(html, /\$299|\$999/, 'one price at a time');
    assert.equal(LAUNCH_OFFER.cents, 14_900);
    assert.equal(usd(LAUNCH_OFFER.cents), '$149');
  });

  test("on a finished run's report link the Buy button names the run (client_reference_id), and replaces the Checkout tiers", async (t) => {
    for (const paid of [false, true]) {
      const g = paid ? await startPaidGauntlet(t, { paymentLink: LINK }) : await startGauntlet(t, { paymentLink: LINK });
      const run = await finishedRun(g);
      const res = await page(run.reportUrl);
      assert.equal(res.status, 402);
      const buy = res.html.match(/<a class="button buy" href="([^"]*)" data-checkout>/);
      assert.ok(buy, `a Buy button (payments ${paid ? 'on' : 'off'})`);
      const url = new URL(unescape(buy[1]));
      assert.equal(`${url.origin}${url.pathname}`, LINK);
      assert.equal(url.searchParams.get('client_reference_id'), run.runId);
      assert.doesNotMatch(res.html, /name="tier"/, 'no $299/$999 forms beside the $149 link');
      assert.doesNotMatch(res.html, /Payments are not set up/);
      assert.match(res.html, /\$149/);
    }
  });

  test("a payment link with its own query keeps it; the run id is added, not swapped in", async (t) => {
    const g = await startGauntlet(t, { paymentLink: `${LINK}?prefilled_promo_code=LAUNCH` });
    const run = await finishedRun(g);
    const href = unescape((await page(run.reportUrl)).html.match(/<a class="button buy" href="([^"]*)"/)[1]);
    const url = new URL(href);
    assert.equal(url.searchParams.get('prefilled_promo_code'), 'LAUNCH');
    assert.equal(url.searchParams.get('client_reference_id'), run.runId);
  });

  test("while the run is going there is nothing to buy yet; the score card never sells (a shared card can't buy the owner's report)", async (t) => {
    const g = await startGauntlet(t, { paymentLink: LINK });
    const run = await startHostedRun(g.origin);
    const going = await page(run.reportUrl);
    assert.equal(going.status, 409);
    assert.doesNotMatch(going.html, /data-checkout/);
    await vulnerableAgent(run.taskUrl);
    const card = (await page(run.cardUrl)).html;
    assert.doesNotMatch(card, /data-checkout/);
    assert.ok(!card.includes(LINK));
  });

  test('the run-started page names the $149 offer instead of the Checkout prices', async (t) => {
    const g = await startGauntlet(t, { paymentLink: LINK });
    const html = (await page(`${g.origin}/runs`, { method: 'POST' })).html;
    assert.match(html, /\$149/);
    assert.doesNotMatch(html, /\$299|\$999/);
  });

  test('paymentLinkConfig: unset is null, an https URL is kept; anything else is refused without echoing the value', () => {
    assert.equal(paymentLinkConfig({}), null);
    assert.equal(paymentLinkConfig({ STRIPE_PAYMENT_LINK: '' }), null);
    assert.equal(paymentLinkConfig({ STRIPE_PAYMENT_LINK: LINK }), LINK);
    assert.equal(paymentLinkConfig({ STRIPE_PAYMENT_LINK: 'https://buy.stripe.com/abc123' }), 'https://buy.stripe.com/abc123');
    const withLogin = new URL('https://buy.stripe.com/x'); // built at runtime: no login-shaped URL in the repo
    withLogin.username = 'someone';
    withLogin.password = 'x'.repeat(8);
    for (const bad of ['buy.stripe.com/abc123', 'http://buy.stripe.com/abc123', 'javascript:alert(1)', withLogin.href]) {
      assert.throws(
        () => paymentLinkConfig({ STRIPE_PAYMENT_LINK: bad }),
        (err) => /STRIPE_PAYMENT_LINK/.test(err.message) && !err.message.includes(bad),
        bad,
      );
    }
  });
});

describe('the Vercel function: Buy button and beacon from env', () => {
  let pglite;
  before(async () => {
    pglite = await pgliteDatabase();
  });
  after(() => pglite.close());

  async function serve(t, env, logged = []) {
    let origin;
    const handler = vercelHandler({
      env: { get TRAPYARD_PUBLIC_URL() { return origin; }, DATABASE_URL: 'placeholder-database', ...env },
      connect: () => pglite,
      log: (line) => logged.push(line),
    });
    const server = createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    origin = `http://127.0.0.1:${server.address().port}`;
    return origin;
  }

  test('STRIPE_PAYMENT_LINK shows the Buy button; production loads the beacon', async (t) => {
    const origin = await serve(t, { STRIPE_PAYMENT_LINK: LINK, VERCEL_ENV: 'production' });
    const html = (await page(`${origin}/`)).html;
    assert.ok(html.includes(`<a class="button buy" href="${LINK}" data-checkout>`));
    assert.match(html, /<script src="\/beacon\.js" defer><\/script>/);
  });

  test('a preview deployment (VERCEL_ENV=preview) or no VERCEL_ENV sends nothing: no beacon script', async (t) => {
    for (const env of [{ VERCEL_ENV: 'preview' }, { VERCEL_ENV: 'development' }, {}]) {
      const origin = await serve(t, env);
      const html = (await page(`${origin}/`)).html;
      assert.doesNotMatch(html, BEACON_TAG, JSON.stringify(env));
      assert.doesNotMatch(html, /data-checkout/, 'and no Buy button without the link');
    }
  });

  test('a malformed STRIPE_PAYMENT_LINK hides the Buy button and is logged without its value; the site stays up', async (t) => {
    const logged = [];
    const bad = 'http://example.com/not-https';
    const origin = await serve(t, { STRIPE_PAYMENT_LINK: bad }, logged);
    const res = await page(`${origin}/`);
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.html, /data-checkout/);
    assert.match(logged.join('\n'), /STRIPE_PAYMENT_LINK/);
    assert.ok(!logged.join('\n').includes(bad));
  });
});

describe('visit beacon: script tag and CSP', () => {
  test('/beacon.js is JavaScript; the CSP lets same-origin scripts run and reach only the RepoHQ endpoint', async (t) => {
    const g = await startGauntlet(t, { signals: true });
    const res = await fetch(`${g.origin}/beacon.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/javascript/);
    assert.ok((await res.text()).includes(SIGNAL_URL));
    const csp = (await fetch(`${g.origin}/`)).headers.get('content-security-policy');
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.match(csp, new RegExp(`connect-src ${new URL(SIGNAL_URL).origin}(;|$)`));
  });

  test('with signals on: public pages and the score card load it; the run-started page marks the core action; private pages never load it', async (t) => {
    const g = await startPaidGauntlet(t, { signals: true, paymentLink: LINK });
    const run = await finishedRun(g);
    const tag = '<script src="/beacon.js" defer></script>';
    for (const path of ['/', '/privacy', '/terms']) assert.ok((await page(`${g.origin}${path}`)).html.includes(tag), path);
    assert.ok((await page(run.cardUrl)).html.includes(tag), 'card');
    const started = (await page(`${g.origin}/runs`, { method: 'POST' })).html;
    assert.ok(started.includes(tag));
    assert.match(started, /<body data-activate>/, 'activate: the first run this browser starts');
    const locked = (await page(run.reportUrl)).html;
    assert.ok(locked.includes(tag), 'the Buy button page, for checkout');
    assert.doesNotMatch((await page(`${g.origin}/`)).html, /data-activate/);
    const { id, returnUrl } = await g.checkout(run.runId);
    g.stripe.pay(id);
    assert.doesNotMatch((await page(returnUrl)).html, /<script/, 'the paid report loads no script');
    assert.doesNotMatch((await page(`${g.origin}/s/${'0'.repeat(32)}`)).html, BEACON_TAG, 'error pages neither');
  });

  test('with signals off (trapyard serve, previews) no page loads it', async (t) => {
    const g = await startGauntlet(t, { paymentLink: LINK });
    const run = await finishedRun(g);
    for (const url of [`${g.origin}/`, `${g.origin}/privacy`, run.cardUrl, run.reportUrl]) {
      assert.doesNotMatch((await page(url)).html, BEACON_TAG, url);
    }
  });
});

describe('trapyard export: delivering a Buy-button purchase by hand', () => {
  for (const kind of ['memory', 'postgres']) {
    test(`exportRun (${kind} store): an ended run's frozen full report as files, recorded-by block included, no verify link`, async (t) => {
      let store = memoryStore();
      if (kind === 'postgres') {
        const db = await pgliteDatabase();
        t.after(() => db.close());
        store = postgresStore(db);
        await store.migrate();
      }
      const g = await startGauntlet(t, { store });
      const run = await finishedRun(g);
      const out = await exportRun(store, run.runId);
      assert.deepEqual(Object.keys(out.files).sort(), ['log.json', 'report.html', 'report.json']);
      const report = JSON.parse(out.files['report.json']);
      assert.equal(report.summary.fell, 4);
      assert.equal(report.hosted.recordedBy, g.publicUrl);
      assert.equal(report.hosted.cardUrl, run.cardUrl);
      assert.equal(report.hosted.verifyUrl, undefined);
      assert.equal(report.hosted.endedBy, 'summary');
      const log = JSON.parse(out.files['log.json']);
      assert.equal(log.format, 'trapyard.log/1');
      assert.equal(log.run.id, run.runId);
      assert.ok(log.events.length > 0);
      const html = out.files['report.html'];
      assert.match(html, /4 of 4 traps fell/);
      assert.match(html, /Recorded by/);
      assert.ok(html.includes(run.cardUrl));
      assert.doesNotMatch(html, /Verify online/);
      assert.doesNotMatch(html, /<script/);
    });
  }

  test('trapyard export: usage errors (exit 2) for a missing or malformed run id, or no DATABASE_URL', async () => {
    for (const [args, pattern] of [
      [['export'], /export takes one run id/],
      [['export', 'not-a-run-id'], /export takes one run id/],
      [['export', 'f'.repeat(16)], /export needs DATABASE_URL/],
    ]) {
      const { code, stderr } = await cli(args);
      assert.equal(code, 2, args.join(' '));
      assert.match(stderr, pattern);
    }
    const unknown = await cli(['constructor']);
    assert.equal(unknown.code, 2, 'a prototype key is not a command');
    assert.match(unknown.stderr, /unknown command/);
  });

  test('exportRun: an unknown run is null; a run still going is refused', async (t) => {
    const store = memoryStore();
    const g = await startGauntlet(t, { store });
    assert.equal(await exportRun(store, 'f'.repeat(16)), null);
    const run = await startHostedRun(g.origin);
    await assert.rejects(exportRun(store, run.runId), /has not ended/);
  });

  test('exportRun: a run that expired with nobody closing it is scored and closed first, with the expiry warning', async (t) => {
    const store = memoryStore();
    const g = await startGauntlet(t, { store });
    const run = await startHostedRun(g.origin);
    const out = await exportRun(store, run.runId, { now: new Date(Date.parse(run.expiresAt) + 1000) });
    const report = JSON.parse(out.files['report.json']);
    assert.equal(report.hosted.endedBy, 'expired');
    assert.match(report.hosted.warnings.join(' '), /expired/);
    assert.equal((await store.findRun(run.runId)).closedBy, 'expired', 'closed in the store too, once');
  });
});
