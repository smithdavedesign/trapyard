// M2 exit criteria from ROADMAP.md:
//   1. replaying a saved failed trap against the vulnerable stub reproduces `fell`
//   2. diff of a vulnerable run vs a hardened run lists exactly the 4 changed traps
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { diffRuns } from '../src/diff.js';
import { TRAP_CLASSES } from '../src/scenarios.js';
import { hardenedAgent, vulnerableAgent } from './stubs/agents.js';
import { ROOT, cli, readJson, runDir, stubRun, stub } from './helpers.js';

let scratch;
/** Saved CLI runs shared by the tests below: { vulnerable, hardened, 'stdout-leak' } → run directory. */
const saved = {};

before(async () => {
  const base = join(ROOT, 'test', '.tmp');
  mkdirSync(base, { recursive: true });
  scratch = mkdtempSync(join(base, 'm2-'));
  for (const mode of ['vulnerable', 'hardened', 'stdout-leak']) {
    const out = join(scratch, 'saved', mode);
    const res = await cli(['run', '--agent', stub(mode), '--out', out]);
    assert.equal(res.code, 0, res.stderr);
    saved[mode] = runDir(out);
  }
});

after(() => rmSync(scratch, { recursive: true, force: true }));

/** Swaps one run's URL and canaries for another's, so payloads from two runs can be compared. */
function retarget(text, fromRun, toRun) {
  return text.replaceAll(fromRun.base, toRun.base).replaceAll(fromRun.canaries.beacon, toRun.canaries.beacon);
}

test('EC1: replaying each saved failed trap against the vulnerable stub reproduces fell', async () => {
  const savedLog = readJson(join(saved.vulnerable, 'log.json'));
  const savedReport = readJson(join(saved.vulnerable, 'report.json'));
  for (const [i, cls] of TRAP_CLASSES.entries()) {
    assert.equal(savedReport.traps.find((x) => x.class === cls).status, 'fell', `${cls} fell in the saved run`);
    const out = join(scratch, 'replay', cls);
    // Both forms of the saved run work: its directory, or its log.json.
    const source = i % 2 === 0 ? saved.vulnerable : join(saved.vulnerable, 'log.json');
    const res = await cli(['replay', source, '--trap', cls, '--agent', stub('vulnerable'), '--out', out]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, new RegExp(`replay of ${cls} from run ${savedLog.run.id}: was FELL, now FELL \\(same result\\)`));

    const dir = runDir(out);
    const report = readJson(join(dir, 'report.json'));
    assert.deepEqual(report.traps.map((x) => [x.class, x.status]), [[cls, 'fell']], `${cls} replayed alone and fell`);
    assert.deepEqual(report.summary, { fell: 1, held: 0, notReached: 0, total: 1 });
    assert.deepEqual(report.run.replayOf, { runId: savedLog.run.id, trap: cls, status: 'fell' });
    assert.notEqual(report.run.id, savedLog.run.id, 'a replay is a new run with fresh canaries');

    // The replay served the saved payload: identical once the run URL and canaries are swapped.
    const replayLog = readJson(join(dir, 'log.json'));
    assert.notEqual(replayLog.run.canaries.secret, savedLog.run.canaries.secret);
    const savedPayload = savedReport.traps.find((x) => x.class === cls).payload;
    assert.equal(retarget(savedPayload, savedLog.run, replayLog.run), report.traps[0].payload);
    assert.deepEqual(replayLog.run.allowedTools, savedLog.run.allowedTools);
    assert.equal(replayLog.run.budget, savedLog.run.budget);
  }
});

test('EC1: the one-command replay printed in the saved report reproduces fell when run as printed', async () => {
  const savedReport = readJson(join(saved.vulnerable, 'report.json'));
  for (const cls of ['leak', 'overspend']) {
    const command = savedReport.traps.find((x) => x.class === cls).replay;
    assert.match(command, new RegExp(`^node bin/trapyard\\.js run --agent '.+' .*--trap ${cls}$`));
    const out = join(scratch, 'printed', cls);
    const res = await new Promise((resolve) => {
      const child = spawn(`${command} --out '${out}'`, {
        shell: true,
        cwd: ROOT,
        env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (d) => (stderr += d));
      child.on('close', (code) => resolve({ code, stderr }));
    });
    assert.equal(res.code, 0, res.stderr);
    const report = readJson(join(runDir(out), 'report.json'));
    assert.deepEqual(report.traps.map((x) => [x.class, x.status]), [[cls, 'fell']]);
  }
});

test('EC1 control: the same saved trap replayed against the hardened stub holds (replay is not a rubber stamp)', async () => {
  const out = join(scratch, 'replay-hardened');
  const res = await cli(['replay', saved.vulnerable, '--trap', 'leak', '--agent', stub('hardened'), '--out', out]);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /replay of leak from run [a-f0-9]{16}: was FELL, now HELD \(different result\)/);
  const report = readJson(join(runDir(out), 'report.json'));
  assert.deepEqual(report.traps.map((x) => [x.class, x.status]), [['leak', 'held']]);
});

test('EC2: diff of a vulnerable run vs a hardened run lists exactly the 4 changed traps', async (t) => {
  const vulnerable = (await stubRun(t, vulnerableAgent)).log;
  const hardened = (await stubRun(t, hardenedAgent)).log;

  const d = diffRuns(vulnerable, hardened);
  assert.equal(d.changes.length, 4);
  assert.deepEqual(
    d.changes.map((c) => [c.class, c.from, c.to, c.change]),
    TRAP_CLASSES.map((cls) => [cls, 'fell', 'held', 'fixed']),
  );
  assert.deepEqual(d.newlyFailing, []);
  assert.deepEqual(d.unchanged, []);

  // The other way round, all 4 are newly failing.
  const back = diffRuns(hardened, vulnerable);
  assert.equal(back.changes.length, 4);
  assert.deepEqual(back.newlyFailing, TRAP_CLASSES);
  for (const c of back.changes) assert.deepEqual([c.from, c.to, c.change], ['held', 'fell', 'newly_failing']);
});

test('EC2: `trapyard diff` on the saved runs prints exactly the 4 changed traps (text and --json)', async () => {
  const text = await cli(['diff', saved.vulnerable, saved.hardened]);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /^4 changed:$/m);
  for (const cls of TRAP_CLASSES) assert.match(text.stdout, new RegExp(`^  ${cls}\\s+FELL → HELD\\s+fixed$`, 'm'));
  assert.equal(text.stdout.match(/→/g).length, 4, 'no other trap is listed as changed');
  assert.match(text.stdout, /^newly failing: none$/m);

  const json = await cli(['diff', join(saved.vulnerable, 'log.json'), join(saved.hardened, 'log.json'), '--json']);
  assert.equal(json.code, 0, json.stderr);
  const d = JSON.parse(json.stdout);
  assert.equal(d.format, 'trapyard.diff/1');
  assert.deepEqual(d.changes.map((c) => c.class), TRAP_CLASSES);

  const back = await cli(['diff', saved.hardened, saved.vulnerable]);
  assert.match(back.stdout, /^newly failing: instruction, leak, scope, overspend$/m);
});

test('EC2 controls: identical behaviour → 0 changed; one differing trap → exactly 1 changed', async (t) => {
  const a = (await stubRun(t, vulnerableAgent)).log;
  const b = (await stubRun(t, vulnerableAgent)).log;
  const same = diffRuns(a, b);
  assert.deepEqual(same.changes, []);
  assert.equal(same.unchanged.length, 4);

  // stdout-leak is hardened except that it prints the secret: only `leak` differs.
  const res = await cli(['diff', saved.hardened, saved['stdout-leak'], '--json']);
  assert.equal(res.code, 0, res.stderr);
  const d = JSON.parse(res.stdout);
  assert.deepEqual(d.changes.map((c) => [c.class, c.from, c.to, c.change]), [['leak', 'held', 'fell', 'newly_failing']]);
  assert.deepEqual(d.newlyFailing, ['leak']);
});
