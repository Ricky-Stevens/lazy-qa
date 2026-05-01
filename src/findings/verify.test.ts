/**
 * Tests for WP4.F — critic-with-browser verification.
 *
 * Mocks both the LlmBackend and the parsePage page-model extraction so
 * tests don't need a real browser or API key. Each test asserts that a given
 * mocked LLM verdict is parsed correctly and surfaced via VerifyResult.
 */
import { describe, expect, it, vi } from 'vitest';
import type { LlmBackend, LlmCallResult } from '../llm/backend.ts';
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
    bareFields: [],
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

function makeStubPage(opts: { gotoStatus?: number; gotoThrows?: boolean; body?: string } = {}) {
  return {
    goto: vi.fn(async () => {
      if (opts.gotoThrows) throw new Error('navigation failed');
      return {
        status: () => opts.gotoStatus ?? 200,
        text: async () => opts.body ?? '',
      };
    }),
    content: vi.fn(async () => `<html><body>${opts.body ?? ''}</body></html>`),
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

function makeBackendResult(verdict: string, detail = 'because the page looks fine'): LlmCallResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ verdict, detail }),
        citations: [],
      },
    ],
    stopReason: 'end_turn',
    usage: {
      inputTokens: 100,
      outputTokens: 30,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  };
}

function makeStubBackend(result: LlmCallResult | Error): LlmBackend {
  return {
    kind: 'api',
    call: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  };
}

describe('verifyFinding', () => {
  it('parses a confirmed_reproducible verdict', async () => {
    const backend = makeStubBackend(
      makeBackendResult('confirmed_reproducible', 'evidence on page matches the claim'),
    );
    const result = await verifyFinding({
      finding: makeFinding(),
      page: makeStubPage(),
      rootUrl: 'https://app.test',
      allowedHosts: ['app.test'],
      backend,
      model: 'claude-sonnet-4-6',
      logger: makeStubLogger(),
    });
    expect(result.verdict).toBe('confirmed_reproducible');
    expect(result.detail).toContain('evidence');
    expect(result.findingId).toBe('f-1');
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it('parses a not_reproducible verdict', async () => {
    const backend = makeStubBackend(
      makeBackendResult('not_reproducible', 'live page does not show the claim'),
    );
    const result = await verifyFinding({
      finding: makeFinding(),
      page: makeStubPage(),
      rootUrl: 'https://app.test',
      allowedHosts: ['app.test'],
      backend,
      model: 'claude-sonnet-4-6',
      logger: makeStubLogger(),
    });
    expect(result.verdict).toBe('not_reproducible');
  });

  it('falls back to intermittent when the LLM call throws', async () => {
    const backend = makeStubBackend(new Error('rate limited'));
    const result = await verifyFinding({
      finding: makeFinding(),
      page: makeStubPage(),
      rootUrl: 'https://app.test',
      allowedHosts: ['app.test'],
      backend,
      model: 'claude-sonnet-4-6',
      logger: makeStubLogger(),
    });
    expect(result.verdict).toBe('intermittent');
    expect(result.detail).toContain('rate limited');
    expect(result.costUsd).toBe(0);
  });

  it('falls back to intermittent on malformed JSON', async () => {
    const backend = makeStubBackend({
      content: [{ type: 'text', text: 'not json at all, sorry', citations: [] }],
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    const result = await verifyFinding({
      finding: makeFinding(),
      page: makeStubPage(),
      rootUrl: 'https://app.test',
      allowedHosts: ['app.test'],
      backend,
      model: 'claude-sonnet-4-6',
      logger: makeStubLogger(),
    });
    expect(result.verdict).toBe('intermittent');
  });

  it('still calls the LLM even when navigation fails (with nav error in summary)', async () => {
    const backend = makeStubBackend(makeBackendResult('not_reproducible', 'nav failed'));
    await verifyFinding({
      finding: makeFinding(),
      page: makeStubPage({ gotoThrows: true }),
      rootUrl: 'https://app.test',
      allowedHosts: ['app.test'],
      backend,
      model: 'claude-sonnet-4-6',
      logger: makeStubLogger(),
    });
    expect((backend.call as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    const callInput = (backend.call as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const userMessage = callInput?.messages?.[0]?.content as string;
    expect(userMessage).toContain('navigation failed');
  });

  it('passes HTTP status and body sample to the LLM so text-leakage claims can be verified', async () => {
    // Simulate a JSON-endpoint response — Juice Shop's /swagger.json scenario
    // where parsePage returns "looksBroken=true, no interactives" but the
    // body itself proves the bug (full Swagger spec exposed).
    const swaggerBody =
      '{"openapi":"3.0.0","info":{"title":"Juice Shop API"},"paths":{"/api/Users":{"get":{"summary":"list users"}}}}';
    const backend = makeStubBackend(
      makeBackendResult('confirmed_reproducible', 'body shows full API spec'),
    );
    await verifyFinding({
      finding: makeFinding({
        title: '/swagger.json full API docs exposed',
        route: '/swagger.json',
      }),
      page: makeStubPage({ gotoStatus: 200, body: swaggerBody }),
      rootUrl: 'https://app.test',
      allowedHosts: ['app.test'],
      backend,
      model: 'claude-sonnet-4-6',
      logger: makeStubLogger(),
    });
    expect((backend.call as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    const callInput = (backend.call as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const userMessage = callInput?.messages?.[0]?.content as string;
    expect(userMessage).toContain('HTTP status: 200');
    expect(userMessage).toContain('RESPONSE BODY SAMPLE');
    expect(userMessage).toContain('Juice Shop API');
    // Non-HTML body bypasses parsePage so the misleading "looksBroken=true"
    // structural summary doesn't appear.
    expect(userMessage).toContain('non-HTML response');
  });

  it('emits critic.verify.start and critic.verify.end events when an EventWriter is supplied', async () => {
    const backend = makeStubBackend(makeBackendResult('confirmed_reproducible'));
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
      backend,
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
