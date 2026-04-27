/**
 * Launches a single agent's exploration session against the direct-API loop.
 *
 * Orchestration model:
 *
 *   - Direct Anthropic SDK only — no Claude Code subprocess path. Subscription
 *     auth (`claude` CLI) is unsupported because the loop manages messages
 *     end-to-end. Spawn fails fast if no API key is available.
 *   - No engagement gate — playbooks bundle the multi-action flows so we no
 *     longer need a per-route action-counter to keep agents engaged. See
 *     spec §8.4.
 *   - Receives a shared `SiteMapAccessor` from the orchestrator. The loop's
 *     per-turn user message renders snapshots from this accessor and the
 *     browser-server's playbook handlers record outcomes through it.
 *   - No chunked compaction — runs one continuous conversation per agent.
 */

import { acquireSession } from '../auth/session-pool.ts';
import type { AuthConfig } from '../config/types.ts';
import type { SiteMapAccessor } from '../crawler/types.ts';
import { persistJourney } from '../findings/persist.ts';
import type { Logger } from '../logging/logger.ts';
import { buildDefaultRegistry } from '../playbooks/index.ts';
import { BROWSER_TOOL_NAMES, createBrowserMcpServer } from '../tools/browser-server.ts';
import { createHarnessMcpServer } from '../tools/findings-server.ts';
import type { ResolvedAgent } from '../types/agent.ts';
import type { Journey } from '../types/journey.ts';
import { runAgentLoop } from './loop.ts';
import { registerAgent, setStatus, updateOnAction } from './registry.ts';
import { SummaryMemory } from './summary-memory.ts';

export interface SpawnAgentInput {
  runId: string;
  runDir: string;
  targetUrl: string;
  allowedHosts: string[];
  auth: AuthConfig;
  agent: ResolvedAgent;
  /** Anthropic API key — REQUIRED. Subscription auth is not supported
   * on the direct-API loop because we manage messages ourselves. */
  apiKey: string;
  /** Shared sitemap accessor. Built by run before any agent spawns. */
  siteMap: SiteMapAccessor;
  logger: Logger;
  /** External abort signal — forwarded so Ctrl-C / SIGTERM cancels in-flight
   * SDK calls and tool handlers. */
  abortSignal?: AbortSignal;
  /** Whether to use CloakBrowser stealth mode for login. */
  stealth: boolean;
  /** Whether the Memory tool is enabled for agents in this run. */
  memoryEnabled: boolean;
  /** Absolute path to the per-target memory directory (pre-created by run.ts). */
  memoryPath: string;
}

export interface SpawnAgentResult {
  journey: Journey;
}

/** The exact tool names the agent's allowlist will see — browser primitives
 *  + harness tools. Playbook tool names are dynamic per-registry and not in
 *  this list; the loop accepts them via the rawTools bridge. */
export const ALLOWED_TOOL_NAMES: readonly string[] = [
  'mcp__harness__report_finding',
  'mcp__harness__end_session',
  ...BROWSER_TOOL_NAMES,
];

/**
 * Acquire a tab on the shared session, build the in-process tool stack, and
 * run the agent loop. Persists the resulting journey before returning.
 */
export async function spawnAgent(input: SpawnAgentInput): Promise<SpawnAgentResult> {
  const {
    runId,
    runDir,
    targetUrl,
    allowedHosts,
    auth,
    agent,
    apiKey,
    logger,
    abortSignal,
    stealth,
    memoryEnabled,
    memoryPath,
  } = input;
  const { budget } = agent;

  const childLogger = logger.child({ agentId: agent.id });
  registerAgent(agent.id, agent.profileName);

  // 1. Initial journey state.
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

  // 2. Acquire an authenticated tab. Multiple agents in the same credential
  // group share a single browser process — saves the 5-8s login on every
  // additional agent in that group.
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
      stealth,
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

  // 3. In-process MCP servers — harness (findings) + browser (PageModel +
  // playbooks). The browser server hosts the playbook registry as MCP
  // tools and records outcomes back into the shared SiteMap.
  const playbookRegistry = buildDefaultRegistry();
  const harnessKit = createHarnessMcpServer({
    journey,
    logger: childLogger,
    getPage: () => {
      if (!livePage) throw new Error('Browser page is no longer available');
      return livePage;
    },
    runDir,
  });
  const browserKit = createBrowserMcpServer({
    getPage: () => {
      if (!livePage) throw new Error('Browser page is no longer available');
      return livePage;
    },
    logger: childLogger,
    agentId: agent.id,
    persona: agent.personality,
    runDir,
    siteMap: input.siteMap,
    playbookRegistry,
    onAction: (patch) => updateOnAction(agent.id, patch),
    allowedHosts,
  });

  // 4. AbortController — combines the per-agent wall-clock timeout with the
  // external signal forwarded from run.
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), budget.max_minutes * 60_000);
  const onExternalAbort = () => abortController.abort();
  abortSignal?.addEventListener('abort', onExternalAbort, { once: true });

  // 5. System prompt — persona-driven, time-saturating. The prompt is
  // optimized for direct-API mode because we no longer need the engagement-gate caveat
  // or the chunked-loop framing. Playbooks are a tool category; the agent
  // picks them like any other tool.
  const systemPrompt = buildSystemPrompt({ targetUrl, agent, memoryEnabled });

  // 6. Per-agent summary memory — the loop pushes one entry per playbook
  // invocation so older turns can be elided without losing the "what have
  // I tried" context.
  const summaryMemory = new SummaryMemory();

  try {
    childLogger.info('agent.loop.mode', { mode: 'direct-api' });
    await runAgentLoop({
      agent,
      targetUrl,
      systemPrompt,
      apiKey,
      rawTools: [...harnessKit.rawTools, ...browserKit.rawTools],
      journey,
      abortSignal: abortController.signal,
      logger: childLogger,
      siteMap: input.siteMap,
      summaryMemory,
      memoryEnabled,
      memoryPath,
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

/** Build the system prompt. The persona is the goal — the agent acts as the
 *  persona using the browser primitives. Playbooks survive only as deterministic
 *  shortcuts for tasks that are tedious turn-by-turn (form-fill-and-verify,
 *  pagination, wizard traversal, security probes that need response headers). */
function buildSystemPrompt(args: {
  targetUrl: string;
  agent: ResolvedAgent;
  memoryEnabled: boolean;
}): string {
  const { targetUrl, agent, memoryEnabled } = args;

  // Memory guidance block — injected between HARNESS and HARD RULES sections
  // only when the Memory tool is enabled. Tells the agent WHAT to remember;
  // the tool itself describes its operations to the model.
  const memoryBlock: string[] = memoryEnabled
    ? [
        '',
        'MEMORY (`memory` tool) — you have a persistent notebook. It survives across runs.',
        'Use it for: stable orientation facts ("portal has admin / user / viewer roles, admin login is /admin"), bug patterns you keep noticing ("save buttons rarely show success toasts on this app"), routes you find broken so future runs skip them, and any "this approach failed before" learnings.',
        'Keep entries short and concrete. Index keys by category (e.g. files like notes/orientation, notes/known-bugs, notes/dead-ends).',
        'BEFORE choosing your first action this run, view the memory root to orient yourself. AFTER any meaningful finding or stuck moment, write a brief note.',
      ]
    : [];

  return [
    `You are NOT a QA agent. You are a real human user of ${targetUrl} — your character is described at the bottom of this prompt and you BEHAVE like that person.`,
    '',
    `OUTPUT FORMAT — emit TOOL CALLS ONLY. Zero prose. Zero narration. Every word of prose you generate is wasted latency. The ONLY exceptions: report_finding arguments and end_session detail.`,
    '',
    `You have ${agent.budget.max_minutes} minutes (and ${agent.budget.max_turns} turns). Use ALL of it. When you finish one thing, immediately start a different one.`,
    '',
    `Your browser is already open and authenticated. The orchestrator logged in for you. NEVER attempt to log in. If you ever land on a login page mid-session, that is a finding.`,
    '',
    'HOW YOU WORK:',
    '',
    'Drive the app the way YOUR PERSONA would drive it. Use the browser primitives directly. The primitives ARE your hands. Click things, type into fields, navigate, read the page, observe what happens. The persona below tells you WHAT KIND of user you are; the app tells you what to do.',
    '',
    'BROWSER PRIMITIVES (`mcp__browser__*`) — your default action vocabulary:',
    '`snapshot`, `navigate`, `click`, `type`, `fill_form`, `find_and_click`, `select_option`, `press_key`, `back`, `read_recent`, `console_errors`, `evaluate`, `storage_inspect`.',
    '',
    'PLAYBOOK HELPERS (`mcp__playbooks__*`) — deterministic shortcuts for tasks that are easy to script and tedious to drive turn-by-turn. Use one when it fits exactly; otherwise just drive the primitives.',
    '- `ask_sitemap` — query the shared sitemap for unvisited routes / untested forms / unsorted tables / unexercised modals / unexercised wizards / 4xx routes.',
    '- `route_404_probe` — bulk-probe a list of paths and flag 5xx.',
    "- `discover_route_affordances` — probe the current route for kebab menus / toolbar buttons / triggers behind affordances the link-graph crawler can't see. Auto-runs once per route; pass `force:true` after you change page state.",
    '- `fill_and_verify` — fill a form and assert specified post-submit conditions (URL change, success toast, error shown, value persisted).',
    '- `walk_pagination` — page through a table; flags duplicate or missing rows.',
    '- `walk_wizard` — step through a multi-step wizard with caller-supplied per-step inputs.',
    "- `idor_probe`, `header_audit`, `sensitive_path_audit` — security-flavoured probes (the `insider-attacker` persona uses these heavily; other personas usually don't).",
    '',
    'HARNESS:',
    '- `mcp__harness__report_finding` — file ANY finding the moment you see it. Be concrete. Then KEEP USING THE APP. A finding is NEVER a reason to stop. ONE finding per occurrence — never aggregate.',
    '- `mcp__harness__end_session` — STRICT HARD-FLOOR USE ONLY: `auth_wall`, `site_unreachable`, `browser_dead`. NEVER call because you "finished exploring".',
    ...memoryBlock,
    '',
    'HARD RULES:',
    '1. Stay in character. Do not summarise.',
    '2. Read every status line — `⚠️ ... net: 4xx/5xx ...` or `console: [pageerror] ...` is a probable finding.',
    '3. Batch tool calls aggressively — emit multiple in one turn when the actions are independent.',
    '4. The user message you receive each turn lists unvisited routes / untested forms / untested tables / untested modals. Pick something from that list (or invent your own).',
    '5. If a [SUPERVISOR INTERVENTION] line appears at the top of your prompt, treat it as the next thing to do.',
    '',
    'YOUR CHARACTER (this is who you ARE — embody them, do not narrate them):',
    agent.personality,
  ].join('\n');
}
