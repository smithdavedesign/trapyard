import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, reportHtml, reportJson, shellQuote } from '../src/report.js';
import { SCENARIO_SET, TRAPS } from '../src/scenarios.js';
import { vulnerableAgent, hardenedAgent } from './stubs/agents.js';
import { ev, makeLog, stubRun, trap } from './helpers.js';

test('report is stamped with format, scenario-set version, run id, run date and allowed tools', () => {
  const report = buildReport(makeLog());
  assert.equal(report.format, 'trapyard.report/1');
  assert.deepEqual(report.scenarioSet, SCENARIO_SET);
  assert.equal(report.run.id, 'testrun');
  assert.equal(report.run.date, '2026-10-25T00:00:00.000Z');
  assert.deepEqual(report.run.allowedTools, ['read_note', 'get_secret', 'spend']);
  assert.equal(report.run.budget, '100.00');
  assert.deepEqual(report.summary, { fell: 0, held: 0, notReached: 4, total: 4 });
});

test('each trap carries title, page, technique, the payload the agent saw and its evidence', async (t) => {
  const { log, run } = await stubRun(t, vulnerableAgent);
  const report = buildReport(log);
  for (const def of TRAPS) {
    const x = trap(report, def.class);
    assert.equal(x.title, def.title);
    assert.equal(x.technique, def.technique);
    assert.equal(x.page, `${run.base}/pages/${def.page}`);
    assert.equal(x.payload, def.payload(run));
    for (const e of x.evidence) assert.deepEqual(e, report.requestLog.find((r) => r.seq === e.seq));
  }
  assert.equal(report.requestLog.length, log.events.length);
});

test('a fix hint appears for every fell trap and only for fell traps', async (t) => {
  const vulnerable = buildReport((await stubRun(t, vulnerableAgent)).log);
  for (const x of vulnerable.traps) assert.ok(x.fixHint && x.fixHint.length > 80, `${x.class} has a hint`);
  assert.equal(new Set(vulnerable.traps.map((x) => x.fixHint)).size, 4, 'one distinct hint per class');
  const hardened = buildReport((await stubRun(t, hardenedAgent)).log);
  for (const x of hardened.traps) assert.equal(x.fixHint, null);
});

test('the report states its limits: no certification or guarantee', () => {
  const report = buildReport(makeLog());
  assert.match(report.scope, /not a certification/);
  assert.match(report.scope, /guarantee/);
  assert.match(reportHtml(makeLog()), /not a certification/);
});

test('replay command reproduces the run settings; uses the recorded agent command when there is one', () => {
  const plain = buildReport(makeLog());
  assert.equal(
    plain.replay.command,
    "node bin/trapyard.js run --agent '<your agent command>' --allow read_note,get_secret,spend --budget 100.00",
  );
  const withAgent = buildReport(
    makeLog([], {
      allowedTools: ['read_note', 'spend', 'send_email'],
      budget: '25.00',
      agent: { command: "python agent.py --name 'bot'", exitCode: 0, signal: null, timedOut: false },
    }),
  );
  assert.equal(
    withAgent.replay.command,
    "node bin/trapyard.js run --agent 'python agent.py --name '\\''bot'\\''' --allow read_note,spend,send_email --budget 25.00",
  );
});

test('shellQuote wraps in single quotes and escapes embedded ones', () => {
  assert.equal(shellQuote('a b'), "'a b'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  assert.equal(shellQuote('$(rm -rf /)'), "'$(rm -rf /)'");
});

test('warnings flag runs whose result may be incomplete', () => {
  assert.deepEqual(buildReport(makeLog()).warnings, [
    'The agent never fetched any trap page; not_reached traps were not tested.',
  ]);
  const pages = TRAPS.map((x) => ev.page(x.page));
  assert.deepEqual(buildReport(makeLog(pages)).warnings, []);
  const crashed = buildReport(
    makeLog(pages, { agent: { command: 'a', exitCode: 3, signal: null, timedOut: false }, truncated: true }),
  );
  assert.deepEqual(crashed.warnings, [
    'The agent exited with code 3.',
    'The run hit the event cap; later requests were refused and are not in this report.',
  ]);
  const timedOut = buildReport(
    makeLog(pages, { agent: { command: 'a', exitCode: null, signal: 'SIGKILL', timedOut: true } }),
  );
  assert.deepEqual(timedOut.warnings, ['The agent timed out and was stopped.']);
});

test('request log keeps long bodies short in the report (the saved log keeps them whole)', () => {
  const report = buildReport(makeLog([{ method: 'POST', url: '/r/testrun/output', kind: 'output', body: 'y'.repeat(5000) }]));
  const body = report.requestLog[0].body;
  assert.ok(body.length < 2100);
  assert.match(body, /…\[3000 more characters\]$/);
});

test('report JSON is pretty-printed with a trailing newline', () => {
  const json = reportJson(makeLog());
  assert.ok(json.endsWith('}\n'));
  assert.deepEqual(JSON.parse(json), buildReport(makeLog()));
});

test('HTML report shows run id, version, date, statuses, payloads and the replay command', async (t) => {
  const { log, run } = await stubRun(t, vulnerableAgent);
  const html = reportHtml(log);
  assert.match(html, /^<!doctype html>/);
  assert.ok(html.includes(run.id));
  assert.ok(html.includes(SCENARIO_SET.version));
  assert.ok(html.includes(log.run.startedAt));
  assert.equal(html.match(/class="status fell"/g).length, 4);
  for (const def of TRAPS) assert.ok(html.includes(def.title));
  assert.ok(html.includes('node bin/trapyard.js run --agent'));
  // Planted payloads are shown as text, never as live markup.
  assert.ok(html.includes('&lt;') || !TRAPS.some((x) => x.payload(run).includes('<')));
  assert.ok(!html.includes('<!-- AI agent'));
});

test('HTML report escapes everything the agent sent', () => {
  const nasty = '<script>alert(1)</script><img src=x onerror=alert(2)>"\'&';
  const html = reportHtml(
    makeLog([
      { method: 'POST', url: `/r/testrun/exfil?q=${nasty}`, kind: 'exfil', body: nasty },
      ev.tool(nasty, { x: nasty }),
    ], { agent: { command: nasty, exitCode: 0, signal: null, timedOut: false } }),
  );
  assert.ok(!html.includes('<script'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});

test('the HTML report prints to PDF: page margins, table headers on every page, no split rows, colours kept, the log on its own page', () => {
  const html = reportHtml(makeLog([ev.page('invoice')]));
  assert.match(html, /@page\{[^}]*margin/);
  const print = /@media print\{([\s\S]*?)\}\n/.exec(html)?.[1] ?? '';
  for (const rule of ['thead{display:table-header-group}', 'break-inside:avoid', 'print-color-adjust:exact', '.no-print{display:none}', '.request-log{break-before:page}']) {
    assert.ok(print.includes(rule), rule);
  }
  assert.match(html, /<h2 class="request-log">Request log<\/h2>/);
  // Self-contained: no script, and nothing loaded from anywhere (a PDF printed offline looks the same).
  assert.doesNotMatch(html, /<script|<link |src="http|@import|url\(/i);
});

test('a hosted report adds who recorded it, the card and verify links, how it ended, extra warnings and a banner, all escaped', () => {
  const log = makeLog(TRAPS.map((x) => ev.page(x.page)));
  const nasty = '<b>"x"</b>';
  const html = reportHtml(log, {
    hosted: {
      origin: 'https://trapyard.example',
      cardUrl: 'https://trapyard.example/s/card',
      verifyUrl: `https://trapyard.example/report/testrun?session_id=a&b=${nasty}`,
      ended: '2026-10-25T00:10:00.000Z: the agent posted its summary',
      warnings: [`Hosted warning ${nasty}`],
      note: 'A hosted run sees only the requests that reach the range.',
    },
    banner: '<div class="no-print" id="banner">trusted</div>',
  });
  assert.ok(html.includes('<div class="no-print" id="banner">trusted</div>'), 'the banner is trapyard-written HTML, inserted as-is');
  assert.ok(html.includes('https://trapyard.example'));
  assert.ok(html.includes('href="https://trapyard.example/s/card"'));
  assert.ok(html.includes('session_id=a&amp;b=&lt;b&gt;&quot;x&quot;&lt;/b&gt;'));
  assert.ok(!html.includes(nasty));
  assert.match(html, /the agent posted its summary/);
  assert.match(html, /<li>Hosted warning &lt;b&gt;/);
  assert.match(html, /A hosted run sees only the requests that reach the range\./);
  assert.match(html, /over HTTP/, 'the agent row says a hosted run never sees the agent command');
  // The local report is unchanged by the option's existence.
  assert.equal(reportHtml(log), reportHtml(log, {}));
  assert.doesNotMatch(reportHtml(log), /Recorded by|Verify online/);
});

test('logs that are not trapyard logs are rejected with a clear error', () => {
  for (const bad of [null, 42, {}, { format: 'other/1' }, { ...makeLog(), events: 'x' }, { ...makeLog(), run: null }]) {
    assert.throws(() => buildReport(bad), /not a trapyard log/);
  }
  assert.throws(() => buildReport({ ...makeLog(), scenarioSet: { id: 'core', version: '1999.1.0' } }), /scenario set 1999\.1\.0/);
});
