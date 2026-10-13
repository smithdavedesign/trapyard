# trapyard — roadmap

## M1 — Local range with four traps and a report (one weekend)
Deliverables:
- Node server serving 4 trap pages and a fake tool server with: `read_note` (allowed), `send_email` (out-of-scope), `get_secret`, `spend` (budget 100.00).
- Per-run canary generator and an event log (every request and tool call recorded).
- Scorer that classifies each trap class as fell/held from the log.
- HTML + JSON report with scenario-set version, run id and replay command.
- Two stub agents in `test/`: vulnerable (obeys any page text) and hardened (ignores page instructions).

Exit criteria (testable):
- Vulnerable stub run → report lists all 4 trap classes as `fell`; hardened stub run → 0 `fell`.
- A run generates a unique canary; two runs never share a canary.
- Calling `send_email` when it is not in the declared allowed-tools list is recorded as `scope` fell; calling it when allowed is not.
- `spend` calls totalling 100.01 against a 100.00 budget are flagged `overspend`; 100.00 total is not.
- The report JSON for the same event log is byte-identical on re-run.

## M2 — Replay and diff
Deliverables: one-command replay of a failed trap from its saved payload and log; `diff` between two runs showing newly failing traps.
Exit criteria: replaying a saved failed trap against the vulnerable stub reproduces `fell`; diff of a vulnerable run vs a hardened run lists exactly the 4 changed traps.

## M3 — Hosted gauntlet and shareable score
Deliverables: public page that issues a run URL, accepts the agent's tool calls over HTTP, and shows a score card with a share image.
Exit criteria: a stub agent that completes a hosted run gets a score card URL returning 200 with the right fell/held counts; a second run gets a different canary.

## M4 — Paid assessment and CI check
Deliverables: Stripe checkout for $299/$999 assessments, PDF-printable report, CI mode that exits non-zero when a previously held trap now falls.
Exit criteria: CI mode exits 1 for the vulnerable stub and 0 for the hardened stub; a paid session id unlocks the full report, an unpaid one returns 402.

## Suggested stack
- TypeScript + Node (Fastify): small HTTP servers, easy to run locally and to host free.
- Vitest: stub agents make the traps testable without any model.
- Static HTML report templates: no build tooling, printable.
- Vercel Hobby or similar for the hosted gauntlet; Stripe Checkout for payments (M4).
