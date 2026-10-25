// The visit beacon, so RepoHQ counts real use. Served as /beacon.js, and only on the production
// deployment (the server leaves the script tag out elsewhere: see `signals` in gauntlet.js).
//
//   visit     any page that loads it, once per browser session (sessionStorage)
//   activate  the run-started page (<body data-activate>), once per browser (localStorage)
//   checkout  every click on a Buy button ([data-checkout])
//
// Each event is one POST of {"slug", "kind", "referrer"}: fire-and-forget, keepalive, no cookies. The
// referrer is document.referrer only when another site sent the visitor, else null, so no trapyard
// address (a score card, a report link) ever leaves the page. Nothing is sent when
// navigator.webdriver is true or localStorage "repohq:notrack" is set.
//
// The body goes as text/plain in no-cors mode: a "simple" request, so no CORS preflight can drop it
// and the page never reads the answer. The JSON is the same either way.

export const SIGNAL_URL = 'https://repohq.vercel.app/api/ideas/signal';
export const SIGNAL_SLUG = 'trapyard';

/**
 * Runs in the browser. It takes the window and its settings as arguments and uses nothing else from
 * this module, so beaconScript() can serve its source as-is and the tests can run it in Node.
 */
export function beacon(win, { url, slug }) {
  const doc = win.document;
  const read = (area, key) => {
    try {
      return win[area].getItem(key);
    } catch {
      return null;
    }
  };
  // True only if the flag was not set and is now: blocked storage counts nothing rather than everything.
  const firstTime = (area, key) => {
    try {
      if (win[area].getItem(key) !== null) return false;
      win[area].setItem(key, '1');
      return true;
    } catch {
      return false;
    }
  };
  const silent = () => win.navigator.webdriver === true || read('localStorage', 'repohq:notrack') !== null;
  const referrer = () => {
    try {
      const from = doc.referrer;
      return from && new URL(from).origin !== win.location.origin ? from : null;
    } catch {
      return null;
    }
  };
  const send = (kind) => {
    try {
      win
        .fetch(url, {
          method: 'POST',
          body: JSON.stringify({ slug, kind, referrer: referrer() }),
          keepalive: true,
          credentials: 'omit',
          mode: 'no-cors',
          referrerPolicy: 'no-referrer',
        })
        .catch(() => {});
    } catch {
      // never break the page
    }
  };

  if (silent()) return;
  if (firstTime('sessionStorage', 'trapyard:visit')) send('visit');
  if (doc.body && doc.body.hasAttribute('data-activate') && firstTime('localStorage', 'trapyard:activated')) send('activate');
  doc.addEventListener('click', (event) => {
    const target = event.target;
    if (target && typeof target.closest === 'function' && target.closest('[data-checkout]') && !silent()) send('checkout');
  });
}

/** The source of /beacon.js. */
export const beaconScript = () => `(${beacon.toString()})(window, ${JSON.stringify({ url: SIGNAL_URL, slug: SIGNAL_SLUG })});\n`;
