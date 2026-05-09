/**
 * SDK-driven supervisor. Parallel implementation of supervisor.ts that runs the
 * same 7-tool supervise loop under `query()` from
 * `@anthropic-ai/claude-agent-sdk` instead of raw `messages.create`.
 *
 * Public surface is identical to supervisor.ts:
 *   runSupervisorSdk(input: SupervisorInput): Promise<SupervisorResult>
 *
 * Key differences vs API-mode supervisor.ts:
 *   - Tools are wired as a single MCP server via `tool()` + `createSdkMcpServer`
 *   - The driving prompt is an async generator: one initial seed message then
 *     a continuation message per turn until termination conditions are met
 *   - AbortController is bridged from input.abortSignal (same as loop-sdk.ts /
 *     auth-agent-sdk.ts)
 *
 * NOTE: The supervisor does NOT inject per-turn snapshots (unlike auth-agent-sdk).
 * The agent reads agent state itself via the list_agents tool when it wants to.
 * The continuation message just says "Continue." to keep the SDK loop alive.
 */

import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { recoverAllSessions } from '../auth/session-pool.ts';
import { resolveClaudeBinaryPath } from '../llm/sdk-binary.ts';
import { computeCostUsd } from './cost.ts';
import {
  count4xxIn,
  count5xxIn,
  getGlobalPauseSnapshot,
  pushNudge,
  setGlobalPause,
  snapshotAll,
} from './registry.ts';
import {
  buildSystemPrompt,
  type SupervisorInput,
  type SupervisorResult,
} from './supervisor-shared.ts';

/** Wrap a plain text string as an MCP CallToolResult content block. */
function textResult(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] };
}

export async function runSupervisorSdk(input: SupervisorInput): Promise<SupervisorResult> {
  const { events } = input;
  const startedAt = Date.now();
  let turn = 0;
  let costUsd = 0;
  let reloginCount = 0;
  let nudgeCount = 0;
  let pauseCount = 0;
  let broadcastCount = 0;
  let selfEnded = false;
  let endedReason: SupervisorResult['endedReason'] = 'max-turns';
  const tokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  const systemPrompt = buildSystemPrompt(input.authType);

  // Build all 7 tools using the SDK tool() wrapper.
  // Handlers are byte-for-byte equivalent to the corresponding rawTools entries
  // in supervisor.ts — same logic, same events emitted.

  const listAgentsTool = tool(
    'list_agents',
    'Return live runtime state for every explorer agent: id, profileName, status (starting | active | auth_walled | finished | errored), currentUrl, last action timestamp, last turn timestamp, findings count, turns completed, recent tool names, pending nudge. Call this at the start of each cycle to decide who needs help.',
    {},
    async () => {
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
        const untestedForms = new Set(
          input.siteMap.listFormsUntested('form_fuzz_validation').map((f) => f.route),
        );
        const untestedTables = new Set(
          input.siteMap.listTablesUntested('table_sort_each_column').map((t) => t.route),
        );
        const untestedModals = new Set(
          input.siteMap.listModalsUntested('modal_lifecycle').map((m) => m.route),
        );
        const untestedWizards = new Set(
          input.siteMap.listWizardsUntested('walk_wizard').map((w) => w.route),
        );
        const allRoutes = input.siteMap.listAllRoutes();
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
        if (exhausted.length > 0) {
          exhaustedText = `\nExhausted routes (fully tested — agents should AVOID these):\n  ${exhausted.slice(0, 30).join('\n  ')}\n`;
        }
      }

      const text =
        lines.length === 0
          ? `${intelText}No agents registered yet. Wait and check again.`
          : `${header}${intelText}${exhaustedText}Agents (${lines.length}):\n${lines.join('\n')}`;
      return textResult(text);
    },
  );

  const broadcastToTeamTool = tool(
    'broadcast_to_team',
    'Push a directive to ALL agents (or all agents matching a profile). Distinct from nudge_agent which targets ONE agent — broadcasts go to every explorer. Use for team-wide intelligence: "credentials X:Y are available, log in now", "admin panel discovered at /admin/users, prioritise it", "target backend is down for everyone, switch to read-only exploration". The harness watermarks per-agent so each broadcast renders exactly once per agent. Cap broadcasts at one per significant team event — repeated broadcasts on the same topic are noise.',
    {
      message: z
        .string()
        .min(20)
        .max(800)
        .describe(
          'The directive. Be concrete: include the credentials/URL/instructions agents will need.',
        ),
      for_profile: z
        .string()
        .optional()
        .describe(
          'Optional: scope the broadcast to agents whose profileName matches (e.g. "bobby-tables"). Omit to broadcast to all profiles.',
        ),
    },
    async ({ message, for_profile }: { message: string; for_profile?: string }) => {
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
      broadcastCount += 1;
      input.logger.info('supervisor.broadcast', {
        forProfile: for_profile,
        preview: message.slice(0, 200),
      });
      await events?.write({
        type: 'team.broadcast',
        message,
        forProfile: for_profile,
      });
      return textResult(
        `Broadcast queued${for_profile ? ` for profile=${for_profile}` : ' for all agents'}. Each agent will see the message exactly once on their next turn.`,
      );
    },
  );

  const reloginSessionTool = tool(
    'relogin_session',
    'Re-authenticate every active shared browser session. Use this when ANY agent is auth_walled. The harness opens a recovery tab on each shared context, fills the login form, and closes the tab. Cookies are context-scoped so all agents on that session immediately see the new auth. Deduplicates concurrent calls — calling more than once per minute is harmless but wasteful.',
    {},
    async () => {
      const result = await recoverAllSessions();
      reloginCount += 1;
      const text = `relogin_session result: ok=${result.ok} recovered=${result.recovered} failed=${result.failed} | ${result.detail}`;
      input.logger.info('supervisor.relogin', {
        ok: result.ok,
        recovered: result.recovered,
        failed: result.failed,
        detail: result.detail,
      });
      await events?.write({
        type: 'supervisor.intervention',
        kind: 'auth-walled',
        detail: `relogin: ok=${result.ok} recovered=${result.recovered} failed=${result.failed} — ${result.detail}`,
      });
      return textResult(text);
    },
  );

  const nudgeAgentTool = tool(
    'nudge_agent',
    "Queue a directive message for a specific agent. The message is delivered as a [SUPERVISOR INTERVENTION] line at the top of that agent's next chunk's user prompt (≤30s latency). Be specific: name what they were doing, what to try instead. A vague nudge is wasted. ONE pending nudge per agent — calling again before consumption overwrites the previous nudge.",
    {
      agentId: z.string().min(1).describe('The agentId from list_agents.'),
      message: z
        .string()
        .min(20)
        .max(1000)
        .describe(
          'Directive for the agent. Reference their currentUrl and recentTools. Tell them what to do, not what to think about.',
        ),
    },
    async ({ agentId, message }: { agentId: string; message: string }) => {
      const ok = pushNudge(agentId, message);
      if (ok) nudgeCount += 1;
      const text = ok
        ? `Nudge queued for ${agentId}. They will read it at the start of their next chunk (≤30s).`
        : `Failed: no agent registered with id '${agentId}'. Call list_agents to see valid IDs.`;
      input.logger.info('supervisor.nudge', { agentId, ok, preview: message.slice(0, 200) });
      if (ok) {
        await events?.write({
          type: 'supervisor.intervention',
          kind: 'no-progress',
          detail: `nudge → ${agentId}: ${message.slice(0, 200)}`,
        });
      }
      return textResult(text);
    },
  );

  const pauseAgentsTool = tool(
    'pause_agents',
    "Pause ALL explorer agents for the given duration. Agents' next browser action will sleep until the pause expires (capped at 30s per call, but the pause persists across calls — they re-sleep on each subsequent action). Use when the backend is unhealthy (multi-agent 4xx storm, global outage) so agents stop burning budget thrashing on errors. Calling again before the previous pause expires extends it. Clamped to [10, 180] seconds.",
    {
      duration_seconds: z.number().int().min(10).max(180),
      reason: z
        .string()
        .min(10)
        .max(200)
        .describe('Why the pause is needed. Surfaced in agent logs and useful for debugging.'),
    },
    async ({ duration_seconds, reason }: { duration_seconds: number; reason: string }) => {
      const clamped = Math.max(10, Math.min(180, duration_seconds));
      const until = Date.now() + clamped * 1000;
      setGlobalPause(until, reason);
      pauseCount += 1;
      input.logger.info('supervisor.pause_agents', { durationSec: clamped, reason });
      await events?.write({
        type: 'supervisor.intervention',
        kind: 'backend-storm',
        detail: `pause_agents ${clamped}s: ${reason}`,
      });
      return textResult(
        `pause_agents: all agents will sleep until ~${clamped}s from now. Reason: ${reason}. Their next browser action will block; nudges and finding reports continue to work.`,
      );
    },
  );

  const waitTool = tool(
    'wait',
    'Pause for the specified number of seconds before your next turn. The harness sleeps real time — do not poll faster than every 30 seconds. Clamped to [10, 120].',
    {
      seconds: z.number().int().min(10).max(120),
    },
    async ({ seconds }: { seconds: number }) => {
      const clamped = Math.max(10, Math.min(120, seconds));
      await new Promise((r) => setTimeout(r, clamped * 1000));
      return textResult(`Waited ${clamped}s.`);
    },
  );

  const endSessionTool = tool(
    'end_session',
    'Stop the supervisor loop. Use ONLY when all agents have status=finished or status=errored. NEVER use while any agent is still active or auth_walled.',
    {
      reason: z.string().min(5).max(200),
    },
    async ({ reason }: { reason: string }) => {
      selfEnded = true;
      endedReason = 'self-ended';
      input.logger.info('supervisor.end_session', { reason });
      return textResult(`Supervisor ending: ${reason}`);
    },
  );

  // For runs with auth.type='none', hide relogin_session so the supervisor
  // can't waste a turn calling it (same logic as supervisor.ts).
  const allTools = [
    listAgentsTool,
    broadcastToTeamTool,
    ...(input.authType === 'form' ? [reloginSessionTool] : []),
    nudgeAgentTool,
    pauseAgentsTool,
    waitTool,
    endSessionTool,
  ];

  const SUPERVISOR_SERVER_NAME = 'supervisor';
  const supervisorServer = createSdkMcpServer({
    name: SUPERVISOR_SERVER_NAME,
    version: '1.0.0',
    tools: allTools,
  });

  // Pre-approve all supervisor tools so the SDK auto-executes them without
  // prompting — same rationale as loop-sdk.ts.
  const supervisorAllowedTools = allTools.map(
    (t) => `mcp__${SUPERVISOR_SERVER_NAME}__${(t as { name: string }).name}`,
  );

  // AbortController bridging — same pattern as loop-sdk.ts and auth-agent-sdk.ts.
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (input.abortSignal.aborted) {
    controller.abort();
  } else {
    input.abortSignal.addEventListener('abort', onAbort, { once: true });
  }

  // Per-turn async generator.
  // The SDK pulls a user message before each assistant turn. We yield:
  //   1. The initial "Begin supervising" seed message.
  //   2. Short continuation messages ("Continue.") until termination conditions
  //      are hit. If we stopped yielding, the SDK would exit after the first
  //      round-trip — this keeps the multi-turn loop alive.
  //
  // Lockstep gate: see loop-sdk.ts for the full explanation. Same race here —
  // the SDK pulls from this generator as fast as we yield, and `turn` only
  // advances when the consumer below sees an assistant message. Without this
  // gate the supervisor floods claude with hundreds of thousands of "Continue."
  // messages before the first response comes back.
  const TURN_GATE_TIMEOUT_MS = 120_000;
  let turnGateResolve: (() => void) | null = null;
  let turnGatePromise: Promise<void> = Promise.resolve();
  function armTurnGate(): void {
    turnGatePromise = new Promise<void>((r) => {
      turnGateResolve = r;
      setTimeout(() => {
        if (turnGateResolve === r) {
          input.logger.warn('supervisor-sdk.turnGate.timeout');
          r();
          turnGateResolve = null;
        }
      }, TURN_GATE_TIMEOUT_MS).unref();
    });
  }
  function releaseTurnGate(): void {
    if (turnGateResolve) {
      const r = turnGateResolve;
      turnGateResolve = null;
      r();
    }
  }
  async function* prompts(): AsyncGenerator<{
    type: 'user';
    message: { role: 'user'; content: string };
    parent_tool_use_id: null;
  }> {
    armTurnGate();
    yield {
      type: 'user',
      message: {
        role: 'user',
        content:
          'Begin supervising. Call list_agents to see who is active, then act. Do not narrate.',
      },
      parent_tool_use_id: null,
    };
    await turnGatePromise;
    while (
      !selfEnded &&
      !input.abortSignal.aborted &&
      turn < input.maxTurns &&
      costUsd < input.maxUsd &&
      Date.now() - startedAt < input.maxMinutes * 60_000
    ) {
      armTurnGate();
      yield {
        type: 'user',
        message: {
          role: 'user',
          content: 'Continue. Re-check via list_agents if state may have changed.',
        },
        parent_tool_use_id: null,
      };
      await turnGatePromise;
    }
  }

  // Dedupe assistant messages — the SDK emits each completed assistant message
  // twice in stream-json mode. See loop-sdk.ts for the same fix + observation.
  const seenAssistantIds = new Set<string>();
  try {
    for await (const message of query({
      prompt: prompts(),
      options: {
        model: input.model,
        systemPrompt,
        maxTurns: input.maxTurns,
        pathToClaudeCodeExecutable: resolveClaudeBinaryPath(),
        // Supervisor's tool surface is the supervisor MCP server only.
        // Disable built-in Claude Code tools (host filesystem/shell access)
        // and the user's global CLAUDE.md / settings.json from the prompt.
        tools: [],
        settingSources: [],
        permissionMode: 'dontAsk',
        mcpServers: { [SUPERVISOR_SERVER_NAME]: supervisorServer },
        allowedTools: supervisorAllowedTools,
        abortController: controller,
      },
    })) {
      if (message.type === 'assistant') {
        // SDKAssistantMessage narrows here; widen the inner BetaMessage's usage
        // fields to optional because the SDK can omit them on partial streams.
        const m = message.message as {
          id?: string;
          content: Array<{ type: string; text?: string; name?: string }>;
          stop_reason?: string | null;
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
        };

        // First emission already released the gate. Do not re-release on
        // the duplicate — see loop-sdk.ts for why.
        if (m.id && seenAssistantIds.has(m.id)) {
          continue;
        }
        if (m.id) seenAssistantIds.add(m.id);

        turn += 1;

        if (m.usage) {
          tokenUsage.input += m.usage.input_tokens ?? 0;
          tokenUsage.output += m.usage.output_tokens ?? 0;
          tokenUsage.cacheRead += m.usage.cache_read_input_tokens ?? 0;
          tokenUsage.cacheWrite += m.usage.cache_creation_input_tokens ?? 0;
          try {
            costUsd = computeCostUsd(input.model, tokenUsage);
          } catch {
            // Unknown model — keep going on token totals only.
          }
        }

        // Early-exit check: all agents terminal → supervisor can stop.
        const all = snapshotAll();
        if (all.length > 0 && all.every((a) => a.status === 'finished' || a.status === 'errored')) {
          endedReason = 'all-finished';
          break;
        }

        // Unblock the prompts() generator so it can yield "Continue."
        releaseTurnGate();
      }

      if (message.type === 'result') {
        // Unblock any pending gate so the generator exits cleanly.
        releaseTurnGate();
        break;
      }
    }
  } catch (err) {
    if (controller.signal.aborted || input.abortSignal.aborted) {
      endedReason = 'signal';
    } else {
      endedReason = 'error';
      input.logger.error('supervisor-sdk.error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    releaseTurnGate();
  } finally {
    input.abortSignal.removeEventListener('abort', onAbort);
    releaseTurnGate();
  }

  // Resolve final endedReason, honouring priority order (same as supervisor.ts).
  if (selfEnded && endedReason !== 'error') {
    endedReason = 'self-ended';
  } else if (
    (controller.signal.aborted || input.abortSignal.aborted) &&
    endedReason === 'max-turns'
  ) {
    endedReason = 'signal';
  } else if (costUsd >= input.maxUsd && endedReason === 'max-turns') {
    endedReason = 'budget-hit';
  }

  input.logger.info('supervisor-sdk.complete', {
    turns: turn,
    costUsd: costUsd.toFixed(4),
    reloginCount,
    nudgeCount,
    pauseCount,
    broadcastCount,
    endedReason,
  });

  return {
    turns: turn,
    costUsd,
    endedReason,
    reloginCount,
    nudgeCount,
    pauseCount,
    broadcastCount,
  };
}
