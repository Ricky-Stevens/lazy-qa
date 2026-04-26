import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { recoverAllSessions } from '../auth/session-pool.ts';
import type { Logger } from '../logging/logger.ts';
import type { RawToolDef } from '../tools/browser-server.ts';
import { computeCostUsd } from './cost.ts';
import {
  count4xxIn,
  getGlobalPauseSnapshot,
  pushNudge,
  setGlobalPause,
  snapshotAll,
} from './registry.ts';

/**
 * Supervisor agent. Watches the explorer agents via the runtime registry,
 * intervenes aggressively when they get stuck.
 *
 * Detects (aggressive mode):
 *   - auth_walled (URL on Auth0 login/logout) → call relogin_session, nudge
 *   - no progress in 60s → nudge with a specific suggestion
 *   - repetitive loop (last 5 tools same on same area, no findings) → nudge
 *   - page tunneling (>120s on same route, no new findings) → nudge to move on
 *
 * Tools available: list_agents, relogin_session, nudge_agent, wait, end_session.
 * No browser tools. No findings tools. The supervisor does NOT explore.
 *
 * Implementation: direct Anthropic SDK only — the supervisor's tools are
 * synthesised here; no MCP subprocess needed. Runs concurrently with the
 * explorer agents in run.ts via Promise.allSettled.
 */

export interface SupervisorInput {
  apiKey: string;
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
}

export interface SupervisorResult {
  turns: number;
  costUsd: number;
  endedReason: 'all-finished' | 'budget-hit' | 'max-turns' | 'signal' | 'error' | 'self-ended';
  reloginCount: number;
  nudgeCount: number;
  pauseCount: number;
}

const SYSTEM_PROMPT = `You are the SUPERVISOR. Other AI agents are exploring a target portal in parallel; your job is to keep them productive and unblock them aggressively.

You do NOT explore. You do NOT have browser tools. You only orchestrate.

YOUR LOOP:
1. Call list_agents to see all agents' state.
2. Identify problems aggressively (see DETECTION RULES below).
3. Take action: relogin_session for auth issues, pause_agents for backend storms, nudge_agent for stuck agents.
4. Call wait({seconds: 30}) — DO NOT poll faster than every 30s. The agents need time to act on your interventions.
5. Repeat until every agent is status='finished' or status='errored'.

OUTPUT FORMAT: Tool calls only. Zero prose. Zero "I'll now check...". Zero "Let me see...". Only call tools.

DETECTION RULES (intervene aggressively, don't second-guess):

1. AUTH-WALLED — agent.authWalled=true OR agent.currentUrl contains auth0.com/u/login or oidc/logout or v2/logout
   → ACTION: relogin_session() once per detected auth wall (it dedupes, so calling it for multiple auth-walled agents in one turn is fine — call it ONCE).
   → THEN: nudge_agent(each affected agentId, "Session was recovered by the supervisor. Reload the page (mcp__browser__navigate to the dashboard) and continue exploring. Do NOT try to log in yourself.")

2. BACKEND STORM — TWO OR MORE agents have recent4xxCount >= 5 in the same window, OR ANY agent has recent4xxCount >= 10. This means the backend is unhealthy (WAF cool-down, rate limit, dependency down) and agents will burn budget filing duplicate findings.
   → FIRST ACTION: try relogin_session() once — sometimes the storm is just session expiry.
   → THEN: pause_agents({duration_seconds: 60, reason: "backend 4xx storm — waiting for recovery"}). This makes ALL agents sleep on their next action; saves token cost while the backend recovers.
   → AFTER PAUSE: on your next cycle, check list_agents again. If recent4xxCount is now low, nudge_agent each affected agent to retry the dashboard. If it's still high after 2 pauses, the backend is genuinely down — let the agents end naturally (do NOT keep pausing forever).

3. NO PROGRESS — Date.now() - agent.lastActionAt > 60_000 (>60s since last browser action) AND status === 'active' AND NOT currently paused
   → ACTION: nudge_agent(agentId, "You haven't taken an action in over a minute. Try a completely different approach: <reference their recentTools and currentUrl to suggest something specific, e.g. 'open a kebab menu on a table row' or 'navigate to the dashboard and pick a different module'>.")

4. REPETITIVE LOOP — recentTools shows the SAME tool name 5+ times AND findingsCount has not increased in those turns
   → ACTION: nudge_agent(agentId, "You're stuck repeating <tool>. Stop and try something different: navigate to a sibling page, or use find_and_click with a different hint, or open a row's actions menu. Whatever you've been doing for the last 5 turns is not working.")

5. PAGE TUNNELING — same currentUrl for >120s with high turnsCompleted relative to startedAt and no new findings in that window
   → ACTION: nudge_agent(agentId, "You've been on <route> for over 2 minutes without finding anything new. There are other modules/areas — move on. Navigate to a sibling area in the nav or to the dashboard, then pick a different feature to investigate.")

WHEN TO STOP:
- All agents have status='finished' or 'errored' → call end_session({reason: "all explorers done"}).
- You have called list_agents and it returned an empty array AFTER you've previously seen agents → wait 60s, check again. If still empty, end_session.
- Hard rule: never end_session while ANY agent is still active or auth_walled.

BE SPECIFIC IN NUDGES. Reference what the agent was actually doing. A vague nudge is wasted; a nudge that names their currentUrl + recentTools and points to a concrete next step is what unblocks them.`;

export async function runSupervisor(input: SupervisorInput): Promise<SupervisorResult> {
  const client = new Anthropic({ apiKey: input.apiKey });
  const startedAt = Date.now();
  let turns = 0;
  let costUsd = 0;
  let reloginCount = 0;
  let nudgeCount = 0;
  let pauseCount = 0;
  let selfEnded = false;
  let endedReason: SupervisorResult['endedReason'] = 'max-turns';

  const tokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  // Tool definitions. RawToolDef shape is reused so we get z.toJSONSchema for free.
  const rawTools: RawToolDef[] = [
    {
      name: 'list_agents',
      description:
        'Return live runtime state for every explorer agent: id, profileName, status (starting | active | auth_walled | finished | errored), currentUrl, last action timestamp, last turn timestamp, findings count, turns completed, recent tool names, pending nudge. Call this at the start of each cycle to decide who needs help.',
      shape: {},
      handler: async () => {
        const all = snapshotAll();
        const now = Date.now();
        const globalPause = getGlobalPauseSnapshot();
        const lines = all.map((a) => {
          const lastActionAgo = a.lastActionAt ? Math.round((now - a.lastActionAt) / 1000) : null;
          const lastTurnAgo = a.lastTurnAt ? Math.round((now - a.lastTurnAt) / 1000) : null;
          const recent4xx = count4xxIn(a.agentId, 30_000);
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
        const text =
          lines.length === 0
            ? 'No agents registered yet. Wait and check again.'
            : `${header}Agents (${lines.length}):\n${lines.join('\n')}`;
        return { content: [{ type: 'text' as const, text }] };
      },
    },
    {
      name: 'relogin_session',
      description:
        'Re-authenticate every active shared browser session. Use this when ANY agent is auth_walled. The harness opens a recovery tab on each shared context, fills the login form, and closes the tab. Cookies are context-scoped so all agents on that session immediately see the new auth. Deduplicates concurrent calls — calling more than once per minute is harmless but wasteful.',
      shape: {},
      handler: async () => {
        const result = await recoverAllSessions();
        reloginCount += 1;
        const text = `relogin_session result: ok=${result.ok} recovered=${result.recovered} failed=${result.failed} | ${result.detail}`;
        input.logger.info('supervisor.relogin', {
          ok: result.ok,
          recovered: result.recovered,
          failed: result.failed,
          detail: result.detail,
        });
        return { content: [{ type: 'text' as const, text }] };
      },
    },
    {
      name: 'nudge_agent',
      description:
        "Queue a directive message for a specific agent. The message is delivered as a [SUPERVISOR INTERVENTION] line at the top of that agent's next chunk's user prompt (≤30s latency). Be specific: name what they were doing, what to try instead. A vague nudge is wasted. ONE pending nudge per agent — calling again before consumption overwrites the previous nudge.",
      shape: {
        agentId: z.string().min(1).describe('The agentId from list_agents.'),
        message: z
          .string()
          .min(20)
          .max(1000)
          .describe(
            'Directive for the agent. Reference their currentUrl and recentTools. Tell them what to do, not what to think about.',
          ),
      },
      handler: async (args) => {
        const { agentId, message } = args as { agentId: string; message: string };
        const ok = pushNudge(agentId, message);
        if (ok) nudgeCount += 1;
        const text = ok
          ? `Nudge queued for ${agentId}. They will read it at the start of their next chunk (≤30s).`
          : `Failed: no agent registered with id '${agentId}'. Call list_agents to see valid IDs.`;
        input.logger.info('supervisor.nudge', { agentId, ok, preview: message.slice(0, 200) });
        return { content: [{ type: 'text' as const, text }] };
      },
    },
    {
      name: 'pause_agents',
      description:
        "Pause ALL explorer agents for the given duration. Agents' next browser action will sleep until the pause expires (capped at 30s per call, but the pause persists across calls — they re-sleep on each subsequent action). Use when the backend is unhealthy (multi-agent 4xx storm, global outage) so agents stop burning budget thrashing on errors. Calling again before the previous pause expires extends it. Clamped to [10, 180] seconds.",
      shape: {
        duration_seconds: z.number().int().min(10).max(180),
        reason: z
          .string()
          .min(10)
          .max(200)
          .describe('Why the pause is needed. Surfaced in agent logs and useful for debugging.'),
      },
      handler: async (args) => {
        const { duration_seconds, reason } = args as {
          duration_seconds: number;
          reason: string;
        };
        const clamped = Math.max(10, Math.min(180, duration_seconds));
        const until = Date.now() + clamped * 1000;
        setGlobalPause(until, reason);
        pauseCount += 1;
        input.logger.info('supervisor.pause_agents', { durationSec: clamped, reason });
        return {
          content: [
            {
              type: 'text' as const,
              text: `pause_agents: all agents will sleep until ~${clamped}s from now. Reason: ${reason}. Their next browser action will block; nudges and finding reports continue to work.`,
            },
          ],
        };
      },
    },
    {
      name: 'wait',
      description:
        'Pause for the specified number of seconds before your next turn. The harness sleeps real time — do not poll faster than every 30 seconds. Clamped to [10, 120].',
      shape: {
        seconds: z.number().int().min(10).max(120),
      },
      handler: async (args) => {
        const { seconds } = args as { seconds: number };
        const clamped = Math.max(10, Math.min(120, seconds));
        await new Promise((r) => setTimeout(r, clamped * 1000));
        return { content: [{ type: 'text' as const, text: `Waited ${clamped}s.` }] };
      },
    },
    {
      name: 'end_session',
      description:
        'Stop the supervisor loop. Use ONLY when all agents have status=finished or status=errored. NEVER use while any agent is still active or auth_walled.',
      shape: {
        reason: z.string().min(5).max(200),
      },
      handler: async (args) => {
        const { reason } = args as { reason: string };
        selfEnded = true;
        input.logger.info('supervisor.end_session', { reason });
        return { content: [{ type: 'text' as const, text: `Supervisor ending: ${reason}` }] };
      },
    },
  ];

  const anthropicTools: Anthropic.Tool[] = rawTools.map((rt) => {
    const objSchema = z.object(rt.shape);
    const jsonSchema = z.toJSONSchema(objSchema) as Record<string, unknown>;
    return {
      name: rt.name,
      description: rt.description,
      input_schema: jsonSchema as Anthropic.Tool['input_schema'],
    };
  });

  const handlerByName = new Map(rawTools.map((rt) => [rt.name, rt.handler]));

  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content:
        'Begin supervising. Call list_agents to see who is active, then act. Do not narrate.',
    },
  ];

  while (
    !input.abortSignal.aborted &&
    !selfEnded &&
    turns < input.maxTurns &&
    costUsd < input.maxUsd &&
    Date.now() - startedAt < input.maxMinutes * 60_000
  ) {
    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: input.model,
        max_tokens: 2048,
        system: [
          {
            type: 'text',
            text: SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
        ],
        messages,
        tools: anthropicTools,
      });
    } catch (err) {
      if (input.abortSignal.aborted) {
        endedReason = 'signal';
      } else {
        endedReason = 'error';
        input.logger.error('supervisor.api.error', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    turns += 1;
    const usage = response.usage;
    tokenUsage.input += usage.input_tokens ?? 0;
    tokenUsage.output += usage.output_tokens ?? 0;
    tokenUsage.cacheRead += usage.cache_read_input_tokens ?? 0;
    tokenUsage.cacheWrite += usage.cache_creation_input_tokens ?? 0;
    try {
      costUsd = computeCostUsd(input.model, tokenUsage);
    } catch {
      // Unknown model → keep going on token totals only.
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );

    if (toolUses.length === 0) {
      // No tool call → supervisor emitted prose only. That's a violation of
      // its prompt; nudge it back into shape.
      messages.push({
        role: 'user',
        content:
          'You output text without calling a tool. That is forbidden. Call list_agents now, then act, then wait.',
      });
      continue;
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
      toolUses.map(async (use) => {
        const handler = handlerByName.get(use.name);
        if (!handler) {
          return {
            type: 'tool_result',
            tool_use_id: use.id,
            content: `Unknown tool: ${use.name}`,
            is_error: true,
          } satisfies Anthropic.ToolResultBlockParam;
        }
        try {
          const result = await handler(use.input as Record<string, unknown>);
          const text = result.content[0]?.text ?? '';
          return {
            type: 'tool_result',
            tool_use_id: use.id,
            content: text,
          } satisfies Anthropic.ToolResultBlockParam;
        } catch (err) {
          return {
            type: 'tool_result',
            tool_use_id: use.id,
            content: err instanceof Error ? err.message : String(err),
            is_error: true,
          } satisfies Anthropic.ToolResultBlockParam;
        }
      }),
    );

    messages.push({ role: 'user', content: toolResults });

    if (selfEnded) {
      endedReason = 'self-ended';
      break;
    }

    // Cheap belt-and-braces: if every registered agent is in a terminal state,
    // we can stop early without waiting for the supervisor to call end_session.
    const all = snapshotAll();
    if (all.length > 0 && all.every((a) => a.status === 'finished' || a.status === 'errored')) {
      endedReason = 'all-finished';
      break;
    }
  }

  if (input.abortSignal.aborted && endedReason === 'max-turns') endedReason = 'signal';
  if (costUsd >= input.maxUsd && endedReason === 'max-turns') endedReason = 'budget-hit';

  input.logger.info('supervisor.complete', {
    turns,
    costUsd: costUsd.toFixed(4),
    reloginCount,
    nudgeCount,
    pauseCount,
    endedReason,
  });

  return { turns, costUsd, endedReason, reloginCount, nudgeCount, pauseCount };
}
