// CLI: run --trap, replay and diff (beyond the exit criteria), including usage errors.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, cli, readJson, runDir, scratchDir, statuses, stub } from './helpers.js';

let scratch;
let full; // a vulnerable run with default settings
let subset; // a hardened overspend-only run with non-default settings

before(async () => {
  const base = join(ROOT, 'test', '.tmp');
  mkdirSync(base, { recursive: true });
  scratch = mkdtempSync(join(base, 'cli-m2-'));
  const a = await cli(['run', '--agent', stub('vulnerable'), '--out', join(scratch, 'full')]);
  assert.equal(a.code, 0, a.stderr);
  full = runDir(join(scratch, 'full'));
  const b = await cli([
    'run', '--agent', stub('hardened'), '--out', join(scratch, 'subset'),
    '--trap', 'overspend', '--allow', 'read_note,spend,send_email', '--budget', '50.00',
  ]);
  assert.equal(b.code, 0, b.stderr);
  subset = runDir(join(scratch, 'subset'));
});

after(() => rmSync(scratch, { recursive: true, force: true }));

test('run --trap limits the run to those traps and its report replays with the same --trap', async (t) => {
  const report = readJson(join(subset, 'report.json'));
  assert.deepEqual(statuses(report), { overspend: 'held' });
  assert.match(report.replay.command, / --allow read_note,spend,send_email --budget 50\.00 --trap overspend$/);

  const out = scratchDir(t, 'cli-trap-list');
  const res = await cli(['run', '--agent', stub('vulnerable'), '--out', out, '--trap', 'scope, leak']);
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(statuses(readJson(join(runDir(out), 'report.json'))), { leak: 'fell', scope: 'fell' });
  assert.match(res.stdout, /2 fell, 0 held, 0 not reached/);
});

test('replay reuses the saved run\'s allowed tools and budget, and reports a changed result', async (t) => {
  const out = scratchDir(t, 'cli-replay-settings');
  const res = await cli(['replay', subset, '--trap', 'overspend', '--agent', stub('vulnerable'), '--out', out]);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /replay of overspend from run [a-f0-9]{16}: was HELD, now FELL \(different result\)/);
  const log = readJson(join(runDir(out), 'log.json'));
  assert.deepEqual(log.run.allowedTools, ['read_note', 'spend', 'send_email']);
  assert.equal(log.run.budget, '50.00');
  assert.deepEqual(log.run.traps, ['overspend']);
  assert.equal(log.run.agent.command, stub('vulnerable'));
});

test('replay of a trap the agent never reached says so instead of claiming it held', async (t) => {
  const out = scratchDir(t, 'cli-replay-unreached');
  const res = await cli(['replay', full, '--trap', 'scope', '--agent', `${JSON.stringify(process.execPath)} -e "0"`, '--out', out]);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /replay of scope from run [a-f0-9]{16}: was FELL, now NOT REACHED \(different result\)/);
  assert.match(res.stdout, /warning: The agent never fetched any trap page/);
});

test('replay usage errors exit 2, explain themselves and write nothing', async (t) => {
  const out = scratchDir(t, 'cli-replay-usage');
  const files = scratchDir(t, 'cli-replay-files');
  const savedLog = readJson(join(full, 'log.json'));
  const variant = (name, change) => {
    const path = join(files, `${name}.json`);
    const log = structuredClone(savedLog);
    change(log);
    writeFileSync(path, JSON.stringify(log));
    return path;
  };
  const oldVersion = variant('old-version', (l) => (l.scenarioSet.version = '1999.1.0'));
  const narrowTools = variant('narrow-tools', (l) => (l.run.allowedTools = ['read_note']));
  const tinyBudget = variant('tiny-budget', (l) => (l.run.budget = '1.00'));
  const agent = ['--agent', stub('vulnerable'), '--out', out];
  const cases = [
    [['replay', '--trap', 'leak', ...agent], /replay takes exactly one saved run/],
    [['replay', full, subset, '--trap', 'leak', ...agent], /replay takes exactly one saved run/],
    [['replay', full, '--trap', 'leak', '--out', out], /--agent is required.*never runs a command read from a log/],
    [['replay', full, ...agent], /--trap is required; traps that fell in run [a-f0-9]{16}: instruction, leak, scope, overspend/],
    [['replay', subset, ...agent], /--trap is required; traps that fell in run [a-f0-9]{16}: none/],
    [['replay', full, '--trap', 'phishing', ...agent], /unknown trap: phishing/],
    [['replay', full, '--trap', 'leak,scope', ...agent], /--trap takes one trap/],
    [['replay', subset, '--trap', 'leak', ...agent], /trap leak was not part of run [a-f0-9]{16} \(its traps: overspend\)/],
    [['replay', join(files, 'missing.json'), '--trap', 'leak', ...agent], /cannot read/],
    [['replay', join(full, 'report.json'), '--trap', 'leak', ...agent], /not a trapyard log: format is "trapyard.report\/1"/],
    [['replay', oldVersion, '--trap', 'leak', ...agent], /scenario set 1999\.1\.0/],
    [['replay', narrowTools, '--trap', 'leak', ...agent], /saved run's settings are not valid: allowed tools must include spend/],
    [['replay', tinyBudget, '--trap', 'leak', ...agent], /saved run's settings are not valid: budget must be/],
    [['replay', full, '--trap', 'leak', ...agent, '--timeout', '0'], /--timeout/],
  ];
  for (const [args, message] of cases) {
    const res = await cli(args);
    assert.equal(res.code, 2, `${args.join(' ')} → exit 2\n${res.stderr}`);
    assert.match(res.stderr, message, args.join(' '));
  }
  assert.deepEqual(readdirSync(out), [], 'no run directory written on usage errors');
});

test('run --trap usage errors exit 2', async (t) => {
  const out = scratchDir(t, 'cli-run-trap-usage');
  for (const [trap, message] of [['phishing', /unknown trap: phishing/], [',', /at least one trap/]]) {
    const res = await cli(['run', '--agent', 'x', '--trap', trap, '--out', out]);
    assert.equal(res.code, 2, res.stderr);
    assert.match(res.stderr, message);
  }
  assert.deepEqual(readdirSync(out), []);
});

test('diff of runs with different settings and trap sets prints the warnings and what was not compared', async () => {
  const res = await cli(['diff', full, subset]);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /^  overspend\s+FELL → HELD\s+fixed$/m);
  assert.match(res.stdout, /^1 changed:$/m);
  assert.match(res.stdout, /^not compared: instruction \(only in the from run\), leak \(only in the from run\), scope \(only in the from run\)$/m);
  assert.match(res.stdout, /^warning: The runs allowed different tools \(read_note, get_secret, spend vs read_note, spend, send_email\)/m);
  assert.match(res.stdout, /^warning: The runs had different budgets \(100\.00 vs 50\.00\)/m);
});

test('diff usage errors exit 2', async (t) => {
  const files = scratchDir(t, 'cli-diff-usage');
  const cases = [
    [['diff'], /diff takes two saved runs/],
    [['diff', full], /diff takes two saved runs/],
    [['diff', full, subset, full], /diff takes two saved runs/],
    [['diff', full, join(files, 'missing')], /cannot read/],
    [['diff', join(full, 'report.json'), subset], /not a trapyard log: format is "trapyard.report\/1"/],
    [['diff', full, subset, '--bogus'], /bogus/],
  ];
  for (const [args, message] of cases) {
    const res = await cli(args);
    assert.equal(res.code, 2, `${args.join(' ')} → exit 2`);
    assert.match(res.stderr, message, args.join(' '));
  }
});
