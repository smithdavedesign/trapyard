# trapyard: launch readiness

The product does what it did before. This pass added what a public launch needs: search and share tags, a privacy page, plain terms, a $149 Buy button, a visit beacon for RepoHQ, screenshots and a provisioning file. `npm test`: **272 tests, 0 failing** (231 before; the 41 new tests are in `test/launch.test.js`, `test/beacon.test.js` and `test/share-image.test.js`).

trapyard is not a Next.js app. It is one Node HTTP handler that runs as the Vercel function (`api/index.js`) and as `trapyard serve`. So each item below follows this app's own conventions: routes in `src/gauntlet.js`, server-rendered HTML in `src/pages.js`, a PNG drawn by code in `src/share-image.js`.

## What I did

1. **Search and sharing** (`src/site.js`)
   - `/`, `/privacy` and `/terms` each have:
     - their own `<title>` and meta description
     - a canonical URL
     - Open Graph and Twitter `summary_large_image` tags that point at **`/og.png`**, a 1200×630 image drawn by code with the existing bitmap-font PNG encoder (nothing copied from the web)
     - JSON-LD for a `SoftwareApplication`. While the Buy button is shown, it also holds an `Offer` of **149.00 USD, paid once per agent**.
   - Score cards keep their own share image and gained the same description, canonical URL, Twitter tags and JSON-LD.
   - All URLs are built from the configured public origin, never from the `Host` header.
   - **`/robots.txt`** allows indexing, points at the sitemap, and keeps crawlers off `/r/` (the trap pages), `/report/`, `/api/`, `/runs` and `/checkout`.
   - **`/sitemap.xml`** lists the three public pages.
2. **`/privacy`** (new) says, plainly:
   - what a run keeps: its settings and every request the agent makes to it
   - what trapyard doesn't keep: no cookies, no IP addresses, no accounts
   - what Stripe and Vercel see
   - the two browser-storage flags
   - the three beacon events (`visit`, `activate`, `checkout`), where they go, when nothing is sent, and how to opt out
   - contact through GitHub issues

   **`/terms`** gained:
   - **no warranty**
   - "covers only the traps listed" and "on the range only", alongside the existing "not a certification" wording
   - REVENUE.md's **$149 once per agent (a report and one retest)**
   - the refund line: within 14 days, made **by hand** in Stripe
   - contact through GitHub issues, with a warning never to post a task URL, a report link or payment details there

   Every page's footer links **Privacy · Terms · Contact: GitHub issues**.
3. **Buy button.** It links to `STRIPE_PAYMENT_LINK`, read on the server, so no browser variable is needed.
   - **Hidden when the variable is unset**, and also when it is malformed: the site stays up and the function log names the setting, never its value.
   - Where it shows:
     - in the landing page header, next to "Start a free run"
     - in the landing page's "full report" section (`#buy`)
     - on an ended run's 402 report page. There the link carries `?client_reference_id=<run id>`, so the Stripe payment names the run.
   - While the link is set, $149 is the only price any page shows. The $299/$999 Checkout Session code is untouched and comes back if the link is removed.
   - Score cards never sell, as before: a shared card can't be used to buy the owner's report.
   - Nothing is hard-coded: no link, no key.
4. **Visit beacon** (`src/beacon.js`, served as `/beacon.js`)
   - It POSTs `{"slug":"trapyard","kind":…,"referrer":…}` to `https://repohq.vercel.app/api/ideas/signal`, fire-and-forget, with `keepalive` and `credentials: 'omit'`.
   - Events:
     - **`visit`** on public pages and score cards, once per session (`sessionStorage`)
     - **`activate`** when someone uses the core action, **"Start a free run"** (it fires on the run-started page), once per browser (`localStorage`)
     - **`checkout`** on every click of a Buy button, or of the Checkout tier buttons when those are on
   - `referrer` is `document.referrer` only when it comes from another origin, else `null`.
   - It sends nothing when:
     - `navigator.webdriver` is true
     - localStorage `repohq:notrack` is set
     - the deployment is not production. The server includes the script tag only when `VERCEL_ENV === 'production'`, so previews and local runs never load it.
   - The CSP gained `script-src 'self'` and `connect-src https://repohq.vercel.app`, and nothing else.
   - The paid report and error pages load no script.
5. **`.provision`** has exactly the two requested lines: the Vercel project, and a request for the $149 Stripe payment link.
6. **Tests.** They check:
   - every public page's tags
   - unique titles and descriptions
   - JSON-LD with and without the Offer
   - robots.txt and the sitemap (each listed URL answers 200)
   - the `/og.png` size
   - the footer on every kind of page
   - privacy and terms content
   - the Buy button hidden without the variable and shown with it, `client_reference_id`, and a malformed link hidden and logged without its value
   - the beacon's script tag only in production, and the CSP
   - the beacon's behaviour, run against a fake `window`: once per session or browser, referrer rules, webdriver, notrack, blocked storage, a failing fetch, and the served script running in a fresh VM
   - `exportRun` on the memory store and on Postgres (PGlite)

   Two mutation checks were caught and reverted: a beacon that ignores `navigator.webdriver`, and a Buy button shown without the variable.
7. **Screenshots.** `npm run screenshots` starts the real `trapyard serve` as a child process, with only `PATH` and a placeholder `STRIPE_PAYMENT_LINK=https://example.com/pay`. It waits for it to answer, drives Chromium from `CHROMIUM_PATH`, and stops it. It writes six PNGs:
   - `home-*`: the start page with the Buy button
   - `run-*`: the core action, a run started, with the footer links
   - `card-*`: the result, 4 of 4 traps fell for the vulnerable stub agent

   I opened all six and checked them. README's Screenshots section now shows only these.
8. **Delivery for the payment link.** A payment link can't unlock a hosted report by itself, so the seller now has a tool. **`node bin/trapyard.js export <run id>`** reads a run from `DATABASE_URL` and writes `log.json`, `report.json` and `report.html`: the same frozen full report the paid page shows, with "recorded by" and the score card link, minus the verify-online link. It is owner-only and has no public route.

## Decisions made without asking

- **$149 replaces the displayed $299/$999 while `STRIPE_PAYMENT_LINK` is set.** REVENUE.md sets the launch price at $149, and showing $149 next to a $299 report would be contradictory. `TIERS` and `/checkout` are unchanged.
- **The JSON-LD Offer appears only while the Buy button does.** Structured data should match what the page sells; production with the link set has it on every public page.
- **Delivery is by hand, "usually within two business days".** That promise is on the landing, report and terms pages; change it in `src/pages.js` (`DELIVERY`) and `termsPage` if it doesn't suit.
- **The beacon's body is sent as `text/plain` in `no-cors` mode.** The body is still JSON. A "simple" request can't be dropped by a CORS preflight, and the page never reads the answer. If RepoHQ's endpoint insists on `Content-Type: application/json`, change `send()` in `src/beacon.js`.
- **The production gate is on the server** (`VERCEL_ENV`), not a `NEXT_PUBLIC_*` variable: there is no client bundle. `trapyard serve` uses the same rule.
- **Score cards count as public pages for tags and the beacon, but stay out of the sitemap.** They are unlisted per-run pages.

## How to check

```sh
npm ci && npm test                              # 272 pass, ~1–2 min, no network beyond 127.0.0.1
STRIPE_PAYMENT_LINK=https://example.com/pay npm run gauntlet   # open http://127.0.0.1:4317: the Buy button
npm run gauntlet                                # the same without the variable: no Buy button
CHROMIUM_PATH=/path/to/chromium npm run screenshots
```

After deploying, the following should all answer 200 on `https://trapyard.vercel.app`: `/robots.txt`, `/sitemap.xml`, `/og.png`, `/privacy` and `/terms`. Also:
- Paste `https://trapyard.vercel.app/` into Google's Rich Results Test (JSON-LD) and into a Slack or X post (share preview).
- `npm run smoke -- https://trapyard.vercel.app` still checks the core flow end to end.

## Left for David

1. **The payment link.** The `request` line in `.provision` asks you for a Stripe Payment Link: $149, one-time, for "trapyard full report + one retest".
   - Paste its URL into the Vercel project's env as **`STRIPE_PAYMENT_LINK`** (Production), then redeploy. The Buy button appears; nothing else needs setting.
   - In Stripe, consider a confirmation message such as "Your report arrives by email within two business days".
2. **Delivering a purchase.** Each payment shows `client_reference_id` (the run id) when it was bought from a run's report page. Otherwise the buyer replies to the receipt with their report link. Then, with `DATABASE_URL` in your shell, run `node bin/trapyard.js export <run id>` and email the `report.html` (or a PDF of it) and `report.json`. Do the same for their one retest.
3. **Delete the four old screenshots.** My sandbox couldn't delete files: `git rm docs/screenshots/checkout-*.png docs/screenshots/report-*.png`. README no longer shows them.
4. **Optional custom domain.** Add it in Vercel, then set `TRAPYARD_PUBLIC_URL=https://<domain>` so canonical URLs, the sitemap, share tags and run links all use it.
5. **Before taking real money:**
   - Vercel Hobby is for non-commercial use (BUILD.md, "Deploy"). Decide whether to move to a host that allows commercial use first.
   - Read `/terms` and `/privacy`.
   - Make sure the GitHub repo is public, or the "Contact: GitHub issues" link leads nowhere for visitors.
6. **Your own browser.** On the live site, run `localStorage.setItem('repohq:notrack', '1')` once in the console so your visits aren't counted.

## Self-review

Checked against gstack's pre-landing checklist ("Review Categories", "Fix-First Heuristic") by re-reading `git diff` and every new file.

- **Step 0 scope.**
  - The payment link reuses the existing pages, report renderer, store and `settle` logic. The only new modules are `src/site.js` and `src/beacon.js`.
  - More than 8 files are touched because the task spans SEO, legal pages, payments, analytics, screenshots and docs. Each change is small.
  - Search unavailable: I proceeded with in-distribution knowledge only.
- **CRITICAL: none open.** Two found while building and fixed:
  - [P1] (confidence: 9/10) `src/gauntlet.js`: the new fixed-route table was first a plain object, so a request path equal to a prototype key could have reached `Object.prototype`. It is now a `Map`.
  - [P2] (confidence: 9/10) `bin/trapyard.js`: the command lookup (older code) let `trapyard constructor` run `Object`. It now uses `Object.hasOwn`, and a test covers it.
- **Checked and clean:**
  - **XSS.** Every interpolated value goes through `esc()`. The payment link must be `https:`, so a `javascript:` link is refused. The run id added to it is 16 hex characters, checked by the route. In the JSON-LD every `<` is escaped.
  - **Enum completeness.** `LAUNCH_OFFER` is deliberately not in `TIERS`, so `/checkout` can't sell it. The extended `offer` flag has one consumer, `reportLockedPage`, which was read in full.
  - **No new SQL.**
  - **No shell or child-process changes** apart from the screenshot script. It spawns `node` with an argument array and a minimal env.
  - **Secrets.** No credential-shaped strings in the repo. The one login-in-a-URL test value is built at runtime.
- **INFORMATIONAL, left as is:**
  - The JSON-LD Offer also appears on score cards, which don't sell. It describes the product, not that run.
  - `/beacon.js` is served even when signals are off. It is harmless, since no page loads it then.
  - Score cards are reachable by crawlers if someone posts the link publicly, as before.
