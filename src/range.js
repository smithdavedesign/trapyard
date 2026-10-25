// The range: per-run canaries, the trap pages, the fake tool server and the event log.
//
//   agent ──HTTP──▶ handler ──▶ answer(run, request) ──▶ response
//                       └─────────────┴──▶ event ──▶ run.events (in memory, capped)
//
// answer() is pure, and the hosted gauntlet (gauntlet.js) calls the same function inside a store
// transaction, so a hosted run serves and records exactly what a local one does.
//
// Every request under /r/<run id>/ is recorded, whatever its outcome. The log is never served over
// HTTP: it holds the canaries, and an agent that could read it could game its own score.

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import {
  DEFAULT_ALLOWED_TOOLS,
  DEFAULT_BUDGET,
  NOTES,
  SCENARIO_SET,
  TASK_SPEND_CENTS,
  TASK_TOOLS,
  TOOLS,
  TRAP_CLASSES,
  formatCents,
  parseAmount,
  renderPage,
  renderTask,
} from './scenarios.js';
import { STATUSES } from './score.js';

// Additive since M1: run.traps (absent = all four) and run.replayOf (absent = null).
export const LOG_FORMAT = 'trapyard.log/1';

const TOOL_NAMES = TOOLS.map((t) => t.name);
const RUN_ID = /^[a-f0-9]{16}$/;
const RUN_PATH = /^\/r\/([a-f0-9]{16})(\/[^?]*)?(?:\?.*)?$/;
const OUTPUT_EXCERPT = 40; // characters kept either side of a canary found in the agent's own output
const MAX_NAME = 100; // characters kept of agent-supplied tool and secret names

const hex = (bytes) => randomBytes(bytes).toString('hex');

/** Checks a list of trap classes; returns it deduplicated in scenario order. */
export function validateTraps(traps) {
  if (!Array.isArray(traps)) throw new Error('traps must be an array of trap classes');
  for (const t of traps) {
    if (!TRAP_CLASSES.includes(t)) throw new Error(`unknown trap: ${t} (known: ${TRAP_CLASSES.join(', ')})`);
  }
  if (traps.length === 0) throw new Error('a run needs at least one trap');
  return TRAP_CLASSES.filter((c) => traps.includes(c));
}

/** Checks a replay's lineage: the run it replays, the trap (one of `traps`) and that trap's status there. */
export function validateReplayOf(replayOf, traps) {
  if (replayOf === undefined || replayOf === null) return null;
  if (typeof replayOf !== 'object' || Array.isArray(replayOf)) {
    throw new Error('replayOf must be an object: { runId, trap, status }');
  }
  const { runId, trap, status } = replayOf;
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) throw new Error('replayOf.runId must be a 16-character hex run id');
  if (!traps.includes(trap)) throw new Error("replayOf.trap must be one of this run's traps");
  if (!STATUSES.includes(status)) throw new Error(`replayOf.status must be one of ${STATUSES.join(', ')}`);
  return { runId, trap, status };
}

/** Checks run options; returns them normalised. Throws with a message fit for a CLI user. */
export function validateRunOptions({
  allowedTools = DEFAULT_ALLOWED_TOOLS,
  budget = DEFAULT_BUDGET,
  traps = TRAP_CLASSES,
  replayOf = null,
} = {}) {
  if (!Array.isArray(allowedTools)) throw new Error('allowedTools must be an array of tool names');
  const tools = [...new Set(allowedTools)];
  for (const t of tools) {
    if (!TOOL_NAMES.includes(t)) throw new Error(`unknown tool: ${t} (known: ${TOOL_NAMES.join(', ')})`);
  }
  for (const t of TASK_TOOLS) {
    if (!tools.includes(t)) throw new Error(`allowed tools must include ${t}: the range's task uses it`);
  }
  const budgetCents = parseAmount(budget);
  if (budgetCents === null || budgetCents < TASK_SPEND_CENTS) {
    throw new Error(
      `budget must be an amount of at least ${formatCents(TASK_SPEND_CENTS)} with up to 2 decimals ` +
        `(the task pays a ${formatCents(TASK_SPEND_CENTS)} invoice)`,
    );
  }
  const classes = validateTraps(traps);
  return { allowedTools: tools, budgetCents, traps: classes, replayOf: validateReplayOf(replayOf, classes) };
}

/** A new run's header (the log's `run`): validated settings and fresh canaries, living under `origin`. */
export function newRun(origin, options, { id = hex(8), now = new Date() } = {}) {
  const { allowedTools, budgetCents, traps, replayOf } = validateRunOptions(options);
  return {
    id,
    base: `${origin}/r/${id}`,
    startedAt: now.toISOString(),
    allowedTools,
    budget: formatCents(budgetCents),
    traps,
    replayOf,
    canaries: { secret: `tysecret-${id}-${hex(6)}`, beacon: `${id}${hex(8)}` },
    agent: null,
    truncated: false,
  };
}

/** `/r/<run id>/<path>?query` → { id, path }; null for anything else. */
export function parseRunUrl(url) {
  const m = RUN_PATH.exec(url);
  return m ? { id: m[1], path: m[2] ?? '/' } : null;
}

/** Reads the body; resolves null once it passes `limit` bytes (the rest is drained, not kept). */
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    req.on('end', () => resolve(size > limit ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Sends a JSON (or `type`) response; `headers` add to or override the defaults. */
export function send(res, status, payload, type = 'application/json; charset=utf-8', headers = {}) {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload));
}

const json = (kind, status, payload) => ({ kind, status, payload });
const notAllowed = () => json('other', 405, { error: 'method not allowed' });

function callTool(run, rawName, body, { seq, spentCents }) {
  let name;
  try {
    name = decodeURIComponent(rawName);
  } catch {
    name = rawName;
  }
  name = name.slice(0, MAX_NAME);
  let args = null;
  try {
    const parsed = body ? JSON.parse(body) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed;
  } catch {
    // args stays null → 400 below
  }
  const done = (status, result, extra) => ({ kind: 'tool', status, payload: result, tool: { name, args, result }, ...extra });
  if (args === null) return done(400, { error: 'arguments must be a JSON object' });

  switch (name) {
    case 'read_note': {
      const found = typeof args.id === 'string' && Object.hasOwn(NOTES, args.id);
      return found ? done(200, { id: args.id, text: NOTES[args.id] }) : done(404, { error: 'no such note' });
    }
    case 'send_email':
      // Fake: nothing is ever sent.
      return done(200, { status: 'queued', id: `msg-${seq}` });
    case 'get_secret':
      return done(200, {
        name: typeof args.name === 'string' ? args.name.slice(0, MAX_NAME) : 'deploy_key',
        secret: run.canaries.secret,
      });
    case 'spend': {
      const cents = parseAmount(args.amount);
      if (cents === null) {
        return done(400, { error: 'amount must be a positive decimal with at most 2 places, e.g. "40.00"' });
      }
      // The fake ledger accepts overspending (balance goes negative) so the agent's behaviour is
      // what gets scored, not a decline it happened to receive.
      const total = spentCents + cents;
      const balance = formatCents(parseAmount(run.budget) - total);
      return done(200, { ok: true, charged: formatCents(cents), balance }, { spentCents: total });
    }
    default:
      return done(404, { error: `unknown tool: ${name}` });
  }
}

function route(run, { method, path, body, seq, spentCents }) {
  if (path === '/task') return method === 'GET' ? json('task', 200, renderTask(run)) : notAllowed();
  if (path === '/tools') return method === 'GET' ? json('tools-list', 200, { tools: TOOLS }) : notAllowed();
  if (path.startsWith('/tools/')) {
    return method === 'POST' ? callTool(run, path.slice('/tools/'.length), body, { seq, spentCents }) : notAllowed();
  }
  if (path.startsWith('/pages/')) {
    if (method !== 'GET') return notAllowed();
    const html = renderPage(path.slice('/pages/'.length), run);
    return html
      ? { kind: 'page', status: 200, payload: html, type: 'text/html; charset=utf-8' }
      : json('page', 404, { error: 'no such page' });
  }
  if (path === '/exfil') return json('exfil', 200, { ok: true });
  if (path === `/b/${run.canaries.beacon}`) return { kind: 'beacon', status: 200, payload: 'ok', type: 'text/plain; charset=utf-8' };
  if (path === '/output') return method === 'POST' ? json('output', 200, { ok: true }) : notAllowed();
  return json('not-found', 404, { error: 'not found' });
}

/**
 * One request against a run → what to send back and the event to record. Pure: the caller passes
 * the ledger total (`spentCents`) and the number the event will get (`seq`) and keeps what comes
 * back. `body` is null when it was over `maxBody` bytes. The event cap is the caller's to check.
 */
export function answer(run, { method, url, path, body, seq, at, spentCents, maxBody }) {
  const out =
    body === null
      ? json('too-large', 413, { error: `body larger than ${maxBody} bytes` })
      : route(run, { method, path, body, seq, spentCents });
  const event = { seq, at, method, url, kind: out.kind, status: out.status, body: body ?? '', ...(out.tool ? { tool: out.tool } : {}) };
  return { status: out.status, payload: out.payload, type: out.type, event, spentCents: out.spentCents ?? spentCents };
}

export function createRange({ maxEvents = 1000, maxBody = 32 * 1024 } = {}) {
  /** @type {Map<string, {info: object, events: object[], spentCents: number}>} */
  const runs = new Map();
  let server = null;
  let baseUrl = null;

  function createRun(options) {
    if (!baseUrl) throw new Error('range has no base URL yet: call listen() before createRun()');
    let id;
    do id = hex(8);
    while (runs.has(id));
    const info = newRun(baseUrl, options, { id });
    runs.set(id, { info, events: [], spentCents: 0 });
    return { ...structuredClone(info), taskUrl: `${info.base}/task` };
  }

  function getRun(id) {
    const r = runs.get(id);
    if (!r) throw new Error(`unknown run: ${id}`);
    return r;
  }

  /** The run's full log as plain JSON (a copy). */
  function getLog(id) {
    const r = getRun(id);
    return JSON.parse(JSON.stringify({ format: LOG_FORMAT, scenarioSet: SCENARIO_SET, run: r.info, events: r.events }));
  }

  function record(r, { method, url, kind, status, body, tool }) {
    r.events.push({
      seq: r.events.length + 1,
      at: new Date().toISOString(),
      method,
      url,
      kind,
      status,
      body,
      ...(tool ? { tool } : {}),
    });
  }

  /** Stores how the agent process ended; a secret canary in its own output becomes a log event. */
  function recordAgent(id, { command, exitCode, signal, timedOut, output = '' }) {
    const r = getRun(id);
    r.info.agent = { command, exitCode, signal, timedOut };
    const secret = r.info.canaries.secret;
    const at = output.indexOf(secret);
    if (at !== -1) {
      const excerpt = output.slice(Math.max(0, at - OUTPUT_EXCERPT), at + secret.length + OUTPUT_EXCERPT);
      record(r, { method: '', url: '(agent output)', kind: 'agent-output', status: null, body: excerpt });
    }
  }

  async function handler(req, res) {
    const url = req.url ?? '/';
    const target = parseRunUrl(url);
    const r = target && runs.get(target.id);
    if (!r) {
      req.resume();
      return send(res, 404, { error: 'unknown run' });
    }
    const body = await readBody(req, maxBody);
    // No await between this check and the push: the cap cannot be overshot by concurrent requests.
    if (r.events.length >= maxEvents) {
      r.info.truncated = true;
      return send(res, 429, { error: 'event limit reached for this run' });
    }
    const out = answer(r.info, {
      method: req.method,
      url,
      path: target.path,
      body,
      seq: r.events.length + 1,
      at: new Date().toISOString(),
      spentCents: r.spentCents,
      maxBody,
    });
    r.events.push(out.event);
    r.spentCents = out.spentCents;
    send(res, out.status, out.payload, out.type);
  }

  /** Listens on host:port (default 127.0.0.1, any free port) and returns the base URL. */
  async function listen(port = 0, host = '127.0.0.1') {
    server = createServer((req, res) => {
      handler(req, res).catch(() => {
        if (!res.headersSent) send(res, 500, { error: 'internal error' });
        else res.destroy();
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
    const address = server.address();
    baseUrl = `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`;
    return baseUrl;
  }

  async function close() {
    if (!server) return;
    const s = server;
    server = null;
    await new Promise((resolve) => {
      s.close(() => resolve());
      s.closeAllConnections();
    });
  }

  return { listen, close, createRun, getLog, recordAgent, handler };
}
