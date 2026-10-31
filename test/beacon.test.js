// The visit beacon (src/beacon.js), run in Node against a fake window: what it sends, when, and when
// it stays silent. The served /beacon.js text is run the same way in a fresh VM context, so the
// function the tests call is the code the browser gets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { SIGNAL_SLUG, SIGNAL_URL, beacon, beaconScript } from '../src/beacon.js';

const ORIGIN = 'https://trapyard.vercel.app';

/** A Storage-like object; `broken` makes every call throw, as blocked storage does. */
function storage(broken = false, entries = {}) {
  const map = new Map(Object.entries(entries));
  const guard = () => {
    if (broken) throw new Error('SecurityError');
  };
  return {
    getItem: (k) => (guard(), map.has(k) ? map.get(k) : null),
    setItem: (k, v) => (guard(), map.set(k, String(v))),
    map,
  };
}

/** An element whose closest('[data-checkout]') finds itself or an ancestor marked data-checkout. */
function element(checkout, parent = null) {
  return { closest: (sel) => (sel === '[data-checkout]' ? (checkout ? element(true) : parent?.closest(sel) ?? null) : null) };
}

/**
 * A fake browser window. `sent` collects every fetch as { url, options, body }; `click(target)`
 * dispatches a click to the document's listeners.
 */
function fakeWindow({
  referrer = '',
  webdriver = false,
  local = storage(),
  session = storage(),
  activate = false,
  fetchFails = false,
} = {}) {
  const sent = [];
  const listeners = [];
  const win = {
    navigator: { webdriver },
    location: { origin: ORIGIN, href: `${ORIGIN}/` },
    localStorage: local,
    sessionStorage: session,
    document: {
      referrer,
      body: { hasAttribute: (name) => activate && name === 'data-activate' },
      addEventListener: (type, fn) => {
        if (type === 'click') listeners.push(fn);
      },
    },
    fetch: (url, options) => {
      if (fetchFails === 'throw') throw new TypeError('blocked');
      sent.push({ url, options, body: JSON.parse(options.body) });
      return fetchFails ? Promise.reject(new TypeError('offline')) : Promise.resolve({ ok: true });
    },
  };
  return { win, sent, local, session, click: (target) => listeners.forEach((fn) => fn({ target })) };
}

const run = (w) => beacon(w.win, { url: SIGNAL_URL, slug: SIGNAL_SLUG });
const kinds = (w) => w.sent.map((s) => s.body.kind);

test('the endpoint and slug are the ones RepoHQ counts', () => {
  assert.equal(SIGNAL_URL, 'https://idea-factory.1426davejobs.workers.dev/api/ideas/signal');
  assert.equal(SIGNAL_SLUG, 'trapyard');
});

test('visit: a POST of {slug, kind, referrer} as JSON, fire-and-forget with keepalive and no cookies', () => {
  const w = fakeWindow();
  run(w);
  assert.equal(w.sent.length, 1);
  const [{ url, options, body }] = w.sent;
  assert.equal(url, SIGNAL_URL);
  assert.equal(options.method, 'POST');
  assert.equal(options.keepalive, true);
  assert.equal(options.credentials, 'omit');
  assert.deepEqual(Object.keys(body), ['slug', 'kind', 'referrer']);
  assert.deepEqual(body, { slug: 'trapyard', kind: 'visit', referrer: null });
});

test('visit: once per browser session (sessionStorage), again in a new session', () => {
  const local = storage();
  const session = storage();
  const first = fakeWindow({ local, session });
  run(first);
  const sameSession = fakeWindow({ local, session });
  run(sameSession);
  assert.deepEqual(kinds(first), ['visit']);
  assert.deepEqual(kinds(sameSession), [], 'the second page of the session sends nothing');
  const newSession = fakeWindow({ local, session: storage() });
  run(newSession);
  assert.deepEqual(kinds(newSession), ['visit']);
});

test('referrer: only when another site sent the visitor; a same-site, empty or odd referrer is null', () => {
  const cases = [
    ['https://news.ycombinator.com/item?id=1', 'https://news.ycombinator.com/item?id=1'],
    ['https://trapyard.vercel.app.evil.example/', 'https://trapyard.vercel.app.evil.example/'],
    [`${ORIGIN}/s/${'a'.repeat(32)}`, null],
    [`${ORIGIN}/`, null],
    ['', null],
    ['not a url', null],
  ];
  for (const [referrer, expected] of cases) {
    const w = fakeWindow({ referrer });
    run(w);
    assert.equal(w.sent[0].body.referrer, expected, referrer || '(empty)');
  }
});

test('activate: on the page that marks the core action (data-activate), once per browser (localStorage), across sessions', () => {
  const local = storage();
  const first = fakeWindow({ local, activate: true });
  run(first);
  assert.deepEqual(kinds(first), ['visit', 'activate']);
  const later = fakeWindow({ local, session: storage(), activate: true });
  run(later);
  assert.deepEqual(kinds(later), ['visit'], 'a second run in a new session is not a second activation');
  const plain = fakeWindow({ activate: false });
  run(plain);
  assert.deepEqual(kinds(plain), ['visit'], 'other pages never send activate');
});

test('checkout: every click on a Buy button (or inside one), nothing for other clicks', () => {
  const w = fakeWindow();
  run(w);
  w.click(element(false));
  w.click(element(true));
  w.click(element(false, element(true))); // the text inside the button
  w.click(null);
  w.click({}); // a target without closest(), e.g. a text node
  assert.deepEqual(kinds(w), ['visit', 'checkout', 'checkout']);
});

test('silent when navigator.webdriver is true (bots, screenshot runs): no request, no flag written', () => {
  const w = fakeWindow({ webdriver: true, activate: true });
  run(w);
  w.click(element(true));
  assert.deepEqual(w.sent, []);
  assert.equal(w.session.map.size, 0);
  assert.equal(w.local.map.size, 0);
});

test('silent when localStorage "repohq:notrack" is set (the owner\'s browser), whatever its value', () => {
  for (const value of ['1', 'true', '']) {
    const w = fakeWindow({ local: storage(false, { 'repohq:notrack': value }), activate: true });
    run(w);
    w.click(element(true));
    assert.deepEqual(w.sent, [], JSON.stringify(value));
  }
});

test('blocked storage never breaks the page and never double-counts: visit and activate are skipped, checkout still counts', () => {
  const w = fakeWindow({ local: storage(true), session: storage(true), activate: true });
  assert.doesNotThrow(() => run(w));
  w.click(element(true));
  assert.deepEqual(kinds(w), ['checkout']);
});

test('a failing network never surfaces: a rejected or throwing fetch is swallowed', async () => {
  for (const fetchFails of [true, 'throw']) {
    const w = fakeWindow({ fetchFails });
    assert.doesNotThrow(() => run(w));
    assert.doesNotThrow(() => w.click(element(true)));
  }
  await new Promise((done) => setImmediate(done)); // an unhandled rejection would fail the run here
});

test('the served /beacon.js runs on its own (no closure over this module) and sends the same visit', () => {
  const w = fakeWindow({ referrer: 'https://example.org/post' });
  runInNewContext(beaconScript(), { window: w.win, URL, JSON });
  assert.deepEqual(w.sent.map((s) => s.body), [{ slug: 'trapyard', kind: 'visit', referrer: 'https://example.org/post' }]);
  assert.equal(w.sent[0].url, SIGNAL_URL);
});
