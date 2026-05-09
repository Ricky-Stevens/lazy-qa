/**
 * Shared types + system-prompt builder for both `supervisor.ts` (API mode) and
 * `supervisor-sdk.ts` (subscription mode). Lives here so neither module needs
 * to import from the other at the value level — that previously created a
 * runtime cycle.
 */

import type { LlmBackend } from '../llm/backend.ts';
import type { Logger } from '../logging/logger.ts';
import type { EventWriter } from './events.ts';
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
