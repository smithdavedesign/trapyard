# Verdict: pass — score 5/10

Real, technically clean idea, but the demand evidence is questionnaire text and vendor marketing, not a buyer who lost a deal, and the "why not promptfoo?" answer is unproven.

## Six forcing questions (pre-product routing: Q1–Q3 weigh most)

**Q1 Demand reality — 3/10.** Evidence is questionnaire templates and vendor blogs (tianpan.co, delve.co, IDC, mindstudio.ai). RESEARCH.md says outright that no first-person account of a startup losing a deal over this was found. Prices of $16K+ come from vendors selling those engagements (self-reported). Nobody has paid, asked when it ships, or panicked. Waitlist signups would be interest, not demand. Stronger evidence: a founder who forwards a real questionnaire and says "I'd pay $299 for this by Friday", or a pasted prospect email demanding injection test results.

**Q2 Status quo — 5/10.** The workaround is reassurance prose, a system-prompt guard, or a weekend with promptfoo/garak/PyRIT (free). The $16K+ tier is irrelevant to a 3–50 person startup. The status quo is cheap and "good enough" until an enterprise reviewer pushes back, and the research doesn't show how often that happens or whether a vendor-run self-test report satisfies the reviewer (one source says independent evaluation weighs more).

**Q3 Desperate specificity — 4/10.** The persona is a founder/CTO of a 3–50 person agent startup holding a deal behind a security review. That is a real role with a real consequence (a stalled deal), but no named person exists, and David has no connection to this group beyond general AI-tools interest. The buyer is also ambiguous: the startup being reviewed, or the enterprise reviewing.

**Q4 Narrowest wedge — 6/10.** The wedge is good: four trap classes, canary detection, a replayable report. M1 is weekend-sized and testable without a model. But the paid version ($299) implies trust, brand and a credible scenario corpus that a solo, unknown author doesn't have on day one. The narrowest demand test is the free gauntlet or a sample report, not the product.

**Q5 Observation (M1 users to watch).** Watch 5 agent builders point their own agent at the range unaided. Look at: where setup stalls (wiring a tool server into their agent is the likely cliff), whether they read the fix hints, whether they forward the report to a prospect or reviewer, and whether anyone asks "can you certify this?" (a liability signal).

**Q6 Future-fit — 6/10.** More agents with real tools means more injection exposure and more buyer demands for dated, per-model evidence. But the market is consolidating (promptfoo → OpenAI, Lakera → Check Point, and others), so labs and suites will likely bundle basic agent testing for free. Scenarios also decay and need constant refresh. Plausibly a durable niche, but the moat is thin.

## Premises
1. Agent startups hit security reviews that ask for injection-test evidence — supported by questionnaire content; no first-hand buyer stories.
2. Startups will pay $299–$999 rather than run promptfoo — unsupported.
3. A reviewer accepts a vendor-run self-test report — unsupported, partly contradicted.
4. Testing the real tool environment is meaningfully better than model-level probes — plausible and technically distinct, but the range only proves behavior on the range.
5. A solo, unknown author can be trusted with security claims — weak; needs a free public artifact to earn credibility.

## Alternatives
- **Minimal viable:** ship M1 as an open-source repo plus a sample report, and post to agent-builder and security communities. Cost: zero. Tests pull, not payment.
- **Ideal architecture:** hosted gauntlet with run URLs, a shareable score card, CI diffing and Stripe. Large, and it spends effort before any demand is shown.
- **Lateral:** contribute traps as a promptfoo plugin or an AgentDojo-style pack and use it for reputation. Cheaper, but no revenue path.
- **Extend David's repos:** no overlap. dawnlog (agent run receipts) is the nearest and could supply the log format, but it doesn't test agents.

## Narrowest wedge
One public page with a sample report for a vulnerable stub agent plus a 4-trap local range, framed as "what would a prospect's security team see about your agent". The test is whether builders request a run on their real agent.

## M1 feasibility
- One-weekend build: yes. Fastify/Node, two stub agents, a scorer and a static HTML/JSON report, all testable without a model.
- Zero cost: yes for the local range and a static page; no paid API is needed because the customer runs their own agent.
- The one test that proves M1: the vulnerable stub reports 4/4 `fell` and the hardened stub 0/4, with byte-identical report JSON on re-run.
- That proves the code works, not that anyone wants it.

## Risks
- Demand is inferred from questionnaires and has no buyer behavior behind it.
- OSS substitutes are free (promptfoo, garak, PyRIT), and OpenAI's pending acquisition of promptfoo may bundle agent testing.
- Vendor-run reports may carry little weight with reviewers.
- Liability when a clean report precedes an incident.
- Scenario staleness: the range decays without constant upkeep.
- A public gauntlet publishes attack techniques.
- Trust: an unknown solo author selling security assurance.

## Kill criteria
Drop it if, after contacting about 15 agent builders and security reviewers, fewer than 2 of 5 say a sample report would help a real review, or if no one pastes a real questionnaire or prospect request. Also drop it if fewer than 20 agents run through a free gauntlet in the first month, or if nobody pays $299 within 60 days.

## What would flip this to validate
A named founder with a deal blocked on this, or a security reviewer who says they'd accept this kind of report. Both are cheap to find with 10 direct conversations before writing code.
