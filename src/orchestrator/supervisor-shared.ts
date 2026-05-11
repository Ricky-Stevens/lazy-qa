/**
 * Shared types + system-prompt builder for both `supervisor.ts` (API mode) and
 * `supervisor-sdk.ts` (subscription mode). Lives here so neither module needs
 * to import from the other at the value level — that previously created a
 * runtime cycle.
 */

import { recoverAllSessions } from '../auth/session-pool.ts';
import type { SiteMapAccessor } from '../crawler/types.ts';
import type { LlmBackend } from '../llm/backend.ts';
import type { Logger } from '../logging/logger.ts';
import type { EventWriter } from './events.ts';
import {
  count4xxIn,
  count5xxIn,
  getGlobalPauseSnapshot,
  pushNudge,
  setGlobalPause,
  snapshotAll,
} from './registry.ts';
import type { SharedKnowledge } from './shared-knowledge.ts';

export interface SupervisorInput {
  backend: LlmBackend;
  model: string;
  /** Wall-clock cap for the supervisor itself. Should be ≥ the longest agent
   * budget so the supervisor stays alive while explorers run. */
  maxMinutes: number;
  /** Hard cost cap. Supervisor is cheap (sleeps a lot), but bound it. */
  maxUsd: number;
  /** Bound on supervisor turns (each turn = one model response). */
  maxTurns: number;
  abortSignal: AbortSignal;
  logger: Logger;
  /** Event writer for this run. Optional — emits supervisor.intervention events. */
  events?: EventWriter;
  /** Target auth type — 'form' or 'none'. When 'none', the relogin_session
   *  tactic is hidden (there's no login to perform; the recovery handler
   *  would just fail with a confusing message). */
  authType: 'form' | 'none';
  /** Shared cross-agent intelligence store. The supervisor reads from this to
   *  surface team intel in list_agents and writes to it via broadcast_to_team
   *  to push directives at all explorers. */
  sharedKnowledge?: SharedKnowledge;
  /** Site map accessor — used to compute exhausted routes (routes where all
   *  applicable playbooks have completed) so the supervisor can steer agents
   *  away from already-tested pages. */
  siteMap?: import('../crawler/types.ts').SiteMapAccessor;
  testPlan?: import('./test-plan.ts').TestPlan;
}

export interface SupervisorResult {
  turns: number;
  costUsd: number;
  endedReason: 'all-finished' | 'budget-hit' | 'max-turns' | 'signal' | 'error' | 'self-ended';
  reloginCount: number;
  nudgeCount: number;
  pauseCount: number;
  broadcastCount: number;
}

export function buildSystemPrompt(authType: 'form' | 'none'): string {
  const reloginAvailable = authType === 'form';
  const authWalledRule = reloginAvailable
    ? `1. AUTH-WALLED — agent.authWalled=true OR agent.currentUrl contains auth0.com/u/login or oidc/logout or v2/logout
   → ACTION: relogin_session() once per detected auth wall (it dedupes, so calling it for multiple auth-walled agents in one turn is fine — call it ONCE).
   → THEN: nudge_agent(each affected agentId, "Session was recovered by the supervisor. Reload the page (mcp__browser__navigate to the dashboard) and continue exploring. Do NOT try to log in yourself.")`
    : `1. AUTH-WALLED — auth.type='none' for this run, so there is NO login to recover. The relogin_session tactic is unavailable. If an agent appears auth-walled (lots of 401/403, currentUrl on a login page) it means the agent has navigated somewhere that requires auth this run can't provide.
   → ACTION: nudge_agent(agentId, "This run has no credentials. Stop trying to access authenticated endpoints; explore the public surface (homepage, search, public APIs returning 200) and stay focused on what's reachable.")`;

  // Storm detection is TRIANGULATED — single-agent 5xx is just that agent
  // probing or hitting a flaky endpoint, never a reason to pause others. The
  // signal we trust is CORRELATED 5xx across multiple agents: if 2+ agents
  // simultaneously see XHR/fetch 5xx (document 5xx is excluded upstream),
  // the backend is genuinely sick and pausing everyone protects budget.
  const stormRule = reloginAvailable
    ? `2. BACKEND STORM (triangulated) — TWO OR MORE agents simultaneously have recent5xxCount >= 3. ALL of these conditions must hold:
   - At least 2 distinct agents
   - Each above the threshold in the same window
   This is the ONLY storm signal. A single agent at recent5xxCount=20 is NOT a storm — that agent is just probing endpoints or hit a flaky API; let them self-throttle. Pausing the whole run would punish healthy agents for one agent's behaviour.
   → FIRST ACTION: try relogin_session() once — sometimes correlated 5xx is downstream of stale sessions across agents.
   → THEN: pause_agents({duration_seconds: 60, reason: "backend 5xx storm across N agents — waiting for recovery"}).
   → AFTER PAUSE: on the next cycle, if multi-agent 5xx is now resolved, nudge each agent to retry. If it stays high across 2 pauses, the backend is genuinely down — let agents end naturally (do NOT keep pausing forever).`
    : `2. BACKEND STORM (triangulated) — TWO OR MORE agents simultaneously have recent5xxCount >= 3. ALL conditions must hold:
   - At least 2 distinct agents
   - Each above the threshold in the same window
   This is the ONLY storm signal. A single agent's 5xx is just that agent probing/hitting a flaky endpoint — NEVER pause the whole run for one agent's mess. Pausing healthy agents because one is probing wastes everyone's budget.
   → ACTION: pause_agents({duration_seconds: 60, reason: "backend 5xx storm across N agents — waiting for recovery"}).
   → AFTER PAUSE: on the next cycle, if multi-agent 5xx is resolved, nudge each agent to retry. If still elevated after 2 pauses, the backend is genuinely down — let agents end naturally.`;

  return `You are the SUPERVISOR. Other AI agents are exploring a target portal in parallel; your job is to keep them productive and unblock them aggressively.

You do NOT explore. You do NOT have browser tools. You only orchestrate.

YOUR LOOP:
1. Call list_agents to see all agents' state.
2. Identify problems aggressively (see DETECTION RULES below).
3. Take action: ${reloginAvailable ? 'relogin_session for auth issues, ' : ''}pause_agents for backend storms, nudge_agent for stuck agents.
4. Call wait({seconds: 30}) — DO NOT poll faster than every 30s. The agents need time to act on your interventions.
5. Repeat until every agent is status='finished' or status='errored'.

OUTPUT FORMAT: Tool calls only. Zero prose. Zero "I'll now check...". Zero "Let me see...". Only call tools.

DETECTION RULES (intervene aggressively, don't second-guess):

${authWalledRule}

${stormRule}

3. NO PROGRESS — Date.now() - agent.lastActionAt > 60_000 (>60s since last browser action) AND status === 'active' AND NOT currently paused
   → ACTION: nudge_agent(agentId, "You haven't taken an action in over a minute. Try a completely different approach: <reference their recentTools and currentUrl to suggest something specific, e.g. 'open a kebab menu on a table row' or 'navigate to the dashboard and pick a different module'>.")
   → EXHAUSTED ROUTES: if list_agents shows "Exhausted routes" — agents on those routes MUST navigate away immediately. Include the exhausted routes list in your nudge: "Route X is fully tested. Navigate to <untested route> instead."
   → IMPORTANT: if an agent's currentUrl matches an exhausted route, nudge them EVEN IF they have been active recently. Exhausted routes should not be re-explored.

4. NEW TEAM INTELLIGENCE — list_agents shows teamIntel.credentials > 0 OR teamIntel.routes > 0 (whatever growth happened since the last cycle). Specifically watch for newly shared CREDENTIALS — they are gold and must be broadcast immediately.
   → CREDENTIALS: broadcast_to_team({message: "Team intelligence: credentials available — username=<X>, password=<Y> (source: <Z>). Call try_login(<X>, <Y>) on your next turn. The authenticated surface has many more affordances; explore there before returning to anonymous routes."})
       Also nudge the SHARING agent: "You just shared credentials with the team — IMMEDIATELY call try_login(<X>, <Y>) yourself before continuing."
   → NEW AUTH-REQUIRED ROUTE: broadcast_to_team({message: "New authenticated route discovered: <URL> (note: <Z>). Once you've logged in via try_login, navigate there to explore."}) — only broadcast if not previously broadcast.
   → DO NOT spam broadcasts. One broadcast per credential set, one per significant route. The harness watermarks per-agent so messages aren't re-shown, but excessive broadcasts crowd out your other directives.

5. COVERAGE TRACKING — if check_plan_coverage is available, call it every 2-3 cycles (not every cycle — let agents work). If items remain uncovered and agents are idle or finishing, nudge the most appropriate active agent toward the uncovered item. Reference the specific uncovered item in your nudge: "The test plan item [form-validation on /clients] hasn't been covered yet — navigate there and run form_fuzz_validation on the form."

WHEN TO STOP:
- All agents have status='finished' or 'errored' → call end_session({reason: "all explorers done"}).
- You have called list_agents and it returned an empty array AFTER you've previously seen agents → wait 60s, check again. If still empty, end_session.
- Hard rule: never end_session while ANY agent is still active or auth_walled.

BE SPECIFIC IN NUDGES. Reference what the agent was actually doing. A vague nudge is wasted; a nudge that names their currentUrl + recentTools and points to a concrete next step is what unblocks them.`;
}

// ─── Supervisor Tracker ─────────────────────────────────────────────────────

/** Mutable counters for supervisor interventions and cost tracking. Both
 *  supervisor.ts and supervisor-sdk.ts create one at the start and pass it
 *  into the shared handler functions. */
export class SupervisorTracker {
  reloginCount = 0;
  nudgeCount = 0;
  pauseCount = 0;
  broadcastCount = 0;
  selfEnded = false;
  endedReason: SupervisorResult['endedReason'] = 'max-turns';

  toResult(turns: number, costUsd: number): SupervisorResult {
    return {
      turns,
      costUsd,
      endedReason: this.endedReason,
      reloginCount: this.reloginCount,
      nudgeCount: this.nudgeCount,
      pauseCount: this.pauseCount,
      broadcastCount: this.broadcastCount,
    };
  }
}

// ─── Shared Tool Handlers ───────────────────────────────────────────────────
// Pure-logic handler bodies extracted from supervisor.ts / supervisor-sdk.ts.
// Both variants wrap these in their respective tool definitions (RawToolDef
// for API mode, tool() for SDK mode). The wrappers pass `input`, `tracker`,
// and `events` from their outer closure.

/** Canonical MCP CallToolResult shape — both API-mode and SDK-mode return this. */
export type ToolResult = { content: Array<{ type: 'text'; text: string }> };
function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

export async function handleListAgents(
  input: SupervisorInput,
): Promise<ToolResult> {
  const all = snapshotAll();
  const now = Date.now();
  const globalPause = getGlobalPauseSnapshot();
  const lines = all.map((a) => {
    const lastActionAgo = a.lastActionAt ? Math.round((now - a.lastActionAt) / 1000) : null;
    const lastTurnAgo = a.lastTurnAt ? Math.round((now - a.lastTurnAt) / 1000) : null;
    const recent4xx = count4xxIn(a.agentId, 30_000);
    const recent5xx = count5xxIn(a.agentId, 30_000);
    const agentPauseRemainingSec =
      a.pauseUntil && a.pauseUntil > now ? Math.round((a.pauseUntil - now) / 1000) : 0;
    return JSON.stringify({
      agentId: a.agentId,
      profile: a.profileName,
      status: a.status,
      authWalled: a.authWalled,
      currentUrl: a.currentUrl,
      lastActionSecondsAgo: lastActionAgo,
      lastTurnSecondsAgo: lastTurnAgo,
      turns: a.turnsCompleted,
      findings: a.findingsCount,
      recentTools: a.recentTools,
      recent4xxCount: recent4xx,
      recent5xxCount: recent5xx,
      agentPauseRemainingSec,
      hasPendingNudge: a.pendingNudge !== null,
    });
  });
  const globalPauseRemainingSec =
    globalPause.until > now ? Math.round((globalPause.until - now) / 1000) : 0;
  const header =
    globalPauseRemainingSec > 0
      ? `Global pause: ${globalPauseRemainingSec}s remaining (reason: ${globalPause.reason}).\n`
      : '';

  let intelText = '';
  if (input.sharedKnowledge) {
    const snap = input.sharedKnowledge.snapshot();
    if (snap.credentials.length > 0 || snap.routes.length > 0) {
      const intelLines: string[] = ['Team intelligence:'];
      if (snap.credentials.length > 0) {
        intelLines.push(`  Credentials (${snap.credentials.length}):`);
        for (const c of snap.credentials.slice(0, 8)) {
          const ver = c.loginVerified ? ' [verified]' : '';
          intelLines.push(
            `    ${c.username}:${c.password.slice(0, 3)}***${ver} (by ${c.foundBy}, source: ${c.source})`,
          );
        }
      }
      if (snap.routes.length > 0) {
        intelLines.push(`  Discovered routes (${snap.routes.length}):`);
        for (const r of snap.routes.slice(0, 10)) {
          intelLines.push(
            `    ${r.url} ${r.requiresAuth ? '[auth]' : ''} status=${r.lastStatus} (by ${r.foundBy})`,
          );
        }
      }
      intelText = `${intelLines.join('\n')}\n\n`;
    }
  }

  let exhaustedText = '';
  if (input.siteMap) {
    exhaustedText = renderExhaustedRoutes(input.siteMap);
  }

  const text =
    lines.length === 0
      ? `${intelText}No agents registered yet. Wait and check again.`
      : `${header}${intelText}${exhaustedText}Agents (${lines.length}):\n${lines.join('\n')}`;
  return textResult(text);
}

/** Compute the exhausted-routes block for list_agents output. Extracted so
 *  both API and SDK handlers stay clean. */
function renderExhaustedRoutes(siteMap: SiteMapAccessor): string {
  const untestedForms = new Set(
    siteMap.listFormsUntested('form_fuzz_validation').map((f) => f.route),
  );
  const untestedTables = new Set(
    siteMap.listTablesUntested('table_sort_each_column').map((t) => t.route),
  );
  const untestedModals = new Set(
    siteMap.listModalsUntested('modal_lifecycle').map((m) => m.route),
  );
  const untestedWizards = new Set(
    siteMap.listWizardsUntested('walk_wizard').map((w) => w.route),
  );
  const allRoutes = siteMap.listAllRoutes();
  const exhausted = allRoutes
    .filter((r) => {
      if (!r.visited) return false;
      const hasAffordances =
        r.formIds.length > 0 ||
        r.tableIds.length > 0 ||
        r.modalIds.length > 0 ||
        r.wizardIds.length > 0;
      if (!hasAffordances) return false;
      return (
        !untestedForms.has(r.route) &&
        !untestedTables.has(r.route) &&
        !untestedModals.has(r.route) &&
        !untestedWizards.has(r.route)
      );
    })
    .map((r) => r.route);
  if (exhausted.length === 0) return '';
  return `\nExhausted routes (fully tested — agents should AVOID these):\n  ${exhausted.slice(0, 30).join('\n  ')}\n`;
}

export async function handleBroadcast(
  input: SupervisorInput,
  tracker: SupervisorTracker,
  args: { message: string; for_profile?: string },
): Promise<ToolResult> {
  const { message, for_profile } = args;
  if (!input.sharedKnowledge) {
    return textResult(
      'broadcast_to_team is unavailable in this run (no SharedKnowledge instance). Use nudge_agent instead.',
    );
  }
  input.sharedKnowledge.addBroadcast({
    message,
    forProfile: for_profile,
    issuedBy: 'supervisor',
    issuedAt: new Date().toISOString(),
  });
  tracker.broadcastCount += 1;
  input.logger.info('supervisor.broadcast', {
    forProfile: for_profile,
    preview: message.slice(0, 200),
  });
  await input.events?.write({
    type: 'team.broadcast',
    message,
    forProfile: for_profile,
  });
  return textResult(
    `Broadcast queued${for_profile ? ` for profile=${for_profile}` : ' for all agents'}. Each agent will see the message exactly once on their next turn.`,
  );
}

export async function handleRelogin(
  input: SupervisorInput,
  tracker: SupervisorTracker,
): Promise<ToolResult> {
  const result = await recoverAllSessions();
  tracker.reloginCount += 1;
  const text = `relogin_session result: ok=${result.ok} recovered=${result.recovered} failed=${result.failed} | ${result.detail}`;
  input.logger.info('supervisor.relogin', {
    ok: result.ok,
    recovered: result.recovered,
    failed: result.failed,
    detail: result.detail,
  });
  await input.events?.write({
    type: 'supervisor.intervention',
    kind: 'auth-walled',
    detail: `relogin: ok=${result.ok} recovered=${result.recovered} failed=${result.failed} — ${result.detail}`,
  });
  return textResult(text);
}

export async function handleNudge(
  input: SupervisorInput,
  tracker: SupervisorTracker,
  args: { agentId: string; message: string },
): Promise<ToolResult> {
  const { agentId, message } = args;
  const ok = pushNudge(agentId, message);
  if (ok) tracker.nudgeCount += 1;
  const text = ok
    ? `Nudge queued for ${agentId}. They will read it at the start of their next chunk (≤30s).`
    : `Failed: no agent registered with id '${agentId}'. Call list_agents to see valid IDs.`;
  input.logger.info('supervisor.nudge', { agentId, ok, preview: message.slice(0, 200) });
  if (ok) {
    await input.events?.write({
      type: 'supervisor.intervention',
      kind: 'no-progress',
      detail: `nudge → ${agentId}: ${message.slice(0, 200)}`,
    });
  }
  return textResult(text);
}

export async function handlePause(
  input: SupervisorInput,
  tracker: SupervisorTracker,
  args: { duration_seconds: number; reason: string },
): Promise<ToolResult> {
  const { duration_seconds, reason } = args;
  const clamped = Math.max(10, Math.min(180, duration_seconds));
  const until = Date.now() + clamped * 1000;
  setGlobalPause(until, reason);
  tracker.pauseCount += 1;
  input.logger.info('supervisor.pause_agents', { durationSec: clamped, reason });
  await input.events?.write({
    type: 'supervisor.intervention',
    kind: 'backend-storm',
    detail: `pause_agents ${clamped}s: ${reason}`,
  });
  return textResult(
    `pause_agents: all agents will sleep until ~${clamped}s from now. Reason: ${reason}. Their next browser action will block; nudges and finding reports continue to work.`,
  );
}

export async function handleWait(args: { seconds: number }): Promise<ToolResult> {
  const clamped = Math.max(10, Math.min(120, args.seconds));
  await new Promise((r) => setTimeout(r, clamped * 1000));
  return textResult(`Waited ${clamped}s.`);
}

export async function handleEndSession(
  input: SupervisorInput,
  tracker: SupervisorTracker,
  args: { reason: string },
): Promise<ToolResult> {
  tracker.selfEnded = true;
  input.logger.info('supervisor.end_session', { reason: args.reason });
  return textResult(`Supervisor ending: ${args.reason}`);
}

/** Tool descriptions — shared across both API-mode (as part of RawToolDef) and
 *  SDK-mode (as tool() description arg). Avoids the twin copies drifting. */
export const SUPERVISOR_TOOL_DESCRIPTIONS = {
  list_agents:
    'Return live runtime state for every explorer agent: id, profileName, status (starting | active | auth_walled | finished | errored), currentUrl, last action timestamp, last turn timestamp, findings count, turns completed, recent tool names, pending nudge. Call this at the start of each cycle to decide who needs help.',
  broadcast_to_team:
    'Push a directive to ALL agents (or all agents matching a profile). Distinct from nudge_agent which targets ONE agent — broadcasts go to every explorer. Use for team-wide intelligence: "credentials X:Y are available, log in now", "admin panel discovered at /admin/users, prioritise it", "target backend is down for everyone, switch to read-only exploration". The harness watermarks per-agent so each broadcast renders exactly once per agent. Cap broadcasts at one per significant team event — repeated broadcasts on the same topic are noise.',
  relogin_session:
    'Re-authenticate every active shared browser session. Use this when ANY agent is auth_walled. The harness opens a recovery tab on each shared context, fills the login form, and closes the tab. Cookies are context-scoped so all agents on that session immediately see the new auth. Deduplicates concurrent calls — calling more than once per minute is harmless but wasteful.',
  nudge_agent:
    "Queue a directive message for a specific agent. The message is delivered as a [SUPERVISOR INTERVENTION] line at the top of that agent's next chunk's user prompt (≤30s latency). Be specific: name what they were doing, what to try instead. A vague nudge is wasted. ONE pending nudge per agent — calling again before consumption overwrites the previous nudge.",
  pause_agents:
    "Pause ALL explorer agents for the given duration. Agents' next browser action will sleep until the pause expires (capped at 30s per call, but the pause persists across calls — they re-sleep on each subsequent action). Use when the backend is unhealthy (multi-agent 4xx storm, global outage) so agents stop burning budget thrashing on errors. Calling again before the previous pause expires extends it. Clamped to [10, 180] seconds.",
  wait: 'Pause for the specified number of seconds before your next turn. The harness sleeps real time — do not poll faster than every 30 seconds. Clamped to [10, 120].',
  end_session:
    'Stop the supervisor loop. Use ONLY when all agents have status=finished or status=errored. NEVER use while any agent is still active or auth_walled.',
} as const;
