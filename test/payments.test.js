// The Stripe Checkout client (against a fake Stripe on 127.0.0.1), the tiers and the payments config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paymentsConfig } from '../src/gauntlet.js';
import { PaymentError, RETEST_DAYS, TIERS, isSessionId, stripeCheckout, usd } from '../src/payments.js';
import { fakeSessionId, fakeStripeKey, startFakeStripe } from './fake-stripe.js';

const RUN = 'a1b2c3d4e5f60718';
const PUBLIC = 'https://trapyard.example';

async function setup(t, options = {}) {
  const stripe = await startFakeStripe(options);
  t.after(() => stripe.close());
  return { stripe, client: stripeCheckout({ secretKey: stripe.key, apiBase: stripe.apiBase, ...options.client }) };
}

test('tiers: $299 full report, $999 assessment with 3 retests in 30 days', () => {
  assert.deepEqual(Object.keys(TIERS), ['report', 'assessment']);
  assert.equal(TIERS.report.cents, 29_900);
  assert.equal(TIERS.report.retests, 0);
  assert.equal(TIERS.assessment.cents, 99_900);
  assert.equal(TIERS.assessment.retests, 3);
  assert.equal(RETEST_DAYS, 30);
  assert.equal(usd(29_900), '$299');
  assert.equal(usd(99_900), '$999');
  assert.equal(usd(1_050), '$10.50');
});

test('createSession posts a one-off USD Checkout Session for the run and tier, and returns its id and URL', async (t) => {
  const { stripe, client } = await setup(t);
  const out = await client.createSession({ runId: RUN, tier: 'assessment', publicUrl: PUBLIC });
  assert.ok(isSessionId(out.id));
  assert.equal(out.url, `${stripe.apiBase}/pay/${out.id}`);

  const [req] = stripe.requests;
  assert.equal(req.method, 'POST');
  assert.equal(req.url, '/v1/checkout/sessions');
  assert.equal(req.headers.authorization, `Bearer ${stripe.key}`);
  assert.equal(req.headers['content-type'], 'application/x-www-form-urlencoded');
  const form = stripe.form(out.id);
  assert.equal(form.mode, 'payment');
  assert.equal(form['line_items[0][quantity]'], '1');
  assert.equal(form['line_items[0][price_data][currency]'], 'usd');
  assert.equal(form['line_items[0][price_data][unit_amount]'], '99900');
  assert.match(form['line_items[0][price_data][product_data][name]'], /trapyard/i);
  assert.equal(form.success_url, `${PUBLIC}/report/${RUN}?session_id={CHECKOUT_SESSION_ID}`, 'the placeholder reaches Stripe as-is');
  assert.equal(form.cancel_url, `${PUBLIC}/report/${RUN}`);
  assert.equal(form.client_reference_id, RUN);
  assert.equal(form['metadata[run_id]'], RUN);
  assert.equal(form['metadata[tier]'], 'assessment');
  assert.match(form['custom_text[submit][message]'], /not a certification/);
});

test('createSession refuses an unknown tier or a malformed run id without calling Stripe', async (t) => {
  const { stripe, client } = await setup(t);
  await assert.rejects(client.createSession({ runId: RUN, tier: 'gold', publicUrl: PUBLIC }), /tier/);
  await assert.rejects(client.createSession({ runId: 'nope', tier: 'report', publicUrl: PUBLIC }), /run id/);
  assert.equal(stripe.requests.length, 0);
});

test('getSession reads paid, unpaid and processing sessions, with the tier, run id and creation time', async (t) => {
  const now = () => new Date('2026-10-25T10:00:00.000Z');
  const { stripe, client } = await setup(t, { now });
  const { id } = await client.createSession({ runId: RUN, tier: 'report', publicUrl: PUBLIC });

  const open = await client.getSession(id);
  assert.deepEqual(open, { id, paid: false, processing: false, tier: 'report', runId: RUN, createdAt: '2026-10-25T10:00:00.000Z' });
  stripe.processing(id);
  assert.equal((await client.getSession(id)).processing, true);
  assert.equal((await client.getSession(id)).paid, false);
  stripe.pay(id);
  assert.deepEqual(await client.getSession(id), { ...open, paid: true });
  const get = stripe.requests.at(-1);
  assert.equal(get.method, 'GET');
  assert.equal(get.url, `/v1/checkout/sessions/${id}`);
  assert.equal(get.headers.authorization, `Bearer ${stripe.key}`);
});

test('getSession: a session Stripe does not know is null; one not made by trapyard has no tier or run', async (t) => {
  const { stripe, client } = await setup(t);
  assert.equal(await client.getSession(fakeSessionId()), null);
  const foreign = stripe.create({ runId: '<script>', tier: 'platinum', paid: true });
  const s = await client.getSession(foreign);
  assert.equal(s.paid, true);
  assert.equal(s.tier, null);
  assert.equal(s.runId, null);
  await assert.rejects(client.getSession('cs_test_../../v1/charges'), /session id/);
});

test('Stripe errors, outages and timeouts are PaymentErrors that never carry the key', async (t) => {
  const { stripe, client } = await setup(t, { client: { timeoutMs: 200 } });
  for (const status of [500, 401, 429]) {
    stripe.outage(status);
    const err = await client.getSession(fakeSessionId()).catch((e) => e);
    assert.ok(err instanceof PaymentError, String(status));
    assert.match(err.message, new RegExp(String(status)));
    assert.ok(!err.message.includes(stripe.key));
    await assert.rejects(client.createSession({ runId: RUN, tier: 'report', publicUrl: PUBLIC }), PaymentError);
  }
  stripe.outage('hang');
  const slow = await client.getSession(fakeSessionId()).catch((e) => e);
  assert.ok(slow instanceof PaymentError);
  assert.match(slow.message, /could not be reached/);
  stripe.outage(null);

  const nowhere = stripeCheckout({ secretKey: stripe.key, apiBase: 'http://127.0.0.1:9' });
  const down = await nowhere.getSession(fakeSessionId()).catch((e) => e);
  assert.ok(down instanceof PaymentError);
  assert.ok(!down.message.includes(stripe.key));
});

test('a Stripe answer of the wrong shape is a PaymentError, not a redirect to somewhere odd', async () => {
  const fetchWith = (payload) => async () => new Response(JSON.stringify(payload), { status: 200 });
  const odd = (payload) =>
    stripeCheckout({ secretKey: fakeStripeKey(), fetch: fetchWith(payload) }).createSession({ runId: RUN, tier: 'report', publicUrl: PUBLIC });
  await assert.rejects(odd({ id: fakeSessionId(), url: 'javascript:alert(1)' }), PaymentError);
  await assert.rejects(odd({ id: 'nope', url: 'https://checkout.stripe.com/c/pay/x' }), PaymentError);
  const text = stripeCheckout({ secretKey: fakeStripeKey(), fetch: async () => new Response('<html>', { status: 200 }) });
  await assert.rejects(text.getSession(fakeSessionId()), PaymentError);
});

test('isSessionId accepts Stripe Checkout Session ids only', () => {
  assert.ok(isSessionId(fakeSessionId()));
  assert.ok(isSessionId(['cs', 'live', 'a1B2'.repeat(10)].join('_')));
  for (const bad of [undefined, '', 'cs_test_', 'pi_test_abc', 'cs_test_a/b', 'cs_test_a b', `cs_test_${'a'.repeat(300)}`]) {
    assert.ok(!isSessionId(bad), String(bad));
  }
});

test('paymentsConfig: off without STRIPE_SECRET_KEY; a malformed key is an error that does not echo it', () => {
  assert.equal(paymentsConfig({}), null);
  assert.equal(paymentsConfig({ STRIPE_SECRET_KEY: '' }), null);
  const key = fakeStripeKey();
  assert.deepEqual(paymentsConfig({ STRIPE_SECRET_KEY: key }), { secretKey: key });
  const restricted = ['rk', 'live', 'Z9y8X7w6'.repeat(3)].join('_');
  assert.deepEqual(paymentsConfig({ STRIPE_SECRET_KEY: restricted }), { secretKey: restricted });
  const publishable = ['pk', 'test', 'Q1w2E3r4'.repeat(3)].join('_');
  for (const bad of [publishable, 'not-a-key', `${key} `]) {
    assert.throws(
      () => paymentsConfig({ STRIPE_SECRET_KEY: bad }),
      (err) => /STRIPE_SECRET_KEY/.test(err.message) && !err.message.includes(bad.trim()),
    );
  }
});
