# trapyard — shortest honest path to a first dollar

**Bottom line:** the evidence that anyone will pay is weak (review 5/10, demand 3/10). The product is built (M1–M4 merged, live at https://trapyard.vercel.app), so the cheapest next move is not more building. It is ten conversations plus a low-priced paid report. Price: **$149 once per agent** (a report and one retest), moving to the PRD's $299 only if people pay $149 without arguing.

Confidence: **low**. Nothing here comes from a buyer. The evidence is questionnaire templates, vendor blogs and my own price searches.

## Who pays
A founder or CTO of a 3–50 person startup or agency whose agent browses, calls tools or spends money, and who sells it to business customers. The trigger is a prospect's security questionnaire with a prompt-injection evidence line while a deal waits. It is their budget (company card, no procurement at this size).

Not named yet. "Founder of an agent startup" is a filter, not a person. The first task is to find three real ones (see First ten).

## What they pay today
- **Nothing:** reassurance prose and a system-prompt guard. This is the main competitor.
- **Free:** promptfoo, garak and PyRIT, plus a weekend of setup. They test the model. They don't plant secrets in the agent's own tool environment.
- **Freelancers:** I found a Contra listing for prompt-injection hardening of an agent, from $300. It covers up to 25 attempts, a written report and a retest. This is the nearest real price anchor, and it matches the $149–$299 range.
- **Platforms:** Lakera lists a Pro plan at $99/month (one third-party page, verified April 2026; includes runtime guard requests, so it's not like-for-like). Mindgard, Repello and similar vendors quote custom pricing, with engagements from about $16K by the vendors' own account.
- **Adjacent:** AgentOps Pro starts at $40/month. It's observability, not a test range.

The $299–$999 in the PRD has no direct competitor, and also no proof that the gap is a market. $149 is below the freelancer anchor, so a first buyer is not asked to trust an unknown author with a lot of money.

## Narrowest version worth paying for
One agent, one run against the four trap classes (planted instruction, leaked secret, out-of-scope tool, overspend), and an HTML/JSON report with a replay command per failure, dated and versioned, plus one retest after fixes. The report is framed as "evidence for your security reviewer", never as certification.

CI diffing and the monthly tier (about $49–$99) come later, only after someone asks for them.

Free hook: the sample report and a free run of the hosted gauntlet. The free tier gets the fell/held counts. The paid report adds payloads, request logs and replay. (That matches the M4 design: an unpaid session returns 402 for the full report.)

## What has to be true before charging
1. Stripe Checkout payment link ($149), with David creating the product and mapping it in RepoHQ. Agents hold no card.
2. Privacy policy and terms pages. Both are missing now. The terms must say plainly: tests listed traps only, behavior on the range only, no guarantee, no certification.
3. Launch basics: meta description, og:image, robots.txt, sitemap.xml (4/9 launch checks pass today).
4. Someone other than David has run the gauntlet end to end on a real agent. The review flagged wiring a tool server into an agent as the likely cliff. A paid-run delivery path must exist: the buyer pays, gets the unlocked report, and David can refund by hand.
5. A hand check of the first paid report for false "fell" results (the PRD target is 0 in 20).

## Plan, in order
1. **Days 1–2 (agent work):** privacy/terms, SEO basics, a clear sample report on the home page, a "request a run" button.
2. **Days 1–7 (David):** 10 direct conversations before any launch post. Ask for a real questionnaire or prospect email. Offer one free run on their real agent in exchange for 20 minutes watching. This tests the two unsupported premises: that a reviewer accepts a vendor-run report, and that a founder prefers this to promptfoo.
3. **Week 2:** the people from those conversations who say the report would help get the $149 link. Ask for payment before delivering the second run.
4. **Week 3–4:** post the free gauntlet publicly (channels below). Count agents run.

## First ten
From a first pass at named places (I haven't verified who is active):
- Replies and DMs to people who post on Hacker News "Show HN" or "Ask HN" threads about agent security, or about shipping agents to enterprises, in the last 60 days.
- r/LocalLLaMA, r/AI_Agents and r/LLMDevs threads on prompt injection: reply with the free gauntlet, not a pitch.
- The MCP and agent-framework Discords/GitHub discussions (LangChain, CrewAI, the MCP servers repo). Anyone asking "how do I test my agent for injection" is the target.
- Indie Hackers and X/LinkedIn posts by founders saying they're "going through SOC 2 / a security review" with an agent product.
- David's own network: any founder he knows who ships an agent product.

## Channels
See revenue.json. All free.

## Risks
- **Interest is not demand.** Free gauntlet runs might never convert. Kill criteria below are set for that.
- **"Why not promptfoo?"** Unanswered. OpenAI is acquiring promptfoo, which may bundle agent testing for free.
- **A reviewer may ignore a vendor-run self-test report.** One source says independent testing weighs more. Ask this in every conversation.
- **Liability:** a clean report followed by an incident. Terms and report wording must prevent any reading of "secure".
- **Trust:** an unknown solo author selling security assurance. The open sample report and an open method help.
- **Stale scenarios:** the range decays. Put a version and date on every report, and promise nothing about refresh until it's real.
- **The public gauntlet publishes attack techniques.** Keep public traps to well-known classes.

## Stop if
- After about 15 contacts, fewer than 2 of 5 who see the sample say it would help a real review, and nobody shares a real questionnaire or prospect request.
- Fewer than 20 distinct agents run through the free gauntlet in the first 30 days after the public post.
- Nobody pays $149–$299 within 60 days of the public post.

If any of these hits, park it. The code is built, so stopping costs only David's time.

## Assignment
David: send 10 direct messages this week asking for a real security questionnaire or a 20-minute watched run. Do not launch publicly before at least three replies.

Sources: [Contra hardening listing](https://contra.com/s/E6ZlobA7-prompt-injection-hardening-for-your-ai-agent), [Lakera pricing (third party)](https://costbench.com/software/ai-evaluation/lakera/), [Mindgard pricing](https://ethicalhacking.ai/pricing/mindgard-ai-security-pricing), [Repello vendor pricing](https://repello.ai/blog/ai-red-teaming-vendor-pricing), [AgentOps](https://agentops.ai/?=crew), plus the sources in RESEARCH.md.
