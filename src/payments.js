// Payments: the two things for sale and a Stripe Checkout client (two REST calls over fetch, no SDK).
//
//   POST /checkout ─▶ createSession({ runId, tier }) ─▶ 303 to Stripe Checkout
//   Stripe ─▶ buyer back at /report/<run>?session_id=… ─▶ getSession(id) ─▶ paid? which run? which tier?
//
// Stripe is the record of payment: nothing about an order is stored here, and there is no webhook.
// The secret key goes only into the Authorization header; errors carry a status or an error name,
// never the key or Stripe's message.

export const STRIPE_API = 'https://api.stripe.com';

/** What a buyer can pay for, in USD cents. A retest is another run's full report, unlocked by the same payment. */
export const TIERS = {
  report: {
    id: 'report',
    title: 'Full report',
    cents: 29_900,
    retests: 0,
    product: 'trapyard full report',
    summary: "this run's full report, online and printable to PDF",
  },
  assessment: {
    id: 'assessment',
    title: 'Assessment',
    cents: 99_900,
    retests: 3,
    product: 'trapyard assessment: full report + 3 retests',
    summary: "this run's full report, plus full reports for up to 3 retest runs you start within 30 days, to show your fixes",
  },
};

/** Days after buying an assessment in which a run must start to count as one of its retests. */
export const RETEST_DAYS = 30;

const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{1,250}$/;
const RUN_ID = /^[a-f0-9]{16}$/;
const CHECKOUT_NOTE =
  'A trapyard report shows how your agent behaved on the trapyard range on one date. It is not a certification or a security guarantee.';

export const isSessionId = (id) => typeof id === 'string' && SESSION_ID.test(id);

/** 29900 → "$299", 1050 → "$10.50". */
export const usd = (cents) => (cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`);

/** Stripe could not be reached, or answered something unexpected. The message is safe to log. */
export class PaymentError extends Error {}

export function stripeCheckout({ secretKey, apiBase = STRIPE_API, fetch = globalThis.fetch, timeoutMs = 10_000 }) {
  async function call(method, path, form) {
    let res;
    try {
      res = await fetch(`${apiBase}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${secretKey}`,
          ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        },
        body: form ? new URLSearchParams(form).toString() : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new PaymentError(`Stripe could not be reached (${err.name})`);
    }
    if (method === 'GET' && res.status === 404) return null;
    if (!res.ok) throw new PaymentError(`Stripe answered ${res.status} to ${method} /v1/checkout/sessions`);
    try {
      return await res.json();
    } catch {
      throw new PaymentError('Stripe sent an answer that is not JSON');
    }
  }

  return {
    /** A one-off Checkout Session for `tier` of run `runId`; Stripe sends the buyer back to the run's report. */
    async createSession({ runId, tier, publicUrl }) {
      if (typeof tier !== 'string' || !Object.hasOwn(TIERS, tier)) throw new Error(`unknown tier: ${tier}`);
      if (typeof runId !== 'string' || !RUN_ID.test(runId)) throw new Error('a run id is 16 hex characters');
      const t = TIERS[tier];
      const report = `${publicUrl}/report/${runId}`;
      const session = await call('POST', '/v1/checkout/sessions', {
        mode: 'payment',
        'line_items[0][quantity]': '1',
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][unit_amount]': String(t.cents),
        'line_items[0][price_data][product_data][name]': t.product,
        'line_items[0][price_data][product_data][description]': `${t.summary[0].toUpperCase()}${t.summary.slice(1)}.`,
        success_url: `${report}?session_id={CHECKOUT_SESSION_ID}`, // Stripe fills in the placeholder
        cancel_url: report,
        client_reference_id: runId,
        'metadata[run_id]': runId,
        'metadata[tier]': tier,
        'payment_intent_data[metadata][run_id]': runId, // so support can find the payment by run
        'custom_text[submit][message]': CHECKOUT_NOTE,
      });
      let url;
      try {
        url = new URL(session?.url);
      } catch {
        url = null;
      }
      if (!isSessionId(session?.id) || !url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
        throw new PaymentError('Stripe answered without a usable Checkout Session');
      }
      return { id: session.id, url: url.href };
    },

    /**
     * The session as trapyard needs it, or null if Stripe has no such session. `tier` and `runId` are
     * null when the session was not made by trapyard's checkout.
     */
    async getSession(id) {
      if (!isSessionId(id)) throw new Error('not a Stripe Checkout session id');
      const s = await call('GET', `/v1/checkout/sessions/${id}`);
      if (s === null) return null;
      if (!s || typeof s !== 'object') throw new PaymentError('Stripe answered without a Checkout Session');
      const tier = s.metadata?.tier;
      const runId = s.metadata?.run_id;
      return {
        id,
        paid: s.payment_status === 'paid',
        processing: s.status === 'complete' && s.payment_status === 'unpaid',
        tier: typeof tier === 'string' && Object.hasOwn(TIERS, tier) ? tier : null,
        runId: typeof runId === 'string' && RUN_ID.test(runId) ? runId : null,
        createdAt: Number.isFinite(s.created) ? new Date(s.created * 1000).toISOString() : null,
      };
    },
  };
}
