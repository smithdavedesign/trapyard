// `trapyard serve` (the hosted gauntlet on 127.0.0.1) and the post-deploy smoke script.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { ROOT, cli, getJson, startHostedRun, stub } from './helpers.js';

const CLI = join(ROOT, 'bin', 'trapyard.js');

/** Resolves with the first match of `pattern` in a stream's output. */
function waitFor(stream, pattern) {
  return new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${pattern}; got: ${text}`)), 10_000);
    stream.setEncoding('utf8');
    stream.on('data', (d) => {
      text += d;
      const m = pattern.exec(text);
      if (m) {
        clearTimeout(timer);
        resolve(m);
      }
    });
  });
}

/** Runs a shell command to completion with extra env; resolves with its exit code and output. */
function sh(command, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('serve runs the gauntlet; an agent process completes a hosted run; the smoke script passes against it', async (t) => {
  const server = spawn(process.execPath, [CLI, 'serve', '--port', '0'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((resolve) => server.on('close', (code, signal) => resolve({ code, signal })));
  t.after(() => server.kill('SIGKILL'));
  const [, origin] = await waitFor(server.stdout, /gauntlet on (http:\/\/127\.0\.0\.1:\d+)/);

  // A real agent is a separate process that only gets the task URL.
  const run = await startHostedRun(origin);
  const agent = await sh(stub('vulnerable'), { TRAPYARD_TASK_URL: run.taskUrl });
  assert.equal(agent.code, 0, agent.stderr);
  const card = await getJson(run.cardJsonUrl);
  assert.equal(card.status, 200);
  assert.deepEqual(card.body.summary, { fell: 4, held: 0, notReached: 0, total: 4 });

  const smoke = await sh(`${JSON.stringify(process.execPath)} test/hosted-smoke.js ${origin}`);
  assert.equal(smoke.code, 0, smoke.stdout + smoke.stderr);
  assert.match(smoke.stdout, /^vulnerable: 4 fell, 0 held, 0 not reached — as expected/m);
  assert.match(smoke.stdout, /^hardened: 0 fell, 4 held, 0 not reached — as expected/m);

  server.kill('SIGTERM');
  assert.deepEqual(await exited, { code: 0, signal: null }, 'SIGTERM stops serve cleanly');
});

test('serve rejects a bad --port or --public-url with exit 2', async () => {
  for (const args of [['--port', 'abc'], ['--port', '70000'], ['--public-url', 'ftp://x.example'], ['--public-url', 'https://x.example/path'], ['extra']]) {
    const res = await cli(['serve', ...args]);
    assert.equal(res.code, 2, args.join(' '));
    assert.match(res.stderr, /usage:/);
  }
});

test('the smoke script fails (exit 1) when a card does not show what the stub should get, and exit 2 without a URL', async () => {
  const usage = await sh(`${JSON.stringify(process.execPath)} test/hosted-smoke.js`);
  assert.equal(usage.code, 2);
  // Nothing listens on port 9 (discard): the check must fail, not pass silently.
  const down = await sh(`${JSON.stringify(process.execPath)} test/hosted-smoke.js http://127.0.0.1:9`);
  assert.equal(down.code, 1);
});
