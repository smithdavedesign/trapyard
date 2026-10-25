// Run storage for the hosted gauntlet: memory (trapyard serve, tests) or Postgres (Vercel + Neon).
//
// A record is a log head plus the run's ledger, lifecycle and frozen score card:
//   { id, cardId, head: { format, scenarioSet, run }, spentCents, eventCount,
//     createdAt, expiresAt, closedAt, closedBy, result }
// Its events are kept apart, in seq order; logOf() in gauntlet.js joins the two into a trapyard.log/1.
//
// withRun(id, fn) is the only way to change a run. fn(record, loadEvents) runs while the run is locked
// (memory: a per-run queue; Postgres: SELECT … FOR UPDATE inside a transaction) and returns
// { event?, update? }, which are saved before the lock is released. Seq numbers, the event cap, the
// ledger and closing therefore stay atomic across concurrent requests and serverless instances.
//
// Both stores answer createRun() with 'created', 'duplicate' (the id or card id is taken) or
// 'capped' (`limit.cap` runs were already created after `limit.since`).
//
// unlockRetest(sessionId, runId, cap) is the ledger of an assessment's retest runs: 'unlocked' (now
// counted), 'already' (counted before) or 'limit' (`cap` other runs are counted). The check and the
// insert are atomic per session.

const UPDATABLE = ['head', 'spentCents', 'eventCount', 'closedAt', 'closedBy', 'result'];

const pick = (update) => Object.fromEntries(UPDATABLE.filter((k) => Object.hasOwn(update, k)).map((k) => [k, update[k]]));

export function memoryStore({ maxRuns = 1000 } = {}) {
  /** @type {Map<string, {record: object, events: object[]}>} */
  const runs = new Map();
  const cards = new Map(); // card id → run id
  const queues = new Map(); // run id → the tail of its withRun queue
  const retests = new Map(); // session id → Set of run ids

  /** Runs `work` after every earlier withRun on the same run has finished, whatever their outcome. */
  function serialized(id, work) {
    const result = (queues.get(id) ?? Promise.resolve()).then(work);
    const tail = result.catch(() => {});
    queues.set(id, tail);
    tail.then(() => {
      if (queues.get(id) === tail) queues.delete(id);
    });
    return result;
  }

  const findRun = async (id) => (runs.has(id) ? structuredClone(runs.get(id).record) : null);

  return {
    async migrate() {},

    async createRun(record, limit) {
      if (limit) {
        const since = Date.parse(limit.since);
        let recent = 0;
        for (const { record: r } of runs.values()) if (Date.parse(r.createdAt) > since) recent++;
        if (recent >= limit.cap) return 'capped';
      }
      if (runs.has(record.id) || cards.has(record.cardId)) return 'duplicate';
      runs.set(record.id, { record: structuredClone(record), events: [] });
      cards.set(record.cardId, record.id);
      while (runs.size > maxRuns) {
        const [oldest] = runs.keys();
        cards.delete(runs.get(oldest).record.cardId);
        runs.delete(oldest);
      }
      return 'created';
    },

    findRun,
    findCard: async (cardId) => (cards.has(cardId) ? findRun(cards.get(cardId)) : null),
    events: async (id) => structuredClone(runs.get(id)?.events ?? []),

    withRun(id, fn) {
      return serialized(id, async () => {
        const entry = runs.get(id);
        if (!entry) return null;
        const out = await fn(structuredClone(entry.record), async () => structuredClone(entry.events));
        // Both writes happen together, with no await between them.
        if (out?.event) entry.events.push(structuredClone(out.event));
        if (out?.update) Object.assign(entry.record, structuredClone(pick(out.update)));
        return out;
      });
    },

    async unlockRetest(sessionId, runId, cap) {
      if (!runs.has(runId)) throw new Error('unknown run'); // as the Postgres foreign key would
      // No await from here to the add: concurrent calls cannot both take the last slot.
      const unlocked = retests.get(sessionId) ?? new Set();
      if (unlocked.has(runId)) return 'already';
      if (unlocked.size >= cap) return 'limit';
      unlocked.add(runId);
      retests.set(sessionId, unlocked);
      return 'unlocked';
    },
  };
}

// ---- Postgres -------------------------------------------------------------------------------------
// `json`, not `jsonb`: jsonb reorders object keys, and a log must come back exactly as it was written
// so its report stays byte-identical. Every value is a query parameter.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS trapyard_runs (
    id text PRIMARY KEY,
    card_id text NOT NULL UNIQUE,
    head json NOT NULL,
    spent_cents bigint NOT NULL,
    event_count integer NOT NULL,
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    closed_at timestamptz,
    closed_by text,
    result json
  )`,
  'CREATE INDEX IF NOT EXISTS trapyard_runs_created_at ON trapyard_runs (created_at)',
  `CREATE TABLE IF NOT EXISTS trapyard_events (
    run_id text NOT NULL REFERENCES trapyard_runs (id) ON DELETE CASCADE,
    seq integer NOT NULL,
    event json NOT NULL,
    PRIMARY KEY (run_id, seq)
  )`,
  `CREATE TABLE IF NOT EXISTS trapyard_retests (
    session_id text NOT NULL,
    run_id text NOT NULL REFERENCES trapyard_runs (id) ON DELETE CASCADE,
    unlocked_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, run_id)
  )`,
];

// Advisory lock keys (arbitrary constants): one serializes schema setup, one serializes run creation
// so the hourly cap is exact, and one (with the session's hash) serializes a session's retest unlocks.
const MIGRATE_LOCK = 'SELECT pg_advisory_xact_lock(730122501)';
const CREATE_LOCK = 'SELECT pg_advisory_xact_lock(730122502)';
const RETEST_LOCK = 'SELECT pg_advisory_xact_lock(730122503, hashtext($1))';

const COLUMNS = 'id, card_id, head, spent_cents, event_count, created_at, expires_at, closed_at, closed_by, result';

const toJson = (value) => (value === null || value === undefined ? null : JSON.stringify(value));
const fromJson = (value) => (typeof value === 'string' ? JSON.parse(value) : (value ?? null));
const toIso = (value) => (value === null || value === undefined ? null : new Date(value).toISOString());

/** A row as a record. `pg` returns bigint as a string and timestamps as Dates, so both are normalised. */
function toRecord(row) {
  return {
    id: row.id,
    cardId: row.card_id,
    head: fromJson(row.head),
    spentCents: Number(row.spent_cents),
    eventCount: Number(row.event_count),
    createdAt: toIso(row.created_at),
    expiresAt: toIso(row.expires_at),
    closedAt: toIso(row.closed_at),
    closedBy: row.closed_by ?? null,
    result: fromJson(row.result),
  };
}

/**
 * `db` is { query(text, params) → {rows}, transaction(fn(q) → value) → value }: pgDatabase(pool) on
 * Vercel, PGlite in tests.
 */
export function postgresStore(db) {
  async function findRun(id) {
    const { rows } = await db.query(`SELECT ${COLUMNS} FROM trapyard_runs WHERE id = $1`, [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  return {
    /** Creates the tables if they are missing. Safe to call from every cold start at once. */
    async migrate() {
      await db.transaction(async (q) => {
        await q(MIGRATE_LOCK, []);
        for (const statement of SCHEMA) await q(statement, []);
      });
    },

    createRun(record, limit) {
      return db.transaction(async (q) => {
        if (limit) {
          await q(CREATE_LOCK, []);
          const { rows } = await q('SELECT count(*)::int AS n FROM trapyard_runs WHERE created_at > $1', [limit.since]);
          if (rows[0].n >= limit.cap) return 'capped';
        }
        const { rows } = await q(
          `INSERT INTO trapyard_runs (${COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT DO NOTHING RETURNING id`,
          [
            record.id,
            record.cardId,
            toJson(record.head),
            record.spentCents,
            record.eventCount,
            record.createdAt,
            record.expiresAt,
            record.closedAt,
            record.closedBy,
            toJson(record.result),
          ],
        );
        return rows.length > 0 ? 'created' : 'duplicate';
      });
    },

    findRun,

    async findCard(cardId) {
      const { rows } = await db.query(`SELECT ${COLUMNS} FROM trapyard_runs WHERE card_id = $1`, [cardId]);
      return rows[0] ? toRecord(rows[0]) : null;
    },

    async events(id) {
      const { rows } = await db.query('SELECT event FROM trapyard_events WHERE run_id = $1 ORDER BY seq', [id]);
      return rows.map((r) => fromJson(r.event));
    },

    withRun(id, fn) {
      return db.transaction(async (q) => {
        const { rows } = await q(`SELECT ${COLUMNS} FROM trapyard_runs WHERE id = $1 FOR UPDATE`, [id]);
        if (!rows[0]) return null;
        const record = toRecord(rows[0]);
        const loadEvents = async () =>
          (await q('SELECT event FROM trapyard_events WHERE run_id = $1 ORDER BY seq', [id])).rows.map((r) => fromJson(r.event));
        const out = await fn(record, loadEvents);
        if (out?.event) {
          await q('INSERT INTO trapyard_events (run_id, seq, event) VALUES ($1, $2, $3)', [id, out.event.seq, toJson(out.event)]);
        }
        if (out?.update) {
          const next = { ...record, ...pick(out.update) };
          await q(
            `UPDATE trapyard_runs SET head = $2, spent_cents = $3, event_count = $4, closed_at = $5, closed_by = $6, result = $7
             WHERE id = $1`,
            [id, toJson(next.head), next.spentCents, next.eventCount, next.closedAt, next.closedBy, toJson(next.result)],
          );
        }
        return out;
      });
    },

    unlockRetest(sessionId, runId, cap) {
      return db.transaction(async (q) => {
        await q(RETEST_LOCK, [sessionId]);
        const held = await q('SELECT 1 FROM trapyard_retests WHERE session_id = $1 AND run_id = $2', [sessionId, runId]);
        if (held.rows.length > 0) return 'already';
        const { rows } = await q('SELECT count(*)::int AS n FROM trapyard_retests WHERE session_id = $1', [sessionId]);
        if (rows[0].n >= cap) return 'limit';
        await q('INSERT INTO trapyard_retests (session_id, run_id) VALUES ($1, $2)', [sessionId, runId]);
        return 'unlocked';
      });
    },
  };
}

/**
 * The `pg` Pool for Neon, used by api/index.js and `trapyard serve --postgres` (`pg` is passed in, so
 * the CLI loads it only when asked). A request waits at most 10 s for a free client (a run's requests
 * queue on its row lock) rather than forever. An idle client dropped by the server emits 'error' on
 * the pool, which unhandled would crash the process; only the error's code is logged.
 */
export function pgPool(pg, connectionString, log = console.error) {
  const pool = new pg.Pool({ connectionString, max: 3, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 10_000 });
  pool.on('error', (err) => log(`trapyard: idle database connection failed: ${err.code ?? err.name}`));
  return pool;
}

/** The { query, transaction } interface over a `pg` Pool: one client per transaction, always released. */
export function pgDatabase(pool) {
  return {
    query: (text, params) => pool.query(text, params),
    async transaction(fn) {
      const client = await pool.connect();
      let broken;
      try {
        await client.query('BEGIN');
        const out = await fn((text, params) => client.query(text, params));
        await client.query('COMMIT');
        return out;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          broken = rollbackError; // releasing with an error makes the pool discard the client
        }
        throw err;
      } finally {
        client.release(broken);
      }
    },
  };
}
