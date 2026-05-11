import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { ApiLlmBackend } from '../llm/api-backend.ts';
import type { RawToolDef } from '../playbooks/framework.ts';
import { computeCostUsd } from './cost.ts';
import { snapshotAll } from './registry.ts';
import { runSupervisorSdk } from './supervisor-sdk.ts';
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

export type { SupervisorInput, SupervisorResult };
// Re-export the types + system-prompt builder so existing consumers (run.ts,
// supervisor-sdk.test.ts, etc.) continue to import from './supervisor.ts'
// without touching the rest of the codebase. The canonical home is now
// supervisor-shared.ts.
export { buildSystemPrompt };

/**
 * Supervisor agent. Watches the explorer agents via the runtime registry,
 * intervenes aggressively when they get stuck.
 *
 * Detects (aggressive mode):
 *   - auth_walled (URL on Auth0 login/logout) → call relogin_session, nudge
 *   - no progress in 60s → nudge with a specific suggestion
 *   - 4xx storm (multi-agent or per-agent threshold) → pause_agents
 *
 * Tools available: list_agents, relogin_session, nudge_agent, wait, end_session.
 * No browser tools. No findings tools. The supervisor does NOT explore.
 *
 * Implementation: direct Anthropic SDK only — the supervisor's tools are
 * synthesised here; no MCP subprocess needed. Runs concurrently with the
 * explorer agents in run.ts via Promise.allSettled.
 */

export async function runSupervisor(input: SupervisorInput): Promise<SupervisorResult> {
  if (input.backend.kind === 'sdk') {
    return runSupervisorSdk(input);
  }
  const client = (input.backend as ApiLlmBackend).getRawClient();
  const startedAt = Date.now();
  let turns = 0;
  let costUsd = 0;
  let endedReason: SupervisorResult['endedReason'] = 'max-turns';

  const tracker = new SupervisorTracker();

  const systemPrompt = buildSystemPrompt(input.authType);
  const tokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  // Tool definitions. RawToolDef shape is reused so we get z.toJSONSchema for free.
  // Handler bodies delegate to the shared functions in supervisor-shared.ts.
  const rawTools: RawToolDef[] = [
    {
      name: 'list_agents',
      description: SUPERVISOR_TOOL_DESCRIPTIONS.list_agents,
      shape: {},
      handler: async () => handleListAgents(input),
    },
    {
      name: 'broadcast_to_team',
      description: SUPERVISOR_TOOL_DESCRIPTIONS.broadcast_to_team,
      shape: {
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
      handler: async (args) =>
        handleBroadcast(input, tracker, args as { message: string; for_profile?: string }),
    },
    {
      name: 'relogin_session',
      description: SUPERVISOR_TOOL_DESCRIPTIONS.relogin_session,
      shape: {},
      handler: async () => handleRelogin(input, tracker),
    },
    {
      name: 'nudge_agent',
      description: SUPERVISOR_TOOL_DESCRIPTIONS.nudge_agent,
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
      handler: async (args) =>
        handleNudge(input, tracker, args as { agentId: string; message: string }),
    },
    {
      name: 'pause_agents',
      description: SUPERVISOR_TOOL_DESCRIPTIONS.pause_agents,
      shape: {
        duration_seconds: z.number().int().min(10).max(180),
        reason: z
          .string()
          .min(10)
          .max(200)
          .describe('Why the pause is needed. Surfaced in agent logs and useful for debugging.'),
      },
      handler: async (args) =>
        handlePause(input, tracker, args as { duration_seconds: number; reason: string }),
    },
    {
      name: 'wait',
      description: SUPERVISOR_TOOL_DESCRIPTIONS.wait,
      shape: {
        seconds: z.number().int().min(10).max(120),
      },
      handler: async (args) => handleWait(args as { seconds: number }),
    },
    {
      name: 'end_session',
      description: SUPERVISOR_TOOL_DESCRIPTIONS.end_session,
      shape: {
        reason: z.string().min(5).max(200),
      },
      handler: async (args) =>
        handleEndSession(input, tracker, args as { reason: string }),
    },
  ];

  if (input.testPlan) {
    rawTools.push({
      name: 'check_plan_coverage',
      description:
        'Return the current test plan with completion status. Shows which items have been completed by agents, which are still uncovered, and suggests the best persona for each gap. Call this periodically to decide whether to nudge agents toward uncovered items.',
      shape: {},
      handler: async () => {
        const { getPlanSummary } = await import('./test-plan.ts');
        const summary = getPlanSummary(input.testPlan!);
        return { content: [{ type: 'text' as const, text: summary }] };
      },
    });
  }

  // For runs with auth.type='none' there is no login to recover. Hide the
  // relogin_session tool entirely so the supervisor's LLM can't waste a turn
  // calling it (and getting "Cannot recover: session was started without
  // form credentials" back).
  const enabledTools =
    input.authType === 'form' ? rawTools : rawTools.filter((t) => t.name !== 'relogin_session');

  const anthropicToolsRaw: Anthropic.Tool[] = enabledTools.map((rt) => {
    const objSchema = z.object(rt.shape);
    const jsonSchema = z.toJSONSchema(objSchema) as Record<string, unknown>;
    return {
      name: rt.name,
      description: rt.description,
      input_schema: jsonSchema as Anthropic.Tool['input_schema'],
    };
  });

  // Cache the tools array: mark the last entry with a 1h breakpoint.
  // Anthropic caches tools[0..lastIndex] inclusive when the last has cache_control.
  const anthropicTools: Anthropic.Tool[] =
    anthropicToolsRaw.length > 0
      ? [
          ...anthropicToolsRaw.slice(0, -1),
          {
            ...anthropicToolsRaw[anthropicToolsRaw.length - 1]!,
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
        ]
      : [];

  const handlerByName = new Map(enabledTools.map((rt) => [rt.name, rt.handler]));

  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content:
        'Begin supervising. Call list_agents to see who is active, then act. Do not narrate.',
    },
  ];

  while (
    !input.abortSignal.aborted &&
    !tracker.selfEnded &&
    turns < input.maxTurns &&
    costUsd < input.maxUsd &&
    Date.now() - startedAt < input.maxMinutes * 60_000
  ) {
    let response!: Anthropic.Message;
    const SUPERVISOR_API_RETRIES = 3;
    const SUPERVISOR_RETRY_BASE_MS = 5_000;
    let supervisorAttempt = 0;
    let apiFailed = false;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      supervisorAttempt += 1;
      try {
        response = await client.messages.create({
          model: input.model,
          max_tokens: 2048,
          system: [
            {
              type: 'text',
              text: systemPrompt,
              cache_control: { type: 'ephemeral', ttl: '1h' },
            },
          ],
          messages,
          tools: anthropicTools,
          // Force tool use every turn. The supervisor's job is to observe
          // (list_agents) and intervene (nudge/pause/broadcast) — it should
          // never produce text-only turns. Eliminates the "output text without
          // calling a tool" correction logic below.
          tool_choice: { type: 'any' },
        });
        break;
      } catch (err) {
        if (input.abortSignal.aborted) {
          endedReason = 'signal';
          apiFailed = true;
          break;
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        const status = (err as { status?: number }).status;
        const isRetryable =
          status === 429 ||
          status === 529 ||
          status === 500 ||
          status === 502 ||
          status === 503 ||
          /ECONNRESET|ETIMEDOUT|ECONNREFUSED|fetch failed|socket hang up/i.test(errMsg);
        if (isRetryable && supervisorAttempt < SUPERVISOR_API_RETRIES) {
          const delayMs = SUPERVISOR_RETRY_BASE_MS * 2 ** (supervisorAttempt - 1);
          input.logger.warn('supervisor.api.retry', {
            attempt: supervisorAttempt,
            status,
            error: errMsg,
            delayMs,
          });
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        endedReason = 'error';
        input.logger.error('supervisor.api.error', {
          error: errMsg,
          attempts: supervisorAttempt,
        });
        apiFailed = true;
        break;
      }
    }
    if (apiFailed) break;

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

    if (tracker.selfEnded) {
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

  tracker.endedReason = endedReason;

  input.logger.info('supervisor.complete', {
    turns,
    costUsd: costUsd.toFixed(4),
    reloginCount: tracker.reloginCount,
    nudgeCount: tracker.nudgeCount,
    pauseCount: tracker.pauseCount,
    broadcastCount: tracker.broadcastCount,
    endedReason,
  });

  return tracker.toResult(turns, costUsd);
}
