import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveGauntlet } from '../src/gauntlet.js';
import { stripeCheckout } from '../src/payments.js';
import { createRange } from '../src/range.js';
import { DEFAULT_ALLOWED_TOOLS, SCENARIO_SET } from '../src/scenarios.js';
import { memoryStore } from '../src/store.js';
import { startFakeStripe } from './fake-stripe.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const CLI = join(ROOT, 'bin', 'trapyard.js');
const STUBS = join(ROOT, 'test', 'stubs', 'agents.js');
export const node = JSON.stringify(process.execPath);

/** The shell command that starts a stub agent (vulnerable | hardened | stdout-leak). */
export const stub = (mode) => `${node} ${JSON.stringify(STUBS)} ${mode}`;

/**
 * The environment for a child process: this one's, minus the hosted settings (so a value set in the
 * developer's shell can't change a test), plus `extra`.
 */
export function childEnv(extra = {}) {
  const env = { ...process.env };
  for (const name of ['DATABASE_URL', 'STRIPE_SECRET_KEY']) delete env[name];
  return { ...env, ...extra };
}

/** Runs the trapyard CLI from the repo root; resolves with its exit code and output. */
export function cli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** The single run directory a `run` wrote into `out`. */
export function runDir(out) {
  const dirs = readdirSync(out);
  assert.equal(dirs.length, 1);
  return join(out, dirs[0]);
}

export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** A listening range that is closed when the test ends. */
export async function startRange(t, options) {
  const range = createRange(options);
  await range.listen();
  t.after(() => range.close());
  return range;
}

/** Run one stub agent against a fresh run and return the run and its log. */
export async function stubRun(t, agent, runOptions) {
  const range = await startRange(t);
  const run = range.createRun(runOptions);
  await agent(run.taskUrl);
  return { range, run, log: range.getLog(run.id) };
}

export async function callTool(run, name, args) {
  const res = await fetch(`${run.base}/tools/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof args === 'string' ? args : JSON.stringify(args),
  });
  return { status: res.status, body: await res.json() };
}

export const trap = (report, cls) => report.traps.find((t) => t.class === cls);

export const statuses = (report) => Object.fromEntries(report.traps.map((t) => [t.class, t.status]));

/** A hand-built log for pure scorer/report tests. Canaries are plain words, nothing key-shaped. */
export function makeLog(events = [], run = {}) {
  return {
    format: 'trapyard.log/1',
    scenarioSet: { ...SCENARIO_SET },
    run: {
      id: 'testrun',
      base: 'http://127.0.0.1:1/r/testrun',
      startedAt: '2026-10-25T00:00:00.000Z',
      allowedTools: [...DEFAULT_ALLOWED_TOOLS],
      budget: '100.00',
      canaries: { secret: 'test-secret-canary', beacon: 'test-beacon-canary' },
      agent: null,
      truncated: false,
      ...run,
    },
    events: events.map((e, i) => ({
      seq: i + 1,
      at: '2026-10-25T00:00:01.000Z',
      method: 'GET',
      url: '/r/testrun/',
      kind: 'other',
      status: 200,
      body: '',
      ...e,
    })),
  };
}

/** Event helpers for makeLog. */
export const ev = {
  page: (slug) => ({ url: `/r/testrun/pages/${slug}`, kind: 'page' }),
  tool: (name, args, status = 200) => ({
    method: 'POST',
    url: `/r/testrun/tools/${name}`,
    kind: 'tool',
    status,
    body: JSON.stringify(args),
    tool: { name, args, result: {} },
  }),
};

/** A scratch directory inside the repo (test/.tmp is git-ignored), removed when the test ends. */
export function scratchDir(t, prefix) {
  const base = join(ROOT, 'test', '.tmp');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, `${prefix}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Real Postgres in process (PGlite, WASM), behind the same { query, transaction } interface as pgDatabase(). */
export async function pgliteDatabase() {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = await PGlite.create();
  return {
    query: (text, params) => db.query(text, params),
    transaction: (fn) => db.transaction((tx) => fn((text, params) => tx.query(text, params))),
    close: () => db.close(),
  };
}

/** A gauntlet on 127.0.0.1 (memory store unless one is given), closed when the test ends. No hourly cap unless set. */
export async function startGauntlet(t, { store = memoryStore(), ...options } = {}) {
  const served = await serveGauntlet({ store, runsPerHour: 1_000_000, ...options });
  t.after(() => served.close());
  return { ...served, store };
}

/** POST /api/runs on a gauntlet; returns the parsed body, asserting 201. */
export async function startHostedRun(origin, options) {
  const res = await fetch(`${origin}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: options === undefined ? '' : JSON.stringify(options),
  });
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  return body;
}

/**
 * A gauntlet whose payments go to a fake Stripe on 127.0.0.1; both are closed when the test ends.
 * Returns the gauntlet plus `stripe` (the fake) and `checkout(runId, tier)`, which posts the buy form
 * and returns the session it created and the URL Stripe would send the buyer back to.
 */
export async function startPaidGauntlet(t, { now, ...options } = {}) {
  const stripe = await startFakeStripe({ now });
  t.after(() => stripe.close());
  const payments = stripeCheckout({ secretKey: stripe.key, apiBase: stripe.apiBase });
  const g = await startGauntlet(t, { payments, ...(now ? { now } : {}), ...options });
  async function checkout(runId, tier = 'report') {
    const res = await fetch(`${g.origin}/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ run: runId, tier }).toString(),
      redirect: 'manual',
    });
    assert.equal(res.status, 303, await res.clone().text());
    const location = res.headers.get('location');
    const id = location.split('/pay/')[1];
    const session = stripe.session(id);
    return { id, location, session, form: stripe.form(id), returnUrl: session.success_url.replace('{CHECKOUT_SESSION_ID}', id) };
  }
  return { ...g, stripe, checkout };
}

/** The range base a hosted run's agent talks to (what callTool() expects as `run.base`). */
export const hostedBase = (run) => ({ base: run.taskUrl.replace(/\/task$/, '') });

export const getJson = async (url) => {
  const res = await fetch(url);
  return { status: res.status, headers: res.headers, body: await res.json() };
};
