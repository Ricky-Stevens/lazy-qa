import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { selectBackend } from './factory.ts';

describe('selectBackend', () => {
  it('returns api backend when LLM_AUTH is unset and apiKey is provided', () => {
    const backend = selectBackend({ apiKey: 'sk-test', llmAuth: undefined });
    expect(backend.kind).toBe('api');
  });

  it('returns api backend when LLM_AUTH=api', () => {
    const backend = selectBackend({ apiKey: 'sk-test', llmAuth: 'api' });
    expect(backend.kind).toBe('api');
  });

  it('returns sdk backend when LLM_AUTH=subscription', () => {
    const backend = selectBackend({ apiKey: undefined, llmAuth: 'subscription' });
    expect(backend.kind).toBe('sdk');
  });

  it('throws when LLM_AUTH=api but apiKey is missing', () => {
    expect(() => selectBackend({ apiKey: undefined, llmAuth: 'api' })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('throws on unknown LLM_AUTH value', () => {
    expect(() => selectBackend({ apiKey: 'sk-test', llmAuth: 'bogus' as 'api' })).toThrow(
      /LLM_AUTH/,
    );
  });

  describe('subscription mode + ANTHROPIC_API_KEY footgun', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('warns when LLM_AUTH=subscription and apiKey is set', () => {
      const backend = selectBackend({ apiKey: 'sk-test', llmAuth: 'subscription' });
      expect(backend.kind).toBe('sdk');
      const messages = warnSpy.mock.calls.map((call) => String(call[0]));
      expect(messages.some((m) => m.includes('LLM_AUTH=subscription'))).toBe(true);
      expect(messages.some((m) => m.includes('ANTHROPIC_API_KEY'))).toBe(true);
    });

    it('does NOT warn when LLM_AUTH=subscription and apiKey is undefined', () => {
      selectBackend({ apiKey: undefined, llmAuth: 'subscription' });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does NOT warn when LLM_AUTH=subscription and apiKey is empty string', () => {
      selectBackend({ apiKey: '', llmAuth: 'subscription' });
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
