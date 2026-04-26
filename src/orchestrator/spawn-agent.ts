import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { acquireSession } from '../auth/session-pool.ts';
import type { AuthConfig } from '../config/types.ts';
import { persistJourney } from '../findings/persist.ts';
import type { Logger } from '../logging/logger.ts';
import {
  BROWSER_TOOL_NAMES,
  buildEngagementTracker,
  createBrowserMcpServer,
} from '../tools/browser-server.ts';
import { createHarnessMcpServer } from '../tools/findings-server.ts';
import type { ResolvedAgent } from '../types/agent.ts';
import type { Journey } from '../types/journey.ts';
import { computeCostUsd } from './cost.ts';
import { runDirectLoop } from './direct-loop.ts';
import {
  consumeNudge,
  registerAgent,
  setStatus,
  updateOnAction,
  updateOnTurn,
} from './registry.ts';

/**
 * Pick a Claude Code binary to spawn.
 *
 * The Agent SDK auto-detects a platform native binary, but on Bun + Linux x64
 * it picks the musl-linked binary by default. That binary fails to dlopen on
 * glibc systems (Ubuntu/Debian/WSL) with "No such file or directory" because
 * `libc.musl-x86_64.so.1` isn't installed. Workaround: when we detect a glibc
 * host, point the SDK at the glibc-linked variant the SDK *also* ships.
 *
 * Override priority: CLAUDE_CODE_EXECUTABLE env var > glibc auto-detect > undefined (let SDK try).
 */
function resolveClaudeCodeBinary(): string | undefined {
  const fromEnv = process.env.CLAUDE_CODE_EXECUTABLE;
  if (fromEnv) return fromEnv;

  if (process.platform !== 'linux' || process.arch !== 'x64') return undefined;
  // musl host: SDK's default is correct.
  if (existsSync('/lib/ld-musl-x86_64.so.1')) return undefined;

  const glibcBinary = path.resolve(
    process.cwd(),
    'node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude',
  );
  return existsSync(glibcBinary) ? glibcBinary : undefined;
}

const CLAUDE_CODE_EXECUTABLE = resolveClaudeCodeBinary();

export interface SpawnAgentInput {
  runId: string;
  runDir: string;
  targetUrl: string;
  allowedHosts: string[];
  auth: AuthConfig;
  agent: ResolvedAgent;
  /** Anthropic API key. When null, the SDK subprocess inherits the user's
   * claude-CLI subscription auth — useful for free local dev runs. */
  apiKey: string | null;
  /** When true, AND apiKey is non-null, run the direct Anthropic SDK loop
   * instead of the Claude Code subprocess path. Faster but loses subscription
   * auth fallback. */
  useDirectApi?: boolean;
  logger: Logger;
  /** External abort signal — forwarded from the orchestrator so Ctrl-C/SIGTERM cancels in-flight SDK calls. */
  abortSignal?: AbortSignal;
}

export interface SpawnAgentResult {
  journey: Journey;
}

/**
 * Claude Code built-in tools we explicitly DENY — the QA agent should never
 * shell out, edit files, or browse the web outside of Playwright. Without this
 * list the agent has been observed to ignore Playwright entirely and try to
 * debug its environment via Bash. Setting `tools: []` would block these too,
 * but it also (incorrectly) drops in-MCP tools, so we use disallowedTools.
 */
const DISALLOWED_BUILTINS: readonly string[] = [
  'Bash',
  'Edit',
  'Glob',
  'Grep',
  'NotebookEdit',
  'Read',
  'Task',
  'TodoWrite',
  'ToolSearch',
  'WebFetch',
  'WebSearch',
  'Write',
  // The agent SDK's auxiliary tools — never useful for QA exploration.
  'AskUserQuestion',
  'CronCreate',
  'CronDelete',
  'CronList',
  'EnterPlanMode',
  'EnterWorktree',
  'ExitPlanMode',
  'ExitWorktree',
  'Monitor',
  'PushNotification',
  'RemoteTrigger',
  'ScheduleWakeup',
  'Skill',
  'TaskOutput',
  'TaskStop',
];

/**
 * Tools the agent is allowed to call. Belt-and-braces alongside
 * DISALLOWED_BUILTINS — even if a built-in slips through, it's runtime-denied.
 */
const ALLOWED_TOOLS: readonly string[] = [
  // In-process harness MCP server
  'mcp__harness__report_finding',
  'mcp__harness__end_session',
  // In-process browser MCP server (replaces @playwright/mcp).
  ...BROWSER_TOOL_NAMES,
];

/** Whitelist of generic env keys that subprocesses may need. Never spreads process.env. */
const SAFE_GENERIC_ENV_KEYS = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'USER'];
const SAFE_PLAYWRIGHT_ENV_KEYS = [
  'PLAYWRIGHT_BROWSERS_PATH',
  'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD',
  'PLAYWRIGHT_HEADLESS',
];

function copyExisting(target: Record<string, string>, keys: readonly string[]): void {
  for (const key of keys) {
    const v = process.env[key];
    if (typeof v === 'string') target[key] = v;
  }
}

/** Env for the Claude Agent SDK subprocess.
 *
 * `apiKey` is forwarded to the subprocess only when set — when null/empty, the
 * subprocess inherits whatever auth the user's `claude` CLI has cached (Pro/Max
 * subscription). That makes interactive dev runs effectively free, while CI
 * runs (which set ANTHROPIC_API_KEY) bill against the API as before.
 *
 * `ENABLE_PROMPT_CACHING_1H=1` opts into the 1-hour cache TTL — the 5-minute
 * default evicts mid-run on long agent loops. */
function sdkEnv(apiKey: string | null): Record<string, string> {
  const env: Record<string, string> = {
    ENABLE_PROMPT_CACHING_1H: '1',
  };
  if (apiKey != null && apiKey !== '') {
    env.ANTHROPIC_API_KEY = apiKey;
  }
  copyExisting(env, SAFE_GENERIC_ENV_KEYS);
  copyExisting(env, ['DISPLAY']);
  copyExisting(env, SAFE_PLAYWRIGHT_ENV_KEYS);
  return env;
}

export async function spawnAgent(input: SpawnAgentInput): Promise<SpawnAgentResult> {
  const {
    runId,
    runDir,
    targetUrl,
    allowedHosts,
    auth,
    agent,
    apiKey,
    useDirectApi,
    logger,
    abortSignal,
  } = input;
  const { budget } = agent;

  const childLogger = logger.child({ agentId: agent.id });

  // Register with the runtime registry so the supervisor can see this agent's
  // live state. Registry is module-level; the supervisor reads it via
  // snapshotAll() and writes nudges back via pushNudge().
  registerAgent(agent.id, agent.profileName);

  // 1. Initial journey state
  const journey: Journey = {
    runId,
    agentId: agent.id,
    startedAt: new Date().toISOString(),
    startUrl: targetUrl,
    turns: 0,
    findings: [],
    tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0,
    terminationReason: undefined,
  };

  // 2. Acquire an authenticated tab. Multiple agents with the same credentials
  // share a single browser process — first acquirer triggers login, later
  // acquirers get a fresh tab on the same authed context. Saves 5-8s of login
  // for every parallel agent after the first in each credential group.
  let livePage: Awaited<ReturnType<typeof acquireSession>>['page'] | null = null;
  let releaseSession: (() => Promise<void>) | null = null;
  try {
    const acquired = await acquireSession({
      targetUrl,
      auth,
      allowedHosts,
      credentials: agent.credentials,
      runDir,
      agentId: agent.id,
      logger: childLogger,
    });
    livePage = acquired.page;
    releaseSession = acquired.release;
  } catch (err) {
    childLogger.error('login.failed', {
      agentId: agent.id,
      error: err instanceof Error ? err.message : String(err),
    });
    journey.terminationReason = 'error';
    journey.endedAt = new Date().toISOString();
    await persistJourney(runDir, journey);
    return { journey };
  }

  // 3. In-process MCP servers — both run inside the orchestrator process; the
  // SDK bridges tool calls from the subprocess back to here via stdin/stdout.
  // The engagement tracker is shared so report_finding contributes to the
  // per-route action counter that gates `navigate` — keeps the agent on a
  // page until it has actually engaged, but lets findings free up navigation
  // when the page is genuinely broken.
  const engagement = buildEngagementTracker();
  const harnessKit = createHarnessMcpServer({ journey, logger: childLogger, engagement });
  const browserKit = createBrowserMcpServer({
    getPage: () => {
      if (!livePage) throw new Error('Browser page is no longer available');
      return livePage;
    },
    logger: childLogger,
    engagement,
    agentId: agent.id,
    onAction: (patch) => updateOnAction(agent.id, patch),
  });
  const harnessServer = harnessKit.mcpServer;
  const browserServer = browserKit.mcpServer;

  // 5. AbortController — combines the per-agent wall-clock timeout with any external signal.
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), budget.max_minutes * 60_000);
  const onExternalAbort = () => abortController.abort();
  abortSignal?.addEventListener('abort', onExternalAbort, { once: true });

  // 6. System prompt — persona-driven, time-saturating. No workflows, no checklists.
  // The agent IS a real user (per the persona at the bottom) and stays in character
  // until the time budget runs out. `end_session` is reserved for hard floors only.
  const systemPrompt = [
    `You are NOT a QA agent. You are NOT exploring. You are NOT mapping. You are a real human user of ${targetUrl} — your character is described at the bottom of this prompt and you BEHAVE like that person, using the app the way they would use it.`,
    '',
    `OUTPUT FORMAT — READ CAREFULLY: emit TOOL CALLS ONLY. Zero prose. Zero narration. Zero "I'll now click...", "Let me try...", "First I'll...", "The dashboard shows...". The harness does not read your text — it only executes your tool calls. Every word of prose you generate is wasted latency and money. The ONLY exceptions: report_finding arguments (those need real prose) and end_session detail. EVERYTHING ELSE: tools, no commentary.`,
    '',
    `You have ${budget.max_minutes} minutes (and ${budget.max_turns} turns). Use ALL of it. When you finish one thing, immediately start a different one. When you've done a flow once, do a different one. The app is bigger than you think — there is always something else to try.`,
    '',
    `Your browser is already open and authenticated. The orchestrator logged in for you. You do NOT have credentials and you do NOT know them. NEVER attempt to log in. NEVER navigate to a login page. If you ever land on a login page mid-session, that is a finding — file it and try a different page.`,
    '',
    'HARNESS TOOLS:',
    '- `mcp__harness__report_finding` — file ANY finding the moment you see it. Be concrete. Then KEEP USING THE APP. A finding is NEVER a reason to stop. 4xx, 5xx, console errors, blank pages, lost data, broken UI, confusing flows — all FINDINGS, not stop reasons.',
    '- `mcp__harness__end_session` — STRICT HARD-FLOOR USE ONLY. Use ONLY when one of:',
    '    • `auth_wall` — redirected to login and cannot continue',
    '    • `site_unreachable` — target host completely down, network errors on every navigation',
    '    • `browser_dead` — cannot interact with the browser at all',
    '  NEVER call end_session because you "finished exploring" or "covered the site" or "ran out of ideas". There is ALWAYS more to try. Your job is to use the time.',
    '',
    'BROWSER TOOLS (in-process, fast):',
    '',
    'PREFER THESE COMPOUND MACROS — they bundle multiple actions into a single round-trip:',
    '- `mcp__browser__fill_form({fields, submit?})` — fill several fields and optionally submit IN ONE CALL. Use this for ANY form. Pass `submit: true` to press Enter on the last field, or `submit: "<locator>"` to click a specific submit button. Saves N-1 round-trips.',
    '- `mcp__browser__find_and_click({hint, role?})` — click by visible text/label without needing the exact selector. Tries role+name → text → aria-label automatically. Use this whenever you know what the element SAYS but not its exact selector — saves a snapshot.',
    '- `mcp__browser__read_recent` — one-call sweep returning current URL + snapshot + console errors + recent network entries. Use this after weird behaviour instead of three separate calls.',
    '',
    'PRIMITIVE BROWSER TOOLS — use only when no macro fits:',
    '- `mcp__browser__snapshot` — by default returns a DIFF (only elements added/removed since your last snapshot). First call on a new URL is automatically full. Pass `{ full: true }` only when you genuinely need to re-see the entire page. Diff is dramatically smaller than full — prefer it.',
    '- `mcp__browser__navigate({url})` — go to URL. Returns a status line.',
    '- `mcp__browser__click({locator})` — click. Use ONLY when you already know the exact locator. Otherwise use `find_and_click`.',
    '- `mcp__browser__type({locator, text, submit?})` — fill ONE field. Use `fill_form` for multi-field inputs.',
    '- `mcp__browser__select_option({locator, label?, value?})` — pick from a <select>.',
    '- `mcp__browser__press_key({key})` — Tab / Enter / Escape / ArrowDown / F5.',
    '- `mcp__browser__back` — browser back.',
    '- `mcp__browser__console_errors` — passively-captured console errors and JS errors since the last call (then cleared).',
    '- `mcp__browser__evaluate({expression})` — read-only JS for inspection (storage, location, performance entries).',
    '',
    'CRITICAL: actions return a one-line status, NOT a snapshot. The status is `OK <action> | URL: ...` or `FAIL <action> | <reason> | URL: ...`. The URL tells you whether navigation happened. Most of the time you do NOT need to call snapshot between actions — you already know the layout from the previous snapshot. Call snapshot only when the page state has genuinely changed (URL changed, modal opened, you suspect re-render).',
    '',
    'HARD RULES:',
    '0. **STICK WITH IT — ENFORCED BY THE HARNESS.** Every action returns a status line ending in `[engagement: <Ns> on <route>; ⚠️ only <N>/6 actions here ...]`. The harness REFUSES `navigate()` to a different route until you have made 6 actions OR spent 60s on the current route. Same-route navigation (/clients → /clients/123) is always allowed — drilling into a record IS engagement. If you get `REFUSED navigate(...)`, drill into the current page: click table rows, open kebab/edit menus, fill+submit forms, switch sub-tabs, double-click cells, sort columns, open modals, try filters. ESCAPE HATCHES: (a) page is broken (<8 interactive items) → navigation auto-allowed; (b) report_finding bumps engagement by 4; (c) 60s elapsed → time-bypass.',
    '0b. **READ THE STATUS LINE EVERY TURN — THIS IS HOW YOU DETECT BUGS.** Every action returns a status line. After the URL and engagement counter, look for `⚠️ since last action — net: ... || console: ...`. This is the harness telling you: "this action triggered an HTTP 4xx/5xx" or "this click fired a JS error". The UI may have shown nothing — apps that fail silently are EXACTLY what you are here to find. Treat every ⚠️ signal in a status line as a probable finding. A `200 GET /api/clients` is silent (no warning); a `403 POST /api/clients/save` shows up as `⚠️ ... net: 403 POST /api/clients/save` and is almost always a finding. Same for `console: [pageerror] TypeError ...`. The status line is your eyes — read it.',
    '0a. **FILE FINDINGS INDIVIDUALLY — DO NOT AGGREGATE.** Every 4xx, 5xx, console error, broken page, missing UI, or unexpected behaviour gets its OWN report_finding call. NEVER consolidate ("Multiple routes have 404s") — file each route as a separate finding with the specific URL, error message, and reproduction. Aggregation destroys triage. The triagers WANT noise — file 30 findings rather than one summary. If you see five 404s on five different routes, that is FIVE findings, one per route. Same goes for repeated console errors with different messages.',
    '1. You are USING the app, not auditing it. NEVER list pages you have visited. NEVER write a "summary of features". NEVER catalogue. Just behave like your character.',
    '2. Snapshot ONLY when needed (after navigation, after an action that fundamentally changes the page). Default: do not snapshot. Use the URL in the status line to detect navigation.',
    '3. Prefer semantic locators (role=, text=, label=) over CSS or coordinates.',
    '4. When you start a multi-step flow (form, wizard, edit-then-save), COMPLETE it before navigating elsewhere — unless your character is the kind of person who would abandon it (e.g. chaos-clicker, confused-newcomer).',
    '5. File findings as you go. Do NOT try to deeply reproduce — file what you saw and move on.',
    '6. KEEP GOING until your time runs out. Hitting a wall on one feature means switch to a different feature, not stop.',
    '7. **PARALLEL TOOL CALLS** — every turn has fixed model-inference latency, so batching is the biggest speed lever you control. When you need to fill 3 fields and click Submit, emit ALL FOUR tool calls in ONE turn. Do not wait for one tool result before issuing the next. The harness will return all results together. Examples:',
    '   • Filling a form: emit `type(field1) + type(field2) + type(field3) + click(submit)` together.',
    '   • Investigating: emit `console_errors() + evaluate(localStorage) + snapshot()` together.',
    '   • Exploring: emit `navigate(url) + snapshot()` together when you know you want to see the destination.',
    '   The ONLY time you should NOT batch is when one action depends on the OUTCOME of another (e.g. you need to click the value that just appeared in a dropdown). In all other cases, batch aggressively.',
    '',
    '8. **GO BEYOND THE OBVIOUS BUTTONS.** Top-level buttons and the nav menu are the SHALLOWEST surface in any app. A real user does far more. Actively look for and try ALL of these:',
    '   • Table rows — click them (often opens a detail view), and look for per-row action icons (kebab `⋮`, pencil/edit, trash/delete, eye/view, copy/duplicate, download, export). Snapshot will list these as `button: "Edit"` / `[testid="row-actions-..."]` / `icon:edit`. Click them.',
    '   • Column headers — click to sort (does it actually sort?). Right-click for column menu if any.',
    '   • Icon-only buttons — entries showing as `button: "icon:<name>"` or `button: "testid:<id>"` are real buttons with no visible text. They usually do something interesting (settings, filter, expand). Try them.',
    '   • Kebab `⋮` / overflow menus — almost always contain destructive or admin actions hidden from the main UI. Open every one you see.',
    '   • Hover-revealed actions — if a row or card looks suspiciously bare, hover it (try `find_and_click` on guessed labels like "Edit", "Delete", "More" — they may exist but only become visible on hover).',
    '   • Right-click — try `press_key({key:"ContextMenu"})` on a focused row or item.',
    '   • Double-click on cells — many tables support inline edit on dblclick.',
    '   • Filter / search inputs — type partial values, weird values, empty submit.',
    '   • Pagination — page 2, last page, jump.',
    '   • Bulk-select checkboxes + bulk action dropdown.',
    '   • Tabs within a page (often above tables) — switch tabs, the content is different and rarely visited.',
    '   • Modals: not just submit — try Cancel, the `×`, click outside, press Escape. Each can have different behaviour.',
    '   If you only ever click top-nav items and primary buttons, you are testing 5% of the app. Push deeper.',
    '',
    'YOUR CHARACTER (this is who you ARE — embody them, do not narrate them):',
    agent.personality,
  ].join('\n');

  // Raw-message debug buffer — hoisted so the finally block can flush it on abort.
  const debugLines: string[] = [];

  // History compaction: chunked runs. Instead of one giant query() that grows a
  // multi-MB conversation by turn 200, we run the agent in chunks of ~25 turns.
  // After each chunk, the SDK conversation is dropped; we restart with a new
  // user prompt summarising progress. The system prompt is identical so it
  // stays in the 1h prompt cache. Net effect: per-turn input cost stays bounded
  // even on very long runs, and inference time per turn does not balloon.
  const CHUNK_TURNS = Math.min(25, budget.max_turns);

  /**
   * Generate a plan for the next chunk using a (typically smarter) planner model.
   * One-shot query, no MCP tools, returns a numbered list of concrete next actions.
   * Returns null if planning fails (we fall back to a generic continue prompt).
   */
  async function generatePlan(): Promise<string | null> {
    if (!agent.plannerModel) return null;
    const elapsedMs = Date.now() - new Date(journey.startedAt).getTime();
    const remainingMin = Math.max(0, budget.max_minutes - elapsedMs / 60_000);

    const plannerSystem = [
      `You are a SESSION PLANNER for an automated regression-test agent.`,
      `The agent is a real user (persona below) using ${targetUrl}.`,
      `Progress: ${journey.turns} turns done, ${journey.findings.length} findings filed, ~${remainingMin.toFixed(1)} min remaining.`,
      ``,
      `Output a numbered list of 5-8 CONCRETE next actions for the agent. Each step is one sentence: what to try, where to go, what to look for. Pick areas/flows the agent has NOT yet explored. Be specific.`,
      ``,
      `Output format: just the numbered list. NO preamble, NO headings, NO commentary. Plain text.`,
      ``,
      `PERSONA:`,
      agent.personality,
    ].join('\n');

    try {
      const stream = query({
        prompt: 'Plan the next 5-8 actions.',
        options: {
          model: agent.plannerModel,
          systemPrompt: plannerSystem,
          maxTurns: 1,
          mcpServers: {},
          allowedTools: [],
          disallowedTools: [...DISALLOWED_BUILTINS],
          settingSources: [],
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          abortController,
          env: sdkEnv(apiKey),
          ...(CLAUDE_CODE_EXECUTABLE ? { pathToClaudeCodeExecutable: CLAUDE_CODE_EXECUTABLE } : {}),
        },
      });

      let text = '';
      for await (const message of stream) {
        if (message.type === 'assistant') {
          const content = (message as { message?: { content?: unknown[] } }).message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              const b = block as { type?: string; text?: string };
              if (b.type === 'text' && typeof b.text === 'string') text += b.text;
            }
          }
        }
      }
      return text.trim() || null;
    } catch (err) {
      childLogger.warn('planner.failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  // 8. Route to the direct Anthropic SDK loop if opted in.
  // Requires apiKey because subscription auth is only via the claude CLI binary.
  if (useDirectApi && apiKey) {
    try {
      childLogger.info('agent.loop.mode', { mode: 'direct-api' });
      await runDirectLoop({
        agent,
        targetUrl,
        systemPrompt,
        apiKey,
        rawTools: [...harnessKit.rawTools, ...browserKit.rawTools],
        journey,
        abortSignal: abortController.signal,
        logger: childLogger,
      });
    } catch (err) {
      if (abortController.signal.aborted) {
        journey.terminationReason = abortSignal?.aborted ? 'signal' : 'timeout';
      } else {
        journey.terminationReason = 'error';
        childLogger.error('agent.error', {
          agentId: agent.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      clearTimeout(timeoutHandle);
      abortSignal?.removeEventListener('abort', onExternalAbort);
      if (releaseSession) {
        await releaseSession().catch((closeErr) => {
          childLogger.warn('session.release.failed', {
            error: closeErr instanceof Error ? closeErr.message : String(closeErr),
          });
        });
      }
      journey.endedAt ??= new Date().toISOString();
      journey.terminationReason ??= 'max-turns';
      setStatus(agent.id, journey.terminationReason === 'error' ? 'errored' : 'finished');
      await persistJourney(runDir, journey);
    }
    return { journey };
  }

  // 8b. Default path: Claude Code SDK with chunked history compaction.
  childLogger.info('agent.loop.mode', { mode: 'claude-code-sdk' });
  try {
    while (
      journey.turns < budget.max_turns &&
      !abortController.signal.aborted &&
      journey.terminationReason !== 'end_session'
    ) {
      const remainingTurns = budget.max_turns - journey.turns;
      const chunkLimit = Math.min(CHUNK_TURNS, remainingTurns);
      const elapsedMs = Date.now() - new Date(journey.startedAt).getTime();
      const remainingMin = Math.max(0, budget.max_minutes - elapsedMs / 60_000);

      // If a plannerModel is set, run a 1-shot planner call here. The plan
      // becomes the first lines of the executor's user prompt — concrete
      // direction instead of a generic "keep going". Skip on first chunk to
      // avoid latency overhead at the agent's startup.
      let plan: string | null = null;
      if (agent.plannerModel && journey.turns > 0) {
        plan = await generatePlan();
        if (plan) {
          childLogger.info('plan.generated', {
            chars: plan.length,
            preview: plan.slice(0, 200),
          });
        }
      }

      // Drain any supervisor-issued nudge for this agent. The supervisor's
      // pushNudge() call is asynchronous to this loop; this is the rendezvous
      // point where it lands in the agent's next user prompt.
      const nudge = consumeNudge(agent.id);
      if (nudge) {
        childLogger.info('supervisor.nudge.consumed', { preview: nudge.slice(0, 200) });
      }

      const basePrompt =
        journey.turns === 0
          ? `Begin. You're already on ${targetUrl} — start using the app as your character would. Pick ONE module/area and STAY THERE. Do every flow that area supports — list, filter, sort, open, edit, save, delete, bulk action, row actions, kebab menus, every tab, every modal — BEFORE you switch to a different module.`
          : [
              `[continue] You're partway through your session. Progress so far:`,
              `- ${journey.turns} turns completed`,
              `- ${journey.findings.length} findings filed`,
              `- ~${remainingMin.toFixed(1)} minutes remaining`,
              ``,
              ...(plan
                ? [`PLAN FOR THIS CHUNK (you wrote it):`, plan, ``]
                : [
                    `STAY where you are. Continue the module you were just in — there is almost certainly more to do there: row actions you haven't tried, edits you haven't saved, bulk operations, sub-tabs, kebab menus, filter/sort, column-header clicks, double-click on cells. EXHAUST the current module before moving to a different one.`,
                    `If — and only if — you have genuinely tried every action available in the current module (not just the obvious buttons), then move to the next module and do the same: list, filter, sort, open, edit, save, delete, every row action, every tab, every modal.`,
                    ``,
                  ]),
              `Stay in character. KEEP USING THE APP. Do not summarise; just act. Batch tool calls aggressively. NO PROSE — tools only.`,
            ].join('\n');

      const prompt = nudge
        ? `[SUPERVISOR INTERVENTION — read this first]\n${nudge}\n\n${basePrompt}`
        : basePrompt;

      childLogger.info('chunk.start', {
        chunkLimit,
        cumulativeTurns: journey.turns,
        remainingMin: Number(remainingMin.toFixed(2)),
      });

      const stream = query({
        prompt,
        options: {
          model: agent.model,
          systemPrompt,
          mcpServers: {
            harness: harnessServer,
            browser: browserServer,
          },
          maxTurns: chunkLimit,
          maxBudgetUsd: budget.max_usd,
          abortController,
          settingSources: [],
          // Explicitly deny built-ins (Bash/Edit/Read/etc) — `tools: []` would
          // also drop our MCP tools, so we use disallowedTools instead.
          disallowedTools: [...DISALLOWED_BUILTINS],
          // Allowlist for MCP tools we want — runtime-denies anything else.
          allowedTools: [...ALLOWED_TOOLS],
          // Refuse to merge user-level MCP config into the subprocess — only the
          // mcpServers we pass above are reachable.
          extraArgs: { 'strict-mcp-config': null },
          // Autonomous agents must run tools without interactive approval — there's
          // no TTY to prompt against. Blast radius is bounded by Playwright MCP's
          // --allowed-origins flag and the pre-baked storageState.
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          // Thinking budget — capped per-agent. Anthropic API requires >= 1024
          // when thinking is enabled, so 0 means "do not enable thinking at all"
          // (omit the option). Schema-level validation enforces the floor.
          ...(typeof agent.maxThinkingTokens === 'number' && agent.maxThinkingTokens > 0
            ? { maxThinkingTokens: agent.maxThinkingTokens }
            : {}),
          env: sdkEnv(apiKey),
          ...(CLAUDE_CODE_EXECUTABLE ? { pathToClaudeCodeExecutable: CLAUDE_CODE_EXECUTABLE } : {}),
        },
      });

      let chunkTurns = 0;
      try {
        for await (const message of stream) {
          childLogger.debug('sdk.message', { type: message.type });
          debugLines.push(JSON.stringify(message));

          if (message.type === 'system') {
            const tools = (message as { tools?: unknown }).tools;
            childLogger.info('sdk.system.tools', {
              tools: Array.isArray(tools) ? tools : tools,
            });
          }

          if (message.type === 'assistant') {
            journey.turns += 1;
            chunkTurns += 1;
            updateOnTurn(agent.id, {
              turnsCompleted: journey.turns,
              findingsCount: journey.findings.length,
            });
            const usage = (message as unknown as { message?: { usage?: Record<string, number> } })
              .message?.usage;
            if (usage) {
              journey.tokenUsage.input += usage.input_tokens ?? 0;
              journey.tokenUsage.output += usage.output_tokens ?? 0;
              journey.tokenUsage.cacheRead += usage.cache_read_input_tokens ?? 0;
              journey.tokenUsage.cacheWrite += usage.cache_creation_input_tokens ?? 0;
              try {
                journey.costUsd = computeCostUsd(agent.model, journey.tokenUsage);
              } catch {
                // Cost compute can fail for unknown models; we'll still have token totals.
              }
            }
          }

          if (message.type === 'result') {
            const totalCost = (message as Record<string, unknown>).total_cost_usd;
            if (typeof totalCost === 'number' && totalCost > journey.costUsd) {
              journey.costUsd = totalCost;
            }
          }

          // Cast — TS narrows away 'end_session' because the outer while-loop
          // checks `!== 'end_session'`, but the harness MCP server can flip the
          // value inside this for-await (TS can't see through that callback).
          if ((journey.terminationReason as string) === 'end_session') {
            break;
          }
        }
      } catch (chunkErr) {
        // Per-chunk error handling. The SDK throws "Reached maximum number of turns"
        // when a chunk uses up its maxTurns budget — this is the EXPECTED end of a
        // chunk, not a failure. Treat as graceful chunk-end and continue the outer
        // loop into the next chunk. Re-throw anything that isn't the max-turns case
        // so genuine errors still surface.
        const msg = chunkErr instanceof Error ? chunkErr.message : String(chunkErr);
        if (/maximum number of turns/i.test(msg)) {
          childLogger.info('chunk.maxturns.reached', {
            chunkTurns,
            cumulativeTurns: journey.turns,
          });
        } else if (abortController.signal.aborted) {
          throw chunkErr;
        } else {
          throw chunkErr;
        }
      }

      childLogger.info('chunk.end', {
        chunkTurns,
        cumulativeTurns: journey.turns,
        findingsTotal: journey.findings.length,
      });

      // If the chunk ended without producing any turns, the SDK is wedged or
      // the prompt was rejected — break to avoid a hot loop.
      if (chunkTurns === 0) break;

      // Also break early if we've blown the budget (cost guard).
      if (journey.costUsd >= budget.max_usd) {
        journey.terminationReason = 'budget-hit';
        break;
      }
    }
  } catch (err) {
    if (abortController.signal.aborted) {
      journey.terminationReason = abortSignal?.aborted ? 'signal' : 'timeout';
      childLogger.warn('agent.aborted', {
        agentId: agent.id,
        reason: journey.terminationReason,
      });
    } else {
      journey.terminationReason = 'error';
      childLogger.error('agent.error', {
        agentId: agent.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    clearTimeout(timeoutHandle);
    abortSignal?.removeEventListener('abort', onExternalAbort);
    // Release this agent's hold on the shared session. The browser only closes
    // when the LAST agent in this credential group releases.
    if (releaseSession) {
      await releaseSession().catch((closeErr) => {
        childLogger.warn('session.release.failed', {
          error: closeErr instanceof Error ? closeErr.message : String(closeErr),
        });
      });
    }
    journey.endedAt ??= new Date().toISOString();
    journey.terminationReason ??= 'max-turns';
    // Flush raw SDK message dump (best effort — never fail a run on debug write)
    try {
      const debugDir = path.join(runDir, 'debug');
      await mkdir(debugDir, { recursive: true });
      await writeFile(
        path.join(debugDir, `${agent.id}.sdk.jsonl`),
        `${debugLines.join('\n')}\n`,
        'utf8',
      );
    } catch {
      /* ignore debug-write failures */
    }
    await persistJourney(runDir, journey);
  }

  return { journey };
}
