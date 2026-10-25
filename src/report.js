// Report: JSON and HTML, both pure functions of a log (reportPage renders an already built report).
// Nothing here reads the clock, the environment or randomness, so the same log always renders
// byte-identical output.

import { LOG_FORMAT, validateReplayOf, validateTraps } from './range.js';
import { SCENARIO_SET, TRAP_CLASSES, parseAmount, runTraps } from './scenarios.js';
import { score } from './score.js';

export const REPORT_FORMAT = 'trapyard.report/1';
const CLIP = 2000; // characters of a URL or body shown in the report; the saved log keeps them whole
const SAFE_TOOL_NAME = /^[A-Za-z0-9_.-]+$/;

const SCOPE =
  'This report covers only the traps listed above, run on the trapyard range against this agent on the date shown. ' +
  'It shows how the agent behaved on the range; it is not a certification, a security guarantee, or evidence of how ' +
  'the agent behaves in production or against other attacks.';

function assertLog(log) {
  const fail = (why) => {
    throw new Error(`not a trapyard log: ${why}`);
  };
  if (!log || typeof log !== 'object') fail('expected a JSON object');
  if (log.format !== LOG_FORMAT) fail(`format is ${JSON.stringify(log.format)}, expected ${LOG_FORMAT}`);
  const run = log.run;
  if (!run || typeof run !== 'object') fail('missing run');
  for (const key of ['id', 'base', 'startedAt', 'budget']) {
    if (typeof run[key] !== 'string') fail(`run.${key} is missing`);
  }
  if (parseAmount(run.budget) === null) fail('run.budget is not an amount');
  if (!Array.isArray(run.allowedTools) || !run.allowedTools.every((t) => typeof t === 'string' && SAFE_TOOL_NAME.test(t))) {
    fail('run.allowedTools must be a list of tool names');
  }
  const c = run.canaries;
  if (!c || typeof c.secret !== 'string' || typeof c.beacon !== 'string' || !c.secret || !c.beacon) {
    fail('run.canaries is missing');
  }
  // run.traps and run.replayOf are absent on M1 logs; when present they must be exactly what the range writes.
  let traps = TRAP_CLASSES;
  if (run.traps !== undefined) {
    try {
      traps = validateTraps(run.traps);
    } catch (err) {
      fail(`run.traps: ${err.message}`);
    }
    if (traps.join() !== run.traps.join()) fail('run.traps must list distinct trap classes in scenario order');
  }
  try {
    validateReplayOf(run.replayOf, traps);
  } catch (err) {
    fail(`run.${err.message}`);
  }
  if (!Array.isArray(log.events)) fail('events must be an array');
  for (const e of log.events) {
    if (!e || typeof e !== 'object' || !Number.isInteger(e.seq) || typeof e.kind !== 'string') fail('malformed event');
    if (typeof e.url !== 'string' || typeof e.body !== 'string') fail(`event ${e.seq} has no url or body`);
    if (e.kind === 'tool' && (!e.tool || typeof e.tool.name !== 'string')) fail(`tool event ${e.seq} has no tool name`);
  }
  if (log.scenarioSet?.version !== SCENARIO_SET.version) {
    throw new Error(
      `this log was recorded with scenario set ${log.scenarioSet?.version}; this trapyard renders ${SCENARIO_SET.version}`,
    );
  }
}

const clip = (text) => (text.length > CLIP ? `${text.slice(0, CLIP)}…[${text.length - CLIP} more characters]` : text);

/** POSIX single-quoting, so the replay command can be pasted into a shell as-is. */
export function shellQuote(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

function reportEvent(e) {
  return {
    seq: e.seq,
    at: e.at,
    method: e.method,
    url: clip(e.url),
    kind: e.kind,
    status: e.status,
    body: clip(e.body),
    ...(e.tool ? { tool: { name: e.tool.name, args: e.tool.args ?? null, result: e.tool.result ?? null } } : {}),
  };
}

function warningsFor(run, summary) {
  const out = [];
  const agent = run.agent;
  if (agent?.timedOut) out.push('The agent timed out and was stopped.');
  else if (agent && agent.exitCode === null && agent.signal) out.push(`The agent was stopped by signal ${agent.signal}.`);
  else if (agent && agent.exitCode !== 0) out.push(`The agent exited with code ${agent.exitCode}.`);
  if (run.truncated) out.push('The run hit the event cap; later requests were refused and are not in this report.');
  if (summary.notReached === summary.total) {
    out.push('The agent never fetched any trap page; not_reached traps were not tested.');
  } else if (summary.notReached > 0) {
    out.push(`${summary.notReached} trap(s) were not reached: the agent never fetched their page, so they were not tested.`);
  }
  return out;
}

/** `trapyard run` with this run's agent and settings. Every part is shell-quoted or validated by assertLog. */
function runCommand(run, traps) {
  const agentArg = run.agent?.command ? shellQuote(run.agent.command) : `'<your agent command>'`;
  const trapArg = traps ? ` --trap ${traps.join(',')}` : '';
  return `node bin/trapyard.js run --agent ${agentArg} --allow ${run.allowedTools.join(',')} --budget ${run.budget}${trapArg}`;
}

/** The report as a plain object. Throws on anything that is not a valid log for this scenario set. */
export function buildReport(input) {
  assertLog(input);
  const log = JSON.parse(JSON.stringify(input)); // same result whether the log came from memory or disk
  const { run } = log;
  const requestLog = log.events.map(reportEvent);
  const bySeq = new Map(requestLog.map((e) => [e.seq, e]));
  const results = score(log);
  const traps = runTraps(run).map((def, i) => ({
    class: def.class,
    title: def.title,
    status: results[i].status,
    page: `${run.base}/pages/${def.page}`,
    technique: def.technique,
    payload: def.payload(run),
    evidence: results[i].evidence.map((seq) => bySeq.get(seq)),
    fixHint: results[i].status === 'fell' ? def.fixHint : null,
    // One command that replays this trap alone, with the same settings and fresh canaries.
    replay: results[i].status === 'fell' ? runCommand(run, [def.class]) : null,
  }));
  const count = (status) => traps.filter((t) => t.status === status).length;
  const summary = { fell: count('fell'), held: count('held'), notReached: count('not_reached'), total: traps.length };
  const subset = traps.length < TRAP_CLASSES.length ? traps.map((t) => t.class) : null;
  return {
    format: REPORT_FORMAT,
    scenarioSet: { ...SCENARIO_SET },
    run: {
      id: run.id,
      date: run.startedAt,
      allowedTools: run.allowedTools,
      budget: run.budget,
      agent: run.agent ?? null,
      truncated: run.truncated === true,
      replayOf: run.replayOf ? { runId: run.replayOf.runId, trap: run.replayOf.trap, status: run.replayOf.status } : null,
    },
    summary,
    warnings: warningsFor(run, summary),
    traps,
    replay: { command: runCommand(run, subset) },
    requestLog,
    scope: SCOPE,
  };
}

export function reportJson(log) {
  return `${JSON.stringify(buildReport(log), null, 2)}\n`;
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPES[ch]);

export const STATUS_LABEL = { fell: 'fell', held: 'held', not_reached: 'not reached' };

export const CSS = `
body{font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:#1a1a1a;max-width:980px;margin:2rem auto;padding:0 1rem}
h1{margin-bottom:.2rem}h2{margin-top:2rem;border-bottom:1px solid #ddd;padding-bottom:.2rem}
.lede{font-size:1.15rem;margin-top:0}
dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:.2rem 1rem}dt{color:#555}dd{margin:0;overflow-wrap:anywhere}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #ddd;padding:.3rem .45rem;text-align:left;vertical-align:top}
td code,dd code{word-break:break-all}
pre{background:#f6f6f6;border:1px solid #e3e3e3;padding:.6rem;white-space:pre-wrap;word-break:break-word;font-size:13px}
.status{display:inline-block;padding:.05rem .5rem;border-radius:3px;font-size:.8rem;text-transform:uppercase;letter-spacing:.03em;vertical-align:middle}
.status.fell{background:#b3261e;color:#fff}.status.held{background:#1e7b34;color:#fff}.status.not_reached{background:#777;color:#fff}
.warnings{background:#fff4e5;border:1px solid #f0c27b;padding:.5rem 1rem}
.trap{border:1px solid #ddd;border-radius:4px;padding:0 1rem 1rem;margin:1rem 0;break-inside:avoid}
footer{margin-top:2rem;color:#555;font-size:13px}
button{font:inherit;font-size:1.05rem;padding:.55rem 1.2rem;border:0;border-radius:4px;background:#1a1a1a;color:#fff;cursor:pointer}
input[type=text]{font:inherit;padding:.45rem;width:100%;max-width:32rem;box-sizing:border-box;margin:.3rem 0}
.paid{background:#eef6ef;border:1px solid #9cc7a4;padding:.6rem 1rem;margin-bottom:1rem}.paid p{margin:.4rem 0}
@media (max-width:640px){table{display:block;overflow-x:auto}dl{grid-template-columns:minmax(0,1fr)}dt{margin-top:.4rem}}
@page{margin:14mm 12mm}
@media print{body{margin:0;max-width:none;font-size:10.5pt}a{color:inherit;text-decoration:none}.no-print{display:none}h2,h3,h4{break-after:avoid}thead{display:table-header-group}tr,pre,dl{break-inside:avoid}table{font-size:8.5pt}.status,.warnings{-webkit-print-color-adjust:exact;print-color-adjust:exact}.request-log{break-before:page}}
`;

function eventTable(events) {
  const rows = events.map((e) => {
    const detail = e.tool ? `${e.tool.name} ${JSON.stringify(e.tool.args)}` : e.body;
    return `<tr><td>${esc(e.seq)}</td><td>${esc(e.at)}</td><td>${esc(e.method)}</td><td><code>${esc(e.url)}</code></td><td>${esc(e.kind)}</td><td>${esc(e.status)}</td><td><code>${esc(detail)}</code></td></tr>`;
  });
  return `<table>
<thead><tr><th>#</th><th>Time</th><th>Method</th><th>URL</th><th>Kind</th><th>Status</th><th>Tool call / body</th></tr></thead>
<tbody>
${rows.join('\n')}
</tbody>
</table>`;
}

function trapSection(t) {
  const evidence =
    t.evidence.length > 0
      ? eventTable(t.evidence)
      : `<p>${t.status === 'not_reached' ? 'The agent never fetched this page, so this trap was not tested.' : 'No request matched this trap.'}</p>`;
  return `<section class="trap" id="trap-${esc(t.class)}">
<h3>${esc(t.title)} <span class="status ${esc(t.status)}">${esc(STATUS_LABEL[t.status])}</span></h3>
<p>Class <code>${esc(t.class)}</code> · page <code>${esc(t.page)}</code> · ${esc(t.technique)}</p>
<h4>Planted payload</h4>
<pre>${esc(t.payload)}</pre>
<h4>Evidence</h4>
${evidence}${t.fixHint ? `\n<h4>How to fix</h4>\n<p>${esc(t.fixHint)}</p>` : ''}${t.replay ? `\n<h4>Replay this trap</h4>\n<pre>${esc(t.replay)}</pre>` : ''}
</section>`;
}

/** A self-contained HTML page that prints to PDF, for a log. Everything from the log is escaped. */
export function reportHtml(log, options) {
  return reportPage(buildReport(log), options);
}

/**
 * The HTML page for a report built by buildReport(). The hosted gauntlet renders the report it
 * froze when the run ended, so a paid report still opens after the scenario set moves on.
 *
 * `hosted` (the paid report of a gauntlet run) adds who recorded the run and links to check it:
 *   { origin, cardUrl, verifyUrl, ended, warnings: [...], note }, all plain text, escaped here.
 *   verifyUrl is null in a report the seller sends by hand (`trapyard export`): that row is left out.
 * `banner` is HTML written by trapyard itself (never agent data), placed at the top of the page.
 */
export function reportPage(r, { hosted = null, banner = '' } = {}) {
  const agent = r.run.agent;
  let agentLine = 'not recorded';
  if (agent) {
    agentLine = `<code>${esc(agent.command)}</code> (${agent.timedOut ? 'timed out' : agent.exitCode === null ? `signal ${esc(agent.signal)}` : `exit ${esc(agent.exitCode)}`})`;
  } else if (hosted) {
    agentLine = 'an agent working over HTTP (a hosted run never sees its command or its own output)';
  }
  const allWarnings = [...(hosted?.warnings ?? []), ...r.warnings];
  const warnings = allWarnings.length
    ? `<div class="warnings"><ul>\n${allWarnings.map((w) => `<li>${esc(w)}</li>`).join('\n')}\n</ul></div>`
    : '';
  const hostedRows = hosted
    ? `\n<dt>Recorded by</dt><dd>the trapyard gauntlet at ${esc(hosted.origin)}</dd>` +
      `\n<dt>Run ended</dt><dd>${esc(hosted.ended)}</dd>` +
      `\n<dt>Score card</dt><dd><a href="${esc(hosted.cardUrl)}">${esc(hosted.cardUrl)}</a></dd>` +
      (hosted.verifyUrl ? `\n<dt>Verify online</dt><dd><a href="${esc(hosted.verifyUrl)}"><code>${esc(hosted.verifyUrl)}</code></a></dd>` : '')
    : '';
  const overview = r.traps
    .map((t) => `<tr><td><a href="#trap-${esc(t.class)}">${esc(t.title)}</a></td><td><code>${esc(t.class)}</code></td><td>${esc(t.technique)}</td><td>${esc(STATUS_LABEL[t.status])}</td></tr>`)
    .join('\n');
  const replayOf = r.run.replayOf
    ? `\n<dt>Replay of</dt><dd>trap <code>${esc(r.run.replayOf.trap)}</code> from run <code>${esc(r.run.replayOf.runId)}</code> (was ${esc(STATUS_LABEL[r.run.replayOf.status])})</dd>`
    : '';
  const trapReplays = r.traps.some((t) => t.replay)
    ? '\n<p>Each trap that fell above has its own replay command. It runs that trap alone (only its page is served) with the same settings and new canaries, so a model sees less context than in the full run.</p>'
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>trapyard report: run ${esc(r.run.id)}</title>
<style>${CSS}</style>
</head>
<body>${banner ? `\n${banner}` : ''}
<header>
<h1>trapyard report</h1>
<p class="lede">${r.summary.fell} of ${r.summary.total} traps fell · ${r.summary.held} held · ${r.summary.notReached} not reached</p>
<dl>
<dt>Run</dt><dd><code>${esc(r.run.id)}</code></dd>
<dt>Run date</dt><dd>${esc(r.run.date)}</dd>
<dt>Scenario set</dt><dd>${esc(r.scenarioSet.id)} ${esc(r.scenarioSet.version)} (${esc(r.scenarioSet.date)})</dd>
<dt>Allowed tools</dt><dd>${r.run.allowedTools.map((t) => `<code>${esc(t)}</code>`).join(', ')}</dd>
<dt>Budget</dt><dd>${esc(r.run.budget)}</dd>
<dt>Agent</dt><dd>${agentLine}</dd>${replayOf}${hostedRows}
</dl>
${warnings}
</header>
<main>
<h2>Traps</h2>
<table>
<thead><tr><th>Trap</th><th>Class</th><th>Technique</th><th>Result</th></tr></thead>
<tbody>
${overview}
</tbody>
</table>
${r.traps.map(trapSection).join('\n')}
<h2>Replay</h2>
<p>Run the same scenario set again with the same settings (new canaries, same traps):</p>
<pre>${esc(r.replay.command)}</pre>${trapReplays}
<h2 class="request-log">Request log</h2>
<p>Every request the agent made to this run, in order.</p>
${eventTable(r.requestLog)}
</main>
<footer>
<p>${esc(r.scope)}${hosted?.note ? ` ${esc(hosted.note)}` : ''}</p>
<p>Report format ${esc(r.format)}.</p>
</footer>
</body>
</html>
`;
}
