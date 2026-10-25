#!/usr/bin/env node
// Post-deploy check: runs both stub agents against a live gauntlet and checks their score cards,
// the hosted version of M3's exit criteria, and that each run's full report is locked (402) until
// paid. It creates two runs on the gauntlet and pays for nothing.
//
//   node test/hosted-smoke.js https://<your deployment>
//
// Exit codes: 0 both cards show what the stubs should get, 1 anything else, 2 usage error.

import { hardenedAgent, vulnerableAgent } from './stubs/agents.js';

const EXPECTED = {
  vulnerable: { agent: vulnerableAgent, summary: { fell: 4, held: 0, notReached: 0, total: 4 } },
  hardened: { agent: hardenedAgent, summary: { fell: 0, held: 4, notReached: 0, total: 4 } },
};

const counts = (s) => `${s.fell} fell, ${s.held} held, ${s.notReached} not reached`;

async function check(origin, name, { agent, summary }) {
  const created = await fetch(`${origin}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '' });
  if (created.status !== 201) throw new Error(`POST /api/runs answered ${created.status}: ${await created.text()}`);
  const run = await created.json();
  await agent(run.taskUrl);

  const card = await fetch(run.cardJsonUrl);
  if (card.status !== 200) throw new Error(`${run.cardJsonUrl} answered ${card.status}`);
  const body = await card.json();
  if (body.state !== 'finished') throw new Error(`the card is ${body.state}, expected finished`);
  for (const [url, type] of [[run.cardUrl, 'text/html'], [run.imageUrl, 'image/png']]) {
    const res = await fetch(url);
    if (res.status !== 200 || !res.headers.get('content-type')?.startsWith(type)) {
      throw new Error(`${url} answered ${res.status} ${res.headers.get('content-type')}`);
    }
  }
  // The full report is locked until paid (M4): its link must answer 402, never the report.
  const locked = await fetch(run.reportUrl);
  if (locked.status !== 402) throw new Error(`${run.reportUrl} answered ${locked.status}, expected 402 before payment`);
  const ok = JSON.stringify(body.summary) === JSON.stringify(summary);
  console.log(`${name}: ${counts(body.summary)} — ${ok ? 'as expected' : `EXPECTED ${counts(summary)}`} (${run.cardUrl})`);
  return ok;
}

const origin = process.argv[2]?.replace(/\/+$/, '');
if (!origin || !/^https?:\/\/[^/]+$/.test(origin)) {
  console.error('usage: node test/hosted-smoke.js https://<gauntlet origin>');
  process.exit(2);
}
let passed = true;
for (const [name, expected] of Object.entries(EXPECTED)) {
  try {
    passed = (await check(origin, name, expected)) && passed;
  } catch (err) {
    console.log(`${name}: FAILED — ${err.message}`);
    passed = false;
  }
}
process.exit(passed ? 0 : 1);
