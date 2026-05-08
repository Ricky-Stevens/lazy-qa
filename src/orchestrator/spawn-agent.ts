/**
 * Launches a single agent's exploration session.
 *
 * Orchestration model:
 *
 *   - Routes to either the direct-API loop (`runAgentLoop`) or the SDK loop
 *     (`runAgentLoopSdk`) based on `backend.kind`. API mode uses ANTHROPIC_API_KEY;
 *     subscription mode uses the local `claude` CLI's cached OAuth token.
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
// biome-ignore lint/style/useImportType: ApiLlmBackend is used at runtime via getApiKey() — not type-only
import { ApiLlmBackend } from '../llm/api-backend.ts';
import type { LlmBackend } from '../llm/backend.ts';
import type { Logger } from '../logging/logger.ts';
import type { PlaybookContext } from '../playbooks/framework.ts';
import type { Skill, SkillsBundle } from '../skills/loader.ts';
import {
  ATTACKER_PROFILES,
  BROWSER_TOOL_NAMES,
  createBrowserMcpServer,
} from '../tools/browser-server.ts';
import { createHarnessMcpServer } from '../tools/findings-server.ts';
import type { SelectorCache } from '../tools/selector-cache.ts';
import type { ResolvedAgent } from '../types/agent.ts';
import type { Journey } from '../types/journey.ts';
import type { EventWriter } from './events.ts';
import type { FindingCache } from './finding-cache.ts';
import { runAgentLoop } from './loop.ts';
import { runAgentLoopSdk } from './loop-sdk.ts';
import { registerAgent, setStatus, updateOnAction } from './registry.ts';
import type { SharedKnowledge } from './shared-knowledge.ts';
import { SummaryMemory } from './summary-memory.ts';

export interface SpawnAgentInput {
  runId: string;
  runDir: string;
  targetUrl: string;
  allowedHosts: string[];
  auth: AuthConfig;
  agent: ResolvedAgent;
  /** Resolved LLM backend for this run. api-mode uses the Anthropic SDK
   *  directly; subscription-mode routes to runAgentLoopSdk. */
  backend: LlmBackend;
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
  /** Skills bundle loaded at run start — used to build playbook tools. */
  skillsBundle: SkillsBundle;
  /** Event writer for this run. Optional — omitted in tests that don't need it. */
  events?: EventWriter;
  /** Persistent selector cache for find_and_click. Optional — undefined when
   *  selector_cache.enabled is false in the run config. */
  selectorCache?: SelectorCache;
  /** Cross-agent finding cache. All parallel agents in this run share one
   *  instance so each turn the agent sees what others have already filed and
   *  skips rediscovery. */
  findingCache?: FindingCache;
  /** Shared cross-agent intelligence store. Threads through to the harness
   *  server (so `share_with_team` writes here), to try_login (so successful
   *  logins auto-register the credential as verified), and to the loop (so
   *  every turn renders the team intelligence block). */
  sharedKnowledge?: SharedKnowledge;
  /** Pre-resolved session identity from the auth-agent phase. Surfaced in
   *  every per-turn user message as `[session: authenticated as <user>]` so
   *  agents know they're already logged in and don't burn turns re-firing
   *  try_login against the inherited storageState. */
  sessionInfo?: { username: string; role?: string };
  /** 2-3 sentence plain-English description of the site. Rendered in the
   *  system prompt for agent orientation. */
  siteSummary?: string;
  /** Site-shape tag (ecommerce / admin-crud / content / mixed / unknown). */
  siteShape?: string;
  /** Live journey map shared with the rebalancer. When provided, the journey
   *  is registered immediately on creation so the rebalancer can read it
   *  while the agent is still running. */
  journeyMap?: Map<string, Journey>;
}

export interface SpawnAgentResult {
  journey: Journey;
}

/** The exact tool names the agent's allowlist will see — browser primitives
 *  + harness tools. Playbook tool names are dynamic per-registry and not in
 *  this list; the loop accepts them via the rawTools bridge. */
export const ALLOWED_TOOL_NAMES: readonly string[] = [
  'mcp__harness__report_finding',
  'mcp__harness__share_with_team',
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
    backend,
    logger,
    abortSignal,
    stealth,
    memoryEnabled,
    memoryPath,
    skillsBundle,
    events,
    selectorCache,
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

  input.journeyMap?.set(agent.id, journey);

  // 2. Acquire an authenticated tab. Multiple agents in the same credential
  // group share a single browser process — saves the 5-8s login on every
  // additional agent in that group.
  let livePage: Awaited<ReturnType<typeof acquireSession>>['page'] | null = null;
  let releaseSession: (() => Promise<void>) | null = null;
  const SESSION_RETRIES = 3;
  const SESSION_RETRY_DELAY_MS = 4_000;
  for (let attempt = 1; attempt <= SESSION_RETRIES; attempt++) {
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
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < SESSION_RETRIES) {
        childLogger.warn('login.retry', { agentId: agent.id, attempt, error: msg });
        await new Promise((r) => setTimeout(r, SESSION_RETRY_DELAY_MS));
      } else {
        childLogger.error('login.failed', { agentId: agent.id, error: msg });
        journey.terminationReason = 'error';
        journey.endedAt = new Date().toISOString();
        await persistJourney(runDir, journey);
        return { journey };
      }
    }
  }

  // Auto-reconnect: when the shared browser dies, try to get a fresh page.
  // The getPage() closures in the MCP servers read `livePage`, so swapping
  // it here transparently heals all tools on the next call. Best-effort —
  // if reconnection fails the agent continues with HTTP-only tools.
  if (livePage) {
    const browser = livePage.context().browser();
    if (browser) {
      const reconnect = async () => {
        childLogger.info('session.reconnect.start', { agentId: agent.id });
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
          childLogger.info('session.reconnect.ok', { agentId: agent.id });
        } catch (err) {
          childLogger.warn('session.reconnect.failed', {
            agentId: agent.id,
            error: err instanceof Error ? err.message : String(err),
          });
          livePage = null;
        }
      };
      browser.on('disconnected', () => void reconnect());
    }
  }

  // 3. In-process MCP servers — harness (findings) + browser (PageModel +
  // playbooks). The browser server receives playbook skills from the bundle
  // rather than a PlaybookRegistry; it mounts them as MCP tools directly.
  //
  // Per-persona filtering: a playbook with a non-empty `personaAllowlist`
  // is only exposed to agents whose profileName is in the list. Used to
  // keep speculative URL-guessing playbooks (sensitive_path_audit,
  // idor_probe, route_404_probe) out of functional personas' tool lists —
  // those personas drift toward cheap-finding probes and stop completing
  // real flows. Logged once at spawn so we can verify the filter is doing
  // what we expect.
  const allPlaybookSkills = Array.from(skillsBundle.playbooks.values());
  const playbookSkills = allPlaybookSkills.filter((skill) => {
    if (!skill.personaAllowlist || skill.personaAllowlist.length === 0) return true;
    return skill.personaAllowlist.includes(agent.profileName);
  });
  const filteredOut = allPlaybookSkills
    .filter((s) => !playbookSkills.includes(s))
    .map((s) => s.name);
  if (filteredOut.length > 0) {
    childLogger.debug('playbooks.filtered', {
      profile: agent.profileName,
      excluded: filteredOut,
    });
  }
  const harnessKit = createHarnessMcpServer({
    journey,
    logger: childLogger,
    getPage: () => {
      if (!livePage) throw new Error('Browser page is no longer available');
      return livePage;
    },
    runDir,
    events,
    findingCache: input.findingCache,
    sharedKnowledge: input.sharedKnowledge,
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
    playbooks: playbookSkills,
    onAction: (patch) => updateOnAction(agent.id, patch),
    allowedHosts,
    events,
    selectorCache,
    sharedKnowledge: input.sharedKnowledge,
  });

  // 4. AbortController — combines the per-agent wall-clock timeout with the
  // external signal forwarded from run.
  //
  // Two layers of timeout protection:
  //   (a) `timeoutHandle` fires `abort()` at max_minutes — the SDK is
  //       supposed to react by SIGTERMing its child, breaking the for-await
  //       in runAgentLoopSdk, and unwinding to the finally block.
  //   (b) `hardDeadlineMs` is a longer fuse that REJECTS the entire loop
  //       call. We've observed the SDK hang in `waitForExit` after the
  //       child exits but before the iterator emits `done` (see Phase-6 mid
  //       run #1). Without this, spawnAgent never returns and the parent
  //       Promise.allSettled blocks forever — even though the agent is
  //       functionally done. The race lets spawnAgent return, run.ts emits
  //       agent.end, and the SDK's leaked iterator gets GC'd at process exit.
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), budget.max_minutes * 60_000);
  const onExternalAbort = () => abortController.abort();
  abortSignal?.addEventListener('abort', onExternalAbort, { once: true });

  const HARD_DEADLINE_GRACE_MS = 60_000;
  let hardDeadlineHandle: ReturnType<typeof setTimeout> | undefined;
  function withHardDeadline<T>(p: Promise<T>): Promise<T> {
    const limitMs = budget.max_minutes * 60_000 + HARD_DEADLINE_GRACE_MS;
    const deadline = new Promise<T>((_, reject) => {
      hardDeadlineHandle = setTimeout(() => {
        // Log loudly so we can see in real-time whether this fired.
        childLogger.warn('agent.hard-deadline.fired', {
          agentId: agent.id,
          limitMs,
        });
        // Fire abort first so the SDK at least gets the signal — it might
        // unwind cleanly between the abort and the reject below.
        abortController.abort();
        reject(
          new Error(
            `agent loop hard-deadline exceeded after ${(limitMs / 1000).toFixed(0)}s`,
          ),
        );
      }, limitMs);
    });
    return Promise.race([p, deadline]);
  }

  // 5. System prompt — persona-driven, time-saturating. The prompt is
  // optimized for direct-API mode because we no longer need the engagement-gate caveat
  // or the chunked-loop framing. Playbooks are a tool category; the agent
  // picks them like any other tool.
  const systemPrompt = buildSystemPrompt({
    targetUrl,
    agent,
    memoryEnabled,
    skillsBundle,
    siteSummary: input.siteSummary,
    siteShape: input.siteShape,
  });

  // 6. Per-agent summary memory — the loop pushes one entry per playbook
  // invocation so older turns can be elided without losing the "what have
  // I tried" context.
  const summaryMemory = new SummaryMemory();

  // Emit agent.start before the loop begins.
  await events?.write({
    type: 'agent.start',
    agentId: agent.id,
    profileName: agent.profileName,
    model: agent.model,
    ...(agent.plannerModel ? { plannerModel: agent.plannerModel } : {}),
    budget: {
      max_turns: budget.max_turns,
      max_minutes: budget.max_minutes,
      max_usd: budget.max_usd,
    },
  });

  try {
    childLogger.info('agent.loop.mode', { mode: backend.kind === 'sdk' ? 'sdk' : 'api' });
    // Per-persona tool filtering. Browser primitives marked `attackerOnly`
    // (evaluate, storage_inspect, fetch_resource, request_with_session,
    // decode_jwt) are exposed only to attacker-flavoured personas. Functional
    // personas (power-user, chaos, completionist, ...) don't need them and
    // granting them encourages drift into security probing.
    const isAttackerProfile = ATTACKER_PROFILES.has(agent.profileName);
    const browserTools = browserKit.rawTools.filter((t) => !t.attackerOnly || isAttackerProfile);
    const filteredAttackerOnly = browserKit.rawTools
      .filter((t) => t.attackerOnly && !isAttackerProfile)
      .map((t) => t.name);
    if (filteredAttackerOnly.length > 0) {
      childLogger.debug('browser.tools.filtered', {
        profile: agent.profileName,
        excluded: filteredAttackerOnly,
      });
    }
    // Discriminated dispatch: SDK loop for subscription auth, raw API loop for
    // api-key auth. The else branch is api-mode (kind is 'api' | 'sdk').
    if (backend.kind === 'sdk') {
      await withHardDeadline(
        runAgentLoopSdk({
          agent,
          targetUrl,
          systemPrompt,
          // No apiKey — sub mode uses the SDK's stored auth.
          // The LoopInput interface still requires `apiKey: string`. Pass an
          // empty string here — the SDK loop never reads it.
          apiKey: '',
          rawTools: [...harnessKit.rawTools, ...browserTools],
          journey,
          abortSignal: abortController.signal,
          logger: childLogger,
          siteMap: input.siteMap,
          summaryMemory,
          memoryEnabled,
          memoryPath,
          events,
          findingCache: input.findingCache,
          sharedKnowledge: input.sharedKnowledge,
          sessionInfo: input.sessionInfo,
        }),
      );
    } else {
      // API mode — preserved behaviour. Extract raw apiKey via getApiKey()
      // (we no longer have apiKey in scope; loop.ts still expects it).
      const apiBackend = backend as ApiLlmBackend;
      await withHardDeadline(
        runAgentLoop({
          agent,
          targetUrl,
          systemPrompt,
          apiKey: apiBackend.getApiKey(),
          rawTools: [...harnessKit.rawTools, ...browserTools],
          journey,
          abortSignal: abortController.signal,
          logger: childLogger,
          siteMap: input.siteMap,
          summaryMemory,
          memoryEnabled,
          memoryPath,
          events,
          findingCache: input.findingCache,
          sharedKnowledge: input.sharedKnowledge,
          sessionInfo: input.sessionInfo,
        }),
      );
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (/hard-deadline exceeded/.test(errMsg)) {
      journey.terminationReason = 'timeout';
      childLogger.warn('agent.hard-deadline', { agentId: agent.id });
    } else if (abortController.signal.aborted) {
      journey.terminationReason = abortSignal?.aborted ? 'signal' : 'timeout';
    } else {
      journey.terminationReason = 'error';
      childLogger.error('agent.error', { agentId: agent.id, error: errMsg });
    }
  } finally {
    clearTimeout(timeoutHandle);
    if (hardDeadlineHandle) clearTimeout(hardDeadlineHandle);
    abortSignal?.removeEventListener('abort', onExternalAbort);
    if (releaseSession) {
      // Race release against a 10s timeout — Playwright's browser.close()
      // has been observed to hang when the chromium process exited
      // ungracefully (last persona to release on a shared session). The
      // browser is gone either way; we just need to free our reference and
      // move on so the parent event loop can exit.
      const release = releaseSession;
      const releaseTimeout = new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          childLogger.warn('session.release.timeout', { agentId: agent.id });
          resolve();
        }, 10_000);
        if (typeof t === 'object' && t !== null && 'unref' in t) {
          (t as { unref: () => void }).unref();
        }
      });
      await Promise.race([
        release().catch((closeErr) => {
          childLogger.warn('session.release.failed', {
            error: closeErr instanceof Error ? closeErr.message : String(closeErr),
          });
        }),
        releaseTimeout,
      ]);
    }
    journey.endedAt ??= new Date().toISOString();
    journey.terminationReason ??= 'max-turns';
    setStatus(agent.id, journey.terminationReason === 'error' ? 'errored' : 'finished');
    // Emit agent.end with final journey stats.
    await events?.write({
      type: 'agent.end',
      agentId: agent.id,
      terminationReason: journey.terminationReason,
      turns: journey.turns,
      costUsd: journey.costUsd,
      findingCount: journey.findings.length,
    });
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
  skillsBundle: SkillsBundle;
  siteSummary?: string;
  siteShape?: string;
}): string {
  const { targetUrl, agent, memoryEnabled, skillsBundle } = args;

  const memoryBlock: string[] = memoryEnabled
    ? [
        '',
        'MEMORY (`memory` tool) — you have a persistent notebook. It survives across runs.',
        'Use it for: stable orientation facts ("portal has admin / user / viewer roles, admin login is /admin"), bug patterns you keep noticing ("save buttons rarely show success toasts on this app"), routes you find broken so future runs skip them, and any "this approach failed before" learnings.',
        'Keep entries short and concrete. Index keys by category (e.g. files like notes/orientation, notes/known-bugs, notes/dead-ends).',
        'BEFORE choosing your first action this run, view the memory root to orient yourself. AFTER any meaningful finding or stuck moment, write a brief note.',
      ]
    : [];

  const playbookLines = Array.from(skillsBundle.playbooks.values())
    .map((s: Skill) => `- \`${s.name}\` — ${s.description}`)
    .join('\n');

  // Site orientation — heuristic siteShape + siteSummary from the classifier.
  // One-time system prompt injection; not repeated per-turn.
  const siteBriefBlock: string[] = [];
  if (args.siteShape || args.siteSummary) {
    siteBriefBlock.push('');
    siteBriefBlock.push('SITE ORIENTATION:');
    if (args.siteShape) siteBriefBlock.push(`Site shape: ${args.siteShape}`);
    if (args.siteSummary) siteBriefBlock.push(args.siteSummary);
  }

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
    '`snapshot`, `ax_snapshot`, `navigate`, `click`, `type`, `fill_form`, `find_and_click`, `select_option`, `press_key`, `back`, `read_recent`, `console_errors`, `evaluate`, `storage_inspect`.',
    '',
    "PRIMITIVES — `snapshot` is the full PageModel (forms, tables, modals, locators); `ax_snapshot` is a cheaper text outline of the accessibility tree (use when you just need to know what's on the page).",
    '',
    'PLAYBOOK HELPERS (`mcp__playbooks__*`) — deterministic shortcuts for tasks that are easy to script and tedious to drive turn-by-turn. Use one when it fits exactly; otherwise just drive the primitives.',
    playbookLines,
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
    ...siteBriefBlock,
    '',
    'YOUR CHARACTER (this is who you ARE — embody them, do not narrate them):',
    agent.personality,
  ].join('\n');
}

// Keep PlaybookContext re-exported so existing imports compile without changes.
export type { PlaybookContext };
