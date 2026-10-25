// A stand-in for the two Stripe Checkout endpoints trapyard calls (create and retrieve a Checkout
// Session), on 127.0.0.1, so payments are testable without a Stripe account or the network. Sessions
// start open and unpaid, as on Stripe; pay(id) is the buyer finishing checkout.
//
// The key and session ids are built at runtime from a prefix and filler, so nothing key-shaped is
// written in the repo. Used by the tests and by scripts/screenshots.mjs.

import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

export const fakeStripeKey = () => ['sk', 'test', 'A1b2C3d4'.repeat(3)].join('_');
export const fakeSessionId = () => ['cs', 'test', randomBytes(12).toString('hex')].join('_');

export async function startFakeStripe({ key = fakeStripeKey(), now = () => new Date() } = {}) {
  const sessions = new Map();
  const requests = [];
  let outage = null; // a status every request is answered with, or 'hang' to never answer
  let origin;

  function makeSession(form, id = fakeSessionId()) {
    const metadata = {};
    for (const [k, v] of Object.entries(form)) {
      const m = /^metadata\[(.+)\]$/.exec(k);
      if (m) metadata[m[1]] = v;
    }
    const session = {
      id,
      object: 'checkout.session',
      mode: form.mode ?? 'payment',
      status: 'open',
      payment_status: 'unpaid',
      amount_total: Number(form['line_items[0][price_data][unit_amount]'] ?? 0),
      currency: form['line_items[0][price_data][currency]'] ?? 'usd',
      client_reference_id: form.client_reference_id ?? null,
      metadata,
      created: Math.floor(now().getTime() / 1000),
      success_url: form.success_url ?? null,
      cancel_url: form.cancel_url ?? null,
      url: `${origin}/pay/${id}`,
    };
    sessions.set(id, { session, form });
    return session;
  }

  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    const reply = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (outage === 'hang') return; // never answers: the caller's timeout must fire
    if (outage) return reply(outage, { error: { type: 'api_error', message: 'fake outage' } });
    if (req.headers.authorization !== `Bearer ${key}`) {
      return reply(401, { error: { type: 'invalid_request_error', message: 'Invalid API Key provided' } });
    }
    if (req.method === 'POST' && req.url === '/v1/checkout/sessions') {
      if (req.headers['content-type'] !== 'application/x-www-form-urlencoded') {
        return reply(400, { error: { type: 'invalid_request_error', message: 'expected a form body' } });
      }
      return reply(200, makeSession(Object.fromEntries(new URLSearchParams(body))));
    }
    const m = /^\/v1\/checkout\/sessions\/([^/?]+)$/.exec(req.url);
    if (req.method === 'GET' && m) {
      const found = sessions.get(decodeURIComponent(m[1]));
      if (found) return reply(200, found.session);
      return reply(404, { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such checkout.session' } });
    }
    return reply(404, { error: { type: 'invalid_request_error', message: 'Unrecognized request URL' } });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;

  const session = (id) => {
    const found = sessions.get(id);
    if (!found) throw new Error(`fake stripe: no session ${id}`);
    return found.session;
  };

  return {
    apiBase: origin,
    key,
    sessions,
    requests,
    /** The form trapyard posted to create a session. */
    form: (id) => sessions.get(id)?.form,
    session,
    /** The buyer completes checkout and the card payment succeeds. */
    pay(id) {
      Object.assign(session(id), { status: 'complete', payment_status: 'paid' });
    },
    /** Checkout completed with a delayed payment method: complete, but not paid yet. */
    processing(id) {
      Object.assign(session(id), { status: 'complete', payment_status: 'unpaid' });
    },
    /** A session made as if by trapyard's checkout, e.g. one paid for another run. */
    create({ runId, tier = 'report', paid = false }) {
      const s = makeSession({ mode: 'payment', 'metadata[run_id]': runId, 'metadata[tier]': tier });
      if (paid) this.pay(s.id);
      return s.id;
    },
    /** Every later request is answered with `status` (e.g. 500), or never answered ('hang'); null ends it. */
    outage(status) {
      outage = status;
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
