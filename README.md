# lazy-qa

**Autonomous QA and security testing, powered by AI agents.**

Point lazy-qa at a web application and walk away. A swarm of AI agents will explore your app the way real humans do — clicking, filling forms, navigating flows, breaking things — and report back everything they find. No test scripts. No maintenance. No flaky selectors to babysit.

## The problem

Manual QA is slow, expensive, and inconsistent. Testers get tired, miss edge cases, and can only cover so much surface area in a sprint. Traditional automated testing (Selenium, Cypress, Playwright scripts) is faster but brittle — every UI change breaks something, and the tests only check what someone thought to write a test for. Neither approach scales well, and neither catches the unexpected.

Security testing is worse. Most teams either skip it entirely, run a scanner that produces a wall of false positives, or pay for an annual pen test that's outdated by the time the report lands. The gap between "we should test this" and "we actually tested this" is where bugs and vulnerabilities live.

## What lazy-qa does

lazy-qa replaces both of those workflows with a single command. It launches a coordinated team of AI agents — each with a distinct personality, focus area, and testing strategy — against your staging environment. The agents share a browser session, communicate findings to each other in real time, and systematically work through your application's attack surface and user experience.

**Security agents** probe for real vulnerabilities: SQL injection, cross-site scripting, broken access controls, authentication bypasses, data exposure, security misconfigurations, and more. They work in waves — reconnaissance first, then targeted exploitation — mimicking how an actual attacker would approach your application.

**QA agents** test what your users actually experience: Can the happy path complete without errors? Do forms validate properly? Does data persist after a reload? What happens when someone clicks the back button mid-checkout, submits a form twice, enters 50,000 characters into a name field, or navigates directly to a URL they shouldn't have access to?

Every agent runs independently but shares intelligence. When a recon agent discovers an exposed API endpoint, the injection specialist knows about it on their next turn. When a QA agent finds a form, the boundary-value tester and the empty-submission tester both learn where it is.

## How it works

1. **Crawl** — lazy-qa opens the target app, logs in with the credentials you provide, and maps the entire link graph automatically.

2. **Plan** — An AI planner reads the sitemap and generates a tailored brief for each agent, telling them which routes to focus on, what forms exist, and what looks interesting.

3. **Test** — Agents launch in managed slots (typically 2 security + 2 QA running at any time). Each agent gets its own browser tab on a shared authenticated session. When an agent exhausts its budget or stops finding new things, the next agent in the queue takes its slot. This continues until every agent has had its turn.

4. **Supervise** — A background supervisor watches all running agents. If one gets stuck, it nudges them. If the backend starts returning errors, it pauses the swarm to let it recover. If a session expires, it re-authenticates automatically.

5. **Report** — After all agents finish, a critic AI reviews every finding, deduplicates, classifies severity, and clusters by theme. A separate verifier re-opens the app and checks whether each reported bug is still reproducible.

## The agents

lazy-qa ships with 24 agents — 10 security specialists and 14 QA testers. Each has a focused mandate and a memorable name.

### Security

| Agent | Focus |
|---|---|
| **bobby-tables** | Insider attacker — IDOR, privilege escalation, JWT abuse, cross-user access |
| **johnny-five** | Reconnaissance — path discovery, exposed files, API surface mapping |
| **clippy** | Tech stack fingerprinting, security header analysis |
| **zero-cool** | Injection — SQL, NoSQL, command, SSRF, path traversal, template |
| **dilbert** | Security misconfiguration — default creds, rate limiting, CAPTCHA bypass, open redirects |
| **sudo** | Authentication bypass — JWT manipulation, password reset abuse, 2FA bypass |
| **mystique** | Broken access control — IDOR on every endpoint, horizontal/vertical privilege escalation |
| **rickroll** | Cross-site scripting — stored, reflected, DOM-based, framework-specific |
| **trust-me-bro** | Request forgery — CSRF, mass assignment, price/quantity manipulation, file upload abuse |
| **mitnick** | Data exfiltration — uses earlier agents' findings to systematically extract sensitive data |

### QA

| Agent | Focus |
|---|---|
| **karen** | Happy path — walks every core user journey end-to-end with valid data |
| **konami** | Hidden UI discovery — tooltips, accordions, kebab menus, collapsed panels |
| **copy-pasta** | Double-submit and idempotency testing |
| **all-your-base** | Boundary values — min/max, extreme lengths, wrong sizes |
| **mulder** | Save persistence — does the data actually survive a reload? |
| **leeroy-jenkins** | Interruption — refresh mid-save, back button abuse, abandon and return |
| **longcat** | Layout stress — long strings, emoji, unicode, rendering edge cases |
| **press-f** | Stale state — deleted records, invalid IDs, ghost data |
| **pac-man** | Volume — duplicates, optional fields, pagination, bulk operations |
| **there-is-no-spoon** | Empty form submission — what happens when you submit nothing? |
| **sheldon** | Accessibility — ARIA compliance, keyboard navigation, screen reader compatibility |
| **wreck-it-ralph** | Wrong-type input — postcodes in name fields, text in number fields, error message quality |
| **marty-mcfly** | Workflow sequence breaking — skip steps, go backwards, jump to the end |
| **bonzi-buddy** | Routing and error handling — bad URLs, manipulated paths, 404 page quality |

## What it finds that humans miss

**Volume and consistency.** 24 agents running systematically will cover more surface area in 20 minutes than a QA team covers in a day. Every form gets boundary-tested. Every API endpoint with an ID gets IDOR-probed. Every text field gets XSS payloads. No human tester maintains that level of discipline across an entire application.

**The boring stuff.** Does the data actually persist after save? Does the error page handle a malformed URL gracefully? Are the security headers set correctly on every endpoint? These are the checks that get skipped when the sprint is short and the backlog is long.

**Cross-cutting patterns.** Because agents share findings in real time, lazy-qa can chain discoveries. A recon agent finds a backup file. An injection specialist uses the database schema it reveals. An exfiltration agent uses the confirmed injection point to dump the user table. That chain — discovery to exploitation to data extraction — is exactly how real breaches happen, and it's nearly impossible to test with isolated scripts.

**The unexpected.** Scripted tests verify what you expect to work. Agents find what you didn't expect to break. A form that accepts negative quantities. A JWT that contains the user's password hash. An admin panel accessible without authentication. A delete button that crashes the page instead of showing a confirmation.

## Current status

lazy-qa is under active development. The agent swarm, orchestration, crawling, and real-time intelligence sharing are working. Reporting and output formatting are still being refined — the system produces raw findings and a critic review, but the final user-facing report format is TBD.

## Quick start

```bash
cp .env.example .env          # add your ANTHROPIC_API_KEY and target credentials
bun install
bun run scan config/example.yaml
```

Requires [Bun](https://bun.sh) 1.x.

## Safety

lazy-qa is designed for staging and test environments only. Built-in safeguards prevent it from running against production:

- Target hostnames must match non-production patterns (`localhost`, `staging.*`, `dev.*`, `qa.*`, `test.*`, `preview.*`)
- A network allowlist restricts all browser traffic to explicitly approved hosts
- Credentials never enter the AI model's context — the orchestrator handles login before agents start
- Logout actions are blocked at the tool level — agents cannot accidentally end their session

## Licence

TBD
