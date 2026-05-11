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
import { resolveClaudeBinaryPath } from '../llm/sdk-binary.ts';
import { computeCostUsd } from './cost.ts';
import { snapshotAll } from './registry.ts';
import {
  buildSystemPrompt,
  handleBroadcast,
  handleEndSession,
  handleListAgents,
  handleNudge,
  handlePause,
  handleRelogin,
  handleWait,
  SUPERVISOR_TOOL_DESCRIPTIONS,
  SupervisorTracker,
  type SupervisorInput,
  type SupervisorResult,
} from './supervisor-shared.ts';

export async function runSupervisorSdk(input: SupervisorInput): Promise<SupervisorResult> {
  const startedAt = Date.now();
  let turn = 0;
  let costUsd = 0;
  const tokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  const tracker = new SupervisorTracker();

  const systemPrompt = buildSystemPrompt(input.authType);

  // Build all 7 tools using the SDK tool() wrapper.
  // Handler bodies delegate to shared functions in supervisor-shared.ts.

  const listAgentsTool = tool(
    'list_agents',
    SUPERVISOR_TOOL_DESCRIPTIONS.list_agents,
    {},
    async () => handleListAgents(input),
  );

  const broadcastToTeamTool = tool(
    'broadcast_to_team',
    SUPERVISOR_TOOL_DESCRIPTIONS.broadcast_to_team,
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
    async ({ message, for_profile }: { message: string; for_profile?: string }) =>
      handleBroadcast(input, tracker, { message, for_profile }),
  );

  const reloginSessionTool = tool(
    'relogin_session',
    SUPERVISOR_TOOL_DESCRIPTIONS.relogin_session,
    {},
    async () => handleRelogin(input, tracker),
  );

  const nudgeAgentTool = tool(
    'nudge_agent',
    SUPERVISOR_TOOL_DESCRIPTIONS.nudge_agent,
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
    async ({ agentId, message }: { agentId: string; message: string }) =>
      handleNudge(input, tracker, { agentId, message }),
  );

  const pauseAgentsTool = tool(
    'pause_agents',
    SUPERVISOR_TOOL_DESCRIPTIONS.pause_agents,
    {
      duration_seconds: z.number().int().min(10).max(180),
      reason: z
        .string()
        .min(10)
        .max(200)
        .describe('Why the pause is needed. Surfaced in agent logs and useful for debugging.'),
    },
    async ({ duration_seconds, reason }: { duration_seconds: number; reason: string }) =>
      handlePause(input, tracker, { duration_seconds, reason }),
  );

  const waitTool = tool(
    'wait',
    SUPERVISOR_TOOL_DESCRIPTIONS.wait,
    {
      seconds: z.number().int().min(10).max(120),
    },
    async ({ seconds }: { seconds: number }) => handleWait({ seconds }),
  );

  const endSessionTool = tool(
    'end_session',
    SUPERVISOR_TOOL_DESCRIPTIONS.end_session,
    {
      reason: z.string().min(5).max(200),
    },
    async ({ reason }: { reason: string }) => {
      const result = await handleEndSession(input, tracker, { reason });
      tracker.endedReason = 'self-ended';
      return result;
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
      !tracker.selfEnded &&
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
          tracker.endedReason = 'all-finished';
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
      tracker.endedReason = 'signal';
    } else {
      tracker.endedReason = 'error';
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
  if (tracker.selfEnded && tracker.endedReason !== 'error') {
    tracker.endedReason = 'self-ended';
  } else if (
    (controller.signal.aborted || input.abortSignal.aborted) &&
    tracker.endedReason === 'max-turns'
  ) {
    tracker.endedReason = 'signal';
  } else if (costUsd >= input.maxUsd && tracker.endedReason === 'max-turns') {
    tracker.endedReason = 'budget-hit';
  }

  input.logger.info('supervisor-sdk.complete', {
    turns: turn,
    costUsd: costUsd.toFixed(4),
    reloginCount: tracker.reloginCount,
    nudgeCount: tracker.nudgeCount,
    pauseCount: tracker.pauseCount,
    broadcastCount: tracker.broadcastCount,
    endedReason: tracker.endedReason,
  });

  return tracker.toResult(turn, costUsd);
}
