#!/usr/bin/env node
// trapyard CLI.
//   run    start the range on 127.0.0.1, run the agent command against one run, write log + report
//   replay run one trap of a saved run again, alone, with the saved settings; compare the result
//   diff   compare two saved runs trap by trap
//   report re-render report.json and report.html from a saved log.json
//   ci     `run`, then exit 1 if a trap fell that did not fall in the baseline run (or at all)
//   serve  run the hosted gauntlet (public page, run URLs, score cards, paid reports)
//   export write a hosted run's full report from the database, to send a Buy-button buyer by hand
// Exit codes: 0 done (whatever the agent fell for), 1 unexpected error, 2 usage error.
// ci: 0 nothing newly fell, 1 a trap newly fell, 2 usage error, 3 incomplete run.

import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ciCheck, ciText, diffRuns, diffText, statusLabel as label } from '../src/diff.js';
import { exportRun, paymentLinkFromEnv, paymentsConfig, publicOrigin, serveGauntlet } from '../src/gauntlet.js';
import { stripeCheckout } from '../src/payments.js';
import { createRange, validateRunOptions, validateTraps } from '../src/range.js';
import { buildReport, reportHtml, reportJson } from '../src/report.js';
import { DEFAULT_ALLOWED_TOOLS, DEFAULT_BUDGET, TRAP_CLASSES } from '../src/scenarios.js';
import { memoryStore, pgDatabase, pgPool, postgresStore } from '../src/store.js';

const USAGE = `usage:
  trapyard run --agent "<command>" [--allow read_note,get_secret,spend] [--budget 100.00]
               [--trap instruction,leak,scope,overspend] [--timeout 120] [--out trapyard-runs]
      Starts the range on 127.0.0.1 and runs <command> with TRAPYARD_TASK_URL set to the run's
      task URL. When the agent exits (or times out) writes <out>/<run id>/log.json, report.json
      and report.html. --trap limits the run to some traps (default: all four).
  trapyard ci --agent "<command>" [--baseline <run dir | log.json>] [run options]
      The same run, then a verdict for CI: exit 1 if a trap fell that did not fall in the baseline
      run (without --baseline: if any trap fell), 3 if nothing newly fell but the run does not show
      every trap was tested (a trap not reached, the agent failed or timed out), else 0.
  trapyard replay <run dir | log.json> --trap <class> --agent "<command>" [--timeout 120]
                  [--out trapyard-runs]
      Runs one trap of a saved run again on its own, with the saved allowed tools and budget and
      new canaries, writes a new run, and says whether the result is the same. The agent command
      is never read from the log.
  trapyard diff <old run dir | log.json> <new run dir | log.json> [--json]
      Lists the traps whose result changed between two runs and which ones newly fail.
  trapyard report <run dir | log.json> [--out <dir>]
      Re-renders report.json and report.html from a saved log (default: next to the log).
  trapyard serve [--port 4317] [--host 127.0.0.1] [--public-url <origin>] [--postgres] [--payments]
      Runs the hosted gauntlet: a public page that starts runs, the range, a score card per run
      and its paid full report. Runs are kept in memory and lost when it stops, unless --postgres
      (keeps them in Postgres at DATABASE_URL). --payments sells full reports through Stripe
      Checkout with STRIPE_SECRET_KEY. --public-url is the origin agents and buyers reach it at,
      if not the listen address (e.g. a tunnel or a host's URL). STRIPE_PAYMENT_LINK in the
      environment shows a Buy button linking to it.
  trapyard export <run id> [--out <dir>]
      Writes a hosted run's full report (log.json, report.json, report.html) from the Postgres
      database at DATABASE_URL, to send by hand to whoever bought it with the Buy button. The run
      id is in the run's report link, or the Stripe payment's client_reference_id.
      Default --out: trapyard-runs/<run id>.`;

const DEFAULT_PORT = 4317;
const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 3600;
const MAX_OUTPUT = 4 * 1024 * 1024; // characters of agent stdout/stderr kept for the canary scan

function usageError(message) {
  console.error(`trapyard: ${message}\n\n${USAGE}`);
  process.exit(2);
}

function parse(args, options, allowPositionals = false) {
  try {
    return parseArgs({ args, options, allowPositionals, strict: true });
  } catch (err) {
    return usageError(err.message);
  }
}

function killTree(child) {
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL'); // the agent runs in its own process group
  } catch {
    // already gone
  }
}

/** Runs the agent command in a shell; resolves with how it ended and what it printed. */
function runAgent(command, taskUrl, timeoutMs) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, {
      shell: true,
      env: { ...process.env, TRAPYARD_TASK_URL: taskUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let output = '';
    let timedOut = false;
    const keep = (chunk) => {
      process.stderr.write(chunk); // the agent's own output stays visible to the user
      if (output.length < MAX_OUTPUT) output += chunk;
    };
    child.stdout.setEncoding('utf8').on('data', keep);
    child.stderr.setEncoding('utf8').on('data', keep);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    const onInterrupt = () => killTree(child); // Ctrl-C stops the agent; the report is still written
    process.once('SIGINT', onInterrupt);
    let settled = false;
    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.removeListener('SIGINT', onInterrupt);
      resolvePromise({ exitCode, signal, timedOut, output });
    };
    child.on('error', (err) => {
      // The shell itself could not start: report it like a failed agent instead of crashing.
      keep(`trapyard: could not start the agent: ${err.message}\n`);
      finish(null, null);
    });
    child.on('close', finish);
  });
}

function writeReport(dir, log) {
  const json = reportJson(log);
  const html = reportHtml(log);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'report.json'), json);
  writeFileSync(join(dir, 'report.html'), html);
}

/** Prints the run's per-trap results and file paths; returns the report. */
function printSummary(log, dir) {
  const report = buildReport(log);
  const lines = [`trapyard run ${report.run.id} · scenario set ${report.scenarioSet.id} ${report.scenarioSet.version}`];
  for (const t of report.traps) lines.push(`  ${t.class.padEnd(12)} ${label(t.status)}`);
  const s = report.summary;
  lines.push(`${s.fell} fell, ${s.held} held, ${s.notReached} not reached`);
  for (const w of report.warnings) lines.push(`warning: ${w}`);
  lines.push(`report: ${join(dir, 'report.html')}`, `json:   ${join(dir, 'report.json')}`);
  console.log(lines.join('\n'));
  return report;
}

function parseTimeout(value) {
  const timeout = value === undefined ? DEFAULT_TIMEOUT_S : Number(value);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_S) {
    usageError(`--timeout must be a whole number of seconds from 1 to ${MAX_TIMEOUT_S}`);
  }
  return timeout;
}

const list = (value) => value.split(',').map((t) => t.trim()).filter(Boolean);

/** Starts a range, runs the agent against one run, writes <out>/<run id>/ and prints the summary; returns { log, report }. */
async function executeRun({ agent, timeout, out, ...runOptions }) {
  const range = createRange();
  await range.listen();
  const run = range.createRun(runOptions);
  let outcome;
  try {
    outcome = await runAgent(agent, run.taskUrl, timeout * 1000);
  } finally {
    await range.close();
  }
  range.recordAgent(run.id, { command: agent, ...outcome });

  const log = range.getLog(run.id);
  const dir = join(resolve(out ?? 'trapyard-runs'), run.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'log.json'), `${JSON.stringify(log, null, 2)}\n`);
  writeReport(dir, log);
  const report = printSummary(log, dir);
  console.log(`log:    ${join(dir, 'log.json')}`);
  return { log, report };
}

/** Reads and validates a saved log, given its path or its run directory. Usage error (exit 2) if it can't. */
function readLog(path) {
  let file = path;
  try {
    if (statSync(path).isDirectory()) file = join(path, 'log.json');
  } catch {
    // reported by the read below
  }
  let log;
  try {
    log = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    usageError(`cannot read ${file}: ${err.code ?? err.message}`);
  }
  let report;
  try {
    report = buildReport(log);
  } catch (err) {
    usageError(err.message);
  }
  return { file, log, report };
}

const RUN_FLAGS = {
  agent: { type: 'string' },
  allow: { type: 'string' },
  budget: { type: 'string' },
  trap: { type: 'string' },
  timeout: { type: 'string' },
  out: { type: 'string' },
};

/** `run`'s flags → the options executeRun takes; usage error (exit 2) if they are not valid. */
function runOptions(values, positionals) {
  if (positionals.length) usageError(`unexpected argument: ${positionals[0]}`);
  if (!values.agent) usageError('--agent is required');
  const options = {
    allowedTools: values.allow ? list(values.allow) : DEFAULT_ALLOWED_TOOLS,
    budget: values.budget ?? DEFAULT_BUDGET,
    traps: values.trap === undefined ? TRAP_CLASSES : list(values.trap),
  };
  try {
    validateRunOptions(options);
  } catch (err) {
    usageError(err.message);
  }
  return { agent: values.agent, timeout: parseTimeout(values.timeout), out: values.out, ...options };
}

async function commandRun(args) {
  const { values, positionals } = parse(args, RUN_FLAGS, true);
  await executeRun(runOptions(values, positionals));
}

async function commandCi(args) {
  const { values, positionals } = parse(args, { ...RUN_FLAGS, baseline: { type: 'string' } }, true);
  const options = runOptions(values, positionals);
  // The baseline is checked before the agent runs: a bad one is a usage error, not a wasted run.
  const baseline = values.baseline === undefined ? null : readLog(values.baseline).log;
  const { log } = await executeRun(options);
  const verdict = ciCheck(log, baseline);
  process.stdout.write(ciText(verdict));
  process.exitCode = verdict.exitCode;
}

async function commandReplay(args) {
  const { values, positionals } = parse(
    args,
    { trap: { type: 'string' }, agent: { type: 'string' }, timeout: { type: 'string' }, out: { type: 'string' } },
    true,
  );
  if (positionals.length !== 1) usageError('replay takes exactly one saved run (its directory or its log.json)');
  // A log is a data file and may come from someone else: never execute the command recorded in it.
  if (!values.agent) {
    usageError('--agent is required: trapyard never runs a command read from a log, so pass the command that starts your agent');
  }
  const timeout = parseTimeout(values.timeout);
  const { log, report } = readLog(positionals[0]);
  const saved = log.run;
  if (values.trap === undefined) {
    const fell = report.traps.filter((t) => t.status === 'fell').map((t) => t.class);
    usageError(`--trap is required; traps that fell in run ${saved.id}: ${fell.join(', ') || 'none'}`);
  }
  if (values.trap.includes(',')) usageError('--trap takes one trap (use run --trap a,b to run several together)');
  const trap = values.trap.trim();
  try {
    validateTraps([trap]);
  } catch (err) {
    usageError(err.message);
  }
  const original = report.traps.find((t) => t.class === trap);
  if (!original) {
    usageError(`trap ${trap} was not part of run ${saved.id} (its traps: ${report.traps.map((t) => t.class).join(', ')})`);
  }
  const options = {
    allowedTools: saved.allowedTools,
    budget: saved.budget,
    traps: [trap],
    replayOf: { runId: saved.id, trap, status: original.status },
  };
  try {
    validateRunOptions(options);
  } catch (err) {
    usageError(`the saved run's settings are not valid: ${err.message}`);
  }

  const { report: replayed } = await executeRun({ agent: values.agent, timeout, out: values.out, ...options });
  const now = replayed.traps[0].status;
  const verdict = now === original.status ? 'same result' : 'different result';
  console.log(`replay of ${trap} from run ${saved.id}: was ${label(original.status)}, now ${label(now)} (${verdict})`);
}

async function commandDiff(args) {
  const { values, positionals } = parse(args, { json: { type: 'boolean' } }, true);
  if (positionals.length !== 2) usageError('diff takes two saved runs: <old> <new> (run directories or log.json files)');
  const [from, to] = positionals.map((path) => readLog(path).log);
  const diff = diffRuns(from, to);
  process.stdout.write(values.json ? `${JSON.stringify(diff, null, 2)}\n` : diffText(diff));
}

async function commandReport(args) {
  const { values, positionals } = parse(args, { out: { type: 'string' } }, true);
  if (positionals.length !== 1) usageError('report takes exactly one log file');
  const { file, log } = readLog(positionals[0]);
  const dir = resolve(values.out ?? dirname(file));
  writeReport(dir, log);
  printSummary(log, dir);
}

/** The Postgres store at DATABASE_URL, migrated, and how to close its pool; exit 1 (naming only the error code) if it can't be set up. */
async function postgresFromEnv(needs = '--postgres') {
  const url = process.env.DATABASE_URL;
  if (!url) usageError(`${needs} needs DATABASE_URL (a Postgres connection string) in the environment`);
  try {
    const { default: pg } = await import('pg'); // loaded only here: the rest of the CLI needs nothing beyond Node
    const pool = pgPool(pg, url);
    const store = postgresStore(pgDatabase(pool));
    await store.migrate();
    return { store, end: () => pool.end() };
  } catch (err) {
    // Only the code or name: a driver's message can carry connection details.
    console.error(`trapyard: cannot set up the database at DATABASE_URL: ${err.code ?? err.name}`);
    process.exit(1);
  }
}

/** Stripe Checkout with STRIPE_SECRET_KEY; usage error if it is missing or malformed (the value is never printed). */
function paymentsFromEnv() {
  let config;
  try {
    config = paymentsConfig(process.env);
  } catch (err) {
    usageError(err.message);
  }
  if (!config) usageError('--payments needs STRIPE_SECRET_KEY (a Stripe secret or restricted key) in the environment');
  return { payments: stripeCheckout(config), mode: /_test_/.test(config.secretKey) ? 'Stripe test mode' : 'Stripe live mode' };
}

async function commandServe(args) {
  const { values, positionals } = parse(
    args,
    {
      port: { type: 'string' },
      host: { type: 'string' },
      'public-url': { type: 'string' },
      postgres: { type: 'boolean' },
      payments: { type: 'boolean' },
    },
    true,
  );
  if (positionals.length) usageError(`unexpected argument: ${positionals[0]}`);
  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (!/^\d+$/.test(values.port ?? '0') || port > 65535) usageError('--port must be a whole number from 0 to 65535');
  let publicUrl;
  if (values['public-url'] !== undefined) {
    try {
      publicUrl = publicOrigin(values['public-url'], '--public-url');
    } catch (err) {
      usageError(err.message);
    }
  }
  const paid = values.payments ? paymentsFromEnv() : null;
  const paymentLink = paymentLinkFromEnv(process.env, console.error);
  const { store, end } = values.postgres ? await postgresFromEnv() : { store: memoryStore(), end: async () => {} };
  const served = await serveGauntlet({
    store,
    payments: paid?.payments ?? null,
    paymentLink,
    signals: process.env.VERCEL_ENV === 'production', // as on Vercel: the visit beacon only in production
    port,
    host: values.host ?? '127.0.0.1',
    publicUrl,
  });
  const listening = served.publicUrl === served.origin ? '' : ` (listening on ${served.origin})`;
  console.log(`trapyard gauntlet on ${served.publicUrl}${listening}`);
  console.log(values.postgres ? 'runs are kept in Postgres (DATABASE_URL)' : 'runs are kept in memory and lost when it stops');
  console.log(paid ? `payments on (${paid.mode})` : 'payments off: full reports are not for sale (--payments turns them on)');
  console.log(paymentLink ? 'Buy button on (STRIPE_PAYMENT_LINK)' : 'Buy button off (STRIPE_PAYMENT_LINK is not set)');
  console.log('Ctrl-C to stop');
  await new Promise((done) => {
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
  await served.close();
  await end();
}

async function commandExport(args) {
  const { values, positionals } = parse(args, { out: { type: 'string' } }, true);
  if (positionals.length !== 1 || !/^[a-f0-9]{16}$/.test(positionals[0])) {
    usageError('export takes one run id: 16 hex characters, from the run\'s report link (/report/<run id>)');
  }
  const [runId] = positionals;
  const dir = resolve(values.out ?? join('trapyard-runs', runId));
  const { store, end } = await postgresFromEnv('export');
  try {
    const exported = await exportRun(store, runId);
    if (!exported) {
      console.error(`trapyard: no run ${runId} in the database at DATABASE_URL`);
      process.exitCode = 1;
      return;
    }
    mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(exported.files)) writeFileSync(join(dir, name), text);
    const report = JSON.parse(exported.files['report.json']);
    console.log(`run ${runId}: ${report.summary.fell} of ${report.summary.total} traps fell (ended ${report.hosted.endedAt})`);
    console.log(`report: ${join(dir, 'report.html')}\njson:   ${join(dir, 'report.json')}`);
  } finally {
    await end();
  }
}

const COMMANDS = {
  run: commandRun,
  ci: commandCi,
  replay: commandReplay,
  diff: commandDiff,
  report: commandReport,
  serve: commandServe,
  export: commandExport,
};

const [command, ...rest] = process.argv.slice(2);
if (!command) usageError('no command given');
if (!Object.hasOwn(COMMANDS, command)) usageError(`unknown command: ${command}`);
try {
  await COMMANDS[command](rest);
} catch (err) {
  console.error(`trapyard: ${err.message}`);
  process.exit(1);
}
