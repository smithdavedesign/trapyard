// Diff: a pure comparison of two runs, both scored from their logs by this code. It lists the traps
// whose status changed and how, the newly failing ones, the unchanged ones, traps only one run
// included, and warnings whenever the two runs are not directly comparable.
//
//   from log ─┐                       per trap class in both runs:
//             ├─ buildReport() ×2 ─▶  from status → to status → newly_failing | fixed | untested | now_tested
//   to log ───┘   (validates both)

import { buildReport } from './report.js';
import { SCENARIO_SET, TRAP_CLASSES } from './scenarios.js';

export const DIFF_FORMAT = 'trapyard.diff/1';

/** from status → to status → change kind, for every pair of different statuses. */
const CHANGE = {
  held: { fell: 'newly_failing', not_reached: 'untested' },
  not_reached: { fell: 'newly_failing', held: 'now_tested' },
  fell: { held: 'fixed', not_reached: 'untested' },
};

const side = (report) => ({
  id: report.run.id,
  date: report.run.date,
  agent: report.run.agent?.command ?? null,
  summary: report.summary,
});

const sameTools = (a, b) => [...a].sort().join() === [...b].sort().join();

/** Compares two logs. Throws (like buildReport) if either is not a valid log for this scenario set. */
export function diffRuns(fromLog, toLog) {
  const from = buildReport(fromLog);
  const to = buildReport(toLog);
  const fromTraps = new Map(from.traps.map((t) => [t.class, t]));
  const toTraps = new Map(to.traps.map((t) => [t.class, t]));
  const changes = [];
  const unchanged = [];
  const notCompared = [];
  for (const cls of TRAP_CLASSES) {
    const a = fromTraps.get(cls);
    const b = toTraps.get(cls);
    if (!a && !b) continue;
    if (!a || !b) notCompared.push({ class: cls, onlyIn: a ? 'from' : 'to' });
    else if (a.status === b.status) unchanged.push({ class: cls, title: a.title, status: a.status });
    else changes.push({ class: cls, title: a.title, from: a.status, to: b.status, change: CHANGE[a.status][b.status] });
  }

  const warnings = [];
  if (!sameTools(from.run.allowedTools, to.run.allowedTools)) {
    warnings.push(
      `The runs allowed different tools (${from.run.allowedTools.join(', ')} vs ${to.run.allowedTools.join(', ')}), ` +
        'so scope results are not directly comparable.',
    );
  }
  if (from.run.budget !== to.run.budget) {
    warnings.push(
      `The runs had different budgets (${from.run.budget} vs ${to.run.budget}), so overspend results are not directly comparable.`,
    );
  }
  if (notCompared.length) {
    warnings.push(
      `${notCompared.length} trap(s) ran in only one of the runs and were not compared: ${notCompared.map((x) => x.class).join(', ')}.`,
    );
  }
  warnings.push(...from.warnings.map((w) => `From run: ${w}`), ...to.warnings.map((w) => `To run: ${w}`));

  return {
    format: DIFF_FORMAT,
    scenarioSet: { ...SCENARIO_SET },
    from: side(from),
    to: side(to),
    changes,
    newlyFailing: changes.filter((c) => c.change === 'newly_failing').map((c) => c.class),
    unchanged,
    notCompared,
    warnings,
  };
}

/** fell → FELL, not_reached → NOT REACHED: how terminal output shows a status. */
export const statusLabel = (status) => status.replaceAll('_', ' ').toUpperCase();
const counts = (s) => `${s.fell} fell, ${s.held} held, ${s.notReached} not reached`;

/** The diff as plain text for a terminal or a CI log. */
export function diffText(d) {
  const lines = [
    `trapyard diff · scenario set ${d.scenarioSet.id} ${d.scenarioSet.version}`,
    `from run ${d.from.id} (${d.from.date}): ${counts(d.from.summary)}`,
    `to   run ${d.to.id} (${d.to.date}): ${counts(d.to.summary)}`,
    d.changes.length ? `${d.changes.length} changed:` : '0 changed',
    ...d.changes.map(
      (c) => `  ${c.class.padEnd(12)} ${`${statusLabel(c.from)} → ${statusLabel(c.to)}`.padEnd(20)} ${c.change.replaceAll('_', ' ')}`,
    ),
    d.unchanged.length
      ? `${d.unchanged.length} unchanged: ${d.unchanged.map((u) => `${u.class} (${statusLabel(u.status)})`).join(', ')}`
      : '0 unchanged',
    `newly failing: ${d.newlyFailing.length ? d.newlyFailing.join(', ') : 'none'}`,
  ];
  if (d.notCompared.length) {
    lines.push(`not compared: ${d.notCompared.map((x) => `${x.class} (only in the ${x.onlyIn} run)`).join(', ')}`);
  }
  for (const w of d.warnings) lines.push(`warning: ${w}`);
  return `${lines.join('\n')}\n`;
}

// ---- CI ------------------------------------------------------------------------------------------
//
//   log ────────┐                         newly falling = fell now, and did not fall in the baseline
//               ├─ buildReport() ×2 ─▶    (no baseline: every trap that fell)
//   baseline ───┘   (validates both)      ─▶ newly_failing (exit 1) | incomplete (exit 3) | ok (exit 0)
//
// A trap already falling in the baseline does not fail CI: the check is a ratchet, so known failures
// can be fixed one at a time. "incomplete" means nothing newly fell but the run cannot show that every
// trap was tested (a trap not reached, the agent crashed or timed out, the log was truncated): CI must
// never go green on a run that proves nothing.

export const CI_FORMAT = 'trapyard.ci/1';
const CI_EXIT = { ok: 0, newly_failing: 1, incomplete: 3 };

/** The CI verdict for a run, against a baseline run (or against "every trap holds"). Throws like buildReport. */
export function ciCheck(log, baselineLog = null) {
  const report = buildReport(log);
  const baseline = baselineLog ? buildReport(baselineLog) : null;
  const before = new Map((baseline?.traps ?? []).map((t) => [t.class, t.status]));
  const classes = (status, test = () => true) => report.traps.filter((t) => t.status === status && test(t)).map((t) => t.class);
  const newlyFailing = classes('fell', (t) => before.get(t.class) !== 'fell');
  const reasons = report.warnings; // exactly the ways a run can be incomplete (see warningsFor in report.js)
  const result = newlyFailing.length > 0 ? 'newly_failing' : reasons.length > 0 ? 'incomplete' : 'ok';
  return {
    format: CI_FORMAT,
    result,
    exitCode: CI_EXIT[result],
    run: { id: report.run.id, date: report.run.date },
    baseline: baseline ? { id: baseline.run.id, date: baseline.run.date } : null,
    newlyFailing,
    stillFailing: classes('fell', (t) => before.get(t.class) === 'fell'),
    fixed: classes('held', (t) => before.get(t.class) === 'fell'),
    notReached: classes('not_reached'),
    reasons,
    // Settings that differ from the baseline: worth knowing, but they don't change the verdict.
    notes: baseline ? diffRuns(baselineLog, log).warnings.filter((w) => !/^(From|To) run: /.test(w)) : [],
  };
}

/** The CI verdict as text for a CI log: the verdict line first. */
export function ciText(c) {
  const against = c.baseline ? ` that did not fall in baseline run ${c.baseline.id}` : '';
  const headline = {
    newly_failing: `FAILED (exit 1): ${c.newlyFailing.length} trap(s) fell${against}: ${c.newlyFailing.join(', ')}`,
    incomplete: 'INCOMPLETE (exit 3): no trap newly fell, but this run does not show that every trap was tested',
    ok: `OK (exit 0): no trap newly fell${c.baseline ? ` since baseline run ${c.baseline.id}` : ''}`,
  }[c.result];
  const lines = [`ci: ${headline}`, `newly falling: ${c.newlyFailing.join(', ') || 'none'}`];
  if (c.stillFailing.length) lines.push(`still falling, as in the baseline: ${c.stillFailing.join(', ')}`);
  if (c.fixed.length) lines.push(`fixed since the baseline: ${c.fixed.join(', ')}`);
  for (const r of c.reasons) lines.push(`reason: ${r}`);
  for (const n of c.notes) lines.push(`note: ${n}`);
  return `${lines.join('\n')}\n`;
}
