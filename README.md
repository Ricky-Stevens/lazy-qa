# regress-harness

An AI-driven regression-testing harness. It launches several LLM-controlled "users" in parallel against a target web app, lets them explore it as themselves (no scripted test cases), and produces a triaged report of bugs they ran into.

The pitch: instead of writing brittle E2E scripts that test what *you* thought to check, you point this at a staging deploy and five different personas — a power user, a chaos clicker, a confused newcomer, a methodical completionist, and an authenticated insider attacker — go and use the app for five minutes each. Anything that breaks, surprises, or fails them shows up as a finding. A separate critic LLM then re-reads every finding, flags duplicates and noise, and writes a markdown triage report.

## Quick start

```bash
cp .env.example .env
# edit .env: ANTHROPIC_API_KEY, REGRESS_TRUSTED_HOSTS, your portal creds
npm install      # or: bun install
npm run scan config/example.yaml      # or: bun run scan config/example.yaml
```

**Runtime:** Node 20+ recommended. Bun 1.x also supported (project was originally Bun-first).

When the run finishes you'll have:

- `runs/<runId>/findings.json` — every finding the agents filed
- `runs/<runId>/review.md` — the critic's triage report (confirmed bugs / likely / duplicate / not-a-bug + themes)
- `runs/<runId>/journeys/*.meta.json` — per-agent metadata (turns, cost, termination reason)
- `runs/<runId>/summary.md` — quick run summary
- `runs/last` — symlink to the most recent run

Re-review a past run without re-running it:

```bash
bun run review runs/<runId>
```

## How it works

Each agent gets its own tab on a single shared Chrome session. The orchestrator logs in once via Playwright and saves the session into a tab; subsequent agents acquire fresh tabs on the same authenticated context (no per-agent login). Credentials are filled by the orchestrator before the LLM loop starts and never enter the model's prompt.

Each agent then runs an LLM loop with two MCP tool servers (both in-process — no subprocesses):

- **`browser`** — `snapshot`, `navigate`, `click`, `type`, `fill_form`, `find_and_click`, `select_option`, `press_key`, `back`, `console_errors`, `evaluate`, `read_recent`. Snapshots default to a diff (only what changed since last call). Actions return one-line statuses and pre-compute the next snapshot in the background while the model is thinking.
- **`harness`** — `report_finding` (rate-limited to 8/60s/agent) and `end_session` (gated to a hard-floor enum: `auth_wall` / `site_unreachable` / `browser_dead` only).

A sixth always-on **supervisor agent** watches the runtime registry and intervenes:

- Auth-walled agent → calls `relogin_session` (re-auths the shared context, reloads sibling tabs to flush stale in-memory tokens)
- 4xx storm across multiple agents → calls `pause_agents` (everyone sleeps, gives the backend a breather)
- Stuck or tunneling agent → `nudge_agent` queues a one-shot prompt prepended to the agent's next chunk

After all explorers finish, the post-run reviewer reads the journeys + findings and classifies each finding via a single batched LLM call: `confirmed_bug` / `likely_bug` / `duplicate` / `environmental` / `not_a_bug`, with severity-correction suggestions and theme clustering. Output is `review.md` + `review.json`.

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
  # Skip the Claude Code subprocess; talk to the Anthropic API directly.
  # Faster + parallel tool execution per turn; needs ANTHROPIC_API_KEY.
  direct_api: true

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
- `planner_model` — optional smarter model that runs a one-shot plan call between chunks; the cheap executor model then follows it
- `override_personality` — inline string to bypass the profile file
- `budget` — per-agent caps (turns, USD, minutes)

## Auth modes

- **`type: form`** (default) — Playwright fills the form. Works for Auth0, generic SSO login pages, anything with username + password + submit. Set `success_url_pattern` or `wait_for_selector` if the post-submit heuristic doesn't fit.
- **`type: none`** with `storage_state_path` — supply your own pre-built `storageState.json` for MFA / passkey / non-form flows. Generate it once interactively with `playwright codegen`, then reuse.
- **API key vs subscription** — set `ANTHROPIC_API_KEY` for billed runs (CI must use this) or leave it unset to fall back to the local `claude` CLI's cached subscription auth (free dev runs on Pro/Max). Note: the supervisor and the post-run reviewer both require the API key path; they're skipped on subscription auth.

## Safety

- **Operator allowlist** — `REGRESS_TRUSTED_HOSTS` env var is required. Every host in the YAML's `target.allowed_hosts` must appear there. Stops a malicious YAML from steering credentials at attacker hosts.
- **Non-prod check** — target hostname must match `localhost` / `staging.` / `dev.` / `qa.` / `test.` / `preview.` prefixes, or be in `REGRESS_NONPROD_HOST_PATTERNS`. Don't point this at production.
- **Credentials never enter the LLM context** — the orchestrator owns the Playwright login; the agent only sees an already-authenticated browser handle.
- **Credential env-var names are filtered** — must match `^[A-Z][A-Z0-9_]*$` and must NOT start with `ANTHROPIC_`, `AWS_`, `GH_`, `GITHUB_`, `AZURE_`, `GCP_`, etc. Stops a malicious YAML referencing an infrastructure secret as a "password".
- **Logout suppression** — `click` and `find_and_click` refuse to click anything matching logout heuristics (text, aria-label, href, testid). Prevents one agent's stray click from terminating the shared session for everyone.
- **Pre-login network allowlist** — Playwright `route()` blocks off-allowlist requests during the credential-fill phase.
- **Forensic storage state** is written to `runs/<runId>/auth/<agentId>/storage-state.json` at `chmod 0600` for post-mortem only — not used for handoff.

## Project structure

- `src/config/` — YAML schema + loader (Zod)
- `src/auth/` — Pre-agent login + the shared multi-tab session pool
- `src/profiles/` — Persona markdown files
- `src/tools/` — In-process MCP servers (`browser-server.ts`, `findings-server.ts`)
- `src/orchestrator/` — `run.ts`, `spawn-agent.ts`, `direct-loop.ts`, `supervisor.ts`, `registry.ts`, cost compute
- `src/findings/` — `review.ts` (critic LLM), `report.ts` (markdown writer), `persist.ts`
- `src/safety/` — Allowlist checks, non-prod gate, credential-name validation
- `src/logging/` — Structured JSON logger with secret redaction
- `bin/` — `regress.ts` (scan), `regress-review.ts` (re-review)

## Commands

```bash
bun run scan <config.yaml>      # full run: explorers + supervisor + post-run review
bun run review <runDir>         # re-review a past run with a fresh critic pass
bun run typecheck               # TypeScript check
bun run lint                    # Biome check
bun run lint:fix                # Biome format + safe-fix
bun run test                    # Vitest
```

## Tuning notes

- **Speed / cost** — flip `direct_api: true` and use Haiku 4.5 with `max_thinking_tokens: 0` for cheapest exploration. Add the supervisor on top for unblocking; it costs ~$0.15/run regardless of how many explorers you run.
- **Coverage** — more parallel agents = more breadth, not more depth. Personas diverge naturally (the same persona twice will explore differently each run).
- **Coherence** — if Haiku is "scatterbrained" and clicking randomly, raise its `max_thinking_tokens` to `1024`. If Sonnet is over-thinking, lower it.
- **Engagement gate** — the harness refuses cross-route navigation until 6 actions on the current route or 60 seconds elapsed. Stops nav-flicking. Bypasses: filing a finding (counts as +4 actions) or a near-empty page (<8 interactive elements, auto-allow).
- **Findings throttle** — 8 findings per agent per 60s. Past that the harness drops them silently (the reviewer dedupes anyway, so cascade-thrashing was costing tokens for nothing).
