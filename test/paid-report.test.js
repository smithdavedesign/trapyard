// The hosted paid report: /report/<run>, /checkout, retests, terms, and how the pages point to them.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { HOSTED_LIMITS, vercelHandler } from '../src/gauntlet.js';
import { RETEST_DAYS } from '../src/payments.js';
import { fakeSessionId, fakeStripeKey } from './fake-stripe.js';
import { hardenedAgent, vulnerableAgent } from './stubs/agents.js';
import { getJson, hostedBase, pgliteDatabase, startGauntlet, startHostedRun, startPaidGauntlet } from './helpers.js';

const DAY = 24 * 60 * 60_000;

function clock(start = '2026-10-25T10:00:00.000Z') {
  let t = Date.parse(start);
  const now = () => new Date(t);
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

/** A hosted run that a stub agent has finished. */
async function finishedRun(g, agent = vulnerableAgent) {
  const run = await startHostedRun(g.origin);
  await agent(run.taskUrl);
  return run;
}

const buy = (origin, fields) =>
  fetch(`${origin}/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });

describe('report link before payment', () => {
  test('an unknown or malformed run is 404; a run still going is 409 with no way to buy yet', async (t) => {
    const g = await startPaidGauntlet(t);
    for (const path of [`/report/${'0'.repeat(16)}`, `/report/${'0'.repeat(16)}.json`, '/report/xyz', '/report/', `/report/${'0'.repeat(16)}/x`]) {
      assert.equal((await fetch(`${g.origin}${path}`)).status, 404, path);
    }
    const run = await startHostedRun(g.origin);
    const going = await fetch(run.reportUrl);
    assert.equal(going.status, 409);
    const html = await going.text();
    assert.match(html, /still going/);
    assert.doesNotMatch(html, /action="\/checkout"/);
    assert.equal((await fetch(`${run.reportUrl}.json`)).status, 409);
    assert.equal((await buy(g.origin, { run: run.runId, tier: 'report' })).status, 409);
    assert.equal(g.stripe.requests.length, 0, 'nothing was sent to Stripe');
  });

  test('the 402 page shows the result, both tiers with prices, what the report holds, and the terms', async (t) => {
    const g = await startPaidGauntlet(t);
    const run = await finishedRun(g);
    const res = await fetch(run.reportUrl);
    assert.equal(res.status, 402);
    assert.match(res.headers.get('cache-control'), /no-store/);
    assert.match(res.headers.get('content-security-policy'), /form-action 'self' https:\/\/checkout\.stripe\.com/);
    const html = await res.text();
    assert.match(html, /4 of 4 traps fell/);
    assert.ok(html.includes(`<input type="hidden" name="run" value="${run.runId}">`));
    assert.match(html, /name="tier" value="report"[\s\S]*\$299/);
    assert.match(html, /name="tier" value="assessment"[\s\S]*\$999/);
    assert.match(html, /3 retest/);
    assert.match(html, /PDF/);
    assert.match(html, /href="\/terms"/);
    assert.match(html, /not a certification/);
    const json = await getJson(`${run.reportUrl}.json`);
    assert.equal(json.status, 402);
    assert.match(json.body.error, /payment required/i);
  });

  test('an expired run that nobody closed is scored when its report link is opened, then sold', async (t) => {
    const now = clock();
    const g = await startPaidGauntlet(t, { now });
    const run = await startHostedRun(g.origin);
    await fetch(`${hostedBase(run).base}/pages/invoice`);
    now.advance(HOSTED_LIMITS.runTtlMs);
    assert.equal((await fetch(run.reportUrl)).status, 402);
    assert.equal((await g.store.findRun(run.runId)).closedBy, 'expired');
    const { id, returnUrl } = await g.checkout(run.runId);
    g.stripe.pay(id);
    const html = await (await fetch(returnUrl)).text();
    assert.match(html, /did not post its summary/, 'the expiry warning is in the paid report');
    assert.match(html, /ran out of time/);
  });

  test('without payments configured: the report link says so (402, no buy buttons); checkout and session links are 503', async (t) => {
    const g = await startGauntlet(t);
    const run = await finishedRun(g, hardenedAgent);
    const res = await fetch(run.reportUrl);
    assert.equal(res.status, 402);
    const html = await res.text();
    assert.doesNotMatch(html, /action="\/checkout"/);
    assert.match(html, /not set up/);
    assert.match(html, /trapyard CLI/);
    assert.equal((await buy(g.origin, { run: run.runId, tier: 'report' })).status, 503);
    assert.equal((await fetch(`${run.reportUrl}?session_id=${fakeSessionId()}`)).status, 503);
  });
});

describe('checkout', () => {
  test('POST /checkout answers 303 to the Stripe Checkout URL, for either tier', async (t) => {
    const g = await startPaidGauntlet(t);
    const run = await finishedRun(g);
    const res = await buy(g.origin, { run: run.runId, tier: 'assessment' });
    assert.equal(res.status, 303);
    assert.match(res.headers.get('cache-control'), /no-store/);
    const id = res.headers.get('location').split('/pay/')[1];
    assert.equal(g.stripe.session(id).amount_total, 99_900);
    assert.equal(g.stripe.session(id).metadata.tier, 'assessment');
    assert.equal(g.stripe.session(id).metadata.run_id, run.runId);
  });

  test('bad input: unknown run 404, unknown tier or missing fields 400, GET 405; Stripe down 502 with nothing secret logged', async (t) => {
    const logged = [];
    const g = await startPaidGauntlet(t, { log: (line) => logged.push(line) });
    const run = await finishedRun(g);
    assert.equal((await buy(g.origin, { run: '0'.repeat(16), tier: 'report' })).status, 404);
    assert.equal((await buy(g.origin, { run: run.runId, tier: 'gold' })).status, 400);
    assert.equal((await buy(g.origin, { tier: 'report' })).status, 400);
    assert.equal((await buy(g.origin, { run: run.runId })).status, 400);
    assert.equal((await fetch(`${g.origin}/checkout`)).status, 405);
    const big = await fetch(`${g.origin}/checkout`, { method: 'POST', body: 'x'.repeat(10_000) });
    assert.equal(big.status, 413);

    g.stripe.outage(500);
    const down = await buy(g.origin, { run: run.runId, tier: 'report' });
    assert.equal(down.status, 502);
    assert.match(await down.text(), /try again/i);
    assert.ok(logged.length > 0);
    assert.ok(!logged.join('\n').includes(g.stripe.key));
  });
});

describe('the paid report', () => {
  test('is private: no-store, noindex, no referrer; it links to the card and to itself for a reviewer, and prints to PDF', async (t) => {
    const g = await startPaidGauntlet(t);
    const run = await finishedRun(g);
    const { id, returnUrl } = await g.checkout(run.runId);
    g.stripe.pay(id);
    const res = await fetch(returnUrl);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.equal(res.headers.get('x-robots-tag'), 'noindex');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
    const html = await res.text();
    assert.ok(html.includes(`href="${run.cardUrl}"`), 'links the public score card');
    assert.ok(html.includes(returnUrl.replace(/&/g, '&amp;')), 'carries the verify-online link');
    assert.ok(html.includes(g.publicUrl), 'says which gauntlet recorded it');
    assert.match(html, /hosted run/i);
    assert.match(html, /Save as PDF/);
    assert.match(html, /@page/);
    assert.match(html, /class="no-print/);
    assert.doesNotMatch(html, /<script/i);
  });

  test('a session that is complete but not yet paid (delayed payment method) is 402 "processing", never the report', async (t) => {
    const g = await startPaidGauntlet(t);
    const run = await finishedRun(g);
    const { id, returnUrl } = await g.checkout(run.runId);
    g.stripe.processing(id);
    const res = await fetch(returnUrl);
    assert.equal(res.status, 402);
    const html = await res.text();
    assert.match(html, /processing/);
    assert.doesNotMatch(html, /Request log/);
  });

  test('a malformed session id is 402 without a Stripe call; a Stripe outage while checking is 502, not 402', async (t) => {
    const g = await startPaidGauntlet(t);
    const run = await finishedRun(g);
    const before = g.stripe.requests.length;
    for (const bad of ['nope', 'cs_test_a%2Fb', '']) {
      assert.equal((await fetch(`${run.reportUrl}?session_id=${bad}`)).status, 402, bad);
    }
    assert.equal(g.stripe.requests.length, before);
    const { id, returnUrl } = await g.checkout(run.runId);
    g.stripe.pay(id);
    g.stripe.outage(503);
    const res = await fetch(returnUrl);
    assert.equal(res.status, 502);
    assert.equal((await fetch(`${run.reportUrl}.json?session_id=${id}`)).status, 502);
    g.stripe.outage(null);
    assert.equal((await fetch(returnUrl)).status, 200);
  });

  test('the report is frozen when the run ends: a paid link still opens, unchanged, after the scenario set moves on', async (t) => {
    const g = await startPaidGauntlet(t);
    const run = await finishedRun(g);
    const { id, returnUrl } = await g.checkout(run.runId);
    g.stripe.pay(id);
    const before = await (await fetch(returnUrl)).text();
    const beforeJson = (await getJson(`${run.reportUrl}.json?session_id=${id}`)).body;
    // As if trapyard now ran a newer scenario set: this code can no longer score the stored log.
    await g.store.withRun(run.runId, (record) => ({
      update: { head: { ...record.head, scenarioSet: { ...record.head.scenarioSet, version: '1999.1.0' } } },
    }));
    const after = await fetch(returnUrl);
    assert.equal(after.status, 200);
    assert.equal(await after.text(), before);
    assert.deepEqual((await getJson(`${run.reportUrl}.json?session_id=${id}`)).body, beforeJson);
    assert.equal((await fetch(run.cardUrl)).status, 200);
  });

  test('a run closed without a frozen report (before M4) gets the same report, built from its log', async (t) => {
    const g = await startPaidGauntlet(t);
    const run = await finishedRun(g);
    const { id, returnUrl } = await g.checkout(run.runId);
    g.stripe.pay(id);
    const frozen = await (await fetch(returnUrl)).text();
    await g.store.withRun(run.runId, (record) => {
      const { report, ...m3Result } = record.result;
      assert.equal(report.format, 'trapyard.report/1');
      return { update: { result: m3Result } };
    });
    assert.equal((await g.store.findRun(run.runId)).result.report, undefined);
    assert.equal(await (await fetch(returnUrl)).text(), frozen);
  });

  test('a session not made by trapyard (no tier, or no run) unlocks nothing', async (t) => {
    const g = await startPaidGauntlet(t);
    const run = await finishedRun(g);
    const noTier = g.stripe.create({ runId: run.runId, tier: 'platinum', paid: true });
    assert.equal((await fetch(`${run.reportUrl}?session_id=${noTier}`)).status, 402);
  });
});

describe('assessment retests', () => {
  test('one assessment unlocks its run plus 3 retest runs started after it; a 4th is refused; reopening uses no slot', async (t) => {
    const now = clock();
    const g = await startPaidGauntlet(t, { now });
    const original = await finishedRun(g);
    now.advance(60_000);
    const { id } = await g.checkout(original.runId, 'assessment');
    g.stripe.pay(id);
    const open = (run) => fetch(`${run.reportUrl}?session_id=${id}`);
    assert.equal((await open(original)).status, 200);

    const retests = [];
    for (let i = 0; i < 4; i++) {
      now.advance(DAY);
      retests.push(await finishedRun(g, hardenedAgent));
    }
    for (const run of retests.slice(0, 3)) assert.equal((await open(run)).status, 200);
    const fourth = await open(retests[3]);
    assert.equal(fourth.status, 402);
    assert.match(await fourth.text(), /3 retests/);
    // Reopening an unlocked retest, or the original, still works and uses nothing up.
    assert.equal((await open(retests[0])).status, 200);
    assert.equal((await open(original)).status, 200);
    const retestHtml = await (await open(retests[1])).text();
    assert.match(retestHtml, /retest/i);
    assert.match(retestHtml, /0 of 4 traps fell/);
  });

  test('retests must start after the purchase and within its 30 days; a $299 report unlocks only its own run', async (t) => {
    const now = clock();
    const g = await startPaidGauntlet(t, { now });
    const older = await finishedRun(g);
    now.advance(60_000);
    const bought = await finishedRun(g);
    now.advance(60_000);
    const assessment = await g.checkout(bought.runId, 'assessment');
    g.stripe.pay(assessment.id);
    const report = await g.checkout(bought.runId, 'report');
    g.stripe.pay(report.id);

    assert.equal((await fetch(`${older.reportUrl}?session_id=${assessment.id}`)).status, 402, 'started before the purchase');
    now.advance(RETEST_DAYS * DAY);
    const late = await finishedRun(g, hardenedAgent);
    assert.equal((await fetch(`${late.reportUrl}?session_id=${assessment.id}`)).status, 402, 'started after the 30 days');
    now.advance(-DAY);
    const inTime = await finishedRun(g, hardenedAgent);
    assert.equal((await fetch(`${inTime.reportUrl}?session_id=${assessment.id}`)).status, 200);
    assert.equal((await fetch(`${inTime.reportUrl}?session_id=${report.id}`)).status, 402, 'a report-tier session has no retests');
  });

  test('a retest still going is 409 and uses no slot', async (t) => {
    const g = await startPaidGauntlet(t);
    const original = await finishedRun(g);
    const { id } = await g.checkout(original.runId, 'assessment');
    g.stripe.pay(id);
    const going = await startHostedRun(g.origin);
    assert.equal((await fetch(`${going.reportUrl}?session_id=${id}`)).status, 409);
    assert.equal(await g.store.unlockRetest(id, going.runId, 1), 'unlocked', 'the 409 used no slot');
  });

  test('the paid assessment report has a form that turns a pasted task or report link into the retest report link', async (t) => {
    const g = await startPaidGauntlet(t);
    const original = await finishedRun(g);
    const { id, returnUrl } = await g.checkout(original.runId, 'assessment');
    g.stripe.pay(id);
    const html = await (await fetch(returnUrl)).text();
    assert.match(html, /<form method="get" action="\/report\/retest"/);
    assert.ok(html.includes(`<input type="hidden" name="session_id" value="${id}">`));

    const retest = await finishedRun(g, hardenedAgent);
    for (const pasted of [retest.taskUrl, retest.reportUrl, ` ${retest.runId} `]) {
      const res = await fetch(`${g.origin}/report/retest?${new URLSearchParams({ session_id: id, run: pasted })}`, { redirect: 'manual' });
      assert.equal(res.status, 303, pasted);
      assert.equal(res.headers.get('location'), `/report/${retest.runId}?session_id=${id}`);
    }
    const bad = await fetch(`${g.origin}/report/retest?${new URLSearchParams({ session_id: id, run: 'no id here' })}`, { redirect: 'manual' });
    assert.equal(bad.status, 400);
    const badSession = await fetch(`${g.origin}/report/retest?${new URLSearchParams({ session_id: 'x', run: retest.runId })}`, { redirect: 'manual' });
    assert.equal(badSession.status, 400);
    // A $299 report has no retest form.
    const single = await g.checkout(original.runId, 'report');
    g.stripe.pay(single.id);
    assert.doesNotMatch(await (await fetch(single.returnUrl)).text(), /action="\/report\/retest"/);
  });
});

describe('pages around the paid report', () => {
  test('the run-started page and the API give the owner the report link, marked private', async (t) => {
    const g = await startPaidGauntlet(t);
    const run = await startHostedRun(g.origin);
    assert.equal(run.reportUrl, `${g.publicUrl}/report/${run.runId}`);
    const page = await (await fetch(`${g.origin}/runs`, { method: 'POST', body: '' })).text();
    const reportUrl = /<a id="report-url" href="([^"]+)"/.exec(page)?.[1];
    assert.match(reportUrl, new RegExp(`^${g.publicUrl}/report/[a-f0-9]{16}$`));
    assert.match(page, /\$299/);
  });

  test('the public score card never offers checkout or reveals the report link', async (t) => {
    const g = await startPaidGauntlet(t);
    const run = await finishedRun(g);
    const html = await (await fetch(run.cardUrl)).text();
    assert.doesNotMatch(html, /action="\/checkout"/);
    assert.ok(!html.includes(run.reportUrl));
    assert.match(html, /full report/i);
  });

  test('the landing page shows the prices; /terms says what is sold, the refund rule and that it is not a certification', async (t) => {
    const g = await startPaidGauntlet(t);
    const landing = await (await fetch(`${g.origin}/`)).text();
    assert.match(landing, /\$299/);
    assert.match(landing, /\$999/);
    assert.match(landing, /href="\/terms"/);
    const res = await fetch(`${g.origin}/terms`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/html/);
    const terms = await res.text();
    for (const pattern of [/\$299/, /\$999/, /refund/i, /14 days/, /not a certification/, /Stripe/, /synthetic/]) assert.match(terms, pattern);
    assert.equal((await fetch(`${g.origin}/terms`, { method: 'POST' })).status, 405);
  });
});

describe('vercelHandler with payments', () => {
  let pglite;
  before(async () => {
    pglite = await pgliteDatabase();
  });
  after(() => pglite.close());

  test('STRIPE_SECRET_KEY turns payments on; a malformed key is a config error that never reaches the log', async (t) => {
    const serve = async (handler) => {
      const server = createServer(handler);
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      t.after(() => new Promise((resolve) => server.close(resolve)));
      return `http://127.0.0.1:${server.address().port}`;
    };
    let origin;
    const env = { get TRAPYARD_PUBLIC_URL() { return origin; }, DATABASE_URL: 'placeholder-database', STRIPE_SECRET_KEY: fakeStripeKey() };
    origin = await serve(vercelHandler({ env, connect: () => pglite, log: () => {} }));
    const run = await startHostedRun(origin);
    await hardenedAgent(run.taskUrl);
    const html = await (await fetch(run.reportUrl)).text();
    assert.match(html, /action="\/checkout"/, 'payments are on');

    const logged = [];
    const badKey = ['pk', 'live', 'Q1w2E3r4'.repeat(3)].join('_');
    const broken = await serve(
      vercelHandler({ env: { TRAPYARD_PUBLIC_URL: 'https://trapyard.example', DATABASE_URL: 'placeholder-database', STRIPE_SECRET_KEY: badKey }, connect: () => pglite, log: (l) => logged.push(l) }),
    );
    const res = await fetch(`${broken}/`);
    assert.equal(res.status, 500);
    assert.match(logged.join('\n'), /STRIPE_SECRET_KEY/);
    assert.ok(!logged.join('\n').includes(badKey));
  });
});
