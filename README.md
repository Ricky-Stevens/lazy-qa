# regress-harness

An AI-driven regression-testing harness. It launches several LLM-controlled "users" in parallel against a target web app, lets them explore it as themselves (no scripted test cases), and produces a triaged report of bugs they ran into.

The pitch: instead of writing brittle E2E scripts that test what *you* thought to check, you point this at a staging deploy and five different personas — a power user, a chaos clicker, a confused newcomer, a methodical completionist, and an authenticated insider attacker — go and use the app for five minutes each. Anything that breaks, surprises, or fails them shows up as a finding. A separate critic LLM then re-reads every finding, flags duplicates and noise, and writes a markdown triage report.

## Quick start

```bash
cp .env.example .env
# edit .env: ANTHROPIC_API_KEY, REGRESS_TRUSTED_HOSTS, your portal creds
bun install
bun run scan config/example.yaml
```

**Runtime:** Bun 1.x (primary). Node 20+ also supported via `tsx`.

When the run finishes you'll have:

- `runs/<runId>/findings.json` — every finding the agents filed
- `runs/<runId>/review.md` — the critic's triage report (confirmed bugs / likely / duplicate / not-a-bug + themes)
- `runs/<runId>/journeys/*.meta.json` — per-agent metadata (turns, cost, termination reason)
- `runs/<runId>/summary.md` — quick run summary
- `runs/<runId>/sitemap.json` — pre-run crawler snapshot
- `runs/last` — symlink to the most recent run

Re-review a past run without re-running it:

```bash
bun run review runs/<runId>
```

## How it works

### 1. Pre-run crawler

Before any agent starts, the orchestrator opens a temporary authenticated tab and runs a BFS crawler (`src/crawler/crawl.ts`). It walks the link graph up to depth 2, capping at 60 routes and 30 seconds of wall-clock time. For each route it parses a `PageModel` — a structured summary of the page's forms, tables, modals, wizards, toolbars, and nav links — and stores it in the shared `SiteMap`. The crawler is read-only: it never clicks buttons, submits forms, or mutates application state.

The `SiteMap` (`src/crawler/sitemap.ts`) is the live mutable store agents share at runtime. As agents navigate and call playbooks, they record visits and outcomes back into the sitemap. The `navigate` tool also expands the sitemap on-demand when an agent reaches a route the pre-run crawler missed.

### 2. PageModel

Every snapshot call and every playbook invocation pulls the current page's `PageModel` from a short-lived cache (`src/page-model/parser.ts`). The parser runs a single `page.evaluate` round-trip that extracts all interactive structure in one pass — forms (fields, labels, submit targets), tables (columns, row count), modals, wizards, toolbars, nav links, and bare interactives. After each action the browser server speculatively kicks off a fresh parse in the background so the next `snapshot` call is instant.

### 3. Persona agents

Each agent gets its own tab on a single shared Chrome session. The orchestrator logs in once; subsequent agents acquire fresh tabs on the same authenticated context. Credentials are filled by the orchestrator before the LLM loop starts and never enter the model's prompt.

Each agent runs a direct Anthropic SDK loop (`src/orchestrator/loop.ts`): one continuous conversation with a 1-hour prompt-cache on the system prompt. History is managed with a sliding window — once the conversation exceeds the compaction threshold (14 messages), the head is replaced with a single synthetic summary derived from the per-agent `SummaryMemory` (which records one entry per playbook invocation), and the most recent 12 messages are kept verbatim. This keeps per-turn input cost bounded without losing "what have I tried" context.

The per-turn user message includes a sitemap snapshot listing unvisited routes, untested forms/tables/modals, and affordance hints (what's behind buttons and kebabs that the link-graph crawler cannot see). Tool calls within a turn execute in parallel.

### 4. Browser MCP tools

The browser server (`src/tools/browser-server.ts`) exposes 13 primitive/macro tools:

| Tool | Purpose |
|---|---|
| `snapshot` | Structured PageModel snapshot (forms, tables, modals, wizards, toolbars, nav) |
| `navigate` | Go to a URL; refuses off-allowlist hosts; expands the sitemap |
| `back` | Browser back |
| `click` | Click an element by Playwright selector; logout controls refused |
| `type` | Type text into a field; optional append / Enter submit |
| `press_key` | Press a keyboard key (Tab, Enter, Escape, ArrowDown, F5) |
| `select_option` | Pick a `<select>` option by label or value |
| `console_errors` | Return buffered console errors and page errors since last call |
| `evaluate` | Run a read-only JS expression; result is redacted and truncated |
| `fill_form` | Fill multiple fields + optional submit in one round-trip |
| `find_and_click` | Find a button or link by visible text; tries multiple selector strategies; logout controls refused |
| `read_recent` | One-call sweep: PageModel + console errors + last 5 network anomalies |
| `storage_inspect` | Surface storage keys by kind (cookie / localStorage / sessionStorage); values are redacted by default |

Playbook tools (`mcp__playbooks__*`) are mounted dynamically from the playbook registry. The persona drives exploration; playbooks are deterministic shortcuts for the turns that are tedious to do step-by-step.

### 5. Harness MCP tools

The findings server (`src/tools/findings-server.ts`) exposes two tools:

- `report_finding` — file a finding (severity, category, steps to reproduce, confidence). Rate-limited to 8 per agent per 60 seconds to prevent cascade thrashing.
- `end_session` — hard-floor exit only: `auth_wall`, `site_unreachable`, `browser_dead`. Gated at the enum level; the agent cannot pass any other reason.

### 6. Supervisor

A sixth always-on supervisor agent (`src/orchestrator/supervisor.ts`) watches the explorer agents via the runtime registry and intervenes:

- **Auth-walled** — agent URL is on an Auth0 login/logout page → calls `relogin_session` (re-auths the shared context, reloads sibling tabs), then nudges the agent to reload the dashboard.
- **Backend storm** — two or more agents have ≥5 recent 4xx responses, or any single agent has ≥10 → calls `pause_agents` (agents sleep on their next action; default 60 s, hard ceiling 180 s), giving the backend time to recover.
- **No progress** — agent hasn't taken a browser action in over 60 seconds → `nudge_agent` with a specific suggestion referencing their current URL and recent tools.

The supervisor is best-effort: a crash never fails the run.

### 7. Post-run critic LLM

After all agents finish, the post-run reviewer (`src/findings/review.ts`) reads the persisted findings and journey metadata and asks a single batched LLM call to classify each finding: `confirmed_bug` / `likely_bug` / `duplicate` / `environmental` / `not_a_bug`. It also clusters findings by theme and suggests severity corrections. Output is `review.md` + `review.json`. Best-effort — a reviewer crash never fails the run; the raw findings are already on disk.

### 8. Output layout

```
runs/<runId>/
  findings.json           all deduplicated findings
  review.md               critic's triage report
  review.json             structured review data
  summary.md              quick per-agent summary table
  sitemap.json            pre-run crawler snapshot
  coverage.md             per-route + playbook coverage report
  manifest.json           run metadata
  journeys/
    <agentId>.meta.json   per-agent journey (turns, cost, token usage, findings)
  auth/
    <agentId>/
      storage-state.json  forensic session snapshot (chmod 0600)
```

## Personas

Profiles live in `src/profiles/` as markdown — pure persona psychology, no scripted steps.

| Profile | Style |
|---|---|
| `power-user` | Knows the app cold; runs real CRUD flows end-to-end, verifies persistence by reload-and-check |
| `chaos-clicker` | Fast, careless, double-clicks, hits browser-back mid-flow, abandons forms |
| `confused-newcomer` | Misreads labels, types the wrong things into fields, navigates away mid-form |
| `completionist` | Methodical; finishes every flow, round-trips every save, exhausts every wizard branch |
| `insider-attacker` | Authenticated grey-box probe — IDOR, RBAC, silent-failure hunt, reflected XSS, storage hygiene |

Add your own by dropping a `<slug>.md` into `src/profiles/` with a `name` + `defaultBudget` frontmatter and a `# Personality` section. Or override inline per-agent via `override_personality` in the YAML.

## Configuration

A run is one YAML file. See `config/example.yaml` for the full shape; the important sections:

```yaml
target:
  url: https://staging.example.com/
  allowed_hosts: [staging.example.com, your-tenant.auth0.com]
  auth:
    type: form
    username_selector: 'input[name="username"]'
    password_selector: 'input[name="password"]'
    submit_selector: 'button[type="submit"]'
    success_url_pattern: '^https://staging\.example\.com'

anthropic:
  api_key_env: ANTHROPIC_API_KEY
  default_model: claude-haiku-4-5-20251001

supervisor:
  enabled: true
  model: claude-sonnet-4-6

review:
  enabled: true
  model: claude-sonnet-4-6

run:
  max_budget_usd: 5
  output_dir: ./runs

agents:
  - id: power-user
    profile: power-user
    model: claude-haiku-4-5-20251001
    max_thinking_tokens: 1024     # 0 = no thinking; >=1024 enabled (API floor)
    credentials:
      username_env: PORTAL_USER
      password_env: PORTAL_PASS
    budget:
      max_minutes: 5
      max_turns: 250
      max_usd: 1.0
```

Per-agent knobs:

- `model` — overrides `anthropic.default_model`
- `max_thinking_tokens` — `0` (off, fastest) or `≥1024`. Useful at `1024` on Haiku for multi-step coherence; `2000+` on Sonnet for the security/completionist personas
- `planner_model` — optional smarter model for one-shot plan calls between chunks; the cheap executor model then follows the plan. Omit for single-model mode (faster per chunk, less directed)
- `override_personality` — inline string to bypass the profile file
- `budget` — per-agent caps (turns, USD, minutes)

## Auth modes

- **`type: form`** (default) — Playwright fills the form. Works for Auth0, generic SSO login pages, anything with username + password + submit. Set `success_url_pattern` or `wait_for_selector` if the post-submit heuristic doesn't fit.
- **`type: none`** with `storage_state_path` — supply your own pre-built `storageState.json` for MFA / passkey / non-form flows. Generate it once interactively with `bunx playwright codegen`, then reuse.
- **API key required** — set `ANTHROPIC_API_KEY` in your environment. The direct-API loop does not support subscription auth via the `claude` CLI. The supervisor and post-run reviewer also require the API key.

## Safety

- **Operator allowlist** — `REGRESS_TRUSTED_HOSTS` env var is required.
  Every host in the YAML's `target.allowed_hosts` must appear there.
  Stops a malicious YAML from steering credentials at attacker hosts.
- **Non-prod check** — target hostname must match `localhost` /
  `staging.` / `dev.` / `qa.` / `test.` / `preview.` prefixes, or be in
  `REGRESS_NONPROD_HOST_PATTERNS`.
- **Network allowlist enforced for the whole run** — Playwright `route()`
  blocks document/xhr/fetch requests to off-allowlist hosts both during
  the credential-fill phase and post-login. Subresources (CSS, fonts,
  images) are allowed off-host so legitimate CDN-backed staging portals
  work.
- **Per-action host check** — the `navigate` tool refuses URLs whose
  hostname is not in `target.allowed_hosts`, returning a status-line
  failure rather than allowing the route handler to silently abort.
- **Pre-login form credentials never enter the LLM context** — the
  orchestrator owns the Playwright login; the agent only sees an
  already-authenticated browser handle. Post-login content the
  application itself exposes (storage, console, headers visible to JS)
  *can* reach the model — use the `mcp__browser__storage_inspect` primitive (which
  surfaces storage keys by kind, never values) when probing storage. Raw
  `evaluate()` results, `read_recent`, `console_errors`, snapshot, and
  playbook evidence are all redacted (secret-shaped fields masked) and
  truncated to 8 KB before being handed to the LLM.
- **Credential env-var names are filtered** — must match
  `^[A-Z][A-Z0-9_]*$` and must NOT start with `ANTHROPIC_`, `AWS_`,
  `GH_`, `GITHUB_`, `AZURE_`, `GCP_`, etc.
- **Logout suppression** — `click` and `find_and_click` refuse to click
  anything matching logout heuristics (text, aria-label, href, testid).
- **Security playbooks are origin-scoped** — IDOR / role-escalation /
  sensitive-path probes refuse off-allowlist URLs, so an open-redirect
  cannot drift the attacker persona onto a third-party host.
- **Forensic storage state** is written to
  `runs/<runId>/auth/<agentId>/storage-state.json` at `chmod 0600` for
  post-mortem only — not used for handoff.

## Project structure

- `src/config/` — YAML schema + loader (Zod)
- `src/auth/` — Pre-agent login, shared multi-tab session pool, recovery
- `src/crawler/` — BFS pre-run crawler, on-demand route expansion, SiteMap
- `src/page-model/` — Single round-trip DOM parser (PageModel), serializer for agent prompts
- `src/playbooks/` — 9 surviving playbooks: 3 discovery (`ask_sitemap`, `route_404_probe`, `discover_route_affordances`), 3 utility (`fill_and_verify`, `walk_pagination`, `walk_wizard`), 3 security (`idor_probe`, `header_audit`, `sensitive_path_audit`). The persona drives flow; playbooks are deterministic shortcuts for the bits that are tedious turn-by-turn.
- `src/plugins/` — Auth provider plugins (`form`, `none`), link extractors, logout guard
- `src/profiles/` — Persona markdown files (5 built-in)
- `src/tools/` — In-process MCP servers (`browser-server.ts`, `findings-server.ts`)
- `src/orchestrator/` — `run.ts`, `spawn-agent.ts`, `loop.ts`, `supervisor.ts`, `registry.ts`, cost compute
- `src/findings/` — `review.ts` (critic LLM), `report.ts` (markdown writer), `persist.ts`, `coverage.ts`
- `src/safety/` — Allowlist checks, non-prod gate, credential-name validation
- `src/logging/` — Structured JSON logger with `redactForLlm` (secret masking + 8 KB truncation)
- `bin/` — `regress.ts` (scan), `regress-review.ts` (re-review)

## Commands

```bash
bun run scan <config.yaml>      # full run: crawler + explorers + supervisor + post-run review
bun run review <runDir>         # re-review a past run with a fresh critic pass
bun run typecheck               # TypeScript check
bun run lint                    # Biome check
bun run lint:fix                # Biome format + safe-fix
bun run test                    # Vitest
```

## Roadmap (active April 2026)

regress-harness is pre-launch. The strategic review at
`docs/superpowers/specs/2026-04-26-regress-harness-strategic-review.md`
captures the v3 direction:

- **Phase 2 (done):** simplified the playbook framework from 31 scripted
  flows to 9 focused playbooks. Persona-first system prompt — primitives
  are the default action vocabulary; playbooks are deterministic shortcuts
  when they fit exactly. Supervisor trimmed to 3 intervention modes;
  `storage_inspect` primitive replaces the deleted playbook.
- **Phase 3:** prompt caching, model routing (Haiku for action / Sonnet
  for planning + critic), Anthropic Memory tool for cross-run learning,
  Agent Skills as the format for personas + playbooks.
- **Phase 4:** critic LLM with browser access (re-runs suspect findings
  to confirm), event-sourced replay.
- **Phase 5:** end-to-end validation against OWASP Juice Shop.

## Tuning notes

- **Speed / cost** — use Haiku 4.5 with `max_thinking_tokens: 0` for cheapest exploration. Add the supervisor on top for unblocking; it costs ~$0.15/run regardless of how many explorers you run.
- **Coverage** — more parallel agents = more breadth, not more depth. Personas diverge naturally (the same persona twice will explore differently each run).
- **Coherence** — if Haiku is "scatterbrained" and clicking randomly, raise its `max_thinking_tokens` to `1024`. If Sonnet is over-thinking, lower it.
- **Findings throttle** — 8 findings per agent per 60s. Past that the harness drops them silently (the reviewer dedupes anyway, so cascade-thrashing was costing tokens for nothing).
