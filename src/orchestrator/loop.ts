/**
 * Agent loop — direct Anthropic SDK loop with continuous conversation,
 * sliding-window history compaction, and per-turn sitemap injection.
 *
 * Orchestration model:
 *
 *   - One continuous conversation (no chunked restart). The system prompt is
 *     1h-cached so the per-turn input cost stays bounded.
 *   - Sliding window: when the message tail grows past ~7 turn-pairs we
 *     elide everything except the last 12 messages and prepend a synthetic
 *     summary message dumping the SummaryMemory bullet list. The system
 *     prompt cache survives this rewrite because we never touch the system
 *     content.
 *   - Per-turn user message includes a sitemap snapshot — top-N unvisited
 *     routes, untested forms/tables/modals — so the agent always has fresh
 *     "what's left to do" context without having to call ask_sitemap.
 *   - Direct API only. Subscription auth (claude CLI) is not supported.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { MemoryTool20250818 } from '@anthropic-ai/sdk/resources/messages/messages.js';
import { z } from 'zod';
import type { Logger } from '../logging/logger.ts';
import { redactForLlm } from '../logging/logger.ts';
import type { PlaybookOutcome } from '../playbooks/outcome.ts';
import { ATTACKER_PROFILES } from '../tools/browser-server.ts';
import type { ResolvedAgent } from '../types/agent.ts';
import { computeCostUsd } from './cost.ts';
import { capToolCallInput, capToolResultContent } from './events.ts';
import {
  buildTaskQueue,
  buildUserMessage,
  extractPersonaTagline,
  extractRoute,
  extractTargetId,
  FORM_TOUCHING_TOOLS,
  type LoopInput,
  oneLineSummary,
  PLAYBOOK_TOOL_PREFIX,
  tryParsePlaybookOutcome,
} from './loop-shared.ts';
import { consumeNudge, getAgentState, updateOnTurn } from './registry.ts';
import type { MemoryEntry, SummaryMemory } from './summary-memory.ts';

// Re-export so existing consumers (loop-sdk.ts, spawn-agent.ts, tests) can
// keep importing `LoopInput` from './loop.ts'. The actual definition lives in
// loop-shared.ts to break the runtime cycle with loop-sdk.ts.
export type { LoopInput };

/**
 * Sliding window: keep the last KEEP_TAIL messages in full, replacing the
 * elided head with a single synthetic "summary" user message. KEEP_TAIL = 12
 * is roughly six (assistant, tool_result) turn pairs.
 */
const KEEP_TAIL = 12;
/** Compact when the conversation grows beyond this many messages. */
const COMPACT_THRESHOLD = 14;

/** Anthropic SDK request hard cap for assistant output. */
const MAX_OUTPUT_TOKENS = 4096;

/** Run the agent loop. Resolves when the loop terminates. Never throws —
 * errors are recorded into `journey.terminationReason`. */
export async function runAgentLoop(input: LoopInput): Promise<void> {
  const client = new Anthropic({ apiKey: input.apiKey });
  const { agent, journey, logger, rawTools, siteMap, summaryMemory, events } = input;

  // 1. Convert RawToolDef → Anthropic SDK tool definitions. Zod 4 ships
  // z.toJSONSchema, so we can derive a clean JSON Schema for free.
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

  // Per-agent tracker for form interactions. We add a formId here whenever the
  // agent calls form_fuzz_validation / form_double_submit / fill_and_verify
  // with that formId. The per-turn user message reads this and surfaces
  // un-fuzzed forms in the sitemap as a TODO. Without this, honest personas
  // chronically navigate without acting on visible forms (run #8: 12 fill_form
  // calls across 434 tool invocations from honest agents).
  const fuzzedFormIds = new Set<string>();

  // 2. Continuous conversation. We only ever push to this array; the
  // sliding-window compaction rewrites the head in-place when needed.
  const messages: Anthropic.MessageParam[] = [];

  // Pre-compute the tools array with cache breakpoint — this is static across
  // turns so we hoist it out of the loop. The last regular tool carries a 1h
  // cache_control breakpoint; the Memory tool (server-managed) sits after it.
  const cachedTools: Anthropic.Tool[] =
    anthropicTools.length > 0
      ? [
          ...anthropicTools.slice(0, -1),
          {
            ...anthropicTools[anthropicTools.length - 1]!,
            cache_control: { type: 'ephemeral' as const, ttl: '1h' as const },
          },
        ]
      : [];
  const MEMORY_TOOL_DEF: MemoryTool20250818 = {
    type: 'memory_20250818',
    name: 'memory',
  };
  const allTools: Anthropic.ToolUnion[] = input.memoryEnabled
    ? [...cachedTools, MEMORY_TOOL_DEF]
    : cachedTools;

  // Pre-compute the persona tagline — the personality text is static per-agent.
  const personaTagline = extractPersonaTagline(agent.personality);

  // Per-turn model routing: the turn IMMEDIATELY after a sliding-window
  // compaction uses plannerModel (typically Sonnet) so the agent can
  // re-orient to the elided context with a smarter model. All other turns
  // use agent.model (typically Haiku).
  let nextTurnIsPlanning = false;
  let lastFindingTurn = 0;
  let previousFindingsCount = 0;
  let turnsOnSameUrl = 0;
  let previousUrl: string | undefined;

  while (
    journey.turns < agent.budget.max_turns &&
    !input.abortSignal.aborted &&
    !journey.terminationReason &&
    journey.costUsd < agent.budget.max_usd
  ) {
    // Drain any supervisor-issued nudge — rendezvous point with
    // runSupervisor's pushNudge() calls. The nudge prepends to the next user
    // message so the agent sees it on the upcoming turn.
    const nudge = consumeNudge(agent.id);
    if (nudge) {
      logger.info('supervisor.nudge.consumed', { preview: nudge.slice(0, 200) });
    }

    const elapsedMs = Date.now() - new Date(journey.startedAt).getTime();
    const remainingMin = Math.max(0, agent.budget.max_minutes - elapsedMs / 60_000);

    // Build the per-turn user message. On turn 0 it's the initial prompt;
    // on subsequent turns the previous turn's user message was the
    // tool_results, so we add a fresh user message with sitemap + summary +
    // continue instruction before the next assistant call.
    const knownFindings = input.findingCache
      ? input.findingCache.forAgent(agent.id).slice(0, 30)
      : [];
    const sharedSnap = input.sharedKnowledge?.snapshot();
    const broadcasts = input.sharedKnowledge
      ? input.sharedKnowledge.consumeBroadcasts(agent.id, agent.profileName)
      : [];
    const isAttacker = ATTACKER_PROFILES.has(agent.profileName);
    const agentState = getAgentState(agent.id);
    const currentAgentUrl = agentState?.currentUrl ?? undefined;
    if (currentAgentUrl && currentAgentUrl === previousUrl) {
      turnsOnSameUrl += 1;
    } else {
      turnsOnSameUrl = 0;
      previousUrl = currentAgentUrl;
    }
    if (journey.findings.length > previousFindingsCount) {
      lastFindingTurn = journey.turns;
      previousFindingsCount = journey.findings.length;
    }

    const userContent = buildUserMessage({
      isFirstTurn: journey.turns === 0,
      targetUrl: input.targetUrl,
      siteMap,
      summaryMemory,
      nudge,
      turnsCompleted: journey.turns,
      findingsCount: journey.findings.length,
      remainingMin,
      knownFindings,
      sharedCredentials: sharedSnap?.credentials ?? [],
      sharedRoutes: sharedSnap?.routes ?? [],
      broadcasts,
      sessionInfo: input.sessionInfo,
      fuzzedFormIds,
      isAttacker,
      personaTagline,
      personaName: agent.profileName,
      currentUrl: currentAgentUrl,
      turnsOnSameUrl,
      lastFindingTurn,
    });

    messages.push({ role: 'user', content: userContent });

    // Sliding-window compaction. When we cross the threshold, replace the
    // elided head with a single synthetic summary user message. The system
    // prompt is untouched so the prompt cache survives.
    if (messages.length > COMPACT_THRESHOLD) {
      compactSlidingWindow(messages, summaryMemory, logger);
      // Signal that the NEXT assistant call is a "planning" turn — the agent
      // needs to re-orient after elision. Use plannerModel for that one call.
      nextTurnIsPlanning = true;
    }

    // Build a per-request messages array with a 5-min cache breakpoint on the
    // last content block of the last message. The persistent `messages` array
    // is reused across turns — mutating in-place would carry the marker forward
    // and invalidate the cache on every turn.
    const cacheBreakpoint: Anthropic.CacheControlEphemeral = { type: 'ephemeral' };
    const requestMessages: Anthropic.MessageParam[] =
      messages.length > 0
        ? [
            ...messages.slice(0, -1),
            (() => {
              const last = messages[messages.length - 1]!;
              if (typeof last.content === 'string') {
                return {
                  role: last.role,
                  content: [
                    {
                      type: 'text' as const,
                      text: last.content,
                      cache_control: cacheBreakpoint,
                    },
                  ],
                } satisfies Anthropic.MessageParam;
              }
              const blocks = last.content;
              if (blocks.length === 0) return last;
              const lastBlock = blocks[blocks.length - 1]!;
              const clonedTail = { ...lastBlock, cache_control: cacheBreakpoint };
              return {
                role: last.role,
                content: [
                  ...(blocks.slice(0, -1) as Anthropic.ContentBlockParam[]),
                  clonedTail as Anthropic.ContentBlockParam,
                ],
              } satisfies Anthropic.MessageParam;
            })(),
          ]
        : [];

    // Pick the model for this turn. Post-compaction turns use plannerModel
    // (if configured) to produce a higher-quality re-orientation synthesis.
    // All other turns use agent.model (Haiku by default after WP3.D).
    const modelForThisTurn =
      nextTurnIsPlanning && agent.plannerModel ? agent.plannerModel : agent.model;

    if (!isAttacker && journey.turns >= 8) {
      const queue = buildTaskQueue(agent.profileName, siteMap, fuzzedFormIds);
      if (queue.length === 0) {
        journey.terminationReason = 'scope-complete';
        logger.info('loop.scope-complete', {
          agentId: agent.id,
          turns: journey.turns,
          findings: journey.findings.length,
        });
        break;
      }
    }

    await events?.write({
      type: 'agent.turn.start',
      agentId: agent.id,
      turn: journey.turns + 1,
      modelUsed: modelForThisTurn,
    });

    let response: Anthropic.Message;
    const API_RETRIES = 3;
    const API_RETRY_BASE_MS = 5_000;
    let apiAttempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      apiAttempt += 1;
      try {
        const thinkingEnabled =
          typeof agent.maxThinkingTokens === 'number' && agent.maxThinkingTokens > 0;
        response = await client.messages.create({
          model: modelForThisTurn,
          max_tokens: MAX_OUTPUT_TOKENS,
          system: [
            {
              type: 'text',
              text: input.systemPrompt,
              // Cache the long system prompt for 1h — cuts per-turn input cost dramatically.
              cache_control: { type: 'ephemeral', ttl: '1h' },
            },
          ],
          messages: requestMessages,
          tools: allTools,
          // Force the agent to always call a tool when extended thinking is off.
          // Explorer agents should never produce text-only turns — every turn
          // should advance via a browser action, playbook, or finding report.
          // When thinking IS enabled, tool_choice must be 'auto' (API constraint),
          // so we omit it and rely on the system prompt to enforce tool use.
          ...(!thinkingEnabled ? { tool_choice: { type: 'any' as const } } : {}),
          ...(thinkingEnabled
            ? { thinking: { type: 'enabled', budget_tokens: agent.maxThinkingTokens! } }
            : {}),
        });
        break;
      } catch (err) {
        if (input.abortSignal.aborted) {
          journey.terminationReason = 'signal';
          nextTurnIsPlanning = false;
          return;
        }
        // Retry on transient errors: 429 (rate limit), 529 (overloaded),
        // 500/502/503 (server errors), and network failures.
        const errMsg = err instanceof Error ? err.message : String(err);
        const status = (err as { status?: number }).status;
        const isRetryable =
          status === 429 ||
          status === 529 ||
          status === 500 ||
          status === 502 ||
          status === 503 ||
          /ECONNRESET|ETIMEDOUT|ECONNREFUSED|fetch failed|socket hang up/i.test(errMsg);
        if (isRetryable && apiAttempt < API_RETRIES) {
          const delayMs = API_RETRY_BASE_MS * 2 ** (apiAttempt - 1);
          logger.warn('loop.api.retry', {
            attempt: apiAttempt,
            status,
            error: errMsg,
            delayMs,
          });
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        journey.terminationReason = 'error';
        // Compact shape summary helps diagnose request-construction bugs (e.g.
        // orphaned tool_result blocks after history compaction). One entry per
        // message: role + content kind + tool block ids only.
        const shape = messages.map((m) => {
          if (typeof m.content === 'string') return `${m.role}:str`;
          const tags = m.content
            .map((b) => {
              const t = (b as { type: string }).type;
              if (t === 'tool_use') return 'tu';
              if (t === 'tool_result') return 'tr';
              if (t === 'thinking') return 'th';
              if (t === 'text') return 'tx';
              return t;
            })
            .join(',');
          return `${m.role}:[${tags}]`;
        });
        logger.error('loop.api.error', {
          error: errMsg,
          shape,
          attempts: apiAttempt,
        });
        // Reset the planning flag even on API error so subsequent turns aren't
        // accidentally promoted to plannerModel.
        nextTurnIsPlanning = false;
        return;
      }
    }

    // Reset after the call resolves — the planning turn is now complete.
    nextTurnIsPlanning = false;

    journey.turns += 1;
    updateOnTurn(agent.id, {
      turnsCompleted: journey.turns,
      findingsCount: journey.findings.length,
    });

    const usage = response.usage;
    const turnTokenUsage = {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
    };
    journey.tokenUsage.input += turnTokenUsage.input;
    journey.tokenUsage.output += turnTokenUsage.output;
    journey.tokenUsage.cacheRead += turnTokenUsage.cacheRead;
    journey.tokenUsage.cacheWrite += turnTokenUsage.cacheWrite;
    // Per-turn cost: accumulate using the model that was actually called.
    // Previously this recomputed from all-time token totals × a single model
    // price, which is wrong once model routing means different turns bill at
    // different rates. Running sum is correct.
    let costUsdDelta = 0;
    try {
      costUsdDelta = computeCostUsd(modelForThisTurn, turnTokenUsage);
      journey.costUsd += costUsdDelta;
    } catch {
      // Unknown model — keep token totals only (cost will be 0 for this turn).
    }

    // Emit agent.turn.end with per-turn stats.
    await events?.write({
      type: 'agent.turn.end',
      agentId: agent.id,
      turn: journey.turns,
      tokenUsage: turnTokenUsage,
      costUsdDelta,
      stopReason: response.stop_reason ?? 'unknown',
    });

    // Append the assistant turn to history.
    messages.push({ role: 'assistant', content: response.content });

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );

    if (toolUses.length === 0) {
      // No tools called — model emitted text only. Treat as the end of this
      // assistant's contribution; the next loop iteration will push a fresh
      // user message to keep them going (subject to budget/abort guards).
      if (response.stop_reason === 'end_turn') {
        // Avoid hot-looping when the model "wraps up" without calling tools.
        // The next user message (sitemap + continue) will re-engage; if the
        // agent immediately ends turn again we'll spin — protect with the
        // outer loop's stop conditions (turns/cost/abort).
      }
      continue;
    }

    // Execute tool calls in PARALLEL — independent actions complete
    // simultaneously so a 4-tool turn finishes in ~max-tool-time, not
    // sum-of-tool-times.
    const toolResultsAndOutcomes = await Promise.all(
      toolUses.map(async (use) => {
        // Emit tool.call before the handler runs.
        await events?.write({
          type: 'tool.call',
          agentId: agent.id,
          turn: journey.turns,
          name: use.name,
          // Cap input at 4 KB to avoid bloating the event log.
          input: capToolCallInput(use.input),
        });

        // Track form interactions for the un-fuzzed-forms TODO. Any of the
        // three form-touching playbooks count: a fill_and_verify counts because
        // the agent has at least filled the form once, even if not fuzzed.
        if (FORM_TOUCHING_TOOLS.has(use.name)) {
          const formId = (use.input as Record<string, unknown> | undefined)?.['formId'];
          if (typeof formId === 'string' && formId.length > 0) fuzzedFormIds.add(formId);
        }

        const handler = handlerByName.get(use.name);
        if (!handler) {
          const errContent = `Unknown tool: ${use.name}`;
          await events?.write({
            type: 'tool.result',
            agentId: agent.id,
            turn: journey.turns,
            name: use.name,
            ok: false,
            content: errContent,
          });
          return {
            block: {
              type: 'tool_result',
              tool_use_id: use.id,
              content: errContent,
              is_error: true,
            } satisfies Anthropic.ToolResultBlockParam,
            outcome: null as PlaybookOutcome | null,
          };
        }
        try {
          const result = await handler(use.input as Record<string, unknown>);
          const text = result.content[0]?.text ?? '';
          // Emit tool.result with redacted+capped content.
          await events?.write({
            type: 'tool.result',
            agentId: agent.id,
            turn: journey.turns,
            name: use.name,
            ok: true,
            content: capToolResultContent(redactForLlm(text)),
          });
          return {
            block: {
              type: 'tool_result',
              tool_use_id: use.id,
              content: text,
            } satisfies Anthropic.ToolResultBlockParam,
            // Only attempt outcome parsing for playbook-namespaced tools; other
            // tools (browser/harness) don't carry PlaybookOutcome shape.
            outcome: use.name.startsWith(PLAYBOOK_TOOL_PREFIX)
              ? tryParsePlaybookOutcome(text)
              : null,
          };
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          await events?.write({
            type: 'tool.result',
            agentId: agent.id,
            turn: journey.turns,
            name: use.name,
            ok: false,
            content: capToolResultContent(redactForLlm(errMsg)),
          });
          return {
            block: {
              type: 'tool_result',
              tool_use_id: use.id,
              content: errMsg,
              is_error: true,
            } satisfies Anthropic.ToolResultBlockParam,
            outcome: null as PlaybookOutcome | null,
          };
        }
      }),
    );

    const toolResults = toolResultsAndOutcomes.map((r) => r.block);
    messages.push({ role: 'user', content: toolResults });

    // Update the SummaryMemory for every playbook tool we just called. The
    // route is best-effort — playbook outcomes don't carry a route directly,
    // so we use the live page url from the journey if available, otherwise
    // a placeholder. The route will still be useful for the agent because
    // the playbook name + targetId combination is what disambiguates entries.
    for (const [i, { outcome }] of toolResultsAndOutcomes.entries()) {
      if (!outcome) continue;
      const use = toolUses[i];
      if (!use) continue;
      const targetId = extractTargetId(use.input as Record<string, unknown>);
      const route = extractRoute(outcome) ?? 'unknown';
      const entry: MemoryEntry = {
        ts: new Date().toISOString(),
        playbookName: outcome.playbookName,
        route,
        targetId,
        status: outcome.status,
        oneLineSummary: oneLineSummary(outcome),
      };
      summaryMemory.add(entry);
      // Emit playbook.outcome after SummaryMemory is updated.
      // The status values in PlaybookOutcome ('ok'|'failed'|'suspicious') map
      // directly to the event taxonomy; 'skipped' is provided for completeness
      // when the playbook was not invoked (currently unused by the loop).
      await events?.write({
        type: 'playbook.outcome',
        agentId: agent.id,
        playbookName: outcome.playbookName,
        route,
        targetId,
        status: outcome.status as 'ok' | 'suspicious' | 'failed' | 'skipped',
        durationMs: outcome.durationMs,
        evidence: outcome.evidence ?? null,
      });
    }

    // Surface end_turn diagnostically — useful for tuning.
    if (response.stop_reason === 'end_turn') {
      logger.debug('loop.end_turn', {
        turns: journey.turns,
        toolCalls: toolUses.length,
      });
    }
  }

  // Set a graceful termination reason if we exited the while-loop without one.
  if (!journey.terminationReason) {
    if (input.abortSignal.aborted) {
      journey.terminationReason = 'signal';
    } else if (journey.costUsd >= agent.budget.max_usd) {
      journey.terminationReason = 'budget-hit';
    } else if (journey.turns >= agent.budget.max_turns) {
      journey.terminationReason = 'max-turns';
    }
  }
}

/**
 * Pure model-selector function — exported for unit testing.
 * Returns `plannerModel` when the next turn is a planning turn AND the agent
 * has a plannerModel configured; otherwise returns `agent.model`.
 */
export function pickModel(nextTurnIsPlanning: boolean, agent: ResolvedAgent): string {
  return nextTurnIsPlanning && agent.plannerModel ? agent.plannerModel : agent.model;
}

/**
 * Sliding-window compaction. When the message list grows beyond the
 * threshold, replace the head with a single synthetic summary message.
 *
 * Mutates the array in-place so the outer-loop reference stays valid.
 */
export function compactSlidingWindow(
  messages: Anthropic.MessageParam[],
  summaryMemory: SummaryMemory,
  logger: Logger,
): void {
  if (messages.length <= COMPACT_THRESHOLD) return;
  const elidedCount = messages.length - KEEP_TAIL;
  if (elidedCount <= 0) return;

  const tail = messages.slice(-KEEP_TAIL);
  // SECURITY: the synthesised summary message must not be a tool_result
  // (orphaned tool_result blocks crash the API). A plain user-text message
  // is safe regardless of what came before.
  const summaryText = [
    `[${elidedCount} earlier turns elided]`,
    summaryMemory.serialize() || 'Earlier turns explored the app; no playbooks recorded yet.',
  ].join('\n');

  // The first surviving message must be a user-prompt; the API rejects both
  // a conversation that begins with an assistant turn AND a tool_result
  // block whose tool_use_id has no preceding tool_use. Strip from the head
  // while either condition holds:
  //   - the message is an assistant (would orphan the tool_use it carries)
  //   - the message is a user with array content containing tool_result blocks
  //     (orphans the tool_results because their assistant got dropped above)
  // Stop at the first user message with string content (a fresh prompt) or
  // user with array content that is NOT tool_results.
  let trimmedTail = tail;
  const isOrphanedToolResults = (m: Anthropic.MessageParam): boolean => {
    if (m.role !== 'user') return false;
    if (typeof m.content === 'string') return false;
    return m.content.some((b) => (b as { type: string }).type === 'tool_result');
  };
  while (
    trimmedTail.length > 0 &&
    (trimmedTail[0]?.role === 'assistant' ||
      (trimmedTail[0] && isOrphanedToolResults(trimmedTail[0])))
  ) {
    trimmedTail = trimmedTail.slice(1);
  }

  const summaryMessage: Anthropic.MessageParam = {
    role: 'user',
    content: summaryText,
  };

  // Splice in place to preserve the outer-loop reference.
  messages.length = 0;
  messages.push(summaryMessage, ...trimmedTail);

  logger.debug('loop.window.compacted', {
    elidedCount,
    keptTail: trimmedTail.length,
  });
}
