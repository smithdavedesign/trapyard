# trapyard — self-serve test range that tries to trick your AI agent

## Live

**https://trapyard.1426davejobs.workers.dev**

The hosted gauntlet runs on a Cloudflare Worker (free plan) since 2026-11-08; the Vercel account is blocked and `trapyard.vercel.app` answers 402. Screenshots taken against the live Worker by Playwright in Chrome for Testing; `npm run smoke -- https://trapyard.1426davejobs.workers.dev` passes (both stub agents, cards, share image, report locked until paid).

| | Desktop (1440×900) | Phone (390×844) |
|---|---|---|
| The landing page: what trapyard does, and "Start a free run" (no Buy button: no payment link is stored) | <img src="docs/screenshots/live-home-desktop.png" alt="The landing page: what trapyard does, and 'Start a free run' (no Buy button: no payment link is stored), desktop" width="520"> | <img src="docs/screenshots/live-home-phone.png" alt="The landing page: what trapyard does, and 'Start a free run' (no Buy button: no payment link is stored), phone" width="200"> |
| The core action: a run started (saved in Neon through the Worker), with the agent's task URL and the score card and report links | <img src="docs/screenshots/live-run-desktop.png" alt="The core action: a run started (saved in Neon through the Worker), with the agent's task URL and the score card and report links, desktop" width="520"> | <img src="docs/screenshots/live-run-phone.png" alt="The core action: a run started (saved in Neon through the Worker), with the agent's task URL and the score card and report links, phone" width="200"> |
| The result: the repo's deliberately vulnerable stub agent did that run's task, and its score card shows 4 of 4 traps fell | <img src="docs/screenshots/live-card-desktop.png" alt="The result: the repo's deliberately vulnerable stub agent did that run's task, and its score card shows 4 of 4 traps fell, desktop" width="520"> | <img src="docs/screenshots/live-card-phone.png" alt="The result: the repo's deliberately vulnerable stub agent did that run's task, and its score card shows 4 of 4 traps fell, phone" width="200"> |
| The privacy page: what a run stores, the three anonymous beacon events, and Cloudflare as the host | <img src="docs/screenshots/live-privacy-desktop.png" alt="The privacy page: what a run stores, the three anonymous beacon events, and Cloudflare as the host, desktop" width="520"> | <img src="docs/screenshots/live-privacy-phone.png" alt="The privacy page: what a run stores, the three anonymous beacon events, and Cloudflare as the host, phone" width="200"> |

## Screenshots

![The landing page on a desktop browser: "Start a free run" and "Buy the full report · $149"](docs/screenshots/home-desktop.png)
The start page as launched: the free run and the Buy button, which shows only when `STRIPE_PAYMENT_LINK` is set (a placeholder link in this run).

![The landing page on a phone](docs/screenshots/home-mobile.png)
The same start page on an iPhone 13 viewport, with both buttons above the fold.

![The run-started page on a desktop browser: the agent's task URL, the score card and report links, the footer](docs/screenshots/run-desktop.png)
The core action: pressing "Start a free run" gives the agent's task URL plus the score card and full report links. The footer links Privacy, Terms and the GitHub issues.

![The run-started page on a phone, scrolled to the footer](docs/screenshots/run-mobile.png)
The same page on a phone, scrolled to the links and footer: the $149 offer and the Privacy / Terms / Contact links.

![A finished score card on a desktop browser: 4 of 4 traps fell, with its share image](docs/screenshots/card-desktop.png)
The result: a deliberately vulnerable stub agent (sample data only) did that run's task, and its score card shows 4 of 4 traps fell, with the 1200×630 share image.

![The same score card on a phone](docs/screenshots/card-mobile.png)
The same score card on a phone.

For startups shipping agents that browse, call tools or spend money, it is a test range of planted traps and fake secrets that returns a reproducible, reviewer-readable report of what their agent fell for, for $149 (launch price, per [REVENUE.md](REVENUE.md)) instead of a $16K+ red-team engagement.

- [Research](RESEARCH.md) — findings and sources
- [PRD](PRD.md)
- [Roadmap](ROADMAP.md)
- [Launch readiness](LAUNCH-READY.md) — SEO, privacy/terms, the Buy button, the visit beacon, and what is left for David

## Quick start (M4: local range, replay, diff, CI mode, hosted gauntlet with score cards and paid reports)

```sh
npm install           # needs Node ≥ 22; pg for the hosted gauntlet, PGlite and playwright-core for tests/screenshots
npm test
npm run demo          # a deliberately vulnerable stub agent → 4/4 traps fell, HTML + JSON report
node bin/trapyard.js run --agent "<command that starts your agent>"
node bin/trapyard.js replay trapyard-runs/<run id> --trap leak --agent "<command>"   # one failed trap, alone
node bin/trapyard.js diff trapyard-runs/<old run id> trapyard-runs/<new run id>      # what changed, what newly fails
node bin/trapyard.js ci --agent "<command>" [--baseline trapyard-runs/<run id>]     # exit 1 if a trap newly falls

npm run gauntlet      # the hosted gauntlet on http://127.0.0.1:4317: start a run, get a shareable score card
npm run screenshots   # regenerate docs/screenshots (needs CHROMIUM_PATH; not part of npm test)
node bin/trapyard.js export <run id>   # the seller: write a hosted run's full report from DATABASE_URL, to send a buyer
```

Your agent receives `TRAPYARD_TASK_URL`. It must fetch that URL and do the task. On the gauntlet, `POST /api/runs` (or the "Start a free run" button) gives you that task URL, a score card link to share, and a private full-report link: 402 until paid through Stripe Checkout, then the full report, printable to PDF. See [BUILD.md](BUILD.md) for how it works, how to deploy it for free, what is tested and what is left.

Effort: Medium · Confidence: Low

_Researched by the idea pipeline on 2026-10-13 ([original record](https://github.com/smithdavedesign/idea-factory/tree/main/ideas/trapyard)); repo created on David's go-ahead 2026-10-13._

## Hosting on Cloudflare Workers

Since 2026-11-08 the hosted gauntlet is the `trapyard` Worker on Cloudflare (free plan, commercial use allowed).
[`src/worker.js`](src/worker.js) serves the same node:http handler as the Vercel function through the Workers runtime's
`node:http` server support (`nodejs_compat`), and `pg` reaches Neon over the Workers socket API. A Worker can't reuse a
socket another request opened, so `workerHandler` (in `src/gauntlet.js`) opens a `pg` pool per request and closes it
when the response is done; pages that don't touch the store never connect. The tables are migrated once per isolate.

```bash
provision cloudflare deploy trapyard "$PWD"            # no build step: wrangler bundles src/worker.js (~71 KiB gzipped)
provision cloudflare secret trapyard DATABASE_URL      # the Neon database, pushed from the keychain
npm run smoke -- https://trapyard.1426davejobs.workers.dev   # the core flow end to end, against the live Worker
```

[`wrangler.jsonc`](wrangler.jsonc) sets `TRAPYARD_PUBLIC_URL` (the Worker's address; change it for a custom domain) and
`NEXT_PUBLIC_DEPLOY_ENV=production`, which turns the visit beacon on (`deployEnv`: it wins over Vercel's `VERCEL_ENV`).
It also turns esbuild's `keep_names` off, because `/beacon.js` is `beacon.toString()`. Payments are read at request
time: `STRIPE_PAYMENT_LINK` (the Buy button; `provision stripe trapyard … --host cloudflare`) and `STRIPE_SECRET_KEY`
(Checkout for the full report; `provision cloudflare secret trapyard STRIPE_SECRET_KEY`). Neither is stored yet, so the
Buy button is hidden and checkout answers 503. `api/index.js` and `vercel.json` still work on Vercel.
