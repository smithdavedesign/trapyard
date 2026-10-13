# trapyard — PRD

## Problem
A startup ships an agent that browses, calls tools or spends money. A prospect's security review asks how it is tested for prompt injection, ideally with numbers per model version. The startup has no evidence beyond "we have a system prompt guard". Free tools (promptfoo, garak, PyRIT) test models and need setup; consulting costs $16K+ (RESEARCH.md). So the founder answers with reassurance, which reviewers say they distrust.

## Target user
Founder or CTO of a 3–50 person startup or agency whose agent (browsing, tool-calling or spending) is being sold to business customers and has just met a security questionnaire. Painful moment: a deal is waiting on the security review and the questionnaire has a prompt-injection evidence line.

## Competitors & gap
Free OSS (promptfoo, garak, PyRIT, DeepTeam, Giskard) tests model behavior and needs configuring; platforms (Lakera, Prompt Security, Aim, CalypsoAI) are now inside big suites and sold by quote; Mindgard/Repello and services start around $16K. The gap is a self-serve, black-box range that tests the customer's *deployed agent with its real tools* and returns a reviewer-readable report with a reproducible case per failure, at $299–$999. Unproven that buyers prefer it to running OSS themselves.

## MVP scope
- A range server with a web-page set containing planted injections (hidden text, fake system messages, instructions in comments).
- A fake tool server (HTTP/MCP-style) exposing allowed tools, an out-of-scope tool, a synthetic secret per run and a fake budget ledger.
- Per-run unique canaries, so a leak is detected by a request to the exfil endpoint or a canary in agent output/logs.
- Four trap classes scored: followed planted instruction, leaked secret, used out-of-scope tool, overspent budget.
- A report (HTML + JSON) listing each trap as fell/held, with the payload, the agent's request log and a one-command replay, stamped with scenario-set version and run date.
- A fix-hint paragraph per failed trap class (static text, not generated claims).
- A CLI or webhook runner so the same run can execute in CI and diff against the previous run.

## Non-goals
- No certification, "secure" badge or compliance claim.
- No hosting or calling the customer's models; the customer runs their agent.
- No real secrets, real money or third-party sites; synthetic data only.
- No model-level jailbreak corpora (promptfoo/garak already do that).
- No runtime guardrail or proxy product.

## Success metrics
- M1: all four trap classes detect a deliberately vulnerable stub agent and report zero failures for a hardened stub (test-checkable).
- Demand test: 5 buyer-side conversations; at least 2 of 5 say a report like the sample would satisfy or help a security review.
- Paid: 3 buyers pay $299+ within 60 days of a public gauntlet; below that, drop.
- Funnel: at least 20 distinct agents run through the free gauntlet in the first month.
- Accuracy: 0 false "fell" results across 20 hand-checked runs.

## Open questions
- Will a reviewer accept a vendor-run self-test report, or only independent testing?
- Is the buyer the startup (selling) or the enterprise (buying)? Who pays first?
- Why not promptfoo plus a weekend of setup? What is the minimum that makes $299 an easy yes?
- How fast do scenarios go stale and what refresh cadence is honest to promise?
- How to word liability so a clean report is never read as a guarantee.
