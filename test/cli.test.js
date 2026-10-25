import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { cli, node, readJson, runDir, scratchDir, statuses, stub } from './helpers.js';

test('run: vulnerable stub end to end → log, JSON and HTML report, 4 fell', async (t) => {
  const out = scratchDir(t, 'cli-run');
  const res = await cli(['run', '--agent', stub('vulnerable'), '--out', out]);
  assert.equal(res.code, 0, res.stderr);
  const dir = runDir(out);
  for (const f of ['log.json', 'report.json', 'report.html']) assert.ok(existsSync(join(dir, f)), f);
  const report = readJson(join(dir, 'report.json'));
  assert.deepEqual(statuses(report), { instruction: 'fell', leak: 'fell', scope: 'fell', overspend: 'fell' });
  assert.equal(report.run.agent.exitCode, 0);
  assert.ok(report.replay.command.includes(`--agent '${stub('vulnerable')}'`));
  assert.match(res.stdout, /instruction\s+FELL/);
  assert.match(res.stdout, /4 fell, 0 held, 0 not reached/);
  assert.ok(res.stdout.includes(join(dir, 'report.html')));
});

test('run: hardened stub with options → 0 fell; report re-rendered from the saved log is byte-identical', async (t) => {
  const out = scratchDir(t, 'cli-hardened');
  const res = await cli([
    'run', '--agent', stub('hardened'), '--out', out,
    '--allow', 'read_note,spend,send_email', '--budget', '50.00', '--timeout', '30',
  ]);
  assert.equal(res.code, 0, res.stderr);
  const dir = runDir(out);
  const report = readJson(join(dir, 'report.json'));
  assert.equal(report.summary.fell, 0);
  assert.deepEqual(report.run.allowedTools, ['read_note', 'spend', 'send_email']);
  assert.equal(report.run.budget, '50.00');

  const again = scratchDir(t, 'cli-report');
  const re = await cli(['report', join(dir, 'log.json'), '--out', again]);
  assert.equal(re.code, 0, re.stderr);
  assert.equal(readFileSync(join(again, 'report.json'), 'utf8'), readFileSync(join(dir, 'report.json'), 'utf8'));
  assert.equal(readFileSync(join(again, 'report.html'), 'utf8'), readFileSync(join(dir, 'report.html'), 'utf8'));
});

test('run: a canary printed by the agent itself is caught as a leak', async (t) => {
  const out = scratchDir(t, 'cli-stdout');
  const res = await cli(['run', '--agent', stub('stdout-leak'), '--out', out]);
  assert.equal(res.code, 0, res.stderr);
  const report = readJson(join(runDir(out), 'report.json'));
  assert.deepEqual(statuses(report), { instruction: 'held', leak: 'fell', scope: 'held', overspend: 'held' });
  assert.equal(report.traps[1].evidence[0].kind, 'agent-output');
});

test('run: an agent that hangs is stopped at --timeout and the report says so', async (t) => {
  const out = scratchDir(t, 'cli-timeout');
  const started = Date.now();
  const res = await cli(['run', '--agent', `${node} -e "setTimeout(() => {}, 60000)"`, '--out', out, '--timeout', '1']);
  assert.equal(res.code, 0, res.stderr);
  assert.ok(Date.now() - started < 15000, 'stopped promptly');
  const report = readJson(join(runDir(out), 'report.json'));
  assert.equal(report.run.agent.timedOut, true);
  assert.equal(report.summary.notReached, 4);
  assert.ok(report.warnings.includes('The agent timed out and was stopped.'));
});

test('run: an agent that fails is reported with its exit code', async (t) => {
  const out = scratchDir(t, 'cli-crash');
  const res = await cli(['run', '--agent', `${node} -e "process.exit(3)"`, '--out', out]);
  assert.equal(res.code, 0, res.stderr);
  const report = readJson(join(runDir(out), 'report.json'));
  assert.equal(report.run.agent.exitCode, 3);
  assert.ok(report.warnings.includes('The agent exited with code 3.'));
});

test('usage errors exit 2 with a message', async (t) => {
  const out = scratchDir(t, 'cli-usage');
  const bad = join(out, 'bad.json');
  writeFileSync(bad, JSON.stringify({ format: 'nope' }));
  const cases = [
    [[], /usage/],
    [['help-me'], /usage/],
    [['run'], /--agent is required/],
    [['run', '--agent', 'x', '--allow', 'read_note,rm'], /unknown tool: rm/],
    [['run', '--agent', 'x', '--budget', 'lots'], /budget/],
    [['run', '--agent', 'x', '--timeout', '0'], /--timeout/],
    [['run', '--agent', 'x', '--bogus'], /bogus/],
    [['report'], /usage/],
    [['report', join(out, 'missing.json')], /cannot read/],
    [['report', bad], /not a trapyard log/],
  ];
  for (const [args, message] of cases) {
    const res = await cli(args);
    assert.equal(res.code, 2, `${args.join(' ')} → exit 2`);
    assert.match(res.stderr, message, args.join(' '));
  }
  assert.deepEqual(readdirSync(out), ['bad.json'], 'no run directory written on usage errors');
});
