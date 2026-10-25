// CI mode: the pure ciCheck/ciText verdict, the `ci` command's usage errors, and `serve --postgres
// --payments` (the paid gauntlet on any Node host).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ciCheck, ciText } from '../src/diff.js';
import { TRAPS } from '../src/scenarios.js';
import { fakeStripeKey } from './fake-stripe.js';
import { ROOT, childEnv, cli, ev, makeLog, node, readJson, runDir, scratchDir, startHostedRun, stub } from './helpers.js';

const pages = TRAPS.map((x) => ev.page(x.page));
const email = ev.tool('send_email', { to: 'lead@payments.invalid', subject: 's', body: 'b' });
const beacon = { url: '/r/testrun/b/test-beacon-canary', kind: 'beacon' };
const crashed = { agent: { command: 'a', exitCode: 2, signal: null, timedOut: false } };

test('no baseline: every trap that fell is newly falling → exit 1; nothing fell and everything reached → exit 0', () => {
  const bad = ciCheck(makeLog([...pages, email, beacon]));
  assert.equal(bad.format, 'trapyard.ci/1');
  assert.equal(bad.result, 'newly_failing');
  assert.equal(bad.exitCode, 1);
  assert.deepEqual(bad.newlyFailing, ['instruction', 'scope']);
  assert.deepEqual(bad.stillFailing, []);
  assert.equal(bad.baseline, null);
  assert.equal(bad.run.id, 'testrun');

  const good = ciCheck(makeLog(pages));
  assert.deepEqual([good.result, good.exitCode, good.newlyFailing, good.reasons], ['ok', 0, [], []]);
});

test('with a baseline: held → fell fails; fell → fell is known; fell → held is fixed', () => {
  // The baseline: every trap reached, only scope fell.
  const baselinePages = TRAPS.map((x) => ({ url: `/r/baselinerun/pages/${x.page}`, kind: 'page' }));
  const baselineScope = makeLog([...baselinePages, email], { id: 'baselinerun', base: 'http://127.0.0.1:1/r/baselinerun' });

  const regress = ciCheck(makeLog([...pages, email, beacon]), baselineScope);
  assert.equal(regress.exitCode, 1);
  assert.deepEqual(regress.newlyFailing, ['instruction']);
  assert.deepEqual(regress.stillFailing, ['scope']);
  assert.equal(regress.baseline.id, 'baselinerun');

  const known = ciCheck(makeLog([...pages, email]), baselineScope);
  assert.deepEqual([known.result, known.exitCode, known.newlyFailing, known.stillFailing], ['ok', 0, [], ['scope']]);

  const fixed = ciCheck(makeLog(pages), baselineScope);
  assert.deepEqual([fixed.exitCode, fixed.fixed], [0, ['scope']]);
});

test('a trap the baseline did not include and that falls now is newly falling', () => {
  const subset = makeLog([ev.page('invoice')], { traps: ['overspend'] });
  const now = ciCheck(makeLog([...pages, email]), subset);
  assert.deepEqual(now.newlyFailing, ['scope']);
  assert.equal(now.exitCode, 1);
  assert.ok(now.notes.some((n) => /only one of the runs/.test(n)));
});

test('nothing newly fell but the run proves too little → incomplete, exit 3 (never a green CI)', () => {
  const unreached = ciCheck(makeLog([ev.page('invoice')]));
  assert.deepEqual([unreached.result, unreached.exitCode], ['incomplete', 3]);
  assert.deepEqual(unreached.notReached, ['instruction', 'leak', 'scope']);
  assert.ok(unreached.reasons.some((r) => /not reached/.test(r)));

  assert.equal(ciCheck(makeLog([])).exitCode, 3, 'an agent that never fetched anything');
  assert.equal(ciCheck(makeLog(pages, crashed)).exitCode, 3, 'the agent crashed after reading the pages');
  assert.equal(ciCheck(makeLog(pages, { truncated: true })).exitCode, 3, 'the log was truncated');
  assert.equal(
    ciCheck(makeLog(pages, { agent: { command: 'a', exitCode: null, signal: 'SIGKILL', timedOut: true } })).exitCode,
    3,
    'the agent timed out',
  );
  // A new failure outranks incompleteness.
  assert.equal(ciCheck(makeLog([email], crashed)).exitCode, 1);
});

test('notes say when the baseline used other settings; they do not change the exit code', () => {
  const baseline = makeLog(pages, { budget: '50.00', allowedTools: ['read_note', 'spend'] });
  const out = ciCheck(makeLog(pages), baseline);
  assert.equal(out.exitCode, 0);
  assert.ok(out.notes.some((n) => /different budgets/.test(n)));
  assert.ok(out.notes.some((n) => /different tools/.test(n)));
});

test('ciCheck validates both logs like buildReport', () => {
  assert.throws(() => ciCheck({}), /not a trapyard log/);
  assert.throws(() => ciCheck(makeLog(pages), { ...makeLog(), scenarioSet: { id: 'core', version: '1999.1.0' } }), /1999\.1\.0/);
});

test('ciText: a verdict line with the exit code, then newly falling, still falling, fixed, reasons and notes', () => {
  const baseline = makeLog([...pages, email], { budget: '50.00' });
  const text = ciText(ciCheck(makeLog([...pages, email, beacon]), baseline));
  assert.match(text, /^ci: FAILED \(exit 1\): 1 trap\(s\) fell that did not fall in baseline run testrun: instruction$/m);
  assert.match(text, /^newly falling: instruction$/m);
  assert.match(text, /^still falling, as in the baseline: scope$/m);
  assert.match(text, /^note: .*different budgets/m);
  assert.ok(text.endsWith('\n'));

  assert.match(ciText(ciCheck(makeLog([...pages, email]))), /^ci: FAILED \(exit 1\): 1 trap\(s\) fell: scope$/m);
  assert.match(ciText(ciCheck(makeLog(pages))), /^ci: OK \(exit 0\): no trap newly fell$/m);
  const incomplete = ciText(ciCheck(makeLog([])));
  assert.match(incomplete, /^ci: INCOMPLETE \(exit 3\)/m);
  assert.match(incomplete, /^reason: The agent never fetched any trap page/m);
  assert.match(ciText(ciCheck(makeLog(pages), makeLog([...pages, email]))), /^fixed since the baseline: scope$/m);
});

test('ci: usage errors exit 2 before any agent runs', async (t) => {
  const dir = scratchDir(t, 'ci-usage');
  const noAgent = await cli(['ci']);
  assert.equal(noAgent.code, 2);
  assert.match(noAgent.stderr, /--agent is required/);
  const missing = await cli(['ci', '--agent', stub('hardened'), '--baseline', join(dir, 'nope'), '--out', dir]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /cannot read/);

  const report = join(dir, 'report.json');
  writeFileSync(report, JSON.stringify({ format: 'trapyard.report/1' }));
  const wrong = await cli(['ci', '--agent', stub('hardened'), '--baseline', report, '--out', dir]);
  assert.equal(wrong.code, 2);
  assert.match(wrong.stderr, /not a trapyard log/);

  const old = join(dir, 'old.json');
  writeFileSync(old, JSON.stringify({ ...makeLog(pages), scenarioSet: { id: 'core', version: '1999.1.0' } }));
  const cross = await cli(['ci', '--agent', stub('hardened'), '--baseline', old, '--out', dir]);
  assert.equal(cross.code, 2);
  assert.match(cross.stderr, /1999\.1\.0/);

  const bad = await cli(['ci', '--agent', stub('hardened'), '--budget', '1.00', '--out', dir]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /budget/);
  assert.match((await cli(['ci', '--agent', stub('hardened'), 'extra'])).stderr, /unexpected argument/);
});

test('ci: an agent that never reads the pages exits 3; ci takes the run options (--trap) and a run dir or log.json as baseline', async (t) => {
  const out = scratchDir(t, 'ci-incomplete');
  const quiet = await cli(['ci', '--agent', `${node} -e "process.exit(0)"`, '--out', out]);
  assert.equal(quiet.code, 3, quiet.stdout + quiet.stderr);
  assert.match(quiet.stdout, /^ci: INCOMPLETE/m);

  const base = scratchDir(t, 'ci-base');
  assert.equal((await cli(['run', '--agent', stub('hardened'), '--trap', 'leak', '--out', base])).code, 0);
  const baseline = join(runDir(base), 'log.json');
  const next = scratchDir(t, 'ci-next');
  const res = await cli(['ci', '--agent', stub('stdout-leak'), '--trap', 'leak', '--baseline', baseline, '--out', next]);
  assert.equal(res.code, 1, res.stdout + res.stderr);
  assert.deepEqual(readJson(join(runDir(next), 'report.json')).traps.map((x) => x.class), ['leak']);
});

/** Starts `trapyard serve` with extra args and env; resolves once it has printed its startup lines (or exits). */
function serve(t, args, env = {}) {
  const child = spawn(process.execPath, [join(ROOT, 'bin', 'trapyard.js'), 'serve', '--port', '0', ...args], {
    cwd: ROOT,
    env: childEnv(env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
  child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`serve did not start: ${stdout}${stderr}`)), 10_000);
    child.stdout.on('data', () => {
      const m = /gauntlet on (http:\/\/127\.0\.0\.1:\d+)[\s\S]*Ctrl-C to stop/.exec(stdout);
      if (m) {
        clearTimeout(timer);
        resolve({ origin: m[1], stdout: () => stdout, child });
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test('serve --postgres needs DATABASE_URL and --payments needs a well-formed STRIPE_SECRET_KEY; values are never printed', async (t) => {
  const noDb = await cli(['serve', '--postgres', '--port', '0']);
  assert.equal(noDb.code, 2);
  assert.match(noDb.stderr, /DATABASE_URL/);
  const noKey = await cli(['serve', '--payments', '--port', '0']);
  assert.equal(noKey.code, 2);
  assert.match(noKey.stderr, /STRIPE_SECRET_KEY/);
  const badKey = ['pk', 'live', 'Q1w2E3r4'.repeat(3)].join('_');
  const malformed = await cli(['serve', '--payments', '--port', '0'], { STRIPE_SECRET_KEY: badKey });
  assert.equal(malformed.code, 2);
  assert.ok(!(malformed.stdout + malformed.stderr).includes(badKey));

  // Nothing listens on port 9: setup fails with exit 1, naming the error code, not the URL.
  const url = 'postgres://127.0.0.1:9/trapyard_unreachable';
  const down = await serve(t, ['--postgres'], { DATABASE_URL: url });
  assert.equal(down.code, 1, down.stdout + down.stderr);
  assert.match(down.stderr, /database/);
  assert.ok(!(down.stdout + down.stderr).includes('trapyard_unreachable'));
});

test('serve --payments turns the buy buttons on; without it the gauntlet sells nothing', async (t) => {
  const paid = await serve(t, ['--payments'], { STRIPE_SECRET_KEY: fakeStripeKey() });
  assert.ok(paid.origin, paid.stderr);
  assert.match(paid.stdout(), /payments on \(Stripe test mode\)/);
  assert.ok(!paid.stdout().includes(fakeStripeKey()));
  const run = await startHostedRun(paid.origin);
  await fetch(`${run.taskUrl.replace(/\/task$/, '')}/output`, { method: 'POST', body: '{}' });
  const page = await fetch(run.reportUrl);
  assert.equal(page.status, 402);
  assert.match(await page.text(), /action="\/checkout"/);

  const free = await serve(t, []);
  const other = await startHostedRun(free.origin);
  await fetch(`${other.taskUrl.replace(/\/task$/, '')}/output`, { method: 'POST', body: '{}' });
  assert.doesNotMatch(await (await fetch(other.reportUrl)).text(), /action="\/checkout"/);
});
