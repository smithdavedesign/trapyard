# trapyard — research

## Summary
- Startups shipping AI agents (browse, call tools, spend money) increasingly get asked by enterprise buyers for *measured* prompt-injection evidence; the free tools test models, not a deployed agent in its own environment.
- Wedge: a black-box test range the customer points their own agent at (web pages + a tool server with planted canary secrets and budgets); the report lists which traps it fell for, with a reproducible case for each, and re-runs in CI.
- Crowded at the platform end (nearly every funded vendor has been acquired), thin at the $299–$999 self-serve end. Confidence is Low: demand for *this* wedge at *this* price is unproven.

## Evidence of the problem
- Enterprise AI security questionnaires now ask for quantified evidence: "What's your quantified injection-resistance rate, by model version, against a published corpus?" A qualifying answer names a benchmark (e.g. OWASP LLM01), a model release and a date; buyers want dated numbers because vendors regress between releases. https://tianpan.co/blog/2026/04/27/80-question-wall-enterprise-ai-security-questionnaire
- IDC: the review process "collects reassurance" and rarely evidence; enterprises look for automated evidence and audit trails. https://www.idc.com/resource-center/blog/idc-quanta-five-questions-security/
- Vendor questionnaire templates cover direct and indirect injection, treating retrieved content and plugin output as untrusted, tool calls logged per user/tenant, sandboxing and rollback. https://delve.co/blog/what-security-questionnaires-should-ask-ai-vendors
- Prompt injection needs three things to hurt: private data, untrusted content reaching the model, and a way to send data out. Filters reduce risk but "cannot prove downstream controls hold", so buyers want reproducible test results and logs. https://mindstudio.ai/blog/how-to-audit-enterprise-ai-vendor-agentic-security-2-questions-before-you-sign
- Agent benchmarks show the test shape: AgentDojo has 97 tasks / 629 security cases where tools return malicious data and an attack succeeds when the attacker-specified tool is called. It is a research harness you run yourself, not a service. https://arxiv.org/html/2406.13352v3
- No first-person account of a startup losing a deal over this was found (searched). The demand evidence is questionnaire content and vendor marketing, not buyer complaints.

## Who pays
- **Buyer:** founder/CTO or head of engineering at a 3–50 person startup or agency that ships an agent (browsing, tool calls, spending) to business customers, when a prospect's security review asks for injection-testing evidence.
- **Price points to test:** $299 (one agent, one run, report) to $999 (multi-tool agent plus retest after fixes); then ~$49–$99/month for a CI re-run on prompt/tool/model change.
- **Evidence they pay for something like it today:**
  - Per-engagement AI red teaming starts around $16K, with full engagements $10K–$100K, per a vendor that sells platforms (self-reported). https://repello.ai/blog/ai-red-teaming-vendor-pricing
  - The same source says a single text-only chatbot audit is $20K–$40K, and that freemium entry tiers near $20/month exist.
  - A vendor guide puts point-in-time engagements at AU$15,000–80,000 and continuous platforms at AU$3,000–15,000/month (marketing estimate). https://aona.ai/blog/ai-red-teaming-cost-roi-enterprise-budget-2026/
  - So there is a large gap between free open-source scanners and $16K+ services; $299–$999 sits in that gap. Whether a startup would pay it rather than run promptfoo itself is the open question.

## Competitors & alternatives
| Name | Price | Gap |
|---|---|---|
| promptfoo (open source; OpenAI agreed to acquire it, Mar 2026) | Free OSS; enterprise unlisted | Model/app-level adversarial "plugins"; user must configure, run and interpret; future tied to OpenAI Frontier. https://www.promptfoo.dev/docs/red-team/ , https://www.securityweek.com/openai-to-acquire-ai-security-startup-promptfoo/ |
| garak, PyRIT, DeepTeam, Giskard | Free OSS | Model-level probes; no planted-secret environment for the agent's real tools. https://www.testmuai.com/blog/ai-red-teaming-tools/ |
| Lakera (bought by Check Point) | Enterprise quote | Runtime protection and red teaming sold to large buyers. https://www.csoonline.com/article/4058653/check-point-acquires-lakera-to-build-a-unified-ai-security-stack.html |
| Prompt Security (SentinelOne), Aim (Cato), CalypsoAI (F5) | Enterprise quote | Same: absorbed into big security suites. https://www.decryptiondigest.com/blog/ai-guardrail-vendors-after-acquisition-lakera-prompt-security-aim-calypsoai |
| Mindgard, Repello | Quote-based / $16K+ engagements | Aimed at enterprises, no small self-serve tier found. https://toolradar.com/tools/mindgard |
| F5 AI Red Team (AWS Marketplace) | Custom quote | Sales-led. https://aws.amazon.com/marketplace/pp/prodview-rgnmuwtd7jbb6 |
| AgentDojo / AgentDyn | Free research code | Benchmarks for agent frameworks you host; not a black-box service against a customer's deployed agent. https://arxiv.org/html/2406.13352v3 |

## Technical notes
- The range is two pieces: (1) a web server serving pages with planted instructions (hidden text, comments, "system" lookalikes, tool-result injection); (2) a tool server (HTTP / MCP-style) exposing fake tools with synthetic secrets, a fake budget and out-of-scope tools.
- Detection is by canary: each secret is unique per run (e.g. `CANARY-<run>-<n>`); a leak is any request to the range's "exfil" endpoint or any output containing the canary; overspend is a ledger the tool server keeps; scope abuse is a call to a tool the customer did not list as allowed.
- The customer's agent runs on the customer's models and keys, so range cost is hosting only; static pages plus a small Node server fit free tiers.
- Reproducible case per trap = the page/tool-result payload, the agent's recorded request log, and a one-command replay.
- Scenarios go stale: keep a versioned scenario set with dates, and stamp every report with scenario-set version and agent model/prompt hash (matches what buyers asked for: results per model version).
- Because the range only sees what the agent does *to the range*, it proves behavior on the range, not safety in production. The report must say so.

## Risks & open questions
- **Crowded and consolidating:** every funded platform has been bought by a big vendor; free OSS covers model-level testing. A self-serve niche may exist because acquirers moved up-market, or because there is no demand.
- **Unproven buyer behavior:** no first-hand story of a deal lost over this; the evidence is questionnaire text.
- **"Why not just run promptfoo?"** The answer must be: nothing to configure, tests the agent's real tool environment, and the output is a document a buyer's security team accepts. Unverified.
- **Liability:** a clean report followed by an incident. Needs plain scope language ("tests listed traps only; not a guarantee"), no certification claims.
- **Stale scenarios:** attacks evolve; a static range decays. Mitigate with dated versions and the CI plan.
- **Does an enterprise reviewer accept a vendor-run self-test report?** One source says independent evaluations carry more weight; this needs 5 buyer-side conversations.
- **Gauntlet as funnel:** a free public gauntlet risks becoming an attack-technique publication; keep public traps to well-known classes.

## Sources
- https://tianpan.co/blog/2026/04/27/80-question-wall-enterprise-ai-security-questionnaire
- https://www.idc.com/resource-center/blog/idc-quanta-five-questions-security/
- https://delve.co/blog/what-security-questionnaires-should-ask-ai-vendors
- https://mindstudio.ai/blog/how-to-audit-enterprise-ai-vendor-agentic-security-2-questions-before-you-sign
- https://arxiv.org/html/2406.13352v3
- https://repello.ai/blog/ai-red-teaming-vendor-pricing
- https://aona.ai/blog/ai-red-teaming-cost-roi-enterprise-budget-2026/
- https://www.promptfoo.dev/docs/red-team/
- https://www.securityweek.com/openai-to-acquire-ai-security-startup-promptfoo/
- https://www.csoonline.com/article/4058653/check-point-acquires-lakera-to-build-a-unified-ai-security-stack.html
- https://www.decryptiondigest.com/blog/ai-guardrail-vendors-after-acquisition-lakera-prompt-security-aim-calypsoai
- https://www.testmuai.com/blog/ai-red-teaming-tools/
- https://toolradar.com/tools/mindgard
- https://aws.amazon.com/marketplace/pp/prodview-rgnmuwtd7jbb6
