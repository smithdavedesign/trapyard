// M3 exit criteria from ROADMAP.md, run against both run stores (memory, and Postgres on PGlite):
//   1. a stub agent that completes a hosted run gets a score card URL returning 200 with the right fell/held counts
//   2. a second run gets a different canary
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { logOf } from '../src/gauntlet.js';
import { buildReport } from '../src/report.js';
import { TRAP_CLASSES } from '../src/scenarios.js';
import { memoryStore, postgresStore } from '../src/store.js';
import { hardenedAgent, vulnerableAgent } from './stubs/agents.js';
import { callTool, getJson, hostedBase, pgliteDatabase, startGauntlet, startHostedRun } from './helpers.js';

let pglite;
before(async () => {
  pglite = await pgliteDatabase();
});
after(() => pglite.close());

const STORES = {
  memory: async () => memoryStore(),
  postgres: async () => {
    const store = postgresStore(pglite);
    await store.migrate();
    return store;
  },
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Fetches a hosted run's score card in all three forms and checks each answers 200. */
async function scoreCard(run) {
  const page = await fetch(run.cardUrl);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /^text\/html/);
  const json = await getJson(run.cardJsonUrl);
  assert.equal(json.status, 200);
  const image = await fetch(run.imageUrl);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  const png = Buffer.from(await image.arrayBuffer());
  assert.deepEqual(png.subarray(0, 8), PNG_SIGNATURE);
  return { html: await page.text(), card: json.body };
}

/** The card's counts must be what the local scorer says about the stored log. */
async function assertMatchesScorer(store, run, card) {
  const log = logOf(await store.findRun(run.runId), await store.events(run.runId));
  assert.deepEqual(buildReport(log).summary, card.summary);
  assert.deepEqual(
    buildReport(log).traps.map((x) => [x.class, x.status]),
    card.traps.map((x) => [x.class, x.status]),
  );
}

const EMAIL = { to: 'lead@payments.invalid', subject: 'Digest', body: 'hello' };

for (const [name, makeStore] of Object.entries(STORES)) {
  describe(`${name} store`, () => {
    test('EC1: the vulnerable stub completes a hosted run → its score card URL returns 200 with 4 fell, 0 held', async (t) => {
      const store = await makeStore();
      const g = await startGauntlet(t, { store });
      const run = await startHostedRun(g.origin);
      assert.match(run.cardUrl, new RegExp(`^${g.publicUrl}/s/[a-f0-9]{32}$`));

      // The card URL works from the start; it says the run is still going and shows no counts yet.
      const early = await scoreCard(run);
      assert.equal(early.card.state, 'running');
      assert.equal(early.card.summary, null);
      assert.match(early.html, /in progress/i);

      await vulnerableAgent(run.taskUrl);

      const { html, card } = await scoreCard(run);
      assert.equal(card.state, 'finished');
      assert.equal(card.finishedBy, 'summary');
      assert.deepEqual(card.summary, { fell: 4, held: 0, notReached: 0, total: 4 });
      assert.deepEqual(card.traps.map((x) => [x.class, x.status]), TRAP_CLASSES.map((c) => [c, 'fell']));
      assert.match(html, /4 of 4 traps fell · 0 held · 0 not reached/);
      await assertMatchesScorer(store, run, card);
    });

    test('EC1: the hardened stub completes a hosted run → its score card shows 0 fell, 4 held', async (t) => {
      const store = await makeStore();
      const g = await startGauntlet(t, { store });
      const run = await startHostedRun(g.origin);
      await hardenedAgent(run.taskUrl);

      const { html, card } = await scoreCard(run);
      assert.equal(card.state, 'finished');
      assert.deepEqual(card.summary, { fell: 0, held: 4, notReached: 0, total: 4 });
      assert.deepEqual(card.traps.map((x) => [x.class, x.status]), TRAP_CLASSES.map((c) => [c, 'held']));
      assert.match(html, /0 of 4 traps fell · 4 held · 0 not reached/);
      await assertMatchesScorer(store, run, card);
    });

    test('EC1: a run where exactly one trap falls → the card counts 1 fell, 3 held (not all-or-nothing)', async (t) => {
      const store = await makeStore();
      const g = await startGauntlet(t, { store });
      const run = await startHostedRun(g.origin);
      // An agent that is hardened except for one out-of-scope tool call.
      assert.equal((await callTool(hostedBase(run), 'send_email', EMAIL)).status, 200);
      await hardenedAgent(run.taskUrl);

      const { html, card } = await scoreCard(run);
      assert.deepEqual(card.summary, { fell: 1, held: 3, notReached: 0, total: 4 });
      assert.deepEqual(card.traps.filter((x) => x.status === 'fell').map((x) => x.class), ['scope']);
      assert.match(html, /1 of 4 traps fell · 3 held · 0 not reached/);
      await assertMatchesScorer(store, run, card);
    });

    test('EC2: a second hosted run gets a different canary', async (t) => {
      const store = await makeStore();
      const g = await startGauntlet(t, { store });
      const a = await startHostedRun(g.origin);
      const b = await startHostedRun(g.origin);
      assert.notEqual(a.runId, b.runId);
      assert.notEqual(a.cardUrl, b.cardUrl);

      // What each run's agent sees: the secret get_secret returns, and the beacon planted in its page.
      const secretA = (await callTool(hostedBase(a), 'get_secret', { name: 'deploy_key' })).body.secret;
      const secretB = (await callTool(hostedBase(b), 'get_secret', { name: 'deploy_key' })).body.secret;
      assert.notEqual(secretA, secretB);
      const pageA = await (await fetch(`${hostedBase(a).base}/pages/release-notes`)).text();
      const pageB = await (await fetch(`${hostedBase(b).base}/pages/release-notes`)).text();

      const canA = (await store.findRun(a.runId)).head.run.canaries;
      const canB = (await store.findRun(b.runId)).head.run.canaries;
      assert.equal(secretA, canA.secret);
      assert.equal(secretB, canB.secret);
      assert.ok(pageA.includes(canA.beacon) && !pageA.includes(canB.beacon), "run A's page carries only A's beacon");
      assert.ok(pageB.includes(canB.beacon) && !pageB.includes(canA.beacon), "run B's page carries only B's beacon");
      assert.equal(new Set([canA.secret, canA.beacon, canB.secret, canB.beacon]).size, 4);
    });

    test('EC2: two gauntlet instances on one store (as on serverless) issue different canaries and serve each other\'s runs', async (t) => {
      const store = await makeStore();
      const one = await startGauntlet(t, { store });
      const two = await startGauntlet(t, { store });
      const a = await startHostedRun(one.origin);
      const b = await startHostedRun(two.origin);
      const canA = (await store.findRun(a.runId)).head.run.canaries;
      const canB = (await store.findRun(b.runId)).head.run.canaries;
      assert.notEqual(canA.secret, canB.secret);
      assert.notEqual(canA.beacon, canB.beacon);
      // A request for run A that lands on instance two is answered from the shared store.
      const task = await getJson(`${two.origin}/r/${a.runId}/task`);
      assert.equal(task.status, 200);
      assert.equal(task.body.runId, a.runId);
    });

    test('EC2: 50 hosted runs never repeat a canary or an id', async (t) => {
      const store = await makeStore();
      const g = await startGauntlet(t, { store });
      const runs = [];
      for (let i = 0; i < 50; i++) runs.push(await startHostedRun(g.origin));
      const records = await Promise.all(runs.map((r) => store.findRun(r.runId)));
      const canaries = records.flatMap((r) => [r.head.run.canaries.secret, r.head.run.canaries.beacon]);
      assert.equal(new Set(canaries).size, 100);
      assert.equal(new Set(runs.map((r) => r.runId)).size, 50);
      assert.equal(new Set(runs.map((r) => r.cardUrl)).size, 50);
    });
  });
}

test('EC1: from the public page — start a run with the form, give the agent the task URL, open the score card', async (t) => {
  const g = await startGauntlet(t);
  const landing = await fetch(`${g.origin}/`);
  assert.equal(landing.status, 200);
  assert.match(await landing.text(), /<form method="post" action="\/runs">/);

  const started = await fetch(`${g.origin}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: '',
  });
  assert.equal(started.status, 201);
  const page = await started.text();
  const taskUrl = /<code id="task-url">([^<]+)<\/code>/.exec(page)?.[1];
  const cardUrl = /<a id="card-url" href="([^"]+)"/.exec(page)?.[1];
  assert.match(taskUrl, new RegExp(`^${g.publicUrl}/r/[a-f0-9]{16}/task$`));
  assert.match(cardUrl, new RegExp(`^${g.publicUrl}/s/[a-f0-9]{32}$`));

  await vulnerableAgent(taskUrl);
  const card = await fetch(cardUrl);
  assert.equal(card.status, 200);
  assert.match(await card.text(), /4 of 4 traps fell · 0 held · 0 not reached/);
});
