// The Cloudflare Worker (wrangler.jsonc; production since 2026-11-08): the same node:http gauntlet as
// the Vercel function in api/index.js, served through the Workers runtime's node:http server support
// (`nodejs_compat`). Settings are the Worker's vars and secrets, which nodejs_compat puts on
// process.env: TRAPYARD_PUBLIC_URL and NEXT_PUBLIC_DEPLOY_ENV in wrangler.jsonc, DATABASE_URL as a
// secret. Each request opens its own `pg` pool and closes it when the response is done (see
// workerHandler); `pg` reaches Neon over the Workers socket API.
import { httpServerHandler } from 'cloudflare:node';
import { createServer } from 'node:http';
import pg from 'pg';
import { workerHandler } from './gauntlet.js';
import { pgDatabase, pgPool } from './store.js';

const PORT = 8080;

createServer(
  workerHandler({
    env: process.env,
    connect: (connectionString) => {
      const pool = pgPool(pg, connectionString);
      return { ...pgDatabase(pool), close: () => pool.end() };
    },
  }),
).listen(PORT);

export default httpServerHandler({ port: PORT });
