import type Anthropic from '@anthropic-ai/sdk';

/** Inputs for one LLM turn — backend-agnostic. */
export interface LlmCallInput {
  model: string;
  systemPrompt: string;
  messages: Anthropic.MessageParam[];
  tools: Anthropic.ToolUnion[];
  maxTokens: number;
  /** Optional extended-thinking budget. Subscription mode maps this to
   *  `maxThinkingTokens`; API mode maps it to the `thinking` param. */
  thinkingBudgetTokens?: number;
  /** Cache-control hints. API backend honours these via `cache_control`
   *  blocks; SDK backend ignores them (the SDK auto-caches). */
  cacheSystem?: boolean;
  cacheLastTool?: boolean;
  cacheLastMessage?: boolean;
  /** Force the model to call a specific tool (structured output) or any tool.
   *  API backend maps this to the `tool_choice` request param; SDK backend
   *  ignores it (the SDK controls tool dispatch internally). */
  toolChoice?: Anthropic.ToolChoice;
}

/** Normalised response across backends. */
export interface LlmCallResult {
  content: Anthropic.ContentBlock[];
  stopReason: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
}

/** Backend interface — one method, identifies its kind for logging. */
export interface LlmBackend {
  readonly kind: 'api' | 'sdk';
  call(input: LlmCallInput): Promise<LlmCallResult>;
}
