/**
 * SDK-driven persona loop. Selected by run.ts when LLM_AUTH=subscription.
 *
 * Architecture vs API-mode loop.ts:
 *   - Tools wired as MCP servers via `mcpServers`.
 *   - Streaming-input async generator yields a fresh per-turn user message
 *     each turn — same content shape as loop.ts (sitemap snapshot, team intel,
 *     known findings, un-fuzzed-forms TODO, site-playbook reminder, broadcasts,
 *     nudges, session info).
 *   - Each MCP tool handler is wrapped to update summaryMemory and
 *     fuzzedFormIds and emit tool.call / tool.result / playbook.outcome events.
 *   - Termination reason set on every exit path.
 *
 * Genuine SDK incompatibilities (same model — no behaviour difference here
 * impacts cost relief, only context-management precision):
 *   - No manual sliding-window compaction. The SDK manages its own context
 *     window; we cannot rewrite the head with a synthetic summary at our chosen
 *     turn count. Long runs will compress differently than API mode.
 *   - No explicit cache_control breakpoints with ttl='1h'. The SDK auto-caches
 *     but we don't control breakpoints. Generally OK — just less optimal.
 *   - No server-side MemoryTool20250818 (beta API-only). The SDK has its own
 *     memory primitives; not wired up here.
 *   - No per-turn planner-vs-Haiku model routing. `query()` takes one model
 *     per invocation; entire run uses agent.model.
 *   - No per-turn `max_tokens` cap (loop.ts caps assistant output at 4096).
 *     The SDK's `query()` Options type does not expose a max-output-tokens
 *     setting — the SDK applies its own internal default. In practice this
 *     means subscription-mode turns can produce slightly larger completions
 *     than API mode; not a correctness issue, just a mild context-budget
 *     difference for long-trajectory runs.
 */

import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { redactForLlm } from '../logging/logger.ts';
import type { RawToolDef } from '../playbooks/framework.ts';
import { ATTACKER_PROFILES, BROWSER_TOOL_NAMES } from '../tools/browser-server.ts';
import { computeCostUsd } from './cost.ts';
import { capToolCallInput, capToolResultContent } from './events.ts';
import {
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
import { consumeNudge, updateOnTurn } from './registry.ts';
import type { MemoryEntry } from './summary-memory.ts';

export async function runAgentLoopSdk(input: LoopInput): Promise<void> {
  const { agent, journey, logger, rawTools, events, abortSignal, summaryMemory } = input;

  // Per-agent tracker for form interactions. Same role as loop.ts: the un-fuzzed
  // forms TODO inspects this set every turn so the agent gets reminded about
  // forms they haven't yet touched. Mutated by the tool wrappers below.
  const fuzzedFormIds = new Set<string>();

  // Partition rawTools by which MCP server they belong in. The SDK auto-prefixes
  // tool names as `mcp__<server-name>__<tool-name>`. The system prompt teaches
  // the agent to call tools by names like `mcp__browser__navigate`,
  // `mcp__harness__report_finding`, `mcp__playbooks__form_fuzz_validation`. To
  // produce those exact names we must:
  //   - Register browser primitives in a server named 'browser' (no name change)
  //   - Register harness tools in a server named 'harness' (no name change)
  //   - Register playbook tools in a server named 'playbooks' AFTER stripping
  //     their existing `mcp__playbooks__` prefix (the rawTool name was prefixed
  //     for API mode where the model sees the raw name verbatim; in SDK mode
  //     the SDK adds the prefix, so a pre-prefixed name double-prefixes).
  //
  // Without this partition, all tools land in one server with names like
  // `mcp__playbooks__report_finding` (wrong namespace) or
  // `mcp__playbooks__mcp__playbooks__form_fuzz_validation` (double prefix),
  // which makes the agent's tool-call namespace incoherent with its system
  // prompt.
  const browserNamesUnprefixed = new Set(
    BROWSER_TOOL_NAMES.map((n) => n.replace(/^mcp__browser__/, '')),
  );
  const harnessRawTools: RawToolDef[] = [];
  const browserRawTools: RawToolDef[] = [];
  const playbooksRawTools: RawToolDef[] = [];
  for (const rt of rawTools) {
    if (rt.name.startsWith(PLAYBOOK_TOOL_PREFIX)) {
      playbooksRawTools.push({
        ...rt,
        name: rt.name.slice(PLAYBOOK_TOOL_PREFIX.length),
      });
    } else if (browserNamesUnprefixed.has(rt.name)) {
      browserRawTools.push(rt);
    } else {
      harnessRawTools.push(rt);
    }
  }

  // Build MCP tools. Each handler is wrapped with a tap that:
  //   - emits tool.call before the underlying handler runs
  //   - tracks fuzzedFormIds for form-touching playbooks
  //   - emits tool.result with redacted + capped content after the handler
  //   - parses PlaybookOutcome for playbook tools, updates summaryMemory, and
  //     emits playbook.outcome
  // Returns a CallToolResult shape the SDK expects.
  //
  // The `eventName` arg is the name we report in tool.call/tool.result events.
  // It must match the API-mode wire name so events.jsonl is consistent across
  // backends — for playbook tools that means re-applying the `mcp__playbooks__`
  // prefix in events even though the SDK-side server registration uses the
  // stripped name.
  function wrapTool(rt: RawToolDef, eventName: string) {
    return tool(rt.name, rt.description, rt.shape, async (args: Record<string, unknown>) => {
      await events?.write({
        type: 'tool.call',
        agentId: agent.id,
        turn: journey.turns,
        name: eventName,
        input: capToolCallInput(args),
      });

      if (FORM_TOUCHING_TOOLS.has(eventName)) {
        const formId = (args as Record<string, unknown>)?.formId;
        if (typeof formId === 'string' && formId.length > 0) fuzzedFormIds.add(formId);
      }

      let result: { content: { type: 'text'; text: string }[] };
      try {
        result = await rt.handler(args);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await events?.write({
          type: 'tool.result',
          agentId: agent.id,
          turn: journey.turns,
          name: eventName,
          ok: false,
          content: capToolResultContent(redactForLlm(errMsg)),
        });
        return {
          content: [{ type: 'text' as const, text: errMsg }],
          isError: true,
        };
      }

      const text = result.content[0]?.text ?? '';
      await events?.write({
        type: 'tool.result',
        agentId: agent.id,
        turn: journey.turns,
        name: eventName,
        ok: true,
        content: capToolResultContent(redactForLlm(text)),
      });

      if (eventName.startsWith(PLAYBOOK_TOOL_PREFIX)) {
        const outcome = tryParsePlaybookOutcome(text);
        if (outcome) {
          const targetId = extractTargetId(args);
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
          await events?.write({
            type: 'playbook.outcome',
            agentId: agent.id,
            playbookName: outcome.playbookName,
            status: outcome.status as 'ok' | 'suspicious' | 'failed' | 'skipped',
            durationMs: outcome.durationMs,
            evidence: outcome.evidence ?? null,
          });
        }
      }

      return { content: [{ type: 'text' as const, text }] };
    });
  }

  const harnessSdkTools = harnessRawTools.map((rt) => wrapTool(rt, rt.name));
  const browserSdkTools = browserRawTools.map((rt) => wrapTool(rt, rt.name));
  // Playbook tools: registered server-side without the prefix; events still
  // report the prefixed name so logs match API-mode for the same tool.
  const playbooksSdkTools = playbooksRawTools.map((rt) =>
    wrapTool(rt, `${PLAYBOOK_TOOL_PREFIX}${rt.name}`),
  );

  const harnessServer = createSdkMcpServer({
    name: 'harness',
    version: '1.0.0',
    tools: harnessSdkTools,
  });
  const browserServer = createSdkMcpServer({
    name: 'browser',
    version: '1.0.0',
    tools: browserSdkTools,
  });
  const playbooksServer = createSdkMcpServer({
    name: 'playbooks',
    version: '1.0.0',
    tools: playbooksSdkTools,
  });

  // Bridge AbortSignal through to the SDK's abortController.
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (abortSignal.aborted) {
    controller.abort();
  } else {
    abortSignal.addEventListener('abort', onAbort, { once: true });
  }

  // Per-turn user message generator. The SDK pulls a new user message from
  // this iterator before each assistant turn — that gives us the API-mode
  // "fresh sitemap + intel + nudge each turn" feature inside `query()`.
  //
  // We also emit `agent.turn.start` here (just before yielding) so the event
  // stream stays coherent with the turn-by-turn structure of the API loop.
  const isAttacker = ATTACKER_PROFILES.has(agent.profileName);
  async function* prompts(): AsyncGenerator<{
    type: 'user';
    message: { role: 'user'; content: string };
    parent_tool_use_id: null;
  }> {
    while (
      journey.turns < agent.budget.max_turns &&
      !abortSignal.aborted &&
      journey.terminationReason !== 'end_session' &&
      journey.costUsd < agent.budget.max_usd
    ) {
      const nudge = consumeNudge(agent.id);
      if (nudge) {
        logger.info('supervisor.nudge.consumed', { preview: nudge.slice(0, 200) });
      }

      const elapsedMs = Date.now() - new Date(journey.startedAt).getTime();
      const remainingMin = Math.max(0, agent.budget.max_minutes - elapsedMs / 60_000);

      const knownFindings = input.findingCache
        ? input.findingCache.forAgent(agent.id).slice(0, 30)
        : [];
      // Honest personas only get a per-turn site-playbook reminder. Attackers
      // are intentionally unconstrained by the inferred site shape — their OWASP
      // methodology drives target selection.
      const sitePlaybookForTurn = isAttacker ? undefined : input.sitePlaybookText;
      const sharedSnap = input.sharedKnowledge?.snapshot();
      const broadcasts = input.sharedKnowledge
        ? input.sharedKnowledge.consumeBroadcasts(agent.id, agent.profileName)
        : [];

      const userContent = buildUserMessage({
        isFirstTurn: journey.turns === 0,
        targetUrl: input.targetUrl,
        siteMap: input.siteMap,
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
        sitePlaybookText: sitePlaybookForTurn,
        fuzzedFormIds,
        isAttacker,
        personaTagline: extractPersonaTagline(agent.personality),
      });

      // Emit agent.turn.start before the SDK fires the next assistant turn.
      // Turn number is 1-indexed in the event stream — `journey.turns` is the
      // count of turns already completed, so the upcoming turn is +1.
      await events?.write({
        type: 'agent.turn.start',
        agentId: agent.id,
        turn: journey.turns + 1,
        modelUsed: agent.model,
      });

      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content: userContent },
        parent_tool_use_id: null,
      };
    }
  }

  try {
    for await (const message of query({
      prompt: prompts(),
      options: {
        model: agent.model,
        systemPrompt: input.systemPrompt,
        maxTurns: agent.budget.max_turns,
        mcpServers: {
          harness: harnessServer,
          browser: browserServer,
          playbooks: playbooksServer,
        },
        abortController: controller,
        ...(typeof agent.maxThinkingTokens === 'number' && agent.maxThinkingTokens > 0
          ? { maxThinkingTokens: agent.maxThinkingTokens }
          : {}),
      },
    })) {
      if (message.type === 'assistant') {
        // `message` narrows to SDKAssistantMessage; `message.message` is the
        // BetaMessage with content/stop_reason/usage. Use `as` to widen the
        // optional usage fields the SDK types declare as required-numbers (the
        // SDK can omit them mid-stream for partial messages).
        const m = message.message as {
          content: Array<{ type: string; text?: string; name?: string }>;
          stop_reason?: string | null;
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
        };
        const turnUsage = m.usage
          ? {
              input: m.usage.input_tokens ?? 0,
              output: m.usage.output_tokens ?? 0,
              cacheRead: m.usage.cache_read_input_tokens ?? 0,
              cacheWrite: m.usage.cache_creation_input_tokens ?? 0,
            }
          : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        if (m.usage) {
          journey.tokenUsage.input += turnUsage.input;
          journey.tokenUsage.output += turnUsage.output;
          journey.tokenUsage.cacheRead += turnUsage.cacheRead;
          journey.tokenUsage.cacheWrite += turnUsage.cacheWrite;
        }
        let costUsdDelta = 0;
        try {
          costUsdDelta = computeCostUsd(agent.model, turnUsage);
          journey.costUsd += costUsdDelta;
        } catch {
          // Unknown model — token totals only; cost stays at 0 delta.
        }
        journey.turns += 1;
        updateOnTurn(agent.id, {
          turnsCompleted: journey.turns,
          findingsCount: journey.findings.length,
        });

        // agent.turn.end pairs with the agent.turn.start emitted from the
        // generator before the SDK consumed our user message.
        await events?.write({
          type: 'agent.turn.end',
          agentId: agent.id,
          turn: journey.turns,
          tokenUsage: turnUsage,
          costUsdDelta,
          stopReason: m.stop_reason ?? 'unknown',
        });
      }

      if (message.type === 'result') {
        // Final result — the SDK has terminated. Set termination reason.
        if (!journey.terminationReason) {
          if (controller.signal.aborted) {
            journey.terminationReason = 'signal';
          } else if (journey.turns >= agent.budget.max_turns) {
            journey.terminationReason = 'max-turns';
          } else if (journey.costUsd >= agent.budget.max_usd) {
            journey.terminationReason = 'budget-hit';
          } else {
            journey.terminationReason = 'sdk-end';
          }
        }
      }
    }
  } catch (err) {
    if (controller.signal.aborted || abortSignal.aborted) {
      journey.terminationReason = 'signal';
    } else {
      journey.terminationReason = 'error';
      logger.error('loop-sdk.error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    abortSignal.removeEventListener('abort', onAbort);
  }

  // Belt-and-braces — if no termination reason was set (e.g. the loop just
  // exhausted without emitting a 'result' message), pick the most accurate
  // available reason. Prefer concrete budget reasons over the generic
  // 'sdk-end' so telemetry tells the truth.
  if (!journey.terminationReason) {
    if (controller.signal.aborted || abortSignal.aborted) {
      journey.terminationReason = 'signal';
    } else if (journey.turns >= agent.budget.max_turns) {
      journey.terminationReason = 'max-turns';
    } else if (journey.costUsd >= agent.budget.max_usd) {
      journey.terminationReason = 'budget-hit';
    } else {
      journey.terminationReason = 'sdk-end';
    }
  }
}
