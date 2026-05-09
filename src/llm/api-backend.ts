import Anthropic from '@anthropic-ai/sdk';
import type { LlmBackend, LlmCallInput, LlmCallResult } from './backend.ts';

export class ApiLlmBackend implements LlmBackend {
  readonly kind = 'api' as const;
  private readonly apiKey: string;
  private readonly client: Anthropic;

  constructor(opts: { apiKey: string }) {
    this.apiKey = opts.apiKey;
    this.client = new Anthropic({ apiKey: opts.apiKey });
  }

  /** Escape hatch for callers (e.g. the persona loop) that still take an apiKey
   *  parameter. Subscription mode should never need this — gate on
   *  `backend.kind === 'api'`. */
  getApiKey(): string {
    return this.apiKey;
  }

  /** Escape hatch for callers needing the raw `messages.batches` API or any
   *  other endpoint not exposed by `LlmBackend.call()`. Subscription mode does
   *  not support batch; callers must check `backend.kind === 'api'` first. */
  getRawClient(): Anthropic {
    return this.client;
  }

  async call(input: LlmCallInput): Promise<LlmCallResult> {
    const systemBlocks: Anthropic.TextBlockParam[] = [
      {
        type: 'text',
        text: input.systemPrompt,
        ...(input.cacheSystem
          ? { cache_control: { type: 'ephemeral' as const, ttl: '1h' as const } }
          : {}),
      },
    ];

    const tools = input.cacheLastTool ? withLastToolCacheBreakpoint(input.tools) : input.tools;

    const messages = input.cacheLastMessage
      ? withLastMessageCacheBreakpoint(input.messages)
      : input.messages;

    const response = await this.client.messages.create({
      model: input.model,
      max_tokens: input.maxTokens,
      system: systemBlocks,
      messages,
      tools,
      ...(typeof input.thinkingBudgetTokens === 'number' && input.thinkingBudgetTokens > 0
        ? { thinking: { type: 'enabled' as const, budget_tokens: input.thinkingBudgetTokens } }
        : {}),
      ...(input.toolChoice ? { tool_choice: input.toolChoice } : {}),
    });

    return {
      content: response.content,
      stopReason: response.stop_reason ?? null,
      usage: {
        inputTokens: response.usage.input_tokens ?? 0,
        outputTokens: response.usage.output_tokens ?? 0,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}

function withLastToolCacheBreakpoint(tools: Anthropic.ToolUnion[]): Anthropic.ToolUnion[] {
  if (tools.length === 0) return tools;
  // biome-ignore lint/style/noNonNullAssertion: length guard above ensures element exists
  const last = tools[tools.length - 1]!;
  return [
    ...tools.slice(0, -1),
    { ...last, cache_control: { type: 'ephemeral', ttl: '1h' } } as Anthropic.ToolUnion,
  ];
}

function withLastMessageCacheBreakpoint(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages;
  // biome-ignore lint/style/noNonNullAssertion: length guard above ensures element exists
  const last = messages[messages.length - 1]!;
  const cacheBreakpoint: Anthropic.CacheControlEphemeral = { type: 'ephemeral' };
  if (typeof last.content === 'string') {
    return [
      ...messages.slice(0, -1),
      {
        role: last.role,
        content: [{ type: 'text', text: last.content, cache_control: cacheBreakpoint }],
      },
    ];
  }
  const blocks = last.content;
  if (blocks.length === 0) return messages;
  // biome-ignore lint/style/noNonNullAssertion: length guard above ensures element exists
  const lastBlock = blocks[blocks.length - 1]!;
  return [
    ...messages.slice(0, -1),
    {
      role: last.role,
      content: [
        ...(blocks.slice(0, -1) as Anthropic.ContentBlockParam[]),
        { ...lastBlock, cache_control: cacheBreakpoint } as Anthropic.ContentBlockParam,
      ],
    },
  ];
}
