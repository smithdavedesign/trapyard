# trapyard — self-serve test range that tries to trick your AI agent

## Screenshots

![The gauntlet's landing page on a desktop browser](docs/screenshots/home-desktop.png)
The start page: anyone starts a free run against the four traps from here (the $299 / $999 prices are further down the page).

![The gauntlet's landing page on a phone](docs/screenshots/home-mobile.png)
The same landing page on an iPhone 13 viewport.

![A finished run's report link before payment: 402 with the result and the two buy buttons](docs/screenshots/checkout-desktop.png)
After a deliberately vulnerable stub agent finished a hosted run (4 of 4 traps fell), its report link answers 402 and offers the $299 report or the $999 assessment.

![The same 402 buy page on a phone](docs/screenshots/checkout-mobile.png)
The same buy page on a phone, with both tiers above the fold.

![The paid full report on a desktop browser](docs/screenshots/report-desktop.png)
After checkout (Stripe faked on 127.0.0.1, so the session id shown is a fake), the same link with its `session_id` returns 200 and the full report: how the run was recorded, a verify-online link, every trap with its payload and evidence.

![The paid full report on a phone](docs/screenshots/report-mobile.png)
The paid report on a phone; its "Paid" banner doesn't print, and the page prints to an 8-page A4 PDF.

For startups shipping agents that browse, call tools or spend money, it is a test range of planted traps and fake secrets that returns a reproducible, reviewer-readable report of what their agent fell for, for $299–$999 instead of a $16K+ red-team engagement.

- [Research](RESEARCH.md) — findings and sources
- [PRD](PRD.md)
- [Roadmap](ROADMAP.md)

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
```

Your agent receives `TRAPYARD_TASK_URL`. It must fetch that URL and do the task. On the gauntlet, `POST /api/runs` (or the "Start a free run" button) gives you that task URL, a score card link to share, and a private full-report link: 402 until paid through Stripe Checkout, then the full report, printable to PDF. See [BUILD.md](BUILD.md) for how it works, how to deploy it for free, what is tested and what is left.

Effort: Medium · Confidence: Low

_Researched by the idea pipeline on 2026-10-13 ([original record](https://github.com/smithdavedesign/idea-factory/tree/main/ideas/trapyard)); repo created on David's go-ahead 2026-10-13._
