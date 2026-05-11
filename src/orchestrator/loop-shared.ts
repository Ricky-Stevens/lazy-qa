/**
 * Shared types + per-turn user message builder used by both `loop.ts` (API
 * mode) and `loop-sdk.ts` (subscription mode). Lives here so neither module
 * imports the other's value-side helpers — that previously created a runtime
 * cycle (same fix as supervisor-shared.ts).
 *
 * What lives here:
 *   - `LoopInput` interface (consumed by both loops + spawn-agent.ts).
 *   - The `PLAYBOOK_TOOL_PREFIX` constant + the `SITEMAP_TOP_N` knob.
 *   - `buildUserMessage` + every render helper it calls.
 *   - The playbook-outcome parsing helpers (`tryParsePlaybookOutcome`,
 *     `extractTargetId`, `extractRoute`, `oneLineSummary`).
 *
 * What stays in `loop.ts`:
 *   - The Anthropic-specific request builder + sliding-window compaction
 *     (these are API-mode only; SDK mode delegates context management to
 *     `query()`).
 */

import type { SiteMapAccessor } from '../crawler/types.ts';
import type { Logger } from '../logging/logger.ts';
import type { RawToolDef } from '../playbooks/framework.ts';
import type { PlaybookOutcome, PlaybookStep } from '../playbooks/outcome.ts';
import type { ResolvedAgent } from '../types/agent.ts';
import type { Journey, TerminationReason } from '../types/journey.ts';
import { computeCostUsd } from './cost.ts';
import type { EventWriter } from './events.ts';
import type { FindingCache, KnownFindingRef } from './finding-cache.ts';
import type {
  SharedBroadcast,
  SharedCredential,
  SharedDiscoveredRoute,
  SharedKnowledge,
} from './shared-knowledge.ts';
import type { SummaryMemory } from './summary-memory.ts';

/** Top-N items per sitemap snapshot section. */
export const SITEMAP_TOP_N = 10;

/** Playbook tool prefix. Must match the prefix used by the skills loader when
 *  building playbook tools. Both loops use this to detect playbook outcomes. */
export const PLAYBOOK_TOOL_PREFIX = 'mcp__playbooks__';

/** Form-touching playbooks. Tracked in `fuzzedFormIds` so the un-fuzzed-forms
 *  TODO surfaces only forms the agent has not yet acted on. */
export const FORM_TOUCHING_TOOLS: ReadonlySet<string> = new Set([
  'mcp__playbooks__form_fuzz_validation',
  'mcp__playbooks__form_double_submit',
  'mcp__playbooks__fill_and_verify',
]);

export interface LoopInput {
  agent: ResolvedAgent;
  targetUrl: string;
  systemPrompt: string;
  /** API key for the direct-API persona loop. Read by `runAgentLoop` only;
   *  `runAgentLoopSdk` (subscription mode) ignores this and authenticates via
   *  the local `claude` CLI's stored OAuth token. Pass `''` from sub-mode
   *  callers if you must. */
  apiKey: string;
  /** Primitive + macro + playbook tools, all in `RawToolDef` form. The loop
   * converts these to Anthropic Tool definitions and dispatches calls. */
  rawTools: RawToolDef[];
  journey: Journey;
  abortSignal: AbortSignal;
  logger: Logger;
  /** Shared sitemap accessor. Used to render the per-turn snapshot lines. */
  siteMap: SiteMapAccessor;
  /** Per-agent rolling memory of past playbook attempts. The loop appends to
   * this after every playbook tool result. */
  summaryMemory: SummaryMemory;
  /** Whether to include the server-side Memory tool in the request. */
  memoryEnabled: boolean;
  /** Absolute path to the per-target memory directory. Passed for context /
   * future extensions; the API manages actual I/O server-side. */
  memoryPath: string;
  /** Event writer for this run. Optional — omitted in tests that don't need it. */
  events?: EventWriter;
  /** Cross-agent finding cache. Read at the start of every turn to render
   *  a "Findings already reported by other agents" block in the user message
   *  so this agent skips rediscovery. */
  findingCache?: FindingCache;
  /** Shared cross-agent intelligence store. Read at the start of every turn
   *  to render the team intelligence block (credentials / routes / tokens)
   *  and to drain pending broadcasts targeted at this agent. */
  sharedKnowledge?: SharedKnowledge;
  /** Pre-resolved session identity. When present, every per-turn user message
   *  starts with `[session: authenticated as <user> (role=<role>) — DO NOT
   *  log out, DO NOT re-attempt login]` so the agent knows it's already
   *  authed via inherited storageState. */
  sessionInfo?: { username: string; role?: string };
}

/** Build the per-turn user message — sitemap snapshot + summary memory + continue line. */
export function buildUserMessage(args: {
  isFirstTurn: boolean;
  targetUrl: string;
  siteMap: SiteMapAccessor;
  summaryMemory: SummaryMemory;
  nudge: string | null;
  turnsCompleted: number;
  findingsCount: number;
  remainingMin: number;
  knownFindings: KnownFindingRef[];
  sharedCredentials: SharedCredential[];
  sharedRoutes: SharedDiscoveredRoute[];
  broadcasts: SharedBroadcast[];
  sessionInfo?: { username: string; role?: string };
  /** Form IDs the agent has already touched (fuzzed / filled / verified) this
   *  run. Used to render an "Un-fuzzed forms" TODO so honest personas notice
   *  forms they haven't acted on. */
  fuzzedFormIds: Set<string>;
  /** True for attacker profiles. Skips the form-fuzz TODO render for them. */
  isAttacker: boolean;
  /** Short persona-character reminder. */
  personaTagline?: string;
  /** Persona name (slug) — used to compute the task queue. */
  personaName?: string;
  /** Agent's current URL from the registry — used for stagnation detection. */
  currentUrl?: string;
  /** Consecutive turns the agent has spent on the same URL. */
  turnsOnSameUrl?: number;
  /** Turn number of the agent's most recent finding. 0 if no findings yet. */
  lastFindingTurn?: number;
}): string {
  const sections: string[] = [];

  // Short session reminder — the full banner now lives in the system prompt
  // (cached once). This per-turn line is a compact reinforcement so the
  // agent doesn't forget its auth state after sliding-window compaction.
  if (args.sessionInfo) {
    sections.push('[session: logged in]');
  }

  if (args.nudge) {
    sections.push(`[SUPERVISOR INTERVENTION — read this first]\n${args.nudge}`);
  }

  // Per-turn persona-character reminder. The persona body lives in the system
  // prompt, but after sliding-window compaction (~turn 14) the elided head no
  // longer carries the character framing. Without this re-injection, personas
  // drift toward "generic helpful agent" mode by mid-run. The tagline is short
  // (one to three lines) so it doesn't bloat the per-turn input.
  if (args.personaTagline && args.personaTagline.trim().length > 0) {
    sections.push(`[your character — stay in role]\n${args.personaTagline.trim()}`);
  }

  // Team broadcasts come BEFORE intelligence and findings so they catch the
  // model's attention. They're issued by the supervisor and typically say
  // "credentials available, log in NOW" — front-loading them is intentional.
  for (const b of args.broadcasts) {
    sections.push(`[TEAM BROADCAST]\n${b.message}`);
  }

  // Team intel: attackers get credentials + routes, QA agents only get routes
  // (they don't call try_login — credential intel wastes their input tokens).
  if (args.isAttacker) {
    const intel = renderTeamIntel(args.sharedCredentials, args.sharedRoutes);
    if (intel) sections.push(intel);
  }
  // QA agents don't have try_login or fetch_resource tools, so team-discovered
  // routes and credentials are not actionable for them. Skip to save tokens.

  // Attackers need fewer known-finding reminders (they don't care about QA dupes).
  // Cap at 5 for attackers, 15 for QA agents — saves 200-400 tokens per turn.
  const findingsCap = args.isAttacker ? 5 : 15;
  const knownBlock = renderKnownFindings(args.knownFindings.slice(0, findingsCap));
  if (knownBlock) sections.push(knownBlock);

  // Task queue: directed task list for QA agents, replaces generic exploration.
  // Attackers get the sitemap snapshot instead (they need creative freedom).
  const taskQueue =
    !args.isAttacker && args.personaName
      ? buildTaskQueue(args.personaName, args.siteMap, args.fuzzedFormIds)
      : [];

  if (taskQueue.length > 0) {
    const queueBlock = renderTaskQueue(taskQueue, args.personaName);
    if (queueBlock) sections.push(queueBlock);
  } else if (!args.isAttacker) {
    const todo = renderUnfuzzedFormsTodo(args.siteMap, args.fuzzedFormIds);
    if (todo) sections.push(todo);
  }

  // Stagnation warnings (programmatic, no LLM cost).
  if (!args.isFirstTurn) {
    const warning = buildStagnationWarning({
      turnsCompleted: args.turnsCompleted,
      findingsCount: args.findingsCount,
      lastFindingTurn: args.lastFindingTurn ?? 0,
      currentUrl: args.currentUrl,
      turnsOnSameUrl: args.turnsOnSameUrl ?? 0,
      personaName: args.personaName,
    });
    if (warning) sections.push(warning);
  }

  if (taskQueue.length === 0) {
    const snapshot = renderSiteMapSnapshot(args.siteMap);
    if (snapshot) sections.push(snapshot);
  }

  const memory = args.summaryMemory.serialize();
  if (memory) sections.push(memory);

  if (args.isFirstTurn) {
    if (taskQueue.length > 0) {
      sections.push(
        `Begin. You're already on ${args.targetUrl}. Your task queue above tells you exactly what to test. Go to the NEXT item and start.`,
      );
    } else {
      sections.push(
        `Begin. You're already on ${args.targetUrl}. Start exercising the app as your character would. Batch tool calls aggressively.`,
      );
    }
  } else {
    sections.push(
      `[continue] ${args.turnsCompleted} turns, ${args.findingsCount} findings, ~${args.remainingMin.toFixed(1)} min left. ${taskQueue.length > 0 ? 'Follow your task queue.' : 'Stay in character. Batch tool calls.'}`,
    );
  }

  return sections.join('\n\n');
}

/** Render the team-intelligence block — shared credentials and discovered
 *  routes. Empty string when both lists are empty. The credentials section
 *  has a hard "USE THESE" instruction to nudge agents (especially the
 *  attacker) toward calling `try_login` instead of going back to URL-guessing
 *  after a SQLi dump. */
export function renderTeamIntel(
  credentials: SharedCredential[],
  routes: SharedDiscoveredRoute[],
): string {
  if (credentials.length === 0 && routes.length === 0) return '';
  const lines: string[] = ['[team intelligence — discovered by other agents]'];

  if (credentials.length > 0) {
    lines.push('Credentials available — call try_login(username, password) to use them:');
    for (const c of credentials.slice(0, 10)) {
      const verified = c.loginVerified ? ' [verified]' : '';
      const role = c.role ? ` role=${c.role}` : '';
      const maskedPwd = c.password.length > 2
        ? `${c.password.slice(0, 2)}${'*'.repeat(Math.min(6, c.password.length - 2))}`
        : '****';
      lines.push(`  - ${c.username} : ${maskedPwd}${role}${verified}  (source: ${c.source})`);
    }
    if (credentials.length > 10) {
      lines.push(`  - ... +${credentials.length - 10} more`);
    }
    lines.push(
      'If your tools include try_login, log in BEFORE continuing other exploration. Authenticated sites have a much larger surface than what you see now.',
    );
  }

  if (routes.length > 0) {
    lines.push('Discovered routes (not in original sitemap):');
    for (const r of routes.slice(0, 15)) {
      const auth = r.requiresAuth ? ' [auth-required]' : '';
      const status = r.lastStatus > 0 ? ` (last:${r.lastStatus})` : '';
      lines.push(`  - ${r.url}${auth}${status}  ${r.note}`.trim());
    }
    if (routes.length > 15) {
      lines.push(`  - ... +${routes.length - 15} more`);
    }
  }

  return lines.join('\n');
}

/** Render an "Already reported by other agents" block. Returns empty string
 *  when nothing to render. Format is dense per-line so it doesn't dominate
 *  the message budget. */
export function renderKnownFindings(refs: KnownFindingRef[]): string {
  if (refs.length === 0) return '';
  const lines = ['[findings already reported by other agents — DO NOT re-file these]'];
  // Group by route so the agent can spot "this route is exhausted" at a glance.
  const byRoute = new Map<string, KnownFindingRef[]>();
  for (const r of refs) {
    const key = r.route || '(no route)';
    const arr = byRoute.get(key) ?? [];
    arr.push(r);
    byRoute.set(key, arr);
  }
  for (const [route, group] of byRoute) {
    const summary = group
      .slice(0, 3)
      .map((g) => `${g.severity}:${g.title.slice(0, 60)}`)
      .join(' | ');
    const more = group.length > 3 ? ` (+${group.length - 3} more)` : '';
    lines.push(`- ${route}: ${summary}${more}`);
  }
  lines.push(
    'Skip routes already on this list unless you can demonstrate a NEW kind of bug there. Prefer unexplored ground.',
  );
  return lines.join('\n');
}

/** Render the un-fuzzed forms TODO. Walks every route in the sitemap, lists
 *  any formIds the agent hasn't yet touched (passed any of the form-touching
 *  playbooks). Empty string when every visible form has been touched.
 *
 *  Why: honest personas spent ~3% of tool calls on fill_form across run #8 and
 *  zero of those used invalid input. Surfacing the duty in every turn message
 *  forces the agent to act on visible forms instead of just navigating. */
export function renderUnfuzzedFormsTodo(
  siteMap: SiteMapAccessor,
  fuzzedFormIds: Set<string>,
): string {
  const unfuzzedByRoute = new Map<string, string[]>();
  let totalUnfuzzed = 0;
  for (const r of siteMap.listAllRoutes()) {
    if (!r.formIds || r.formIds.length === 0) continue;
    const unfuzzed = r.formIds.filter((id) => !fuzzedFormIds.has(id));
    if (unfuzzed.length === 0) continue;
    unfuzzedByRoute.set(r.url, unfuzzed);
    totalUnfuzzed += unfuzzed.length;
    if (totalUnfuzzed >= 12) break; // cap to keep the message tight
  }
  if (totalUnfuzzed === 0) return '';

  const lines: string[] = [
    `[forms not yet fuzzed by you — ${totalUnfuzzed} pending]`,
    `Each form on the site is a target. Call mcp__playbooks__form_fuzz_validation({formId: "<id>"}) on each. Forms NOT yet touched:`,
  ];
  for (const [url, formIds] of unfuzzedByRoute) {
    lines.push(`  - ${url}  formIds: ${formIds.join(', ')}`);
  }
  lines.push(
    'You are a QA agent — un-fuzzed forms are unfinished work. Pick one, navigate to its route if not already there, and call form_fuzz_validation.',
  );
  return lines.join('\n');
}

/** Render the top-N unvisited / untested items from the sitemap. Returns
 *  empty string when the sitemap has nothing useful to surface. */
export function renderSiteMapSnapshot(siteMap: SiteMapAccessor): string {
  const lines: string[] = ['[sitemap snapshot]'];
  let included = 0;

  const unvisited = siteMap.listUnvisitedRoutes().slice(0, SITEMAP_TOP_N);
  if (unvisited.length > 0) {
    lines.push(
      `- Unvisited routes: ${unvisited.map((r) => r.route).join(', ')} (${unvisited.length})`,
    );
    included += 1;
  }

  // For "untested" we use a representative playbook per category. This is a
  // heuristic — the playbooks really track per-(playbook,target) attempts but
  // surfacing one bucket per category is enough for the agent to pick.
  const formsUntested = siteMap.listFormsUntested('fill_and_verify').slice(0, SITEMAP_TOP_N);
  if (formsUntested.length > 0) {
    lines.push(
      `- Forms not yet CRUD-tested: ${formsUntested
        .map((f) => `${f.route}:${f.formId}`)
        .join(', ')} (${formsUntested.length})`,
    );
    included += 1;
  }

  const tablesUntested = siteMap
    .listTablesUntested('table_sort_each_column')
    .slice(0, SITEMAP_TOP_N);
  if (tablesUntested.length > 0) {
    lines.push(
      `- Tables not yet sorted: ${tablesUntested
        .map((t) => `${t.route}:${t.tableId}`)
        .join(', ')} (${tablesUntested.length})`,
    );
    included += 1;
  }

  const modalsUntested = siteMap.listModalsUntested('modal_lifecycle').slice(0, SITEMAP_TOP_N);
  if (modalsUntested.length > 0) {
    lines.push(
      `- Modals not yet exercised: ${modalsUntested
        .map((m) => `${m.route}:${m.modalId}`)
        .join(', ')} (${modalsUntested.length})`,
    );
    included += 1;
  }

  // Affordance hints — what's BEHIND the buttons and kebabs the link-graph
  // crawler can't see. Show up to a few non-trivial findings per route so
  // agents know "X has an Add modal", "Y has a kebab with Edit/Disable".
  const affordanceLines = renderAffordanceHints(siteMap);
  if (affordanceLines.length > 0) {
    lines.push(...affordanceLines);
    included += 1;
  }

  return included === 0 ? '' : lines.join('\n');
}

/** Build short "what's behind this" lines from probed affordances. We only
 * surface non-trivial outcomes (modal/wizard/menu/inline-form) and limit
 * total bytes so the per-turn message stays small. Routes are ordered
 * recently-visited-first so the byte budget biases toward routes the agent
 * just touched (and might want to deepen) rather than insertion order. */
export function renderAffordanceHints(siteMap: SiteMapAccessor): string[] {
  const out: string[] = [];
  let bytesUsed = 0;
  const BYTE_BUDGET = 1200;

  const sortedRoutes = siteMap.listAllRoutes().sort((a, b) => {
    // Recently-visited first (descending visitedAt). Unvisited routes go
    // last so we don't spend the byte budget on routes nobody's been to.
    if (a.visitedAt && b.visitedAt) {
      return b.visitedAt.localeCompare(a.visitedAt);
    }
    if (a.visitedAt) return -1;
    if (b.visitedAt) return 1;
    return 0;
  });

  for (const route of sortedRoutes) {
    if (bytesUsed > BYTE_BUDGET) break;
    const model = siteMap.getPageModel(route.route);
    const discovered = model?.discovered ?? [];
    if (discovered.length === 0) continue;

    const items: string[] = [];
    for (const d of discovered) {
      switch (d.outcome.kind) {
        case 'modal':
          items.push(
            `${d.trigger.label}→modal "${d.outcome.modalName}"${d.outcome.hasForm ? '+form' : ''}`,
          );
          break;
        case 'wizard':
          items.push(
            `${d.trigger.label}→wizard "${d.outcome.wizardName}" (${d.outcome.stepCount} steps)`,
          );
          break;
        case 'inline-form':
          items.push(`${d.trigger.label}→inline-form "${d.outcome.formName}"`);
          break;
        case 'menu': {
          const sample = d.outcome.items.slice(0, 4).join('/');
          items.push(`${d.trigger.label}→menu [${sample}]`);
          break;
        }
        // navigation/inert/error/toast deliberately omitted — low signal
      }
    }
    if (items.length === 0) continue;
    const line = `- Affordances ${route.route}: ${items.slice(0, 6).join('; ')}`;
    bytesUsed += line.length + 1;
    if (bytesUsed > BYTE_BUDGET) break;
    out.push(line);
  }
  return out;
}

/** Try to parse a playbook outcome from a tool-result text. Returns null if
 *  the text doesn't look like a serialised PlaybookOutcome.
 *
 *  Supports two formats:
 *  1. JSON — a `{...}` blob anywhere in the text with `playbookName`, `status`,
 *     `summary` keys.
 *  2. YAML-like key: value lines emitted by `serializeOutcome()` in
 *     browser-server.ts — `playbook:`, `status:`, `summary:`, optionally
 *     `evidence:`, `durationMs:`, `steps:`, etc.
 */
export function tryParsePlaybookOutcome(text: string): PlaybookOutcome | null {
  // Empty or trivially short results aren't outcomes.
  if (!text || text.length < 20) return null;

  // --- Attempt 1: JSON blob ---
  const jsonStart = text.indexOf('{');
  if (jsonStart >= 0) {
    const jsonCandidate = text.slice(jsonStart);
    try {
      const parsed: unknown = JSON.parse(jsonCandidate);
      if (parsed && typeof parsed === 'object') {
        const o = parsed as Record<string, unknown>;
        if (
          typeof o.playbookName === 'string' &&
          typeof o.status === 'string' &&
          (o.status === 'ok' || o.status === 'failed' || o.status === 'suspicious') &&
          typeof o.summary === 'string'
        ) {
          return o as unknown as PlaybookOutcome;
        }
      }
    } catch {
      // Not valid JSON — fall through to YAML-like parsing.
    }
  }

  // --- Attempt 2: YAML-like key: value lines (serializeOutcome format) ---
  return tryParseYamlLikeOutcome(text);
}

const VALID_STATUSES = new Set(['ok', 'failed', 'suspicious']);

/** Parse the compact `key: value` text format emitted by `serializeOutcome`.
 *  Returns null if the required fields (`playbook`, `status`, `summary`) are
 *  missing or invalid. */
function tryParseYamlLikeOutcome(text: string): PlaybookOutcome | null {
  const lines = text.split('\n');

  let playbookName: string | undefined;
  let status: 'ok' | 'failed' | 'suspicious' | undefined;
  let summary: string | undefined;
  let evidence: Record<string, unknown> = {};
  let durationMs = 0;
  const steps: PlaybookStep[] = [];
  let inSteps = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // Sub-step lines when inside the `steps:` block.
    if (inSteps) {
      // Step lines look like:  - [ok] Label — detail
      const stepMatch = line.match(/^-\s+\[(ok|FAIL)]\s+(.+)$/);
      if (stepMatch) {
        const ok = stepMatch[1] === 'ok';
        const rest = stepMatch[2]!;
        const dashIdx = rest.indexOf(' — ');
        if (dashIdx >= 0) {
          steps.push({ label: rest.slice(0, dashIdx), ok, detail: rest.slice(dashIdx + 3) });
        } else {
          steps.push({ label: rest, ok });
        }
        continue;
      }
      // Any non-step line exits the steps block.
      inSteps = false;
    }

    // Top-level key: value
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();

    switch (key) {
      case 'playbook':
        playbookName = value;
        break;
      case 'status':
        if (VALID_STATUSES.has(value)) status = value as typeof status;
        break;
      case 'summary':
        summary = value;
        break;
      case 'evidence':
        try {
          evidence = JSON.parse(value) as Record<string, unknown>;
        } catch {
          // evidence value isn't valid JSON — store raw string under a key.
          evidence = { raw: value };
        }
        break;
      case 'durationMs':
        durationMs = Number(value) || 0;
        break;
      case 'steps':
        inSteps = true;
        break;
      // network anomalies / console errors / screenshot — informational only,
      // not needed for the PlaybookOutcome object consumed downstream.
    }
  }

  if (!playbookName || !status || !summary) return null;

  return {
    playbookName,
    status,
    summary,
    evidence,
    signals: { networkAnomalies: [], consoleErrors: [] },
    steps,
    durationMs,
  };
}

/** Extract a target id from the playbook tool input. Most playbooks pass it
 *  as `formId` / `tableId` / `modalId` / `wizardId`. Returns null if absent. */
export function extractTargetId(input: Record<string, unknown>): string | null {
  for (const key of ['formId', 'tableId', 'modalId', 'wizardId']) {
    const v = input[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/** Extract a route from a PlaybookOutcome's evidence, when present. The
 *  browser server's playbook handler is expected to inject this. */
export function extractRoute(outcome: PlaybookOutcome): string | null {
  const ev = outcome.evidence;
  if (!ev) return null;
  const v = (ev as Record<string, unknown>).route;
  return typeof v === 'string' ? v : null;
}

/** Trim the playbook summary to a single line, capped at 160 chars. */
export function oneLineSummary(outcome: PlaybookOutcome): string {
  const firstLine = (outcome.summary ?? '').split('\n')[0]?.trim() ?? '';
  if (firstLine.length <= 160) return firstLine;
  return `${firstLine.slice(0, 157)}...`;
}

/** Extract a short persona tagline from the persona body for per-turn
 *  re-injection. Strategy: find the `# Closing` section (every well-formed
 *  persona ends with a 1-3 line identity reinforcement under that heading)
 *  and return its prose. If no `# Closing` heading, fall back to the first
 *  paragraph after `# Mindset` or `# Personality`. Returns empty string if
 *  neither pattern matches — caller should treat that as "no reminder".
 *
 *  Capped at 400 chars so the per-turn injection stays tight. Goal is identity
 *  reinforcement, not full persona replay.
 */
export function extractPersonaTagline(body: string): string {
  if (!body) return '';
  // Prefer the # Closing section.
  const closingMatch = body.match(/^#+\s*Closing\s*\n+([\s\S]*?)(?:\n#+\s|\n*$)/im);
  if (closingMatch?.[1]) {
    const text = closingMatch[1].trim();
    if (text.length > 0) return text.length <= 400 ? text : `${text.slice(0, 397)}...`;
  }
  // Fall back to first paragraph after # Mindset / # Personality.
  const introMatch = body.match(/^#+\s*(?:Mindset|Personality)\s*\n+([\s\S]*?)(?:\n#+\s|\n*$)/im);
  if (introMatch?.[1]) {
    const firstPara = introMatch[1].split(/\n\s*\n/)[0]?.trim() ?? '';
    if (firstPara.length > 0)
      return firstPara.length <= 400 ? firstPara : `${firstPara.slice(0, 397)}...`;
  }
  return '';
}

// ─── Task Queue ──────────────────────────────────────────────────────────────

const PERSONA_TASK_PROFILE: Record<
  string,
  {
    label: string;
    query: 'forms' | 'tables' | 'routes' | 'modals';
    playbook?: string;
  }
> = {
  'all-your-base': {
    label: 'test boundary values on',
    query: 'forms',
    playbook: 'form_fuzz_validation',
  },
  'there-is-no-spoon': { label: 'submit empty', query: 'forms', playbook: 'form_fuzz_validation' },
  'copy-pasta': { label: 'double-submit', query: 'forms', playbook: 'form_double_submit' },
  'wreck-it-ralph': {
    label: 'wrong-type input on',
    query: 'forms',
    playbook: 'form_fuzz_validation',
  },
  longcat: { label: 'layout-stress', query: 'forms', playbook: 'form_fuzz_validation' },
  mulder: { label: 'save-and-reload', query: 'forms', playbook: 'fill_and_verify' },
  'leeroy-jenkins': {
    label: 'interrupt mid-flow on',
    query: 'forms',
    playbook: 'form_fuzz_validation',
  },
  'marty-mcfly': { label: 'skip steps on', query: 'forms', playbook: 'form_fuzz_validation' },
  'pac-man': { label: 'volume-test', query: 'tables', playbook: 'table_sort_each_column' },
  sheldon: { label: 'accessibility-check', query: 'routes' },
  'bonzi-buddy': { label: 'bad-URL probe', query: 'routes' },
  'press-f': { label: 'stale-state probe', query: 'routes' },
  konami: { label: 'hidden-UI probe', query: 'routes' },
  karen: { label: 'happy-path walk', query: 'routes' },
};

export interface TaskQueueItem {
  route: string;
  targetId?: string;
  action: string;
}

export function buildTaskQueue(
  personaName: string,
  siteMap: SiteMapAccessor,
  fuzzedFormIds: Set<string>,
): TaskQueueItem[] {
  const profile = PERSONA_TASK_PROFILE[personaName];
  if (!profile) return [];

  const items: TaskQueueItem[] = [];
  const MAX_QUEUE = 15;

  switch (profile.query) {
    case 'forms': {
      const playbook = profile.playbook ?? 'form_fuzz_validation';
      const untested = siteMap.listFormsUntested(playbook);
      for (const f of untested) {
        if (fuzzedFormIds.has(f.formId)) continue;
        items.push({
          route: f.route,
          targetId: f.formId,
          action: `${profile.label} form "${f.formId}"`,
        });
        if (items.length >= MAX_QUEUE) break;
      }
      break;
    }
    case 'tables': {
      const playbook = profile.playbook ?? 'table_sort_each_column';
      const untested = siteMap.listTablesUntested(playbook);
      for (const t of untested) {
        items.push({
          route: t.route,
          targetId: t.tableId,
          action: `${profile.label} table "${t.tableId}"`,
        });
        if (items.length >= MAX_QUEUE) break;
      }
      break;
    }
    case 'routes': {
      const unvisited = siteMap.listUnvisitedRoutes();
      const visited = siteMap.listAllRoutes().filter((r) => r.visited);
      const candidates = [...unvisited, ...visited];
      for (const r of candidates) {
        items.push({ route: r.route, action: `${profile.label} ${r.route}` });
        if (items.length >= MAX_QUEUE) break;
      }
      break;
    }
    case 'modals': {
      const untested = siteMap.listModalsUntested(profile.playbook ?? 'modal_lifecycle');
      for (const m of untested) {
        items.push({
          route: m.route,
          targetId: m.modalId,
          action: `${profile.label} modal "${m.modalId}"`,
        });
        if (items.length >= MAX_QUEUE) break;
      }
      break;
    }
  }
  return items;
}

const DEPTH_PERSONAS = new Set(['sheldon', 'konami', 'karen', 'press-f']);

export function renderTaskQueue(queue: TaskQueueItem[], personaName?: string): string {
  if (queue.length === 0) return '';
  const isDepth = personaName ? DEPTH_PERSONAS.has(personaName) : false;
  const lines: string[] = [`[YOUR TASK QUEUE — ${queue.length} remaining]`];
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i]!;
    const prefix = i === 0 ? 'NEXT →' : `${i + 1}.`;
    const target = item.targetId ? `${item.route} (${item.targetId})` : item.route;
    lines.push(`  ${prefix} ${item.action} at ${target}`);
    if (i >= 7 && queue.length > 8) {
      lines.push(`  ... +${queue.length - 8} more`);
      break;
    }
  }
  if (isDepth) {
    lines.push(
      'Navigate to the NEXT item. Test it THOROUGHLY — spend multiple turns if needed. Report findings. Move on when you are satisfied, not before.',
    );
  } else {
    lines.push(
      'Navigate to the NEXT item. Test it. Report findings. Move on. Do NOT skip items or wander.',
    );
  }
  return lines.join('\n');
}

// ─── Stagnation Detection ────────────────────────────────────────────────────

export function buildStagnationWarning(args: {
  turnsCompleted: number;
  findingsCount: number;
  lastFindingTurn: number;
  currentUrl: string | undefined;
  turnsOnSameUrl: number;
  personaName?: string;
}): string {
  const warnings: string[] = [];
  const isDepth = args.personaName ? DEPTH_PERSONAS.has(args.personaName) : false;
  const stuckThreshold = isDepth ? 6 : 3;

  if (args.turnsOnSameUrl >= stuckThreshold && args.turnsCompleted > 5) {
    warnings.push(
      `⚠ STUCK: You have been on ${args.currentUrl ?? 'the same page'} for ${args.turnsOnSameUrl} turns. Navigate to a different page NOW.`,
    );
  }

  const turnsSinceFinding = args.turnsCompleted - args.lastFindingTurn;
  if (turnsSinceFinding >= 8 && args.turnsCompleted > 10) {
    warnings.push(
      `⚠ STAGNANT: ${turnsSinceFinding} turns since your last finding. Move to the next untested item in your task queue.`,
    );
  }

  if (args.turnsCompleted >= 12 && args.findingsCount === 0) {
    warnings.push(
      '⚠ ZERO FINDINGS after 12 turns. You are not being productive. Change your approach completely.',
    );
  }

  return warnings.length > 0 ? `[AUTOMATED PERFORMANCE WARNING]\n${warnings.join('\n')}` : '';
}

// ─── Turn Tracking ──────────────────────────────────────────────────────────

/** Mutable per-agent state tracked across turns for stagnation detection and
 *  per-turn user message rendering. Both loop.ts and loop-sdk.ts maintain an
 *  instance and call `updateTurnTracking` each turn. */
export interface TurnTracker {
  turnsOnSameUrl: number;
  previousUrl: string | undefined;
  lastFindingTurn: number;
  previousFindingsCount: number;
}

export function createTurnTracker(): TurnTracker {
  return {
    turnsOnSameUrl: 0,
    previousUrl: undefined,
    lastFindingTurn: 0,
    previousFindingsCount: 0,
  };
}

/** Update turn-tracking state from the current agent state and journey.
 *  Mutates `tracker` in place. */
export function updateTurnTracking(
  tracker: TurnTracker,
  currentUrl: string | undefined,
  journey: Journey,
): void {
  if (currentUrl && currentUrl === tracker.previousUrl) {
    tracker.turnsOnSameUrl += 1;
  } else {
    tracker.turnsOnSameUrl = 0;
    tracker.previousUrl = currentUrl;
  }
  if (journey.findings.length > tracker.previousFindingsCount) {
    tracker.lastFindingTurn = journey.turns;
    tracker.previousFindingsCount = journey.findings.length;
  }
}

// ─── Scope Completion ───────────────────────────────────────────────────────

/** Check whether a QA agent's task queue is empty (all assigned work done).
 *  Returns true if the agent should terminate with 'scope-complete'. Attackers
 *  and agents without a task profile always return false. */
export function checkScopeComplete(
  agent: ResolvedAgent,
  siteMap: SiteMapAccessor,
  fuzzedFormIds: Set<string>,
  journey: Journey,
  isAttacker: boolean,
): boolean {
  if (isAttacker) return false;
  if (journey.turns < 8) return false;
  const queue = buildTaskQueue(agent.profileName, siteMap, fuzzedFormIds);
  return queue.length === 0;
}

// ─── Cost Accumulation ──────────────────────────────────────────────────────

/** Per-turn token usage shape used by both loops. */
export interface TurnTokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Accumulate a single turn's token usage and cost onto the journey.
 *  Returns the USD delta for this turn (0 if the model is unknown). */
export function accumulateTurnCost(
  journey: Journey,
  model: string,
  usage: TurnTokenUsage,
): number {
  journey.tokenUsage.input += usage.input;
  journey.tokenUsage.output += usage.output;
  journey.tokenUsage.cacheRead += usage.cacheRead;
  journey.tokenUsage.cacheWrite += usage.cacheWrite;
  try {
    const delta = computeCostUsd(model, usage);
    journey.costUsd += delta;
    return delta;
  } catch {
    return 0;
  }
}

// ─── Termination Reason Resolution ──────────────────────────────────────────

/** Set a graceful termination reason when the loop exits without one.
 *  Checks abort, budget, and max-turns in priority order. */
export function resolveTerminationReason(
  journey: Journey,
  agent: ResolvedAgent,
  abortSignal: AbortSignal,
): TerminationReason {
  if (abortSignal.aborted) return 'signal';
  if (journey.costUsd >= agent.budget.max_usd) return 'budget-hit';
  const elapsedMs = Date.now() - new Date(journey.startedAt).getTime();
  if (elapsedMs >= agent.budget.max_minutes * 60_000) return 'timeout';
  if (journey.turns >= agent.budget.max_turns) return 'max-turns';
  return 'max-turns';
}
