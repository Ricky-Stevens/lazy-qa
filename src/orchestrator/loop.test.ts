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
import { compactSlidingWindow } from './loop.ts';
import { SummaryMemory } from './summary-memory.ts';

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
