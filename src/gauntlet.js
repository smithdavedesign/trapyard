// The hosted gauntlet: a public page that starts runs, the range under /r/<run>/…, and a shareable
// score card under /s/<card>. The same handler runs as `trapyard serve` (memory store) and as the
// Vercel function in api/index.js (Postgres store).
//
//   GET  /                      landing page with a "Start a free run" form
//   POST /runs                  the form → 201 page with the agent's task URL and the card link
//   POST /api/runs              JSON options (or nothing) → 201 { runId, taskUrl, cardUrl, … }
//   *    /r/<run>/…             the range: answer() from range.js inside one store transaction
//   GET  /s/<card>[.json|.png]  the score card as HTML, JSON or a share image
//   GET  /report/<run>[.json]   the full report: 402 until paid, 200 with ?session_id=<paid session>
//   POST /checkout              run + tier → a Stripe Checkout Session → 303 to Stripe
//   GET  /report/retest         a pasted retest link + session → 303 to that run's report
//   GET  /terms, /privacy       terms, privacy
//   GET  /robots.txt, /sitemap.xml, /og.png (the site's share image), /beacon.js (the visit beacon)
//
// With a payment link (STRIPE_PAYMENT_LINK) the landing page and an ended run's 402 page show a Buy
// button that sells LAUNCH_OFFER; the seller delivers it by hand (exportRun, `trapyard export`).
// With `signals` (Vercel production only) public pages load the visit beacon (src/beacon.js).
//
//   agent ─▶ /r/<run>/… ─▶ store.withRun(run) ─┬ ended ─────────────▶ 410
//                                              ├ expired ───────────▶ score, close (expired), 410
//                                              ├ event cap reached ─▶ score, close (event-cap), 429
//                                              └ answer() ─▶ event + ledger saved
//                                                  └ POST /output 200 ─▶ score, close (summary)
//
// A run is scored once, when it ends, by buildReport() on its log; the result is frozen on the run,
// so a shared card never changes. The card id is unrelated to the run id: holding a share link
// gives no way to act inside the run, or to buy its report. The report link carries the run id, so
// only whoever started the run has it; once paid, its ?session_id= address is what they share.
//
//   /report/<run>?session_id ─┬ run going ─────────────────────────────▶ 409
//                             ├ no session (or malformed) ─────────────▶ 402 buy page
//                             ├ payments off ──────────────────────────▶ 503 (402 without a session)
//                             ├ Stripe error ──────────────────────────▶ 502, never 402
//                             ├ unknown / not trapyard's / unpaid ─────▶ 402
//                             ├ bought for this run ───────────────────▶ 200
//                             └ assessment, run started in its 30 days ─▶ unlockRetest ─┬ ok ──▶ 200
//                                                                                       └ limit ▶ 402

import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { SIGNAL_URL, beaconScript } from './beacon.js';
import {
  END_REASON,
  cardPage,
  errorPage,
  landingPage,
  paidBanner,
  privacyPage,
  reportLockedPage,
  runStartedPage,
  termsPage,
} from './pages.js';
import { PaymentError, RETEST_DAYS, TIERS, isSessionId, stripeCheckout } from './payments.js';
import { LOG_FORMAT, answer, newRun, parseRunUrl, readBody, send, validateRunOptions } from './range.js';
import { buildReport, reportPage } from './report.js';
import { SCENARIO_SET, TRAPS, runTraps } from './scenarios.js';
import { shareImage, siteImage } from './share-image.js';
import { SITE_IMAGE, robotsTxt, sitemapXml } from './site.js';
import { postgresStore } from './store.js';

export const CARD_FORMAT = 'trapyard.card/1';

/** Hosted runs are smaller than local ones (1000 events, 32 KiB) so a free database lasts. */
export const HOSTED_LIMITS = { maxEvents: 300, maxBody: 8 * 1024, runTtlMs: 30 * 60_000, runsPerHour: 100 };

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const MAX_API_BODY = 4 * 1024;
const RETRY_AFTER_S = 600;
const ID_ATTEMPTS = 3;
const RUN_OPTIONS = ['allowedTools', 'budget', 'traps'];
const CARD_PATH = /^\/s\/([a-f0-9]{32})(\.json|\.png)?$/;
const REPORT_PATH = /^\/report\/([a-f0-9]{16})(\.json)?$/;
// A run id in a pasted task URL (/r/<id>/task), report link (/report/<id>) or on its own.
const RUN_ID_IN = /(?:\/r\/|\/report\/|^)([a-f0-9]{16})(?:[/?#.]|$)/;
const LANDING_CACHE = 'public, max-age=300';
// A finished card never changes, so the CDN may keep it (the image costs ~40 ms to draw).
const FINISHED_CACHE = 'public, max-age=300, s-maxage=86400';
// The site's share image changes only with a deploy.
const SITE_IMAGE_CACHE = 'public, max-age=3600, s-maxage=86400';
// The paid report and its lock: never in a shared cache or a search index.
const PRIVATE = { 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex' };
const HTML = 'text/html; charset=utf-8';
const HTML_HEADERS = {
  // Chrome applies form-action to the redirect after a form POST, so /checkout's 303 needs Stripe here.
  // The only script is the same-origin beacon, and the only place it may send to is RepoHQ.
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self' https://checkout.stripe.com; " +
    `base-uri 'none'; frame-ancestors 'none'; script-src 'self'; connect-src ${new URL(SIGNAL_URL).origin}`,
  'referrer-policy': 'no-referrer',
};

let siteImagePng = null; // drawn on first request, then kept: it never changes

export const CARD_SCOPE =
  'This score card covers only the traps listed, run on the trapyard range against this agent on the date shown. ' +
  'It shows how the agent behaved on the range; it is not a certification, a security guarantee, or evidence of how ' +
  'the agent behaves in production or against other attacks. A hosted run sees only the requests that reach the range, ' +
  'so a secret the agent printed only to its own output is not counted here.';

const EXPIRED_WARNING = 'The agent did not post its summary before the run expired, so the run was scored as it stood.';
const HOSTED_NOTE =
  'This was a hosted run: trapyard saw only the requests that reached the range, so a secret the agent printed only to its own output is not counted.';
const GONE = { status: 410, payload: { error: 'this run has ended; start a new run' } };
const CAPPED = { status: 429, payload: { error: 'event limit reached for this run' } };

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** A configuration problem. Its message is written by trapyard and never contains a setting's value. */
class ConfigError extends Error {}

/** A stored run as a trapyard.log/1: its head plus its events. */
export const logOf = (record, events) => ({ ...record.head, events });

/** The report frozen when the run ended; built from the log only for a run closed before reports were frozen. */
const frozenReport = async (store, record) => record.result?.report ?? buildReport(logOf(record, await store.events(record.id)));

/**
 * Scores the log as it stands and freezes what the card shows, plus the full report (sold at
 * /report/<run>): rendered later from code, a log stops rendering once the scenario set changes.
 */
function finalResult(log, closedBy) {
  const report = buildReport(log);
  return {
    scenarioSet: report.scenarioSet,
    summary: report.summary,
    traps: report.traps.map((t) => ({ class: t.class, title: t.title, technique: t.technique, status: t.status })),
    warnings: closedBy === 'expired' ? [EXPIRED_WARNING, ...report.warnings] : report.warnings,
    report,
  };
}

/** The store update that ends a run. */
function ending(record, events, closedBy, closedAt, head = record.head) {
  return { head, closedAt, closedBy, result: finalResult({ ...head, events }, closedBy) };
}

const isExpired = (record, at) => !record.closedAt && at.getTime() >= Date.parse(record.expiresAt);

/** The record as it stands at `at`; if its deadline passed with nobody posting a summary, it is scored and closed first. */
async function settle(store, record, at) {
  if (!isExpired(record, at)) return record;
  const closed = await store.withRun(record.id, async (current, loadEvents) => {
    if (current.closedAt) return { record: current };
    const update = ending(current, await loadEvents(), 'expired', current.expiresAt);
    return { update, record: { ...current, ...update } };
  });
  return closed?.record ?? record;
}

/**
 * How an ended run was recorded, for its full report: `hosted` for reportPage() and `block` for the
 * JSON. `verifyUrl` (the paid page's own address) is left out of a report sent by hand.
 */
function hostedParts(record, { origin, cardUrl, verifyUrl = null }) {
  const warnings = record.closedBy === 'expired' ? [EXPIRED_WARNING] : [];
  const hosted = {
    origin,
    cardUrl,
    verifyUrl,
    ended: `${record.closedAt}: ${END_REASON[record.closedBy] ?? record.closedBy}`,
    warnings,
    note: HOSTED_NOTE,
  };
  const block = {
    recordedBy: origin,
    cardUrl,
    ...(verifyUrl ? { verifyUrl } : {}),
    endedAt: record.closedAt,
    endedBy: record.closedBy,
    warnings,
    note: HOSTED_NOTE,
  };
  return { hosted, block };
}

/** An http(s) origin with no path, query or login; a trailing slash is dropped. */
export function publicOrigin(raw, name = 'TRAPYARD_PUBLIC_URL') {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${name} is not a URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ConfigError(`${name} must be an http or https URL`);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new ConfigError(`${name} must be a bare origin such as https://trapyard.example (no path, query or login)`);
  }
  return url.origin;
}

/**
 * Hosted settings from the environment: the public origin runs live under (TRAPYARD_PUBLIC_URL, else
 * Vercel's production URL in production and the deployment URL elsewhere) and DATABASE_URL.
 */
export function gauntletConfig(env) {
  const vercelHost = env.VERCEL_ENV === 'production' ? env.VERCEL_PROJECT_PRODUCTION_URL : env.VERCEL_URL;
  const raw = env.TRAPYARD_PUBLIC_URL || (vercelHost ? `https://${vercelHost}` : '');
  if (!raw) throw new ConfigError('set TRAPYARD_PUBLIC_URL to the public origin of the gauntlet, e.g. https://trapyard.example');
  const publicUrl = publicOrigin(raw);
  if (!env.DATABASE_URL) throw new ConfigError('DATABASE_URL is not set: the hosted gauntlet keeps its runs in Postgres');
  return { publicUrl, databaseUrl: env.DATABASE_URL };
}

const STRIPE_KEY = /^(sk|rk)_(test|live)_[A-Za-z0-9]+$/;

/**
 * Payments from the environment: off (null) without STRIPE_SECRET_KEY. A Stripe secret key or, better,
 * a restricted key with write access to Checkout Sessions. The error never contains the value.
 */
export function paymentsConfig(env) {
  const key = env.STRIPE_SECRET_KEY;
  if (!key) return null;
  if (!STRIPE_KEY.test(key)) {
    throw new ConfigError('STRIPE_SECRET_KEY is not a Stripe secret key or restricted key (they start with sk_ or rk_)');
  }
  return { secretKey: key };
}

/**
 * The Buy button's Stripe Payment Link from STRIPE_PAYMENT_LINK: null (no Buy button) when unset,
 * else an https URL with no login. It is public (the page shows it), but the error still never
 * contains the value.
 */
export function paymentLinkConfig(env) {
  const raw = env.STRIPE_PAYMENT_LINK;
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError('STRIPE_PAYMENT_LINK is not a URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new ConfigError('STRIPE_PAYMENT_LINK must be an https URL such as https://buy.stripe.com/… (no login)');
  }
  return url.href;
}

export function createGauntlet({
  store,
  publicUrl,
  payments = null, // stripeCheckout() from payments.js; null sells nothing through Checkout
  paymentLink = null, // from paymentLinkConfig(); null hides the Buy button
  signals = false, // load the visit beacon (production only)
  maxEvents = HOSTED_LIMITS.maxEvents,
  maxBody = HOSTED_LIMITS.maxBody,
  runTtlMs = HOSTED_LIMITS.runTtlMs,
  runsPerHour = HOSTED_LIMITS.runsPerHour,
  now = () => new Date(),
  log = console.error,
}) {
  const limits = { maxEvents, maxBody, runTtlMs, runsPerHour };
  const site = { publicUrl, paymentLink, signals };
  const cardUrl = (cardId) => `${publicUrl}/s/${cardId}`;
  const reportUrl = (runId) => `${publicUrl}/report/${runId}`;

  function started(record) {
    const { run } = record.head;
    const url = cardUrl(record.cardId);
    return {
      runId: run.id,
      taskUrl: `${run.base}/task`,
      cardUrl: url,
      cardJsonUrl: `${url}.json`,
      imageUrl: `${url}.png`,
      reportUrl: reportUrl(run.id),
      expiresAt: record.expiresAt,
      scenarioSet: record.head.scenarioSet,
      allowedTools: run.allowedTools,
      budget: run.budget,
      traps: run.traps,
    };
  }

  /** Creates a run; throws HttpError 400 (bad options) or 429 (hourly cap). */
  async function startRun(options = {}) {
    for (const key of Object.keys(options)) {
      if (!RUN_OPTIONS.includes(key)) throw new HttpError(400, `unknown option: ${key} (known: ${RUN_OPTIONS.join(', ')})`);
    }
    try {
      validateRunOptions(options);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    const at = now();
    const limit = { since: new Date(at.getTime() - HOUR_MS).toISOString(), cap: runsPerHour };
    for (let attempt = 0; attempt < ID_ATTEMPTS; attempt++) {
      const run = newRun(publicUrl, options, { now: at });
      const record = {
        id: run.id,
        cardId: randomBytes(16).toString('hex'),
        head: { format: LOG_FORMAT, scenarioSet: { ...SCENARIO_SET }, run },
        spentCents: 0,
        eventCount: 0,
        createdAt: at.toISOString(),
        expiresAt: new Date(at.getTime() + runTtlMs).toISOString(),
        closedAt: null,
        closedBy: null,
        result: null,
      };
      const outcome = await store.createRun(record, limit);
      if (outcome === 'capped') {
        throw new HttpError(429, `the gauntlet has started its ${runsPerHour} runs for this hour; try again later`);
      }
      if (outcome === 'created') return started(record);
    }
    throw new Error('could not pick an unused run id');
  }

  /** The card as data: from the frozen result once the run has ended, otherwise "running". */
  function cardView(record) {
    const { run } = record.head;
    const url = cardUrl(record.cardId);
    const result = record.result;
    return {
      format: CARD_FORMAT,
      id: record.cardId,
      url,
      json: `${url}.json`,
      image: `${url}.png`,
      state: record.closedAt ? 'finished' : 'running',
      scenarioSet: result?.scenarioSet ?? record.head.scenarioSet,
      startedAt: run.startedAt,
      expiresAt: record.expiresAt,
      finishedAt: record.closedAt,
      finishedBy: record.closedBy,
      allowedTools: run.allowedTools,
      budget: run.budget,
      summary: result?.summary ?? null,
      traps: result?.traps ?? runTraps(run).map((t) => ({ class: t.class, title: t.title, technique: t.technique, status: null })),
      warnings: result?.warnings ?? [],
      scope: CARD_SCOPE,
    };
  }

  const sendHtml = (res, status, html, headers = {}) => send(res, status, html, HTML, { ...HTML_HEADERS, ...headers });

  function notAllowed(req, res) {
    req.resume();
    send(res, 405, { error: 'method not allowed' });
  }

  async function rangeRequest(req, res, target) {
    const body = await readBody(req, maxBody);
    const out = await store.withRun(target.id, async (record, loadEvents) => {
      const at = now(); // read under the lock, so event times follow seq order
      if (record.closedAt) return { reply: GONE };
      if (isExpired(record, at)) return { reply: GONE, update: ending(record, await loadEvents(), 'expired', record.expiresAt) };
      if (record.eventCount >= maxEvents) {
        const head = { ...record.head, run: { ...record.head.run, truncated: true } };
        return { reply: CAPPED, update: ending(record, await loadEvents(), 'event-cap', at.toISOString(), head) };
      }
      const reply = answer(record.head.run, {
        method: req.method,
        url: req.url,
        path: target.path,
        body,
        seq: record.eventCount + 1,
        at: at.toISOString(),
        spentCents: record.spentCents,
        maxBody,
      });
      const update = { eventCount: reply.event.seq, spentCents: reply.spentCents };
      if (target.path === '/output' && reply.status === 200) {
        Object.assign(update, ending(record, [...(await loadEvents()), reply.event], 'summary', at.toISOString()));
      }
      return { reply, event: reply.event, update };
    });
    if (!out) return send(res, 404, { error: 'unknown run' });
    send(res, out.reply.status, out.reply.payload, out.reply.type);
  }

  const settled = (record) => settle(store, record, now());

  async function cardRequest(res, cardId, ext) {
    const found = await store.findCard(cardId);
    if (!found) {
      return ext ? send(res, 404, { error: 'no such score card' }) : sendHtml(res, 404, errorPage(404, 'There is no score card at this address.'));
    }
    const record = await settled(found);
    const card = cardView(record);
    const cache = { 'cache-control': card.state === 'finished' ? FINISHED_CACHE : 'no-store' };
    if (ext === '.json') return send(res, 200, card, undefined, cache);
    if (ext === '.png') return send(res, 200, shareImage(card), 'image/png', cache);
    return sendHtml(res, 200, cardPage(card, site), cache);
  }

  /**
   * Whether `sessionId` opens this run's full report: { session, retest } if it does, otherwise
   * { status, message, offer } (offer: show a way to buy, the Buy button or the Checkout forms).
   * Throws PaymentError if Stripe fails.
   */
  async function access(record, sessionId) {
    const deny = (status, message, offer = false) => ({ status, message, offer });
    const ready = 'The full report of this run is ready.';
    if (!record.closedAt) {
      return deny(409, 'The run is still going. Its full report is ready once the agent posts its summary or the run expires.');
    }
    if (!payments) return sessionId ? deny(503, 'Payments are not set up on this deployment.') : deny(402, ready, Boolean(paymentLink));
    if (!sessionId) return deny(402, ready, true);
    if (!isSessionId(sessionId)) return deny(402, `That payment link is not valid. ${ready}`, true);
    const session = await payments.getSession(sessionId);
    if (!session?.tier || !session.runId) return deny(402, `No trapyard payment was found for that link. ${ready}`, true);
    if (!session.paid) {
      return session.processing
        ? deny(402, 'Your payment is still processing. Reload this page in a few minutes.')
        : deny(402, `That checkout was not paid. ${ready}`, true);
    }
    if (session.runId === record.id) return { session, retest: false };
    const tier = TIERS[session.tier];
    if (!tier.retests) return deny(402, `That payment opens the report of another run. ${ready}`, true);
    const paidAt = Date.parse(session.createdAt);
    const startedAt = Date.parse(record.head.run.startedAt);
    if (!(startedAt >= paidAt && startedAt < paidAt + RETEST_DAYS * DAY_MS)) {
      return deny(402, `An assessment's retests are runs started within ${RETEST_DAYS} days after buying it; this run is not one.`, true);
    }
    if ((await store.unlockRetest(session.id, record.id, tier.retests)) === 'limit') {
      return deny(402, `That assessment's ${tier.retests} retests are used. ${ready}`, true);
    }
    return { session, retest: true };
  }

  async function reportRequest(req, res, runId, ext) {
    const sessionId = new URL(req.url, 'http://x').searchParams.get('session_id');
    const found = await store.findRun(runId);
    if (!found) {
      return ext ? send(res, 404, { error: 'no such run' }) : sendHtml(res, 404, errorPage(404, 'There is no run at this address.'));
    }
    const record = await settled(found);
    let verdict;
    try {
      verdict = await access(record, sessionId);
    } catch (err) {
      if (!(err instanceof PaymentError)) throw err;
      log(`trapyard: checking a payment failed: ${err.message}`);
      verdict = { status: 502, message: 'trapyard could not check the payment with Stripe just now. Try again in a minute.' };
    }
    if (verdict.status) {
      if (ext) {
        const error = verdict.status === 402 ? `payment required: ${verdict.message}` : verdict.message;
        return send(res, verdict.status, { error }, undefined, PRIVATE);
      }
      const page = reportLockedPage({
        title: 'full report',
        message: verdict.message,
        runId: record.id,
        card: cardView(record),
        offer: verdict.offer,
        paymentsOn: Boolean(payments),
        site,
      });
      return sendHtml(res, verdict.status, page, PRIVATE);
    }

    const { session, retest } = verdict;
    const report = await frozenReport(store, record);
    const { hosted, block } = hostedParts(record, {
      origin: publicUrl,
      cardUrl: cardUrl(record.cardId),
      verifyUrl: `${reportUrl(record.id)}?session_id=${session.id}`,
    });
    if (ext) return send(res, 200, { ...report, hosted: block }, undefined, PRIVATE);
    const retestsUntil = new Date(Date.parse(session.createdAt) + RETEST_DAYS * DAY_MS).toISOString().slice(0, 10);
    const banner = paidBanner({ tier: session.tier, retest, sessionId: session.id, retestsUntil });
    return sendHtml(res, 200, reportPage(report, { hosted, banner }), PRIVATE);
  }

  async function checkout(req, res) {
    const body = await readBody(req, MAX_API_BODY);
    if (body === null) return sendHtml(res, 413, errorPage(413, 'That request was too large.'));
    const form = new URLSearchParams(body);
    const runId = form.get('run') ?? '';
    const tier = form.get('tier') ?? '';
    if (!/^[a-f0-9]{16}$/.test(runId) || !Object.hasOwn(TIERS, tier)) {
      return sendHtml(res, 400, errorPage(400, "Choose what to buy from your run's full report link."));
    }
    const found = await store.findRun(runId);
    if (!found) return sendHtml(res, 404, errorPage(404, 'There is no run at this address.'));
    const record = await settled(found);
    if (!record.closedAt) return sendHtml(res, 409, errorPage(409, 'The run is still going. Its full report can be bought once it ends.'));
    if (!payments) return sendHtml(res, 503, errorPage(503, 'Payments are not set up on this deployment.'));
    let session;
    try {
      session = await payments.createSession({ runId, tier, publicUrl });
    } catch (err) {
      if (!(err instanceof PaymentError)) throw err;
      log(`trapyard: starting a checkout failed: ${err.message}`);
      return sendHtml(res, 502, errorPage(502, 'trapyard could not reach Stripe just now. Try again in a minute.'));
    }
    res.writeHead(303, { location: session.url, 'cache-control': 'no-store' });
    res.end();
  }

  /** The assessment's retest form: a pasted task URL, report link or run id → that run's report with the session. */
  function retestRedirect(req, res) {
    const query = new URL(req.url, 'http://x').searchParams;
    const sessionId = query.get('session_id');
    const runId = RUN_ID_IN.exec((query.get('run') ?? '').trim())?.[1];
    if (!isSessionId(sessionId) || !runId) {
      return sendHtml(res, 400, errorPage(400, "Paste the retest run's task URL or its full report link."));
    }
    res.writeHead(303, { location: `/report/${runId}?session_id=${sessionId}`, 'cache-control': 'no-store' });
    res.end();
  }

  async function formRun(req, res) {
    await readBody(req, MAX_API_BODY); // the form has no fields; its body is read and ignored
    try {
      return sendHtml(res, 201, runStartedPage(await startRun(), site), { 'cache-control': 'no-store' });
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      const retry = err.status === 429 ? { 'retry-after': String(RETRY_AFTER_S) } : {};
      return sendHtml(res, err.status, errorPage(err.status, err.message), retry);
    }
  }

  async function apiRun(req, res) {
    try {
      const body = await readBody(req, MAX_API_BODY);
      if (body === null) throw new HttpError(413, `body larger than ${MAX_API_BODY} bytes`);
      let options = {};
      if (body.trim() !== '') {
        try {
          options = JSON.parse(body);
        } catch {
          options = null;
        }
        if (!options || typeof options !== 'object' || Array.isArray(options)) {
          throw new HttpError(400, `the body must be empty or a JSON object of run options (${RUN_OPTIONS.join(', ')})`);
        }
      }
      return send(res, 201, await startRun(options));
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      const retry = err.status === 429 ? { 'retry-after': String(RETRY_AFTER_S) } : {};
      return send(res, err.status, { error: err.message }, undefined, retry);
    }
  }

  const cached = { 'cache-control': LANDING_CACHE };
  /** The fixed GET pages and files, by path (a Map, so no path can reach an object's prototype). */
  const ASSETS = new Map([
    ['/terms', (res) => sendHtml(res, 200, termsPage(site), cached)],
    ['/privacy', (res) => sendHtml(res, 200, privacyPage(site), cached)],
    ['/robots.txt', (res) => send(res, 200, robotsTxt(publicUrl), 'text/plain; charset=utf-8', cached)],
    ['/sitemap.xml', (res) => send(res, 200, sitemapXml(publicUrl), 'application/xml; charset=utf-8', cached)],
    ['/beacon.js', (res) => send(res, 200, beaconScript(), 'text/javascript; charset=utf-8', cached)],
    [
      SITE_IMAGE.path,
      (res) => {
        siteImagePng ??= siteImage(TRAPS);
        send(res, 200, siteImagePng, 'image/png', { 'cache-control': SITE_IMAGE_CACHE });
      },
    ],
  ]);

  async function route(req, res) {
    const url = req.url ?? '/';
    const target = parseRunUrl(url);
    if (target) return rangeRequest(req, res, target);
    const path = url.split('?')[0];
    const readOnly = req.method === 'GET' || req.method === 'HEAD';
    if (path === '/') {
      if (!readOnly) return notAllowed(req, res);
      return sendHtml(res, 200, landingPage({ site, limits }), { 'cache-control': LANDING_CACHE });
    }
    const asset = ASSETS.get(path);
    if (asset) return readOnly ? asset(res) : notAllowed(req, res);
    if (path === '/runs') return req.method === 'POST' ? formRun(req, res) : notAllowed(req, res);
    if (path === '/api/runs') return req.method === 'POST' ? apiRun(req, res) : notAllowed(req, res);
    const card = CARD_PATH.exec(path);
    if (card) return readOnly ? cardRequest(res, card[1], card[2]) : notAllowed(req, res);
    const report = REPORT_PATH.exec(path);
    if (report) return readOnly ? reportRequest(req, res, report[1], report[2]) : notAllowed(req, res);
    if (path === '/report/retest') return readOnly ? retestRedirect(req, res) : notAllowed(req, res);
    if (path === '/checkout') return req.method === 'POST' ? checkout(req, res) : notAllowed(req, res);
    req.resume();
    return send(res, 404, { error: 'not found' });
  }

  async function handler(req, res) {
    try {
      await route(req, res);
    } catch (err) {
      // Only the error's code or name: messages from a database driver can carry connection details.
      log(`trapyard: ${req.method} ${(req.url ?? '').split('?')[0]} failed: ${err.code ?? err.name}`);
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
      else res.destroy();
    }
  }

  return { handler };
}

/** Starts a gauntlet on host:port; its public URL defaults to the address it listens on. */
export async function serveGauntlet({ port = 0, host = '127.0.0.1', publicUrl, ...options }) {
  let handler = (req, res) => send(res, 503, { error: 'starting' });
  const server = createServer((req, res) => handler(req, res));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const origin = `http://${host.includes(':') ? `[${host}]` : host}:${server.address().port}`;
  const gauntlet = createGauntlet({ ...options, publicUrl: publicUrl ?? origin });
  handler = gauntlet.handler;
  const close = () =>
    new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  return { origin, publicUrl: publicUrl ?? origin, gauntlet, close };
}

/** The Buy button's link from env, or null; a malformed one is logged (never its value) and hides the button. */
export function paymentLinkFromEnv(env, log) {
  try {
    return paymentLinkConfig(env);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    log(`trapyard: ${err.message}; the Buy button is hidden`);
    return null;
  }
}

/**
 * The Vercel function: on the first request it reads the config, connects (`connect(databaseUrl)` →
 * a { query, transaction } database) and migrates. A failed setup is not cached, so the next request
 * tries again. Nothing it logs can contain a setting's value. The visit beacon is on only in
 * production (VERCEL_ENV), never on previews.
 */
export function vercelHandler({ env, connect, log = console.error }) {
  let ready = null;
  function setup() {
    if (!ready) {
      ready = (async () => {
        const { publicUrl, databaseUrl } = gauntletConfig(env);
        const pay = paymentsConfig(env);
        const paymentLink = paymentLinkFromEnv(env, log);
        const store = postgresStore(await connect(databaseUrl));
        await store.migrate();
        return createGauntlet({
          store,
          publicUrl,
          log,
          payments: pay && stripeCheckout(pay),
          paymentLink,
          signals: env.VERCEL_ENV === 'production',
        });
      })();
      ready.catch(() => {
        ready = null;
      });
    }
    return ready;
  }
  return async function handler(req, res) {
    let gauntlet;
    try {
      gauntlet = await setup();
    } catch (err) {
      const config = err instanceof ConfigError;
      log(`trapyard: setup failed: ${config ? err.message : (err.code ?? err.name)}`);
      req.resume();
      return send(res, 500, { error: config ? 'trapyard is not configured on this deployment; see the function log' : 'internal error' });
    }
    return gauntlet.handler(req, res);
  };
}

/**
 * An ended run's full report as files, for the seller to send to a Buy-button buyer by hand
 * (`trapyard export`): log.json, report.json (with how it was recorded) and report.html, as the paid
 * page shows them minus the verify-online link. Null for an unknown run; throws while the run is going.
 * An expired run nobody closed yet is scored and closed first, as opening its card would.
 */
export async function exportRun(store, runId, { now = new Date() } = {}) {
  const found = await store.findRun(runId);
  if (!found) return null;
  const record = await settle(store, found, now);
  if (!record.closedAt) throw new Error(`run ${runId} has not ended yet: its report is ready once the agent posts its summary or the run expires`);
  const events = await store.events(record.id);
  const report = record.result?.report ?? buildReport(logOf(record, events));
  const origin = new URL(record.head.run.base).origin; // where the run was recorded, whatever the config says now
  const { hosted, block } = hostedParts(record, { origin, cardUrl: `${origin}/s/${record.cardId}` });
  const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
  return {
    files: {
      'log.json': json(logOf(record, events)),
      'report.json': json({ ...report, hosted: block }),
      'report.html': reportPage(report, { hosted }),
    },
  };
}
