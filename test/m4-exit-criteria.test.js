// M4 exit criteria from ROADMAP.md:
//   1. CI mode exits 1 for the vulnerable stub and 0 for the hardened stub
//   2. a paid session id unlocks the full report, an unpaid one returns 402 (against both run stores)
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { logOf } from '../src/gauntlet.js';
import { buildReport } from '../src/report.js';
import { TRAPS } from '../src/scenarios.js';
import { memoryStore, postgresStore } from '../src/store.js';
import { fakeSessionId } from './fake-stripe.js';
import { hardenedAgent, vulnerableAgent } from './stubs/agents.js';
import { ROOT, cli, getJson, pgliteDatabase, runDir, scratchDir, startHostedRun, startPaidGauntlet, stub } from './helpers.js';

describe('EC1: CI mode', () => {
  let scratch;
  let vulnerableBaseline;
  let hardenedBaseline;

  before(async () => {
    const base = join(ROOT, 'test', '.tmp');
    mkdirSync(base, { recursive: true });
    scratch = mkdtempSync(join(base, 'm4-ci-'));
    const v = await cli(['run', '--agent', stub('vulnerable'), '--out', join(scratch, 'baseline-vulnerable')]);
    assert.equal(v.code, 0, v.stderr);
    vulnerableBaseline = runDir(join(scratch, 'baseline-vulnerable'));
    const h = await cli(['run', '--agent', stub('hardened'), '--out', join(scratch, 'baseline-hardened')]);
    assert.equal(h.code, 0, h.stderr);
    hardenedBaseline = runDir(join(scratch, 'baseline-hardened'));
  });

  after(() => rmSync(scratch, { recursive: true, force: true }));

  test('EC1: `trapyard ci` exits 1 for the vulnerable stub, naming every trap that fell', async (t) => {
    const out = scratchDir(t, 'ci-vulnerable');
    const res = await cli(['ci', '--agent', stub('vulnerable'), '--out', out]);
    assert.equal(res.code, 1, res.stdout + res.stderr);
    assert.match(res.stdout, /^ci: FAILED/m);
    for (const x of TRAPS) assert.match(res.stdout, new RegExp(`newly falling:.*\\b${x.class}\\b`));
    // CI mode writes the same report as `run`, for the CI log or an artifact.
    const dir = runDir(out);
    for (const file of ['log.json', 'report.json', 'report.html']) assert.ok(existsSync(join(dir, file)), file);
  });

  test('EC1: `trapyard ci` exits 0 for the hardened stub', async (t) => {
    const out = scratchDir(t, 'ci-hardened');
    const res = await cli(['ci', '--agent', stub('hardened'), '--out', out]);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /^ci: OK/m);
    assert.match(res.stdout, /newly falling: none/);
  });

  test('EC1 with a baseline: a trap that held in the baseline and now falls → exit 1 (hardened baseline, vulnerable agent)', async (t) => {
    const res = await cli(['ci', '--agent', stub('vulnerable'), '--baseline', hardenedBaseline, '--out', scratchDir(t, 'ci-regress')]);
    assert.equal(res.code, 1, res.stdout + res.stderr);
    assert.match(res.stdout, /4 trap\(s\) fell that did not fall in baseline run/);
  });

  test('EC1 with a baseline: traps already falling in the baseline do not fail CI (vulnerable baseline, vulnerable agent → 0)', async (t) => {
    const res = await cli(['ci', '--agent', stub('vulnerable'), '--baseline', vulnerableBaseline, '--out', scratchDir(t, 'ci-known')]);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /still falling, as in the baseline: instruction, leak, scope, overspend/);
  });

  test('EC1 with a baseline: fixes pass (vulnerable baseline, hardened agent → 0); one regression fails (hardened baseline, stdout-leak → 1, leak only)', async (t) => {
    const fixed = await cli(['ci', '--agent', stub('hardened'), '--baseline', vulnerableBaseline, '--out', scratchDir(t, 'ci-fixed')]);
    assert.equal(fixed.code, 0, fixed.stdout + fixed.stderr);
    const leak = await cli(['ci', '--agent', stub('stdout-leak'), '--baseline', hardenedBaseline, '--out', scratchDir(t, 'ci-leak')]);
    assert.equal(leak.code, 1, leak.stdout + leak.stderr);
    assert.match(leak.stdout, /newly falling: leak$/m);
  });
});

describe('EC2: the paid full report', () => {
  let pglite;
  before(async () => {
    pglite = await pgliteDatabase();
  });
  after(() => pglite.close());

  const STORES = {
    memory: async () => memoryStore(),
    postgres: async () => {
      const store = postgresStore(pglite);
      await store.migrate();
      return store;
    },
  };

  for (const [name, makeStore] of Object.entries(STORES)) {
    test(`EC2 (${name} store): a paid session id unlocks the full report; an unpaid one returns 402`, async (t) => {
      const store = await makeStore();
      const g = await startPaidGauntlet(t, { store });
      const run = await startHostedRun(g.origin);
      assert.equal(run.reportUrl, `${g.publicUrl}/report/${run.runId}`);
      await vulnerableAgent(run.taskUrl);

      // No session: 402, a page to buy it, and none of the report's content.
      const locked = await fetch(run.reportUrl);
      assert.equal(locked.status, 402);
      const lockedHtml = await locked.text();
      assert.match(lockedHtml, /\$299/);
      assert.match(lockedHtml, /\$999/);
      assert.match(lockedHtml, /<form method="post" action="\/checkout"/);
      assert.doesNotMatch(lockedHtml, /Request log|Planted payload/);
      assert.equal((await fetch(`${run.reportUrl}.json`)).status, 402);

      // Checkout: the buyer is sent to Stripe; Stripe sends them back to the report with the session id.
      const { id, returnUrl, session } = await g.checkout(run.runId, 'report');
      assert.equal(returnUrl, `${run.reportUrl}?session_id=${id}`);
      assert.equal(session.amount_total, 29_900);
      assert.equal(session.currency, 'usd');

      // Unpaid (checkout open, nothing charged): 402.
      const unpaid = await fetch(returnUrl);
      assert.equal(unpaid.status, 402);
      assert.doesNotMatch(await unpaid.text(), /Request log|Planted payload/);
      assert.equal((await fetch(`${run.reportUrl}.json?session_id=${id}`)).status, 402);

      // Paid: the full report.
      g.stripe.pay(id);
      const paid = await fetch(returnUrl);
      assert.equal(paid.status, 200);
      const html = await paid.text();
      assert.match(html, /4 of 4 traps fell · 0 held · 0 not reached/);
      for (const section of ['Planted payload', 'Evidence', 'How to fix', 'Request log']) assert.ok(html.includes(section), section);
      assert.ok(html.includes(run.runId));
      for (const x of TRAPS) assert.ok(html.includes(x.title));

      const json = await getJson(`${run.reportUrl}.json?session_id=${id}`);
      assert.equal(json.status, 200);
      const { hosted, ...report } = json.body;
      const log = logOf(await store.findRun(run.runId), await store.events(run.runId));
      assert.deepEqual(report, buildReport(log), 'the paid report is the scorer’s report of the stored log');
      assert.equal(hosted.cardUrl, run.cardUrl);

      // A session Stripe doesn't know, and a paid session bought for another run: 402.
      assert.equal((await fetch(`${run.reportUrl}?session_id=${fakeSessionId()}`)).status, 402);
      const other = await startHostedRun(g.origin);
      await hardenedAgent(other.taskUrl);
      assert.equal((await fetch(`${other.reportUrl}?session_id=${id}`)).status, 402);
    });
  }
});
