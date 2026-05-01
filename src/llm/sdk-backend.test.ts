import { describe, expect, it, vi } from 'vitest';
import { SdkLlmBackend } from './sdk-backend.ts';

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  async function* fakeQuery() {
    yield {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'hi from sdk' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 12,
          output_tokens: 7,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    };
    yield {
      type: 'result',
      subtype: 'success',
      result: 'hi from sdk',
    };
  }
  return {
    query: vi.fn().mockImplementation(() => fakeQuery()),
    createSdkMcpServer: vi.fn(),
    tool: vi.fn(),
  };
});

describe('SdkLlmBackend', () => {
  it('runs a single-turn query and returns normalised result', async () => {
    const backend = new SdkLlmBackend();
    const result = await backend.call({
      model: 'claude-haiku-4-5-20251001',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 1024,
    });
    expect(result.stopReason).toBe('end_turn');
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'hi from sdk' });
    expect(result.usage.inputTokens).toBe(12);
  });
});
