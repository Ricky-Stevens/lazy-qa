import { query } from '@anthropic-ai/claude-agent-sdk';
import type Anthropic from '@anthropic-ai/sdk';
import type { LlmBackend, LlmCallInput, LlmCallResult } from './backend.ts';
import { resolveClaudeBinaryPath } from './sdk-binary.ts';

/**
 * SDK-backed one-shot caller. Uses `@anthropic-ai/claude-agent-sdk`'s `query()`
 * with `maxTurns: 1` so we get a single assistant response and then exit.
 *
 * Auth: when ANTHROPIC_API_KEY is unset and the user has run `claude login`,
 * the SDK uses the stored Claude Code OAuth token (Pro/Max subscription).
 *
 * Limitations vs ApiLlmBackend:
 *   - cache_control hints are ignored (SDK auto-caches)
 *   - tool definitions in `input.tools` are ignored — for one-shot calls we
 *     don't need tools (review/verify/site-playbook/auth-agent are all "ask
 *     the model a question, get JSON/text back"); the persona loop uses
 *     loop-sdk.ts which wires MCP servers via `mcpServers`
 *   - thinking-budget is mapped to `maxThinkingTokens`
 */
export class SdkLlmBackend implements LlmBackend {
  readonly kind = 'sdk' as const;

  async call(input: LlmCallInput): Promise<LlmCallResult> {
    const promptText = serialiseMessages(input.messages);

    let assistantContent: Anthropic.ContentBlock[] = [];
    let stopReason: string | null = null;
    let usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };

    for await (const message of query({
      prompt: promptText,
      options: {
        model: input.model,
        systemPrompt: input.systemPrompt,
        maxTurns: 1,
        pathToClaudeCodeExecutable: resolveClaudeBinaryPath(),
        // Isolation: no built-in tools (this is a text-in / text-out caller)
        // and no host CLAUDE.md / settings.json sources — the SDK otherwise
        // injects the user's global Claude Code instructions into the system
        // prompt, which both bleeds unrelated guidance into the response and
        // burns the single available turn on filesystem actions.
        tools: [],
        settingSources: [],
        ...(typeof input.thinkingBudgetTokens === 'number' && input.thinkingBudgetTokens > 0
          ? { maxThinkingTokens: input.thinkingBudgetTokens }
          : {}),
      },
    })) {
      if (message.type === 'assistant') {
        // SDKAssistantMessage narrows here; widen the inner BetaMessage's
        // shape to use Anthropic's public ContentBlock and optional usage.
        const m = message.message as {
          content: Anthropic.ContentBlock[];
          stop_reason?: string | null;
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
        };
        assistantContent = m.content;
        stopReason = m.stop_reason ?? null;
        if (m.usage) {
          usage = {
            inputTokens: m.usage.input_tokens ?? 0,
            outputTokens: m.usage.output_tokens ?? 0,
            cacheReadTokens: m.usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: m.usage.cache_creation_input_tokens ?? 0,
          };
        }
      }
      // 'result' messages may carry a final usage roll-up; we already captured
      // per-turn usage from the 'assistant' message above. Loop-mode (Task 7)
      // will need to handle multi-turn aggregation differently.
    }

    return {
      content: assistantContent,
      stopReason,
      usage,
    };
  }
}

function serialiseMessages(messages: Anthropic.MessageParam[]): string {
  return messages
    .map((m) => {
      const text =
        typeof m.content === 'string'
          ? m.content
          : m.content
              .map((b) => ('text' in b ? (b as { text: string }).text : ''))
              .filter(Boolean)
              .join('\n');
      return `[${m.role}]\n${text}`;
    })
    .join('\n\n');
}
