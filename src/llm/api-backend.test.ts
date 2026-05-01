import { describe, expect, it, vi } from 'vitest';
import { ApiLlmBackend } from './api-backend.ts';

vi.mock('@anthropic-ai/sdk', () => {
  const create = vi.fn().mockResolvedValue({
    content: [{ type: 'text', text: 'hi' }],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  });
  return {
    default: vi.fn().mockImplementation(() => ({ messages: { create } })),
    __mockCreate: create,
  };
});

describe('ApiLlmBackend', () => {
  it('calls messages.create and returns normalised result', async () => {
    const backend = new ApiLlmBackend({ apiKey: 'sk-test' });
    const result = await backend.call({
      model: 'claude-haiku-4-5-20251001',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 1024,
    });
    expect(result.content).toEqual([{ type: 'text', text: 'hi' }]);
    expect(result.stopReason).toBe('end_turn');
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(5);
  });

  it('applies cache_control to system prompt when cacheSystem=true', async () => {
    const sdk = await import('@anthropic-ai/sdk');
    const create = (sdk as unknown as { __mockCreate: ReturnType<typeof vi.fn> }).__mockCreate;
    create.mockClear();

    const backend = new ApiLlmBackend({ apiKey: 'sk-test' });
    await backend.call({
      model: 'claude-haiku-4-5-20251001',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 1024,
      cacheSystem: true,
    });

    // biome-ignore lint/style/noNonNullAssertion: mock was called at least once — asserted by test
    const args = create.mock.calls[0]![0];
    expect(args.system).toEqual([
      {
        type: 'text',
        text: 'sys',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ]);
  });
});
