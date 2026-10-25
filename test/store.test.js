// The run store's contract, run against both implementations: memory (local serve, tests) and
// Postgres (hosted), the latter on PGlite so the real SQL is exercised without a server.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIO_SET } from '../src/scenarios.js';
import { memoryStore, pgDatabase, pgPool, postgresStore } from '../src/store.js';
import { pgliteDatabase } from './helpers.js';

let pglite;
before(async () => {
  pglite = await pgliteDatabase();
});
after(() => pglite.close());

let counter = 0;
/** A store record with fresh ids. Canaries are plain words, nothing key-shaped. */
function record(overrides = {}) {
  counter += 1;
  const id = `${process.pid.toString(16)}${counter.toString(16)}`.padStart(16, '0').slice(-16);
  return {
    id,
    cardId: `c${id}`.padEnd(32, '0'),
    head: {
      format: 'trapyard.log/1',
      scenarioSet: { ...SCENARIO_SET },
      run: {
        id,
        base: `http://127.0.0.1:1/r/${id}`,
        startedAt: '2026-10-25T10:00:00.000Z',
        allowedTools: ['read_note', 'get_secret', 'spend'],
        budget: '100.00',
        traps: ['instruction', 'leak', 'scope', 'overspend'],
        replayOf: null,
        canaries: { secret: 'store-test-secret', beacon: 'store-test-beacon' },
        agent: null,
        truncated: false,
      },
    },
    spentCents: 0,
    eventCount: 0,
    createdAt: '2026-10-25T10:00:00.000Z',
    expiresAt: '2026-10-25T10:30:00.000Z',
    closedAt: null,
    closedBy: null,
    result: null,
    ...overrides,
  };
}

const event = (seq, extra = {}) => ({
  seq,
  at: '2026-10-25T10:00:01.000Z',
  method: 'GET',
  url: `/r/x/${seq}`,
  kind: 'other',
  status: 200,
  body: '',
  ...extra,
});

const STORES = {
  memory: async () => memoryStore(),
  postgres: async () => {
    const store = postgresStore(pglite);
    await store.migrate();
    return store;
  },
};

for (const [name, makeStore] of Object.entries(STORES)) {
  describe(`${name} store`, () => {
    test('createRun stores a record that findRun and findCard return, as copies', async () => {
      const store = await makeStore();
      const r = record();
      assert.equal(await store.createRun(r), 'created');
      assert.deepEqual(await store.findRun(r.id), r);
      assert.deepEqual(await store.findCard(r.cardId), r);
      const copy = await store.findRun(r.id);
      copy.head.run.id = 'changed';
      copy.eventCount = 99;
      r.head.run.budget = '1.00';
      const again = await store.findRun(r.id);
      assert.equal(again.head.run.id, r.id);
      assert.equal(again.eventCount, 0);
      assert.equal(again.head.run.budget, '100.00', 'the caller mutating its input after create changes nothing');
      assert.equal(await store.findRun('f'.repeat(16)), null);
      assert.equal(await store.findCard('f'.repeat(32)), null);
      assert.deepEqual(await store.events(r.id), []);
    });

    test('a duplicate run id or card id is reported as duplicate and not stored', async () => {
      const store = await makeStore();
      const r = record();
      assert.equal(await store.createRun(r), 'created');
      const sameId = record({ id: r.id });
      assert.equal(await store.createRun(sameId), 'duplicate');
      assert.equal(await store.findCard(sameId.cardId), null);
      const sameCard = record({ cardId: r.cardId });
      assert.equal(await store.createRun(sameCard), 'duplicate');
      assert.equal(await store.findRun(sameCard.id), null);
    });

    test('the hourly cap counts only runs created since `since`', async () => {
      const store = await makeStore();
      // A window no other test uses, so the shared Postgres database doesn't skew the count.
      const at = (minute) => `2031-0${name === 'memory' ? 1 : 2}-01T00:${String(minute).padStart(2, '0')}:00.000Z`;
      const limit = { since: at(5), cap: 2 };
      assert.equal(await store.createRun(record({ createdAt: at(0) }), limit), 'created', 'before the window');
      assert.equal(await store.createRun(record({ createdAt: at(10) }), limit), 'created');
      assert.equal(await store.createRun(record({ createdAt: at(11) }), limit), 'created');
      const third = record({ createdAt: at(12) });
      assert.equal(await store.createRun(third, limit), 'capped');
      assert.equal(await store.findRun(third.id), null);
      assert.equal(await store.createRun(third, { since: at(5), cap: 3 }), 'created');
    });

    test('withRun on an unknown run returns null without calling fn', async () => {
      const store = await makeStore();
      let called = false;
      const out = await store.withRun('e'.repeat(16), () => {
        called = true;
        return {};
      });
      assert.equal(out, null);
      assert.equal(called, false);
    });

    test('withRun saves the event and the update atomically and returns what fn returned', async () => {
      const store = await makeStore();
      const r = record();
      await store.createRun(r);
      const first = event(1, { method: 'POST', kind: 'tool', tool: { name: 'spend', args: { amount: '40.00' }, result: {} } });
      const out = await store.withRun(r.id, async (current, loadEvents) => {
        assert.deepEqual(current, r);
        assert.deepEqual(await loadEvents(), []);
        return { event: first, update: { eventCount: 1, spentCents: 4000 }, reply: 'sent' };
      });
      assert.equal(out.reply, 'sent');
      assert.deepEqual(await store.events(r.id), [first]);
      const saved = await store.findRun(r.id);
      assert.equal(saved.eventCount, 1);
      assert.equal(saved.spentCents, 4000);

      // Closing: head, closedAt, closedBy and result change together; fn sees the earlier event.
      const head = { ...r.head, run: { ...r.head.run, truncated: true } };
      const result = { summary: { fell: 1, held: 3, notReached: 0, total: 4 } };
      await store.withRun(r.id, async (current, loadEvents) => {
        assert.equal(current.eventCount, 1);
        assert.deepEqual(await loadEvents(), [first]);
        return {
          event: event(2),
          update: { eventCount: 2, head, closedAt: '2026-10-25T10:05:00.000Z', closedBy: 'summary', result },
        };
      });
      const closed = await store.findRun(r.id);
      assert.deepEqual(
        { ...closed },
        { ...r, head, spentCents: 4000, eventCount: 2, closedAt: '2026-10-25T10:05:00.000Z', closedBy: 'summary', result },
      );
      assert.deepEqual(await store.findCard(r.cardId), closed);
      assert.deepEqual((await store.events(r.id)).map((e) => e.seq), [1, 2]);

      // fn may change nothing at all.
      assert.deepEqual(await store.withRun(r.id, () => ({ reply: 410 })), { reply: 410 });
      assert.deepEqual(await store.findRun(r.id), closed);
    });

    test('stored JSON keeps its key order (the report must stay byte-identical after a round trip)', async () => {
      const store = await makeStore();
      const r = record();
      r.head.run.agent = { zeta: 1, alpha: 2 };
      await store.createRun(r);
      const e = event(1, { tool: { name: 'send_email', args: { to: 'a', subject: 'b', body: 'c', nested: { z: 1, a: 2 } }, result: {} } });
      await store.withRun(r.id, () => ({ event: e, update: { eventCount: 1, result: { zz: 1, aa: 2 } } }));
      const [saved] = await store.events(r.id);
      assert.equal(JSON.stringify(saved), JSON.stringify(e));
      const found = await store.findRun(r.id);
      assert.equal(JSON.stringify(found.head), JSON.stringify(r.head));
      assert.equal(JSON.stringify(found.result), '{"zz":1,"aa":2}');
    });

    test('a throwing fn saves nothing, the error reaches the caller, and the run is not left locked', async () => {
      const store = await makeStore();
      const r = record();
      await store.createRun(r);
      await assert.rejects(
        store.withRun(r.id, () => {
          throw new Error('boom');
        }),
        /boom/,
      );
      assert.deepEqual(await store.findRun(r.id), r);
      assert.deepEqual(await store.events(r.id), []);
      const out = await store.withRun(r.id, () => ({ event: event(1), update: { eventCount: 1 }, ok: true }));
      assert.equal(out.ok, true);
      assert.equal((await store.findRun(r.id)).eventCount, 1);
    });

    test('concurrent withRun calls on one run are serialized: 25 racing appends get seqs 1..25', async () => {
      const store = await makeStore();
      const r = record();
      await store.createRun(r);
      await Promise.all(
        Array.from({ length: 25 }, () =>
          store.withRun(r.id, async (current) => {
            await new Promise((done) => setTimeout(done, 1)); // a gap a racing request could slip into
            const seq = current.eventCount + 1;
            return { event: event(seq), update: { eventCount: seq, spentCents: current.spentCents + 100 } };
          }),
        ),
      );
      assert.deepEqual((await store.events(r.id)).map((e) => e.seq), Array.from({ length: 25 }, (_, i) => i + 1));
      const saved = await store.findRun(r.id);
      assert.equal(saved.eventCount, 25);
      assert.equal(saved.spentCents, 2500);
    });

    test('large ledger totals and timestamps come back as numbers and ISO strings', async () => {
      const store = await makeStore();
      const r = record({ spentCents: 9_007_199_254_740 });
      await store.createRun(r);
      const saved = await store.findRun(r.id);
      assert.equal(saved.spentCents, 9_007_199_254_740);
      assert.equal(typeof saved.eventCount, 'number');
      assert.equal(saved.createdAt, r.createdAt);
      assert.equal(saved.expiresAt, r.expiresAt);
    });

    test('unlockRetest: unlocked until the cap, already for a run it holds, limit after; sessions are independent', async () => {
      const store = await makeStore();
      const runs = [record(), record(), record()];
      for (const r of runs) await store.createRun(r);
      const session = `cs_test_${name}${counter}`;
      assert.equal(await store.unlockRetest(session, runs[0].id, 2), 'unlocked');
      assert.equal(await store.unlockRetest(session, runs[0].id, 2), 'already');
      assert.equal(await store.unlockRetest(session, runs[1].id, 2), 'unlocked');
      assert.equal(await store.unlockRetest(session, runs[2].id, 2), 'limit');
      assert.equal(await store.unlockRetest(session, runs[1].id, 2), 'already', 'a held run stays open at the cap');
      assert.equal(await store.unlockRetest(`${session}x`, runs[2].id, 2), 'unlocked', 'another session has its own slots');
    });

    test('unlockRetest is atomic: 10 racing unlocks of different runs against a cap of 3 let exactly 3 through', async () => {
      const store = await makeStore();
      const runs = Array.from({ length: 10 }, () => record());
      for (const r of runs) await store.createRun(r);
      const session = `cs_test_race${name}${counter}`;
      const outcomes = await Promise.all(runs.map((r) => store.unlockRetest(session, r.id, 3)));
      assert.equal(outcomes.filter((o) => o === 'unlocked').length, 3);
      assert.equal(outcomes.filter((o) => o === 'limit').length, 7);
    });
  });
}

describe('postgres store', () => {
  test('migrate is idempotent and two cold starts migrating at once do not collide', async () => {
    const a = postgresStore(pglite);
    const b = postgresStore(pglite);
    await Promise.all([a.migrate(), b.migrate(), a.migrate()]);
    await b.migrate();
  });

  test('every value travels as a query parameter, never inside the SQL text', async () => {
    const statements = [];
    const spy = {
      query: (text, params) => {
        statements.push(text);
        return pglite.query(text, params);
      },
      transaction: (fn) =>
        pglite.transaction((q) =>
          fn((text, params) => {
            statements.push(text);
            return q(text, params);
          }),
        ),
    };
    const store = postgresStore(spy);
    await store.migrate();
    const marker = "x'); DROP TABLE trapyard_runs; --";
    const r = record({ closedBy: null });
    r.head.run.canaries.secret = marker;
    await store.createRun(r, { since: '2026-10-25T00:00:00.000Z', cap: 1_000_000 });
    await store.findRun(r.id);
    await store.findCard(r.cardId);
    await store.withRun(r.id, async (_, loadEvents) => {
      await loadEvents();
      return { event: event(1, { body: marker }), update: { eventCount: 1, result: { note: marker } } };
    });
    await store.events(r.id);
    assert.ok(statements.length > 6);
    for (const sql of statements) assert.ok(!sql.includes(marker), `no value in: ${sql}`);
    assert.equal((await store.events(r.id))[0].body, marker);
  });

  test('withRun locks the run row before reading it (PGlite has one connection, so this is checked on the SQL)', async () => {
    const inTransaction = [];
    const spy = {
      query: (text, params) => pglite.query(text, params),
      transaction: (fn) =>
        pglite.transaction((q) =>
          fn((text, params) => {
            inTransaction.push(text.replace(/\s+/g, ' ').trim());
            return q(text, params);
          }),
        ),
    };
    const store = postgresStore(spy);
    const r = record();
    await store.createRun(r);
    inTransaction.length = 0;
    await store.withRun(r.id, () => ({ event: event(1), update: { eventCount: 1 } }));
    assert.match(inTransaction[0], /^SELECT .* FROM trapyard_runs WHERE id = \$1 FOR UPDATE$/);
    assert.match(inTransaction[1], /^INSERT INTO trapyard_events/);
    assert.match(inTransaction[2], /^UPDATE trapyard_runs SET/);
    inTransaction.length = 0;
    await store.createRun(record(), { since: '2026-10-25T00:00:00.000Z', cap: 1_000_000 });
    assert.match(inTransaction[0], /pg_advisory_xact_lock/, 'run creation is serialized so the hourly cap is exact');
  });

  test('unlockRetest locks the session first (PGlite has one connection, so this is checked on the SQL) and passes values as parameters', async () => {
    const inTransaction = [];
    const spy = {
      query: (text, params) => pglite.query(text, params),
      transaction: (fn) =>
        pglite.transaction((q) =>
          fn((text, params) => {
            inTransaction.push({ sql: text.replace(/\s+/g, ' ').trim(), params });
            return q(text, params);
          }),
        ),
    };
    const store = postgresStore(spy);
    const r = record();
    await store.createRun(r);
    inTransaction.length = 0;
    const session = "cs_test_x'); DROP TABLE trapyard_retests; --";
    assert.equal(await store.unlockRetest(session, r.id, 3), 'unlocked');
    assert.match(inTransaction[0].sql, /^SELECT pg_advisory_xact_lock\(\d+, hashtext\(\$1\)\)$/);
    assert.deepEqual(inTransaction[0].params, [session]);
    for (const { sql } of inTransaction) assert.ok(!sql.includes('DROP TABLE'), sql);
    assert.equal(await store.unlockRetest(session, r.id, 3), 'already');
  });

  test('a retest unlock needs a stored run (foreign key), and goes when its run goes', async () => {
    const store = postgresStore(pglite);
    await store.migrate();
    await assert.rejects(store.unlockRetest('cs_test_fk', 'f'.repeat(16), 3));
    const r = record();
    await store.createRun(r);
    assert.equal(await store.unlockRetest('cs_test_fk', r.id, 3), 'unlocked');
    await pglite.query('DELETE FROM trapyard_runs WHERE id = $1', [r.id]);
    const { rows } = await pglite.query('SELECT count(*)::int AS n FROM trapyard_retests WHERE run_id = $1', [r.id]);
    assert.equal(rows[0].n, 0);
  });
});

describe('pgPool (the pg.Pool used on Vercel and by serve --postgres)', () => {
  test('bounded pool and waits, and an error listener that logs only the error code', () => {
    const made = [];
    class FakePool {
      constructor(options) {
        this.options = options;
        this.listeners = {};
        made.push(this);
      }
      on(event, fn) {
        this.listeners[event] = fn;
      }
    }
    const logged = [];
    const pool = pgPool({ Pool: FakePool }, 'placeholder-database', (line) => logged.push(line));
    assert.equal(made.length, 1);
    assert.equal(pool, made[0]);
    assert.deepEqual(pool.options, { connectionString: 'placeholder-database', max: 3, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 10_000 });
    const err = new Error('terminating connection to placeholder-database');
    err.code = '57P01';
    pool.listeners.error(err);
    assert.deepEqual(logged, ['trapyard: idle database connection failed: 57P01']);
  });
});

describe('memory store', () => {
  test('keeps at most maxRuns runs, dropping the oldest and its card', async () => {
    const store = memoryStore({ maxRuns: 2 });
    const [a, b, c] = [record(), record(), record()];
    for (const r of [a, b, c]) assert.equal(await store.createRun(r), 'created');
    assert.equal(await store.findRun(a.id), null);
    assert.equal(await store.findCard(a.cardId), null);
    assert.deepEqual(await store.events(a.id), []);
    assert.deepEqual(await store.findRun(b.id), b);
    assert.deepEqual(await store.findRun(c.id), c);
  });
});

describe('pgDatabase (the pg.Pool adapter used on Vercel)', () => {
  function fakePool({ failOn } = {}) {
    const calls = [];
    const client = {
      query: async (text) => {
        calls.push(text);
        if (text === failOn) throw new Error(`${text} failed`);
        return { rows: [{ ok: 1 }] };
      },
      release: (err) => calls.push(err ? `release(${err.message})` : 'release()'),
    };
    return {
      calls,
      pool: {
        connect: async () => client,
        query: async (text, params) => {
          calls.push(`pool:${text}:${JSON.stringify(params)}`);
          return { rows: [] };
        },
      },
    };
  }

  test('transaction runs BEGIN, the statements and COMMIT on one client, then releases it', async () => {
    const { pool, calls } = fakePool();
    const out = await pgDatabase(pool).transaction(async (q) => {
      await q('SELECT 1', []);
      return 'done';
    });
    assert.equal(out, 'done');
    assert.deepEqual(calls, ['BEGIN', 'SELECT 1', 'COMMIT', 'release()']);
  });

  test('transaction rolls back and rethrows when fn throws, and still releases the client', async () => {
    const { pool, calls } = fakePool();
    await assert.rejects(
      pgDatabase(pool).transaction(async (q) => {
        await q('SELECT 1', []);
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.deepEqual(calls, ['BEGIN', 'SELECT 1', 'ROLLBACK', 'release()']);
  });

  test('a client whose ROLLBACK fails is released with the error, so the pool discards it', async () => {
    const { pool, calls } = fakePool({ failOn: 'ROLLBACK' });
    await assert.rejects(
      pgDatabase(pool).transaction(() => {
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.deepEqual(calls, ['BEGIN', 'ROLLBACK', 'release(ROLLBACK failed)']);
  });

  test('query goes straight to the pool', async () => {
    const { pool, calls } = fakePool();
    await pgDatabase(pool).query('SELECT $1', [1]);
    assert.deepEqual(calls, ['pool:SELECT $1:[1]']);
  });
});
