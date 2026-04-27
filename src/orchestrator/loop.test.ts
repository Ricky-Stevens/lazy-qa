/**
 * Loop regression tests.
 *
 * The headline test pins the bug found in run cd49622f's predecessor: when
 * the sliding window stripped a leading assistant message, it left the
 * orphaned tool_result message right after the synthetic summary —
 * tool_use_id had no matching tool_use, and every agent's first
 * post-compaction API call 400'd.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../logging/logger.ts';
import type { ResolvedAgent } from '../types/agent.ts';
import { compactSlidingWindow, pickModel } from './loop.ts';
import { SummaryMemory } from './summary-memory.ts';

/** Build a minimal Anthropic.Tool array the same way the loop does. */
function buildCachedTools(rawDefs: Array<{ name: string }>): Anthropic.Tool[] {
  const tools: Anthropic.Tool[] = rawDefs.map((d) => ({
    name: d.name,
    description: `${d.name} tool`,
    input_schema: { type: 'object' as const, properties: {} },
  }));
  if (tools.length === 0) return [];
  return [
    ...tools.slice(0, -1),
    {
      ...tools[tools.length - 1]!,
      cache_control: { type: 'ephemeral', ttl: '1h' },
    },
  ];
}

const logger = createLogger({ runId: 'test' });

function userPrompt(label: string): Anthropic.MessageParam {
  return { role: 'user', content: `prompt-${label}` };
}

function assistantToolUse(id: string): Anthropic.MessageParam {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name: 'foo', input: {} }],
  };
}

function userToolResults(ids: string[]): Anthropic.MessageParam {
  return {
    role: 'user',
    content: ids.map((id) => ({
      type: 'tool_result',
      tool_use_id: id,
      content: 'ok',
    })),
  };
}

/** Build N turns: each = [user(prompt), assistant(tool_use), user(tool_results)]. */
function buildTurns(n: number): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (let i = 0; i < n; i++) {
    out.push(userPrompt(`t${i}`));
    out.push(assistantToolUse(`tu_t${i}`));
    out.push(userToolResults([`tu_t${i}`]));
  }
  return out;
}

describe('cachedTools breakpoint', () => {
  it('marks only the last tool definition with cache_control', () => {
    const tools = buildCachedTools([{ name: 'tool_a' }, { name: 'tool_b' }, { name: 'tool_c' }]);

    expect(tools).toHaveLength(3);
    // First N-1 entries must NOT have cache_control.
    expect(
      (tools[0] as Anthropic.Tool & { cache_control?: unknown }).cache_control,
    ).toBeUndefined();
    expect(
      (tools[1] as Anthropic.Tool & { cache_control?: unknown }).cache_control,
    ).toBeUndefined();
    // Last entry must carry the 1h ephemeral marker.
    expect((tools[2] as Anthropic.Tool & { cache_control?: unknown }).cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    });
  });

  it('returns an empty array when there are no tools', () => {
    expect(buildCachedTools([])).toEqual([]);
  });

  it('works with a single tool', () => {
    const tools = buildCachedTools([{ name: 'only_tool' }]);
    expect(tools).toHaveLength(1);
    expect((tools[0] as Anthropic.Tool & { cache_control?: unknown }).cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    });
  });
});

describe('compactSlidingWindow', () => {
  it('does nothing when below the threshold', () => {
    const msgs = buildTurns(4); // 12 messages
    const before = JSON.stringify(msgs);
    compactSlidingWindow(msgs, new SummaryMemory(), logger);
    expect(JSON.stringify(msgs)).toBe(before);
  });

  it('compacts and never leaves orphaned tool_results at position 1', () => {
    // 5 full turns + a fresh 6th user prompt = 16 messages, well over threshold.
    const msgs: Anthropic.MessageParam[] = [...buildTurns(5), userPrompt('t5')];
    expect(msgs.length).toBe(16);

    compactSlidingWindow(msgs, new SummaryMemory(), logger);

    // After compaction, message 0 must be the synthetic summary (user, string).
    expect(msgs[0]?.role).toBe('user');
    expect(typeof msgs[0]?.content).toBe('string');

    // No message before its corresponding tool_use may carry tool_result blocks.
    // Walk through and assert that every tool_result has a tool_use in the
    // immediately preceding assistant message.
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (!m || typeof m.content === 'string') continue;
      const toolResults = m.content.filter(
        (b): b is Anthropic.ToolResultBlockParam => (b as { type: string }).type === 'tool_result',
      );
      if (toolResults.length === 0) continue;
      const prev = msgs[i - 1];
      expect(prev?.role).toBe('assistant');
      const toolUseIds = new Set(
        Array.isArray(prev?.content)
          ? prev.content
              .filter(
                (b): b is Anthropic.ToolUseBlockParam =>
                  (b as { type: string }).type === 'tool_use',
              )
              .map((b) => b.id)
          : [],
      );
      for (const tr of toolResults) {
        expect(toolUseIds.has(tr.tool_use_id)).toBe(true);
      }
    }
  });

  it('strips both the leading assistant and its tool_results when both fall in the window head', () => {
    // Construct so the slice(-KEEP_TAIL) lands on [assistant, user(tool_results), ...].
    // KEEP_TAIL = 12; we need >14 messages with the boundary in the middle of a turn.
    const msgs: Anthropic.MessageParam[] = [...buildTurns(5), userPrompt('t5')]; // 16
    compactSlidingWindow(msgs, new SummaryMemory(), logger);

    // Position 1 (right after the summary) must NOT be a user message whose
    // content array carries tool_result blocks.
    const m1 = msgs[1];
    if (m1 && typeof m1.content !== 'string') {
      const hasToolResults = m1.content.some((b) => (b as { type: string }).type === 'tool_result');
      expect(hasToolResults).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// pickModel — per-turn model routing (WP3.B)
// ---------------------------------------------------------------------------

/** Minimal ResolvedAgent stub for pickModel tests. */
function makeAgent(model: string, plannerModel?: string): ResolvedAgent {
  return {
    id: 'test-agent',
    profileName: 'power-user',
    personality: 'test',
    model,
    plannerModel,
    budget: { max_turns: 80, max_usd: 1, max_minutes: 25 },
    credentials: null,
  };
}

describe('pickModel', () => {
  it('returns agent.model when nextTurnIsPlanning is false', () => {
    const agent = makeAgent('claude-haiku-4-5-20251001', 'claude-sonnet-4-6');
    expect(pickModel(false, agent)).toBe('claude-haiku-4-5-20251001');
  });

  it('returns plannerModel when nextTurnIsPlanning is true and plannerModel is set', () => {
    const agent = makeAgent('claude-haiku-4-5-20251001', 'claude-sonnet-4-6');
    expect(pickModel(true, agent)).toBe('claude-sonnet-4-6');
  });

  it('falls back to agent.model when nextTurnIsPlanning is true but plannerModel is not set', () => {
    const agent = makeAgent('claude-haiku-4-5-20251001');
    expect(pickModel(true, agent)).toBe('claude-haiku-4-5-20251001');
  });

  it('returns agent.model when nextTurnIsPlanning is false regardless of plannerModel', () => {
    const agent = makeAgent('claude-haiku-4-5-20251001', 'claude-sonnet-4-6');
    // Normal action turn — plannerModel must NOT be selected
    expect(pickModel(false, agent)).toBe('claude-haiku-4-5-20251001');
    // After the planning turn resets, the next call should also use Haiku
    expect(pickModel(false, agent)).toBe('claude-haiku-4-5-20251001');
  });
});

// ---------------------------------------------------------------------------
// Memory tool — WP3.E
// ---------------------------------------------------------------------------

/** Build the allTools array the same way loop.ts does — respects the cache
 * breakpoint on the last regular tool, appends the memory tool when enabled. */
function buildAllTools(
  rawDefs: Array<{ name: string }>,
  memoryEnabled: boolean,
): Anthropic.ToolUnion[] {
  const cached = buildCachedTools(rawDefs);
  if (!memoryEnabled) return cached;
  const memoryTool: Anthropic.MemoryTool20250818 = { type: 'memory_20250818', name: 'memory' };
  return [...cached, memoryTool];
}

describe('memory tool inclusion', () => {
  it('includes the memory tool when memoryEnabled is true', () => {
    const tools = buildAllTools([{ name: 'tool_a' }, { name: 'tool_b' }], true);
    const memoryEntry = tools.find((t) => t.name === 'memory');
    expect(memoryEntry).toBeDefined();
    expect(memoryEntry?.type).toBe('memory_20250818');
  });

  it('does NOT include the memory tool when memoryEnabled is false', () => {
    const tools = buildAllTools([{ name: 'tool_a' }, { name: 'tool_b' }], false);
    const memoryEntry = tools.find((t) => t.name === 'memory');
    expect(memoryEntry).toBeUndefined();
  });

  it('cache breakpoint on last regular tool is preserved when memory is appended', () => {
    const tools = buildAllTools([{ name: 'tool_a' }, { name: 'tool_b' }], true);
    // tool_b is the last regular tool — must still carry cache_control
    const toolB = tools.find((t) => t.name === 'tool_b');
    expect(toolB?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    // memory tool appended after — must NOT carry the regular cache breakpoint
    const memoryEntry = tools.find((t) => t.name === 'memory');
    expect(memoryEntry?.cache_control).toBeUndefined();
  });

  it('works correctly with no regular tools and memoryEnabled', () => {
    const tools = buildAllTools([], true);
    // No regular tools → cachedTools is [] → only the memory tool
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('memory');
    expect(tools[0]?.type).toBe('memory_20250818');
  });
});
