/**
 * Tests for WP4.F — critic-with-browser verification.
 *
 * Mocks both the Anthropic SDK and the parsePage page-model extraction so
 * tests don't need a real browser or API key. Each test asserts that a given
 * mocked LLM verdict is parsed correctly and surfaced via VerifyResult.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Finding } from '../types/finding.ts';
import { verifyFinding } from './verify.ts';

vi.mock('../page-model/parser.ts', () => ({
  parsePage: vi.fn().mockResolvedValue({
    url: 'https://app.test/admin',
    route: 'https://app.test/admin',
    title: 'Admin',
    primaryHeading: 'Admin Dashboard',
    forms: [],
    tables: [],
    modals: [],
    wizards: [],
    toolbars: [],
    navLinks: [],
    bareInteractives: [],
    network: [],
    console: [],
    textHash: 'abc123',
    looksBroken: false,
    interactiveCount: 5,
    capturedAt: new Date().toISOString(),
  }),
}));

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'f-1',
    ts: new Date().toISOString(),
    severity: 'major',
    category: 'broken-feature',
    title: 'Save button does nothing',
    description: 'Clicking Save on the user form does not persist the record.',
    stepsToReproduce: ['Open /admin/users/new', 'Fill form', 'Click Save'],
    expected: 'Record is created',
    actual: 'Form silently resets',
    route: '/admin/users/new',
    confidence: 'likely',
    source: 'agent',
    ...overrides,
  };
}

function makeStubPage(opts: { gotoStatus?: number; gotoThrows?: boolean } = {}) {
  return {
    goto: vi.fn(async () => {
      if (opts.gotoThrows) throw new Error('navigation failed');
      return { status: () => opts.gotoStatus ?? 200 };
    }),
  } as never;
}

function makeStubLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as never;
}

function makeMessageResponse(verdict: string, detail = 'because the page looks fine'): object {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: JSON.stringify({ verdict, detail }),
      },
    ],
    model: 'claude-sonnet-4-6',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 30,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}

describe('verifyFinding', () => {
  it('parses a confirmed_reproducible verdict', async () => {
    const create = vi
      .fn()
      .mockResolvedValue(
        makeMessageResponse('confirmed_reproducible', 'evidence on page matches the claim'),
      );
    const result = await verifyFinding({
      finding: makeFinding(),
      page: makeStubPage(),
      rootUrl: 'https://app.test',
      allowedHosts: ['app.test'],
      client: { messages: { create } as never },
      model: 'claude-sonnet-4-6',
      logger: makeStubLogger(),
    });
    expect(result.verdict).toBe('confirmed_reproducible');
    expect(result.detail).toContain('evidence');
    expect(result.findingId).toBe('f-1');
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it('parses a not_reproducible verdict', async () => {
    const create = vi
      .fn()
      .mockResolvedValue(
        makeMessageResponse('not_reproducible', 'live page does not show the claim'),
      );
    const result = await verifyFinding({
      finding: makeFinding(),
      page: makeStubPage(),
      rootUrl: 'https://app.test',
      allowedHosts: ['app.test'],
      client: { messages: { create } as never },
      model: 'claude-sonnet-4-6',
      logger: makeStubLogger(),
    });
    expect(result.verdict).toBe('not_reproducible');
  });

  it('falls back to intermittent when the LLM call throws', async () => {
    const create = vi.fn().mockRejectedValue(new Error('rate limited'));
    const result = await verifyFinding({
      finding: makeFinding(),
      page: makeStubPage(),
      rootUrl: 'https://app.test',
      allowedHosts: ['app.test'],
      client: { messages: { create } as never },
      model: 'claude-sonnet-4-6',
      logger: makeStubLogger(),
    });
    expect(result.verdict).toBe('intermittent');
    expect(result.detail).toContain('rate limited');
    expect(result.costUsd).toBe(0);
  });

  it('falls back to intermittent on malformed JSON', async () => {
    const create = vi.fn().mockResolvedValue({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'not json at all, sorry' }],
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
    });
    const result = await verifyFinding({
      finding: makeFinding(),
      page: makeStubPage(),
      rootUrl: 'https://app.test',
      allowedHosts: ['app.test'],
      client: { messages: { create } as never },
      model: 'claude-sonnet-4-6',
      logger: makeStubLogger(),
    });
    expect(result.verdict).toBe('intermittent');
  });

  it('still calls the LLM even when navigation fails (with nav error in summary)', async () => {
    const create = vi.fn().mockResolvedValue(makeMessageResponse('not_reproducible', 'nav failed'));
    await verifyFinding({
      finding: makeFinding(),
      page: makeStubPage({ gotoThrows: true }),
      rootUrl: 'https://app.test',
      allowedHosts: ['app.test'],
      client: { messages: { create } as never },
      model: 'claude-sonnet-4-6',
      logger: makeStubLogger(),
    });
    expect(create).toHaveBeenCalledTimes(1);
    const userMessage = create.mock.calls[0]?.[0]?.messages?.[0]?.content as string;
    expect(userMessage).toContain('navigation failed');
  });

  it('emits critic.verify.start and critic.verify.end events when an EventWriter is supplied', async () => {
    const create = vi.fn().mockResolvedValue(makeMessageResponse('confirmed_reproducible'));
    const events = {
      write: vi.fn().mockResolvedValue(undefined),
      open: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    } as never;
    await verifyFinding({
      finding: makeFinding(),
      page: makeStubPage(),
      rootUrl: 'https://app.test',
      allowedHosts: ['app.test'],
      client: { messages: { create } as never },
      model: 'claude-sonnet-4-6',
      logger: makeStubLogger(),
      events,
    });
    const calls = (events as unknown as { write: { mock: { calls: unknown[][] } } }).write.mock
      .calls;
    expect(calls).toHaveLength(2);
    expect((calls[0]?.[0] as { type: string }).type).toBe('critic.verify.start');
    expect((calls[1]?.[0] as { type: string }).type).toBe('critic.verify.end');
  });
});
