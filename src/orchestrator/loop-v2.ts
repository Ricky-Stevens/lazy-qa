/**
 * Agent loop v2 — direct Anthropic SDK loop with continuous conversation,
 * sliding-window history compaction, and per-turn sitemap injection.
 *
 * Differences vs v1's direct-loop / spawn-agent SDK path:
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
 *   - Direct API only. Subscription auth (claude CLI) is not supported on
 *     this path. Spawn-agent-v2 enforces that an API key is set.
 */

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { SiteMapAccessor } from '../crawler/types.ts';
import type { Logger } from '../logging/logger.ts';
import type { RawToolDef } from '../playbooks/framework.ts';
import type { PlaybookOutcome } from '../playbooks/outcome.ts';
import type { ResolvedAgent } from '../types/agent.ts';
import type { Journey } from '../types/journey.ts';
import { computeCostUsd } from './cost.ts';
import { consumeNudge, updateOnTurn } from './registry.ts';
import type { MemoryEntry, SummaryMemory } from './summary-memory.ts';

/**
 * Sliding window: keep the last KEEP_TAIL messages in full, replacing the
 * elided head with a single synthetic "summary" user message. KEEP_TAIL = 12
 * is roughly six (assistant, tool_result) turn pairs.
 */
const KEEP_TAIL = 12;
/** Compact when the conversation grows beyond this many messages. */
const COMPACT_THRESHOLD = 14;

/** Top-N items per sitemap snapshot section. */
const SITEMAP_TOP_N = 10;

/** Anthropic SDK request hard cap for assistant output. */
const MAX_OUTPUT_TOKENS = 4096;

/** Playbook tool prefix the registry uses. Must match `PlaybookRegistry.toMcpTools`. */
const PLAYBOOK_TOOL_PREFIX = 'mcp__playbooks__';

export interface LoopV2Input {
  agent: ResolvedAgent;
  targetUrl: string;
  systemPrompt: string;
  apiKey: string;
  /** Primitive + macro + playbook tools, all in `RawToolDef` form. The loop
   * converts these to Anthropic Tool definitions and dispatches calls. */
  rawTools: RawToolDef[];
  journey: Journey;
  abortSignal: AbortSignal;
  logger: Logger;
  /** Shared sitemap accessor. Used to render the per-turn snapshot lines. */
  siteMap: SiteMapAccessor;
  /** Per-agent rolling memory of past playbook attempts. The loop appends to
   * this after every playbook tool result. */
  summaryMemory: SummaryMemory;
}

/** Run the agent loop. Resolves when the loop terminates. Never throws —
 * errors are recorded into `journey.terminationReason`. */
export async function runAgentLoopV2(input: LoopV2Input): Promise<void> {
  const client = new Anthropic({ apiKey: input.apiKey });
  const { agent, journey, logger, rawTools, siteMap, summaryMemory } = input;

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

  // 2. Continuous conversation. We only ever push to this array; the
  // sliding-window compaction rewrites the head in-place when needed.
  const messages: Anthropic.MessageParam[] = [];

  while (
    journey.turns < agent.budget.max_turns &&
    !input.abortSignal.aborted &&
    journey.terminationReason !== 'end_session' &&
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
    const userContent = buildUserMessage({
      isFirstTurn: journey.turns === 0,
      targetUrl: input.targetUrl,
      siteMap,
      summaryMemory,
      nudge,
      turnsCompleted: journey.turns,
      findingsCount: journey.findings.length,
      remainingMin,
    });

    messages.push({ role: 'user', content: userContent });

    // Sliding-window compaction. When we cross the threshold, replace the
    // elided head with a single synthetic summary user message. The system
    // prompt is untouched so the prompt cache survives.
    if (messages.length > COMPACT_THRESHOLD) {
      compactSlidingWindow(messages, summaryMemory, logger);
    }

    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: agent.model,
        max_tokens: MAX_OUTPUT_TOKENS,
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
          error: err instanceof Error ? err.message : String(err),
          shape,
        });
      }
      return;
    }

    journey.turns += 1;
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
      // Unknown model — keep token totals only.
    }

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
        const handler = handlerByName.get(use.name);
        if (!handler) {
          return {
            block: {
              type: 'tool_result',
              tool_use_id: use.id,
              content: `Unknown tool: ${use.name}`,
              is_error: true,
            } satisfies Anthropic.ToolResultBlockParam,
            outcome: null as PlaybookOutcome | null,
          };
        }
        try {
          const result = await handler(use.input as Record<string, unknown>);
          const text = result.content[0]?.text ?? '';
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
          return {
            block: {
              type: 'tool_result',
              tool_use_id: use.id,
              content: err instanceof Error ? err.message : String(err),
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

/** Build the per-turn user message — sitemap snapshot + summary memory + continue line. */
function buildUserMessage(args: {
  isFirstTurn: boolean;
  targetUrl: string;
  siteMap: SiteMapAccessor;
  summaryMemory: SummaryMemory;
  nudge: string | null;
  turnsCompleted: number;
  findingsCount: number;
  remainingMin: number;
}): string {
  const sections: string[] = [];

  if (args.nudge) {
    sections.push(`[SUPERVISOR INTERVENTION — read this first]\n${args.nudge}`);
  }

  const snapshot = renderSiteMapSnapshot(args.siteMap);
  if (snapshot) sections.push(snapshot);

  const memory = args.summaryMemory.serialize();
  if (memory) sections.push(memory);

  if (args.isFirstTurn) {
    sections.push(
      `Begin. You're already on ${args.targetUrl}. Pick a playbook from the list above (or invent your own action via the primitive browser tools) and start exercising the app as your character would.`,
    );
  } else {
    sections.push(
      [
        `[continue] Progress: ${args.turnsCompleted} turns, ${args.findingsCount} findings, ~${args.remainingMin.toFixed(1)} min remaining.`,
        `Stay in character. Pick something from the snapshot above you have NOT yet touched. Batch tool calls aggressively.`,
      ].join('\n'),
    );
  }

  return sections.join('\n\n');
}

/** Render the top-N unvisited / untested items from the sitemap. Returns
 *  empty string when the sitemap has nothing useful to surface. */
function renderSiteMapSnapshot(siteMap: SiteMapAccessor): string {
  const lines: string[] = ['[sitemap snapshot]'];
  let included = 0;

  const unvisited = siteMap.listUnvisitedRoutes().slice(0, SITEMAP_TOP_N);
  if (unvisited.length > 0) {
    lines.push(
      `- Unvisited routes: ${unvisited.map((r) => r.route).join(', ')} (${unvisited.length})`,
    );
    included += 1;
  }

  // For "untested" we use a representative playbook per category. This is a
  // heuristic — the playbooks really track per-(playbook,target) attempts but
  // surfacing one bucket per category is enough for the agent to pick.
  const formsUntested = siteMap.listFormsUntested('crud_create_form').slice(0, SITEMAP_TOP_N);
  if (formsUntested.length > 0) {
    lines.push(
      `- Forms not yet CRUD-tested: ${formsUntested
        .map((f) => `${f.route}:${f.formId}`)
        .join(', ')} (${formsUntested.length})`,
    );
    included += 1;
  }

  const tablesUntested = siteMap
    .listTablesUntested('table_sort_each_column')
    .slice(0, SITEMAP_TOP_N);
  if (tablesUntested.length > 0) {
    lines.push(
      `- Tables not yet sorted: ${tablesUntested
        .map((t) => `${t.route}:${t.tableId}`)
        .join(', ')} (${tablesUntested.length})`,
    );
    included += 1;
  }

  const modalsUntested = siteMap.listModalsUntested('modal_lifecycle').slice(0, SITEMAP_TOP_N);
  if (modalsUntested.length > 0) {
    lines.push(
      `- Modals not yet exercised: ${modalsUntested
        .map((m) => `${m.route}:${m.modalId}`)
        .join(', ')} (${modalsUntested.length})`,
    );
    included += 1;
  }

  // Affordance hints — what's BEHIND the buttons and kebabs the link-graph
  // crawler can't see. Show up to a few non-trivial findings per route so
  // agents know "X has an Add modal", "Y has a kebab with Edit/Disable".
  const affordanceLines = renderAffordanceHints(siteMap);
  if (affordanceLines.length > 0) {
    lines.push(...affordanceLines);
    included += 1;
  }

  return included === 0 ? '' : lines.join('\n');
}

/** Build short "what's behind this" lines from probed affordances. We only
 * surface non-trivial outcomes (modal/wizard/menu/inline-form) and limit
 * total bytes so the per-turn message stays small. Routes are ordered
 * recently-visited-first so the byte budget biases toward routes the agent
 * just touched (and might want to deepen) rather than insertion order. */
function renderAffordanceHints(siteMap: SiteMapAccessor): string[] {
  const out: string[] = [];
  let bytesUsed = 0;
  const BYTE_BUDGET = 1200;

  const sortedRoutes = siteMap.listAllRoutes().sort((a, b) => {
    // Recently-visited first (descending visitedAt). Unvisited routes go
    // last so we don't spend the byte budget on routes nobody's been to.
    if (a.visitedAt && b.visitedAt) {
      return b.visitedAt.localeCompare(a.visitedAt);
    }
    if (a.visitedAt) return -1;
    if (b.visitedAt) return 1;
    return 0;
  });

  for (const route of sortedRoutes) {
    if (bytesUsed > BYTE_BUDGET) break;
    const model = siteMap.getPageModel(route.route);
    const discovered = model?.discovered ?? [];
    if (discovered.length === 0) continue;

    const items: string[] = [];
    for (const d of discovered) {
      switch (d.outcome.kind) {
        case 'modal':
          items.push(
            `${d.trigger.label}→modal "${d.outcome.modalName}"${d.outcome.hasForm ? '+form' : ''}`,
          );
          break;
        case 'wizard':
          items.push(
            `${d.trigger.label}→wizard "${d.outcome.wizardName}" (${d.outcome.stepCount} steps)`,
          );
          break;
        case 'inline-form':
          items.push(`${d.trigger.label}→inline-form "${d.outcome.formName}"`);
          break;
        case 'menu': {
          const sample = d.outcome.items.slice(0, 4).join('/');
          items.push(`${d.trigger.label}→menu [${sample}]`);
          break;
        }
        // navigation/inert/error/toast deliberately omitted — low signal
      }
    }
    if (items.length === 0) continue;
    const line = `- Affordances ${route.route}: ${items.slice(0, 6).join('; ')}`;
    bytesUsed += line.length + 1;
    if (bytesUsed > BYTE_BUDGET) break;
    out.push(line);
  }
  return out;
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

/** Try to parse a playbook outcome from a tool-result text. Returns null if
 *  the text doesn't look like a serialised PlaybookOutcome. */
function tryParsePlaybookOutcome(text: string): PlaybookOutcome | null {
  // Empty or trivially short results aren't outcomes.
  if (!text || text.length < 20) return null;
  // Find the first JSON object in the text — playbook handlers may prefix
  // a one-line summary line then a JSON blob, or be pure JSON.
  const jsonStart = text.indexOf('{');
  if (jsonStart < 0) return null;
  const jsonCandidate = text.slice(jsonStart);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonCandidate);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.playbookName !== 'string') return null;
  if (typeof o.status !== 'string') return null;
  if (o.status !== 'ok' && o.status !== 'failed' && o.status !== 'suspicious') return null;
  if (typeof o.summary !== 'string') return null;
  return o as unknown as PlaybookOutcome;
}

/** Extract a target id from the playbook tool input. Most playbooks pass it
 *  as `formId` / `tableId` / `modalId` / `wizardId`. Returns null if absent. */
function extractTargetId(input: Record<string, unknown>): string | null {
  for (const key of ['formId', 'tableId', 'modalId', 'wizardId']) {
    const v = input[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/** Extract a route from a PlaybookOutcome's evidence, when present. The
 *  browser server v2's playbook handler is expected to inject this. */
function extractRoute(outcome: PlaybookOutcome): string | null {
  const ev = outcome.evidence;
  if (!ev) return null;
  const v = (ev as Record<string, unknown>).route;
  return typeof v === 'string' ? v : null;
}

/** Trim the playbook summary to a single line, capped at 160 chars. */
function oneLineSummary(outcome: PlaybookOutcome): string {
  const firstLine = (outcome.summary ?? '').split('\n')[0]?.trim() ?? '';
  if (firstLine.length <= 160) return firstLine;
  return `${firstLine.slice(0, 157)}...`;
}
