import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { Logger } from '../logging/logger.ts';
import type { RawToolDef } from '../tools/browser-server.ts';
import type { ResolvedAgent } from '../types/agent.ts';
import type { Journey } from '../types/journey.ts';
import { computeCostUsd } from './cost.ts';
import { consumeNudge, updateOnTurn } from './registry.ts';

/**
 * Direct Anthropic SDK agent loop. Bypasses the Claude Code subprocess entirely.
 *
 * Trade-offs vs the SDK path:
 *   + ~500ms-1s/turn faster (no stdio subprocess)
 *   + Tool calls execute IN PARALLEL within a turn — we Promise.all them
 *   + We control the message history; can compact at any boundary
 *   - Requires ANTHROPIC_API_KEY (subscription auth not supported)
 *   - We re-implement chunked-history compaction here too
 *
 * This path is opt-in: spawn-agent picks it when an API key is set AND the
 * config flag `direct_api: true` is enabled.
 */

export interface DirectLoopInput {
  agent: ResolvedAgent;
  targetUrl: string;
  systemPrompt: string;
  apiKey: string;
  rawTools: RawToolDef[];
  journey: Journey;
  abortSignal: AbortSignal;
  logger: Logger;
}

export async function runDirectLoop(input: DirectLoopInput): Promise<void> {
  const client = new Anthropic({ apiKey: input.apiKey });
  const { agent, journey, logger, rawTools } = input;

  // Convert RawToolDef → Anthropic SDK tool definitions. Zod 4 ships
  // z.toJSONSchema, so we get clean JSON Schema for free.
  const anthropicTools: Anthropic.Tool[] = rawTools.map((rt) => {
    const objSchema = z.object(rt.shape);
    const jsonSchema = z.toJSONSchema(objSchema) as Record<string, unknown>;
    // Anthropic accepts an input_schema with `type: "object"`, `properties`, `required`.
    return {
      name: rt.name,
      description: rt.description,
      input_schema: jsonSchema as Anthropic.Tool['input_schema'],
    };
  });

  const handlerByName = new Map(rawTools.map((rt) => [rt.name, rt.handler]));

  const CHUNK_TURNS = Math.min(25, agent.budget.max_turns);

  while (
    journey.turns < agent.budget.max_turns &&
    !input.abortSignal.aborted &&
    journey.terminationReason !== 'end_session' &&
    journey.costUsd < agent.budget.max_usd
  ) {
    const elapsedMs = Date.now() - new Date(journey.startedAt).getTime();
    const remainingMin = Math.max(0, agent.budget.max_minutes - elapsedMs / 60_000);

    // Drain supervisor-issued nudge — rendezvous point with runSupervisor's
    // pushNudge() calls. The nudge prepends to the chunk's first user message
    // so the agent sees it immediately on the next turn.
    const nudge = consumeNudge(agent.id);
    if (nudge) {
      logger.info('supervisor.nudge.consumed', { preview: nudge.slice(0, 200) });
    }

    // Fresh conversation per chunk — history compaction without explicit summary
    // (the system prompt is identical so it gets cached; only the small per-chunk
    // user prompt + tool dialogue is novel input per turn).
    const baseInitialPrompt =
      journey.turns === 0
        ? `Begin. You're already on ${input.targetUrl} — start using the app as your character would.`
        : [
            `[continue] Progress: ${journey.turns} turns, ${journey.findings.length} findings, ~${remainingMin.toFixed(1)} min remaining.`,
            `Pick a feature you have NOT yet deeply explored. Stay in character. Batch tool calls aggressively.`,
          ].join('\n');

    const initialPrompt = nudge
      ? `[SUPERVISOR INTERVENTION — read this first]\n${nudge}\n\n${baseInitialPrompt}`
      : baseInitialPrompt;

    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: initialPrompt }];

    let chunkTurns = 0;
    const chunkLimit = Math.min(CHUNK_TURNS, agent.budget.max_turns - journey.turns);

    while (
      chunkTurns < chunkLimit &&
      !input.abortSignal.aborted &&
      // Cast — TS narrows away 'end_session' because the outer while checks the
      // same; harness MCP handlers can flip the value through journey ref though.
      (journey.terminationReason as string) !== 'end_session' &&
      journey.costUsd < agent.budget.max_usd
    ) {
      let response: Anthropic.Message;
      try {
        response = await client.messages.create({
          model: agent.model,
          max_tokens: 4096,
          system: [
            {
              type: 'text',
              text: input.systemPrompt,
              // Cache the long system prompt for 1h — cuts per-turn input cost dramatically.
              cache_control: { type: 'ephemeral', ttl: '1h' },
            },
          ],
          messages,
          tools: anthropicTools,
          ...(typeof agent.maxThinkingTokens === 'number' && agent.maxThinkingTokens > 0
            ? { thinking: { type: 'enabled', budget_tokens: agent.maxThinkingTokens } }
            : {}),
        });
      } catch (err) {
        if (input.abortSignal.aborted) {
          journey.terminationReason = 'signal';
        } else {
          journey.terminationReason = 'error';
          logger.error('direct.api.error', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }

      journey.turns += 1;
      chunkTurns += 1;
      updateOnTurn(agent.id, {
        turnsCompleted: journey.turns,
        findingsCount: journey.findings.length,
      });

      const usage = response.usage;
      journey.tokenUsage.input += usage.input_tokens ?? 0;
      journey.tokenUsage.output += usage.output_tokens ?? 0;
      journey.tokenUsage.cacheRead += usage.cache_read_input_tokens ?? 0;
      journey.tokenUsage.cacheWrite += usage.cache_creation_input_tokens ?? 0;
      try {
        journey.costUsd = computeCostUsd(agent.model, journey.tokenUsage);
      } catch {
        // unknown model — keep token totals only
      }

      // Append the assistant turn to history.
      messages.push({ role: 'assistant', content: response.content });

      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );

      if (toolUses.length === 0) {
        // No tools called — model emitted text-only. Could be wrap-up. Break the
        // chunk so the outer loop decides whether to start a new chunk.
        break;
      }

      // Execute tool calls in PARALLEL — independent actions complete simultaneously
      // so a 4-tool turn finishes in ~max-tool-time, not sum-of-tool-times.
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

      if (response.stop_reason === 'end_turn') {
        // Model said it's done. Outer loop decides about a new chunk.
        break;
      }
    }

    logger.info('direct.chunk.end', {
      chunkTurns,
      cumulativeTurns: journey.turns,
      findings: journey.findings.length,
    });

    if (chunkTurns === 0) break; // wedged — bail out of outer loop too
    if (journey.costUsd >= agent.budget.max_usd) {
      journey.terminationReason = 'budget-hit';
      break;
    }
  }
}
