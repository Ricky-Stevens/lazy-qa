/**
 * Tests for framework.ts — runPlaybook timing, error handling, timeout,
 * and speculative probe mode wrapping.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaybookContext, Playbook } from './framework.ts';
import { runPlaybook } from './framework.ts';
import type { PlaybookOutcome } from './outcome.ts';
import { ok, suspicious } from './outcome.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlaybook(overrides: Partial<Playbook<{ route: string }>> = {}): Playbook<{ route: string }> {
  return {
    name: 'test_playbook',
    description: 'A test playbook',
    categories: ['discovery'],
    estimatedDurationMs: 5_000,
    inputShape: {},
    run: vi.fn().mockResolvedValue(ok('test_playbook', 'all good', { route: '/test' })),
    ...overrides,
  };
}

function makeContext(): PlaybookContext {
  return {
    page: {} as PlaybookContext['page'],
    pageModel: vi.fn(),
    siteMap: {} as PlaybookContext['siteMap'],
    agentId: 'test-agent',
    persona: 'test',
    runDir: '/tmp/test-run',
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as unknown as PlaybookContext['logger'],
    allowedHosts: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runPlaybook', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns ok outcome from a successful playbook', async () => {
    const pb = makePlaybook();
    const ctx = makeContext();

    const result = await runPlaybook(pb, { route: '/test' }, ctx);

    expect(result.status).toBe('ok');
    expect(result.playbookName).toBe('test_playbook');
  });

  it('sets durationMs on the outcome', async () => {
    const pb = makePlaybook({
      run: vi.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 10));
        return ok('test_playbook', 'done');
      }),
    });
    const ctx = makeContext();

    const result = await runPlaybook(pb, { route: '/test' }, ctx);

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('catches thrown errors and returns failed outcome', async () => {
    const pb = makePlaybook({
      run: vi.fn().mockRejectedValue(new Error('kaboom')),
    });
    const ctx = makeContext();

    const result = await runPlaybook(pb, { route: '/test' }, ctx);

    expect(result.status).toBe('failed');
    expect(result.summary).toContain('kaboom');
    expect(result.evidence).toHaveProperty('error', 'kaboom');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.label).toBe('playbook crashed');
    expect(result.steps[0]!.ok).toBe(false);
  });

  it('handles non-Error exceptions', async () => {
    const pb = makePlaybook({
      run: vi.fn().mockRejectedValue('string exception'),
    });
    const ctx = makeContext();

    const result = await runPlaybook(pb, { route: '/test' }, ctx);

    expect(result.status).toBe('failed');
    expect(result.summary).toContain('string exception');
  });

  it('never throws even when playbook throws', async () => {
    const pb = makePlaybook({
      run: vi.fn().mockRejectedValue(new TypeError('type error')),
    });
    const ctx = makeContext();

    // Should not throw
    const result = await runPlaybook(pb, { route: '/test' }, ctx);
    expect(result).toBeDefined();
    expect(result.status).toBe('failed');
  });

  it('returns failed outcome with correct playbookName', async () => {
    const pb = makePlaybook({
      name: 'custom_pb',
      run: vi.fn().mockRejectedValue(new Error('oops')),
    });
    const ctx = makeContext();

    const result = await runPlaybook(pb, { route: '/test' }, ctx);
    expect(result.playbookName).toBe('custom_pb');
  });

  it('returns signals with empty arrays on crash', async () => {
    const pb = makePlaybook({
      run: vi.fn().mockRejectedValue(new Error('crash')),
    });
    const ctx = makeContext();

    const result = await runPlaybook(pb, { route: '/test' }, ctx);
    expect(result.signals.networkAnomalies).toEqual([]);
    expect(result.signals.consoleErrors).toEqual([]);
  });

  it('preserves suspicious status from playbook', async () => {
    const pb = makePlaybook({
      run: vi.fn().mockResolvedValue(
        suspicious('test_playbook', 'something suspicious', { route: '/x' }),
      ),
    });
    const ctx = makeContext();

    const result = await runPlaybook(pb, { route: '/test' }, ctx);
    expect(result.status).toBe('suspicious');
  });
});
