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
import { resolveClaudeBinaryPath } from '../llm/sdk-binary.ts';
import { redactForLlm } from '../logging/logger.ts';
import type { RawToolDef } from '../playbooks/framework.ts';
import { ATTACKER_PROFILES, BROWSER_TOOL_NAMES } from '../tools/browser-server.ts';
import { capToolCallInput, capToolResultContent } from './events.ts';
import {
  accumulateTurnCost,
  buildUserMessage,
  checkScopeComplete,
  createTurnTracker,
  extractPersonaTagline,
  extractRoute,
  extractTargetId,
  FORM_TOUCHING_TOOLS,
  type LoopInput,
  oneLineSummary,
  PLAYBOOK_TOOL_PREFIX,
  tryParsePlaybookOutcome,
  updateTurnTracking,
} from './loop-shared.ts';
import { consumeNudge, getAgentState, updateOnTurn } from './registry.ts';
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

      const isPlaybook = eventName.startsWith(PLAYBOOK_TOOL_PREFIX);
      const TOOL_TIMEOUT_MS = isPlaybook ? 180_000 : 60_000;
      let result: { content: { type: 'text'; text: string }[] };
      try {
        let timeoutHandle: ReturnType<typeof setTimeout>;
        result = await Promise.race([
          rt.handler(args).finally(() => clearTimeout(timeoutHandle)),
          new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(
              () =>
                reject(
                  new Error(
                    `tool ${rt.name} timed out after ${TOOL_TIMEOUT_MS / 1000}s (browser may have crashed)`,
                  ),
                ),
              TOOL_TIMEOUT_MS,
            );
            if (typeof timeoutHandle === 'object' && timeoutHandle !== null && 'unref' in timeoutHandle) {
              (timeoutHandle as { unref: () => void }).unref();
            }
          }),
        ]);
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
            route,
            targetId,
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

  const HARNESS_SERVER_NAME = 'harness';
  const BROWSER_SERVER_NAME = 'browser';
  const PLAYBOOKS_SERVER_NAME = 'playbooks';

  const harnessServer = createSdkMcpServer({
    name: HARNESS_SERVER_NAME,
    version: '1.0.0',
    tools: harnessSdkTools,
  });
  const browserServer = createSdkMcpServer({
    name: BROWSER_SERVER_NAME,
    version: '1.0.0',
    tools: browserSdkTools,
  });
  const playbooksServer = createSdkMcpServer({
    name: PLAYBOOKS_SERVER_NAME,
    version: '1.0.0',
    tools: playbooksSdkTools,
  });

  // Build the allowedTools list so the SDK auto-approves our MCP tools without
  // prompting for permission. In default permissionMode the subprocess asks for
  // interactive approval before executing any tool — since we run non-
  // interactively (stream-json), unapproved tools silently fail. Listing every
  // tool here as pre-approved fixes this.
  const allowedTools = [
    ...harnessRawTools.map((rt) => `mcp__${HARNESS_SERVER_NAME}__${rt.name}`),
    ...browserRawTools.map((rt) => `mcp__${BROWSER_SERVER_NAME}__${rt.name}`),
    ...playbooksRawTools.map((rt) => `mcp__${PLAYBOOKS_SERVER_NAME}__${rt.name}`),
  ];

  logger.debug('loop-sdk.allowedTools', {
    count: allowedTools.length,
    tools: allowedTools,
  });

  // Bridge AbortSignal through to the SDK's abortController.
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (abortSignal.aborted) {
    controller.abort();
  } else {
    abortSignal.addEventListener('abort', onAbort, { once: true });
  }

  // Pre-compute the persona tagline — the personality text is static per-agent.
  const personaTagline = extractPersonaTagline(agent.personality);

  const turnTracker = createTurnTracker();

  // Per-turn user message generator. The SDK pulls a new user message from
  // this iterator before each assistant turn — that gives us the API-mode
  // "fresh sitemap + intel + nudge each turn" feature inside `query()`.
  //
  // We also emit `agent.turn.start` here (just before yielding) so the event
  // stream stays coherent with the turn-by-turn structure of the API loop.
  //
  // Lockstep gate: the SDK's `Query.streamInput` consumes this generator with a
  // plain `for await`, pulling and forwarding each yielded message to claude's
  // stdin as fast as we yield. If we yield without waiting for the previous
  // turn's assistant response, claude receives a flood of duplicate user
  // messages (the loop conditions only re-evaluate against `journey.turns`,
  // which is incremented by the SEPARATE consumer below — so until that fires,
  // every condition stays true). `turnGatePromise` blocks the next yield until
  // the consumer signals an assistant message arrived (or the loop terminated).
  const isAttacker = ATTACKER_PROFILES.has(agent.profileName);
  const TURN_GATE_TIMEOUT_MS = 120_000;
  const MAX_CONSECUTIVE_TIMEOUTS = 1;
  let turnGateResolve: (() => void) | null = null;
  let turnGatePromise: Promise<void> = Promise.resolve();
  let consecutiveTimeouts = 0;
  let turnsAtLastGate = 0;
  function armTurnGate(): void {
    turnsAtLastGate = journey.turns;
    turnGatePromise = new Promise<void>((r) => {
      turnGateResolve = r;
      setTimeout(() => {
        if (turnGateResolve === r) {
          if (journey.turns === turnsAtLastGate) {
            consecutiveTimeouts += 1;
          } else {
            consecutiveTimeouts = 0;
          }
          logger.warn('loop-sdk.turnGate.timeout', {
            agentId: agent.id,
            consecutiveTimeouts,
            turnsCompleted: journey.turns,
          });
          r();
          turnGateResolve = null;
        }
      }, TURN_GATE_TIMEOUT_MS).unref();
    });
  }
  function releaseTurnGate(): void {
    if (turnGateResolve) {
      consecutiveTimeouts = 0;
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
    while (
      journey.turns < agent.budget.max_turns &&
      !abortSignal.aborted &&
      !journey.terminationReason &&
      journey.costUsd < agent.budget.max_usd &&
      consecutiveTimeouts < MAX_CONSECUTIVE_TIMEOUTS &&
      Date.now() - new Date(journey.startedAt).getTime() < agent.budget.max_minutes * 60_000
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
      const sharedSnap = input.sharedKnowledge?.snapshot();
      const broadcasts = input.sharedKnowledge
        ? input.sharedKnowledge.consumeBroadcasts(agent.id, agent.profileName)
        : [];

      const agentState = getAgentState(agent.id);
      const currentAgentUrl = agentState?.currentUrl ?? undefined;
      updateTurnTracking(turnTracker, currentAgentUrl, journey);

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
        fuzzedFormIds,
        isAttacker,
        personaTagline,
        personaName: agent.profileName,
        currentUrl: currentAgentUrl,
        turnsOnSameUrl: turnTracker.turnsOnSameUrl,
        lastFindingTurn: turnTracker.lastFindingTurn,
      });

      // Scope-completion: QA agents whose personal task queue is empty have
      // finished their job. Only applies to agents WITH a task profile —
      // attackers and unmapped personas run to their natural budget.
      if (checkScopeComplete(agent, input.siteMap, fuzzedFormIds, journey, isAttacker)) {
        journey.terminationReason = 'scope-complete';
        logger.info('loop-sdk.scope-complete', {
          agentId: agent.id,
          turns: journey.turns,
          findings: journey.findings.length,
        });
        break;
      }

      await events?.write({
        type: 'agent.turn.start',
        agentId: agent.id,
        turn: journey.turns + 1,
        modelUsed: agent.model,
      });

      armTurnGate();
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content: userContent },
        parent_tool_use_id: null,
      };
      // Wait for an assistant message (or termination) before yielding the
      // next user turn. Without this gate we'd flood claude's stdin.
      await turnGatePromise;
    }
  }

  // Continuation loop: the SDK's query() terminates when the model emits
  // end_turn (text without tool calls). In API mode, the loop just sends
  // another user message. In SDK mode, we must re-launch query() to keep
  // the agent going. Cap retries to avoid infinite re-launches.
  const MAX_SDK_CONTINUATIONS = 5;
  let sdkContinuations = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const seenAssistantIds = new Set<string>();
    try {
      for await (const message of query({
        prompt: prompts(),
        options: {
          model: agent.model,
          systemPrompt: input.systemPrompt,
          maxTurns: Math.max(1, agent.budget.max_turns - journey.turns),
          pathToClaudeCodeExecutable: resolveClaudeBinaryPath(),
          // Persona's tool surface is exactly the three MCP servers below.
          // Disable the SDK's built-in Claude Code tools (Bash/Read/Edit/etc.)
          // — they would give the agent unrestricted host access — and don't
          // load user/project CLAUDE.md into the agent's system prompt.
          tools: [],
          settingSources: [],
          permissionMode: 'dontAsk',
          mcpServers: {
            [HARNESS_SERVER_NAME]: harnessServer,
            [BROWSER_SERVER_NAME]: browserServer,
            [PLAYBOOKS_SERVER_NAME]: playbooksServer,
          },
          allowedTools,
          abortController: controller,
          stderr: (data: string) => {
            if (data.trim())
              logger.debug('loop-sdk.stderr', {
                agentId: agent.id,
                data: data.trim().slice(0, 500),
              });
          },
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

          // Dedup before any state updates. Do NOT release the gate on a
          // duplicate — the first emission already released it and woke the
          // generator, which armed a NEW gate for the next turn. Releasing
          // again here would unblock that next gate prematurely, causing the
          // generator to yield an extra user message we never asked for.
          if (m.id && seenAssistantIds.has(m.id)) {
            continue;
          }
          if (m.id) seenAssistantIds.add(m.id);

          const turnUsage = m.usage
            ? {
                input: m.usage.input_tokens ?? 0,
                output: m.usage.output_tokens ?? 0,
                cacheRead: m.usage.cache_read_input_tokens ?? 0,
                cacheWrite: m.usage.cache_creation_input_tokens ?? 0,
              }
            : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
          const costUsdDelta = m.usage
            ? accumulateTurnCost(journey, agent.model, turnUsage)
            : 0;
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

          // Unblock the prompts() generator so it can yield the next turn.
          releaseTurnGate();
        }

        if (message.type === 'result') {
          if (!journey.terminationReason) {
            if (controller.signal.aborted) {
              journey.terminationReason = 'signal';
            } else if (journey.turns >= agent.budget.max_turns) {
              journey.terminationReason = 'max-turns';
            } else if (journey.costUsd >= agent.budget.max_usd) {
              journey.terminationReason = 'budget-hit';
            } else {
              // The model stopped calling tools (end_turn). In API mode, the
              // loop just sends another user message. In SDK mode, the query()
              // terminates. Mark as sdk-end; the outer retry loop below will
              // re-launch if budget remains.
              journey.terminationReason = 'sdk-end';
            }
          }
          releaseTurnGate();
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (controller.signal.aborted || abortSignal.aborted) {
        journey.terminationReason = 'signal';
      } else if (/Reached maximum number of turns/i.test(errMsg)) {
        // The SDK throws a "Claude Code returned an error result" with this
        // exact message when its --max-turns cap fires. That's the configured
        // budget terminating cleanly, not an actual failure — classify as
        // max-turns so the run summary is accurate.
        journey.terminationReason = 'max-turns';
      } else {
        journey.terminationReason = 'error';
        logger.error('loop-sdk.error', { error: errMsg });
      }
      // Defensive: if the consumer loop threw mid-turn the gate may still be
      // armed and prompts() would deadlock awaiting it. Release so the generator
      // can observe terminationReason and exit cleanly during cleanup.
      releaseTurnGate();
    } finally {
      releaseTurnGate();
    }

    if (!journey.terminationReason) {
      if (consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
        journey.terminationReason = 'error';
        logger.error('loop-sdk.subprocess-unresponsive', {
          agentId: agent.id,
          consecutiveTimeouts,
          turnsCompleted: journey.turns,
        });
      } else if (controller.signal.aborted || abortSignal.aborted) {
        journey.terminationReason = 'signal';
      } else if (journey.turns >= agent.budget.max_turns) {
        journey.terminationReason = 'max-turns';
      } else if (journey.costUsd >= agent.budget.max_usd) {
        journey.terminationReason = 'budget-hit';
      } else {
        journey.terminationReason = 'sdk-end';
      }
    }

    // Continuation: if the SDK terminated because the model stopped calling
    // tools (sdk-end) but the agent still has budget, re-launch query() with
    // a continuation nudge. This mirrors the API-mode loop's `continue` on
    // end_turn — the model gets another chance with a fresh user message.
    if (
      journey.terminationReason === 'sdk-end' &&
      sdkContinuations < MAX_SDK_CONTINUATIONS &&
      journey.turns < agent.budget.max_turns &&
      journey.costUsd < agent.budget.max_usd &&
      !abortSignal.aborted &&
      Date.now() - new Date(journey.startedAt).getTime() < agent.budget.max_minutes * 60_000
    ) {
      sdkContinuations += 1;
      (journey as { terminationReason: string | undefined }).terminationReason = undefined;
      logger.info('loop-sdk.continuation', {
        agentId: agent.id,
        attempt: sdkContinuations,
        turnsCompleted: journey.turns,
        findings: journey.findings.length,
        costUsd: journey.costUsd,
      });
      consecutiveTimeouts = 0;
      continue;
    }

    break;
  } // end continuation while loop

  abortSignal.removeEventListener('abort', onAbort);
}
