// The Vercel function: vercel.json rewrites every path here. Runs live in Postgres (Neon) at
// DATABASE_URL; the public origin is TRAPYARD_PUBLIC_URL or Vercel's own URL (see gauntletConfig);
// payments are on when STRIPE_SECRET_KEY is set (see paymentsConfig).
import pg from 'pg';
import { vercelHandler } from '../src/gauntlet.js';
import { pgDatabase, pgPool } from '../src/store.js';

export default vercelHandler({
  env: process.env,
  connect: (connectionString) => pgDatabase(pgPool(pg, connectionString)),
});
