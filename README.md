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

Each agent runs a direct Anthropic SDK loop (`src/orchestrator/loop.ts`): one continuous conversation with prompt caching on the system prompt (1h), tools array (1h), and message tail (5min breakpoint). This reduces per-turn cacheRead cost to ~90% of full input price. History is managed with a sliding window — once the conversation exceeds the compaction threshold (14 messages), the head is replaced with a single synthetic summary derived from the per-agent `SummaryMemory` (which records one entry per playbook invocation), and the most recent 12 messages are kept verbatim. This keeps per-turn input cost bounded without losing "what have I tried" context.

The per-turn user message includes a sitemap snapshot listing unvisited routes, untested forms/tables/modals, and affordance hints (what's behind buttons and kebabs that the link-graph crawler cannot see). Tool calls within a turn execute in parallel.

**Default model routing:** agents run on Haiku 4.5 by default (fast, cheap). Immediately after a message-window compaction, the agent's next turn uses Sonnet 4.6 to re-synthesize the elided context — this improves long-trajectory coherence without significantly raising per-run cost.

### 4. Browser MCP tools

The browser server (`src/tools/browser-server.ts`) exposes 14 primitive/macro tools:

| Tool | Purpose |
|---|---|
| `snapshot` | Structured PageModel snapshot (forms, tables, modals, wizards, toolbars, nav) |
| `ax_snapshot` | Text-outline of the accessibility tree (cheap, for "what's on the page" questions) |
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

**PageModel vs AX-tree:** Use `snapshot` (full PageModel) when you need form schemas, table row data, or locator strings. Use `ax_snapshot` for faster orientation — what buttons/links/fields are present and their roles — at 60–80% lower token cost.

Playbook tools (`mcp__playbooks__*`) are mounted dynamically from the Skills directory. The persona drives exploration; playbooks are deterministic shortcuts for the turns that are tedious to do step-by-step.

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

### 7. Post-run critic LLM (Agent-as-a-Judge)

After all agents finish, the post-run reviewer (`src/findings/review.ts`) reads the persisted findings and journey metadata and asks a single batched LLM call to classify each finding: `confirmed_bug` / `likely_bug` / `duplicate` / `environmental` / `not_a_bug`. It also clusters findings by theme and suggests severity corrections.

For every `confirmed_bug` or `likely_bug`, a **critic-with-browser** verifier opens a fresh tab, navigates to the claimed route, captures a live PageModel snapshot, and asks a second LLM whether the bug is still reproducible. Verdicts (`confirmed_reproducible` / `intermittent` / `not_reproducible` / `environmental` / `different_bug`) merge back into the report — `not_reproducible` downgrades the finding to `not_a_bug`, blunting the trace-only false-positive rate. Set `review.verify_with_browser: false` (or omit credentials) to skip verification entirely.

Output is `review.md` + `review.json`. Best-effort — a reviewer crash never fails the run; the raw findings are already on disk.

### 8. Run replay (event-sourced)

Every run writes `runs/<runId>/events.jsonl` — an append-only log of every meaningful state change (run start/end, agent turns, tool calls, findings, supervisor interventions, critic verdicts, verifier verdicts, crawl probes). The locked 19-event taxonomy is in `src/orchestrator/events.ts`.

```bash
bun run replay <runId>            # reconstruct findings.replayed.json from events alone
bun run replay <runId> --diff     # exit 1 if replayed findings differ from the live findings.json
```

Replay is the deterministic-validation pillar: a healthy run replays to the same finding set. Divergence in CI flags a regression in the harness, not the SUT.

### 9. Output layout

```
runs/<runId>/
  findings.json           all deduplicated findings
  events.jsonl            full event-sourced run trace
  review.md               critic's triage report (incl. verifier verdicts)
  review.json             structured review data
  summary.md              quick per-agent summary table
  sitemap.json            pre-run crawler snapshot
  coverage.md             per-route + playbook coverage report
  manifest.json           run metadata
  selector-cache.json     persistent locator cache (find_and_click hits)
  journeys/
    <agentId>.meta.json   per-agent journey (turns, cost, token usage, findings)
  auth/
    <agentId>/
      storage-state.json  forensic session snapshot (chmod 0600)
```

## Personas

Five built-in personas live in `skills/personas/` (Anthropic Agent Skills format):

| Persona | Style |
|---|---|
| `power-user` | Knows the app cold; runs real CRUD flows end-to-end, verifies persistence by reload-and-check |
| `chaos-clicker` | Fast, careless, double-clicks, hits browser-back mid-flow, abandons forms |
| `confused-newcomer` | Misreads labels, types the wrong things into fields, navigates away mid-form |
| `completionist` | Methodical; finishes every flow, round-trips every save, exhausts every wizard branch |
| `insider-attacker` | Authenticated grey-box probe — IDOR, RBAC, silent-failure hunt, reflected XSS, storage hygiene |

Add your own via the "Extending regress-harness" section (above). Override inline per-agent via `override_personality` in the YAML.

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
  stealth: false                    # opt-in CloakBrowser for bot-detection-protected portals

anthropic:
  api_key_env: ANTHROPIC_API_KEY
  default_model: claude-haiku-4-5-20251001

supervisor:
  enabled: true
  model: claude-sonnet-4-6

review:
  enabled: true
  model: claude-sonnet-4-6
  batch_mode: auto                  # 'auto' (batch for large payloads) | 'inline' | 'force_batch'
  verify_with_browser: true         # critic-with-browser: re-verify confirmed/likely findings on the live app
  verify_concurrency: 3             # parallel verifier tabs

crawler:
  parallelism: 3                    # concurrent tabs during pre-run crawl (1 = serial)

selector_cache:
  enabled: true                     # persistent locator cache for find_and_click

run:
  max_budget_usd: 5
  output_dir: ./runs
  memory:
    enabled: true

agents:
  - id: power-user
    profile: power-user
    model: claude-haiku-4-5-20251001
    planner_model: claude-sonnet-4-6
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

- `model` — overrides `anthropic.default_model` (default: Haiku 4.5, fast and cheap)
- `planner_model` — optional. When set, the agent's first turn AFTER a message-window compaction uses this model to re-synthesize context. Typical: Sonnet 4.6 while exploratory turns stay on Haiku. Improves long-trajectory coherence; omit for single-model mode.
- `max_thinking_tokens` — `0` (off, fastest) or `≥1024`. Useful at `1024` on Haiku for multi-step coherence; `2000+` on Sonnet for the security/completionist personas
- `override_personality` — inline string to bypass the profile file
- `budget` — per-agent caps (turns, USD, minutes)

## Cost & Caching

Prompt caching reduces per-turn input cost dramatically:

- **System prompt:** 1-hour cache (shared across all agents in a run)
- **Tools array:** 1-hour cache (all agent loop calls hit the cache)
- **Message tail:** 5-minute cache (the last content block of the most recent message)

For a typical multi-turn agent run, these three breakpoints mean ~90% of the input token bill is charged at the cacheRead rate ($0.08/Mt on Haiku, vs $0.80/Mt full price). The per-run cost delta is substantial: savings compound across turns and across the parallel agent swarm.

Optional batching for the post-run critic reduces output token cost by 50% for large triage payloads. Set `review.batch_mode: auto` (default) or `force_batch` to use the Batch API; SLA is 24h but typical completion is 1–4h. Use `--inline-critic` CLI flag to override for immediate feedback.

## Cross-run learning

Agents now have a per-target persistent Memory tool (`memory` in the toolset). It survives across separate runs against the same portal. Agents use it to record:

- Stable orientation facts ("portal has 3 roles: admin, user, viewer; admin login is /admin")
- Bug patterns noticed across runs
- Routes that are dead ends
- Approaches that have failed before

The Memory tool stores data under `~/.regress-harness/memory/<targetUrlHash>/`. Users can delete this directory to clear accumulated notes. Note: privacy implication — anything the agent writes is persisted locally; document the path so users can clear it if needed.

## Stealth mode

By default, regress-harness uses Playwright's bundled Chromium. For portals behind bot-detection services (Cloudflare, Akamai, PerimeterX), you can enable CloakBrowser's stealth Chromium binary:

```yaml
target:
  stealth: true
```

When enabled:
- First use downloads CloakBrowser's stealth binary (~200 MB). Subsequent runs reuse it.
- The binary is licensed separately by CloakHQ. Regress-harness does NOT redistribute it; users install it directly via `bun add cloakbrowser` (or `npm install cloakbrowser`).
- The stealth binary replaces Playwright Chromium for the pre-login phase only; it carries the same session to the agent loop as the normal path.
- **Default:** `false` (uses bundled Playwright Chromium; no extra download). Opt in only if you hit bot-detection walls.

## Extending regress-harness

Personas and playbooks follow the open-standard Anthropic Agent Skills format. Drop a new skill in the `skills/` directory to extend the harness:

### Custom personas

Create `skills/personas/<your-slug>/SKILL.md`:

```yaml
---
name: your-slug
description: Brief description of this persona's style
type: persona
defaultBudget:
  max_turns: 100
  max_usd: 1.0
  max_minutes: 15
---

# Personality

Describe the persona's behaviour, psychology, and exploration style.
```

### Custom playbooks

Create `skills/playbooks/<your-name>/SKILL.md` and `skills/playbooks/<your-name>/handler.ts`:

**SKILL.md:**
```yaml
---
name: your-playbook-name
description: What this playbook does
type: playbook
categories: [form]  # or [discovery, security, util]
estimatedDurationMs: 5000
---

# Usage

One-paragraph description for the agent.

# Inputs

- `field1`: Description
- `field2`: Description
```

**handler.ts:**
```ts
export const inputShape = { /* zod shape */ } as const;

export async function handler(
  input: /* inferred from inputShape */,
  ctx: PlaybookContext,
): Promise<PlaybookOutcome> {
  // Your playbook logic
}
```

See `skills/playbooks/` for 9 built-in examples. Reference the [Anthropic Agent Skills spec](https://docs.anthropic.com) for full details.

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

- `skills/` — Agent Skills format: personas and playbooks
  - `skills/personas/` — 5 built-in personas (SKILL.md files)
  - `skills/playbooks/` — 9 built-in playbooks (SKILL.md + handler.ts pairs)
- `src/config/` — YAML schema + loader (Zod)
- `src/auth/` — Pre-agent login, shared multi-tab session pool, recovery
- `src/crawler/` — BFS pre-run crawler, on-demand route expansion, SiteMap
- `src/page-model/` — Single round-trip DOM parser (PageModel), serializer for agent prompts
- `src/playbooks/` — Core playbook types and execution engine; see `skills/playbooks/` for implementations
- `src/plugins/` — Auth provider plugins (`form`, `none`), link extractors, logout guard
- `src/skills/` — Skills format loader (reads `skills/` directory, discovers personas + playbooks)
- `src/tools/` — In-process MCP servers (`browser-server.ts` with 14 browser primitives, `findings-server.ts`)
- `src/orchestrator/` — `run.ts`, `spawn-agent.ts`, `loop.ts`, `supervisor.ts`, registry, cost compute, Memory tool integration
- `src/findings/` — `review.ts` (critic LLM, batch-capable), `report.ts` (markdown writer), `persist.ts`, `coverage.ts`
- `src/safety/` — Allowlist checks, non-prod gate, credential-name validation
- `src/logging/` — Structured JSON logger with `redactForLlm` (secret masking + 8 KB truncation)
- `bin/` — `regress.ts` (scan), `regress-review.ts` (re-review with `--inline-critic` override)

## Commands

```bash
bun run scan <config.yaml>      # full run: crawler + explorers + supervisor + post-run review + verifier
bun run review <runDir>         # re-review a past run with a fresh critic pass
bun run review <runDir> --inline-critic  # immediate review (full price, no batch queuing)
bun run replay <runDir>         # reconstruct findings from the events.jsonl trace
bun run replay <runDir> --diff  # CI gate — exit 1 if replayed findings differ from findings.json
bun run typecheck               # TypeScript check
bun run lint                    # Biome check
bun run lint:fix                # Biome format + safe-fix
bun run test                    # Vitest
```

## Roadmap (active April 2026)

regress-harness is pre-launch. The strategic review at
`docs/superpowers/specs/2026-04-26-regress-harness-strategic-review.md`
captures the v3 direction:

- **Phase 1 (done):** cleanup + security hardening (auth pool, playbook consolidation, allowlist enforcement).
- **Phase 2 (done):** simplified the playbook framework from 31 scripted flows to 9 focused playbooks. Persona-first system prompt — primitives are the default action vocabulary; playbooks are deterministic shortcuts when they fit exactly. Supervisor trimmed to 3 intervention modes; `storage_inspect` primitive replaces the deleted playbook.
- **Phase 3 (done):** prompt caching (system + tools + message tail, ~90% cacheRead savings), model routing (Haiku 4.5 for actions / Sonnet 4.6 for post-compaction synthesis), Anthropic Memory tool for cross-run learning (per-target persistent notebook), Agent Skills as the format for personas + playbooks, `ax_snapshot` primitive (cheap AX-tree outline), Batch API critic (50% off output), CloakBrowser stealth opt-in.
- **Phase 4 (done):** event-sourced run trace + replay (`runs/<runId>/events.jsonl`, `bun run replay`), critic-with-browser verification (Agent-as-a-Judge — re-checks `confirmed_bug` / `likely_bug` findings against the live app, downgrades `not_reproducible` to `not_a_bug`), full AX-tree replacement of the DOM-walker `parser.ts` (smaller, cleaner, uses platform accessibility info), parallel-tab pre-run crawl (default 3 tabs), persistent selector cache (per-run `find_and_click` locator memoisation).
- **Phase 5 (next):** end-to-end validation against OWASP Juice Shop.

## Tuning notes

- **Speed / cost** — default is Haiku 4.5 with `max_thinking_tokens: 0` for cheapest exploration + Sonnet 4.6 as post-compaction `planner_model` for improved long-trajectory coherence. Remove `planner_model` for pure Haiku mode (faster per turn, less directed). Add the supervisor on top for unblocking; it costs ~$0.15/run regardless of how many explorers you run.
- **Coverage** — more parallel agents = more breadth, not more depth. Personas diverge naturally (the same persona twice will explore differently each run).
- **Coherence** — if Haiku is "scatterbrained" and clicking randomly, raise its `max_thinking_tokens` to `1024` or enable `planner_model` for every turn (not just post-compaction). If Sonnet is over-thinking, lower `max_thinking_tokens` or disable the planner.
- **Findings throttle** — 8 findings per agent per 60s. Past that the harness drops them silently (the reviewer dedupes anyway, so cascade-thrashing was costing tokens for nothing).
