import { describe, expect, it } from 'vitest';
import { deepRedact, redactForLlm } from './logger.ts';

describe('redactForLlm', () => {
  it('redacts secret-keyed fields in objects', () => {
    const out = redactForLlm({ apiKey: 'sk-secret-123', name: 'public-value' });
    expect(out).not.toContain('sk-secret-123');
    expect(out).toContain('public-value');
  });

  it('passes plain strings through unchanged when under cap', () => {
    expect(redactForLlm('hello world')).toBe('hello world');
  });

  it('truncates strings over cap and marks the truncation', () => {
    const big = 'a'.repeat(10_000);
    const out = redactForLlm(big, 100);
    expect(out.length).toBeLessThan(big.length);
    expect(out).toContain('[truncated at 100 bytes]');
  });

  it('handles nested objects with secrets at depth', () => {
    const out = redactForLlm({
      meta: { apiKey: 'sk-deep-secret' },
      public: 'visible',
    });
    expect(out).not.toContain('sk-deep-secret');
    expect(out).toContain('visible');
  });

  it('handles arrays', () => {
    const out = redactForLlm([{ password: 'hunter2' }, { name: 'ok' }]);
    expect(out).not.toContain('hunter2');
    expect(out).toContain('ok');
  });
});

describe('deepRedact (now exported)', () => {
  it('returns a redacted copy without mutating input', () => {
    const input = { apiKey: 'sk-secret', other: 'visible' };
    const out = deepRedact(input) as Record<string, unknown>;
    expect(input.apiKey).toBe('sk-secret'); // input unchanged
    expect(out.apiKey).not.toBe('sk-secret');
    expect(out.other).toBe('visible');
  });
});
