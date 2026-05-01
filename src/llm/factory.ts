import { ApiLlmBackend } from './api-backend.ts';
import type { LlmBackend } from './backend.ts';
import { SdkLlmBackend } from './sdk-backend.ts';

export type LlmAuth = 'api' | 'subscription';

export interface SelectBackendInput {
  apiKey: string | undefined;
  llmAuth: string | undefined;
}

/** Pick a backend based on env. Defaults to 'api' for backward compat. */
export function selectBackend(input: SelectBackendInput): LlmBackend {
  const auth = input.llmAuth ?? 'api';
  if (auth !== 'api' && auth !== 'subscription') {
    throw new Error(`Unknown LLM_AUTH value: ${auth}. Expected 'api' or 'subscription'.`);
  }
  if (auth === 'api') {
    if (!input.apiKey) {
      throw new Error(
        'LLM_AUTH=api requires ANTHROPIC_API_KEY. Set it, or use LLM_AUTH=subscription for local dev (requires `claude login`).',
      );
    }
    return new ApiLlmBackend({ apiKey: input.apiKey });
  }
  // Footgun: when LLM_AUTH=subscription, ANTHROPIC_API_KEY in process.env is
  // the SDK's preferred auth — it will silently bill the API key instead of
  // the subscription. Warn loudly to stderr so a user who sets both gets a
  // visible heads-up. Emit via console.warn rather than a logger because
  // selectBackend is called before the run's logger is configured.
  if (input.apiKey && input.apiKey.length > 0) {
    console.warn(
      '[llm/factory] LLM_AUTH=subscription was requested but ANTHROPIC_API_KEY is set in the environment.',
    );
    console.warn(
      '[llm/factory] The Claude Agent SDK will use the API key (billing against credits), defeating subscription mode.',
    );
    console.warn(
      '[llm/factory] To actually use your Pro/Max subscription, unset ANTHROPIC_API_KEY (comment it out in .env).',
    );
  }
  return new SdkLlmBackend();
}
