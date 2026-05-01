/**
 * Smoke tests for runSupervisorSdk.
 *
 * Strategy: mock `@anthropic-ai/claude-agent-sdk` so query() yields a
 * configurable sequence of assistant + result events. Mock the registry
 * functions (snapshotAll, etc.) so no real agent state is needed.
 *
 * The happy path: query() yields two assistant turns (with usage) then a
 * result. Asserts that turns accumulate, tokenUsage accumulates, and
 * endedReason is set sensibly.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SdkLlmBackend } from '../llm/sdk-backend.ts';
import type { SupervisorInput } from './supervisor.ts';
import { runSupervisorSdk } from './supervisor-sdk.ts';

// Registry mocks — no real agent state needed.
vi.mock('./registry.ts', () => ({
  snapshotAll: vi.fn().mockReturnValue([]),
  getGlobalPauseSnapshot: vi.fn().mockReturnValue({ until: 0, reason: '' }),
  count4xxIn: vi.fn().mockReturnValue(0),
  count5xxIn: vi.fn().mockReturnValue(0),
  pushNudge: vi.fn().mockReturnValue(true),
  setGlobalPause: vi.fn(),
}));

// session-pool mock so relogin_session doesn't reach real Playwright.
vi.mock('../auth/session-pool.ts', () => ({
  recoverAllSessions: vi
    .fn()
    .mockResolvedValue({ ok: true, recovered: 1, failed: 0, detail: 'ok' }),
}));

// --- Mock @anthropic-ai/claude-agent-sdk ---
// Default: two assistant turns then a result.
vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  async function* fakeQuery() {
    yield {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Checking agents…' }],
        stop_reason: 'tool_use',
        usage: {
          input_tokens: 200,
          output_tokens: 80,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5,
        },
      },
    };
    yield {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'All agents done.' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 150,
          output_tokens: 60,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 2,
        },
      },
    };
    yield {
      type: 'result',
      subtype: 'success',
      result: 'done',
    };
  }
  return {
    query: vi.fn().mockImplementation(() => fakeQuery()),
    createSdkMcpServer: vi
      .fn()
      .mockReturnValue({ name: 'mock-supervisor', version: '1.0.0', tools: [] }),
    tool: vi.fn().mockImplementation((name, _desc, _shape, handler) => ({ name, handler })),
  };
});

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

function makeInput(overrides: Partial<SupervisorInput> = {}): SupervisorInput {
  return {
    backend: new SdkLlmBackend(),
    model: 'claude-haiku-4-5-20251001',
    maxMinutes: 5,
    maxUsd: 10,
    maxTurns: 10,
    abortSignal: new AbortController().signal,
    logger: makeLogger() as unknown as SupervisorInput['logger'],
    authType: 'none',
    ...overrides,
  };
}

describe('runSupervisorSdk', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('happy path: accumulates turns from two assistant events', async () => {
    const result = await runSupervisorSdk(makeInput());

    // Two assistant turns were yielded by the mock query.
    expect(result.turns).toBe(2);
    expect(typeof result.costUsd).toBe('number');
    expect(result.costUsd).toBeGreaterThanOrEqual(0);
  });

  it('happy path: endedReason is a valid value', async () => {
    const result = await runSupervisorSdk(makeInput());

    expect(result.endedReason).toBeDefined();
    expect(['max-turns', 'all-finished', 'self-ended', 'signal', 'budget-hit', 'error']).toContain(
      result.endedReason,
    );
  });

  it('happy path: intervention counts start at zero when no tools are called', async () => {
    const result = await runSupervisorSdk(makeInput());

    // The mock query() just yields text-only assistant turns; no tool handlers
    // are invoked, so all counters stay at 0.
    expect(result.reloginCount).toBe(0);
    expect(result.nudgeCount).toBe(0);
    expect(result.pauseCount).toBe(0);
    expect(result.broadcastCount).toBe(0);
  });

  it('aborted signal sets endedReason to signal', async () => {
    const ac = new AbortController();
    ac.abort();

    // Override mock: query returns an async iterable that immediately rejects,
    // simulating an AbortError. The `as unknown as ReturnType<typeof query>`
    // cast sidesteps the SDK's opaque Query return type.
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    vi.mocked(query).mockImplementationOnce(
      () =>
        ({
          [Symbol.asyncIterator]() {
            return {
              next(): Promise<never> {
                const err = new Error('The operation was aborted');
                err.name = 'AbortError';
                return Promise.reject(err);
              },
            };
          },
          // biome-ignore lint/suspicious/noExplicitAny: fake iterable for test; typing not load-bearing
        }) as any,
    );

    const result = await runSupervisorSdk(makeInput({ abortSignal: ac.signal }));

    expect(result.endedReason).toBe('signal');
  });

  it('returns all required SupervisorResult fields', async () => {
    const result = await runSupervisorSdk(makeInput());

    expect(result).toMatchObject({
      turns: expect.any(Number),
      costUsd: expect.any(Number),
      endedReason: expect.any(String),
      reloginCount: expect.any(Number),
      nudgeCount: expect.any(Number),
      pauseCount: expect.any(Number),
      broadcastCount: expect.any(Number),
    });
  });
});
