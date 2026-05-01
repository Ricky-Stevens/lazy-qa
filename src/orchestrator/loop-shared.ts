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
import type { PlaybookOutcome } from '../playbooks/outcome.ts';
import type { ResolvedAgent } from '../types/agent.ts';
import type { Journey } from '../types/journey.ts';
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
  /** Site-playbook text generated for this persona. When present AND the agent
   *  is not an attacker, a compact reminder block is rendered in every per-turn
   *  user message. Without per-turn reinforcement the brief stops being
   *  load-bearing past turn 1 — agents follow the first sentence then drift.
   *  Excluded for attackers (their freedom-to-attack is a deliberate property). */
  sitePlaybookText?: string;
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
  sitePlaybookText?: string;
  /** Form IDs the agent has already touched (fuzzed / filled / verified) this
   *  run. Used to render an "Un-fuzzed forms" TODO so honest personas notice
   *  forms they haven't acted on. */
  fuzzedFormIds: Set<string>;
  /** True for attacker profiles. Skips the form-fuzz TODO render for them. */
  isAttacker: boolean;
  /** Short persona-character reminder. Re-injected EVERY turn so the persona's
   *  identity survives sliding-window compaction (the system prompt's persona
   *  body gets elided after ~14 messages). Without this, by turn 20 The Spanner
   *  drifts to "I should fill the form correctly" and The Magpie stops hoarding.
   *  Typically the persona's `# Closing` line — extracted by the caller. */
  personaTagline?: string;
}): string {
  const sections: string[] = [];

  // Session banner — appears FIRST on every turn so the agent always knows
  // it's already authenticated. Without this, agents that inherited auth via
  // storageState would burn turns re-firing try_login against the inherited
  // session (the page at /login looks like a normal login form even when
  // the cookie+localStorage already carry a valid token).
  if (args.sessionInfo) {
    const roleStr = args.sessionInfo.role ? ` (role=${args.sessionInfo.role})` : '';
    sections.push(
      `[session: AUTHENTICATED as ${args.sessionInfo.username}${roleStr}] You are already logged in via inherited storageState (cookies + localStorage carry a valid session token). DO NOT call try_login. DO NOT log out under ANY circumstances. DO NOT navigate to /logout, /signout, /sign-out, or click any "Logout"/"Sign out" link — even by accident. If team intelligence credentials match this session, ignore them. Spend your turns exercising authenticated functionality.`,
    );
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

  const intel = renderTeamIntel(args.sharedCredentials, args.sharedRoutes);
  if (intel) sections.push(intel);

  // Per-turn site-playbook reminder. The brief is also in the system prompt,
  // but a compact reinforcement here keeps it load-bearing past turn 1 — without
  // it agents follow the first sentence then drift back to "explore the
  // snapshot." Skipped for attackers (filtered upstream).
  if (args.sitePlaybookText && args.sitePlaybookText.trim().length > 0) {
    sections.push(
      [
        "[your plan for this site — pursue it, don't drift]",
        args.sitePlaybookText.trim(),
        'If a step in the plan succeeds with no surprises, move to the NEXT step rather than re-exploring. Plan steps not yet attempted are higher-priority than the snapshot below.',
      ].join('\n'),
    );
  }

  const knownBlock = renderKnownFindings(args.knownFindings);
  if (knownBlock) sections.push(knownBlock);

  // Un-fuzzed forms TODO. Honest personas only — attackers have a different
  // job (they probe APIs, not UI forms, in the typical attack surface).
  if (!args.isAttacker) {
    const todo = renderUnfuzzedFormsTodo(args.siteMap, args.fuzzedFormIds);
    if (todo) sections.push(todo);
  }

  const snapshot = renderSiteMapSnapshot(args.siteMap);
  if (snapshot) sections.push(snapshot);

  const memory = args.summaryMemory.serialize();
  if (memory) sections.push(memory);

  if (args.isFirstTurn) {
    sections.push(
      `Begin. You're already on ${args.targetUrl}. Pick a playbook from the list above (or invent your own action via the primitive browser tools) and start exercising the app as your character would.`,
    );
  } else {
    sections.push(
      [
        `[continue] Progress: ${args.turnsCompleted} turns, ${args.findingsCount} findings, ~${args.remainingMin.toFixed(1)} min remaining.`,
        `Stay in character. Pick something from the snapshot above you have NOT yet touched. Batch tool calls aggressively.`,
      ].join('\n'),
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
      lines.push(`  - ${c.username} : ${c.password}${role}${verified}  (source: ${c.source})`);
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
  const formsUntested = siteMap.listFormsUntested('crud_create_form').slice(0, SITEMAP_TOP_N);
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
 *  the text doesn't look like a serialised PlaybookOutcome. */
export function tryParsePlaybookOutcome(text: string): PlaybookOutcome | null {
  // Empty or trivially short results aren't outcomes.
  if (!text || text.length < 20) return null;
  // Find the first JSON object in the text — playbook handlers may prefix
  // a one-line summary line then a JSON blob, or be pure JSON.
  const jsonStart = text.indexOf('{');
  if (jsonStart < 0) return null;
  const jsonCandidate = text.slice(jsonStart);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonCandidate);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.playbookName !== 'string') return null;
  if (typeof o.status !== 'string') return null;
  if (o.status !== 'ok' && o.status !== 'failed' && o.status !== 'suspicious') return null;
  if (typeof o.summary !== 'string') return null;
  return o as unknown as PlaybookOutcome;
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
