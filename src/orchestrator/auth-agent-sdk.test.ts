/**
 * Smoke test for runAuthAgentSdk.
 *
 * Strategy: mock `@anthropic-ai/claude-agent-sdk` so query() yields one
 * assistant turn then a result event. Also mock launchBrowser /
 * dismissPersistentBanners so no real Playwright browser is launched.
 *
 * Because the mock query() doesn't actually call the auth_success tool,
 * terminalSignal stays null after the loop → the function falls through to
 * the "no terminal signal" fallback and returns { ok: false }. This verifies
 * the wiring end-to-end without requiring a real browser.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Module-scoped registry so the mock `query()` can invoke handlers that the
// production code registered via `tool()`. This lets us simulate the SDK's
// internal tool dispatch — without it the success path (auth_success tool fires
// → terminalSignal flips → context.storageState is captured) is unreachable
// from a static yield-stream.
type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;
const registeredHandlers = new Map<string, ToolHandler>();
let nextHandlersToInvoke: Array<{ name: string; args: Record<string, unknown> }> = [];

// --- Mock @anthropic-ai/claude-agent-sdk ---
vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  async function* fakeQuery() {
    yield {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Attempting login…' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 120,
          output_tokens: 40,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    };
    // Between the assistant message and the result, invoke any handlers the
    // test queued (e.g. auth_success). This simulates the SDK's tool-loop.
    for (const { name, args } of nextHandlersToInvoke) {
      const handler = registeredHandlers.get(name);
      if (handler) await handler(args);
    }
    yield {
      type: 'result',
      subtype: 'success',
      result: 'done',
    };
  }
  return {
    query: vi.fn().mockImplementation(() => fakeQuery()),
    createSdkMcpServer: vi.fn().mockReturnValue({ name: 'mock-auth', version: '1.0.0', tools: [] }),
    tool: vi
      .fn()
      .mockImplementation((name: string, _desc: string, _shape: unknown, handler: ToolHandler) => {
        registeredHandlers.set(name, handler);
        return { name, handler };
      }),
  };
});

// --- Mock auth/login.ts so no Playwright is launched ---
vi.mock('../auth/login.ts', () => ({
  launchBrowser: vi.fn(),
  dismissPersistentBanners: vi.fn().mockResolvedValue(undefined),
}));

// --- Mock page-model/parser.ts and serialize.ts for safeSnapshot ---
vi.mock('../page-model/parser.ts', () => ({
  parsePage: vi.fn().mockResolvedValue({ type: 'page', interactives: [] }),
}));
vi.mock('../page-model/serialize.ts', () => ({
  serializeForAgent: vi.fn().mockReturnValue('(page snapshot)'),
}));
vi.mock('../logging/logger.ts', () => ({
  redactForLlm: vi.fn().mockImplementation((s: string) => s),
}));

import { launchBrowser } from '../auth/login.ts';
import { SdkLlmBackend } from '../llm/sdk-backend.ts';
import type { AuthAgentInput } from './auth-agent.ts';
import { runAuthAgentSdk } from './auth-agent-sdk.ts';

function makeMockPage() {
  return {
    url: vi.fn().mockReturnValue('http://localhost:3000/login'),
    goto: vi.fn().mockResolvedValue(undefined),
    locator: vi.fn().mockReturnThis(),
    first: vi.fn().mockReturnThis(),
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    press: vi.fn().mockResolvedValue(undefined),
    keyboard: { press: vi.fn().mockResolvedValue(undefined) },
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockContext(page: ReturnType<typeof makeMockPage>) {
  return {
    newPage: vi.fn().mockResolvedValue(page),
    storageState: vi.fn().mockResolvedValue({ cookies: [], origins: [] }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockBrowser(context: ReturnType<typeof makeMockContext>) {
  return {
    newContext: vi.fn().mockResolvedValue(context),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

describe('runAuthAgentSdk', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredHandlers.clear();
    nextHandlersToInvoke = [];
  });

  it('returns ok: false when query completes without auth_success being called', async () => {
    const page = makeMockPage();
    const context = makeMockContext(page);
    const browser = makeMockBrowser(context);

    // Wire launchBrowser to return our mock browser
    vi.mocked(launchBrowser).mockResolvedValue(browser as never);

    const input: AuthAgentInput = {
      targetUrl: 'http://localhost:3000',
      loginUrl: 'http://localhost:3000/login',
      credentials: { username: 'admin', password: 'password123' },
      allowedHosts: ['localhost'],
      backend: new SdkLlmBackend(),
      model: 'claude-haiku-4-5-20251001',
      maxTurns: 3,
      storageStatePath: '/tmp/test-auth-state.json',
      logger: makeLogger() as unknown as AuthAgentInput['logger'],
      stealth: false,
    };

    const result = await runAuthAgentSdk(input);

    // The mock query() never calls auth_success, so terminalSignal stays null
    // → the function exits the loop and returns ok: false with a fallback detail.
    expect(result.ok).toBe(false);
    expect(result.detail).toBeTruthy();
    expect(typeof result.turns).toBe('number');
    expect(typeof result.costUsd).toBe('number');
  });

  it('captures storage state and returns ok: true when auth_success fires', async () => {
    const page = makeMockPage();
    const context = makeMockContext(page);
    const browser = makeMockBrowser(context);
    vi.mocked(launchBrowser).mockResolvedValue(browser as never);

    // Queue auth_success to be invoked by the mock SDK between assistant
    // turn and result event. This flips terminalSignal=success in the runtime
    // closure, so the success branch (storageState capture + sessionInfo) runs.
    nextHandlersToInvoke = [
      { name: 'auth_success', args: { detail: 'logged in via email field' } },
    ];

    const input: AuthAgentInput = {
      targetUrl: 'http://localhost:3000',
      loginUrl: 'http://localhost:3000/login',
      credentials: { username: 'admin', password: 'pw' },
      allowedHosts: ['localhost'],
      backend: new SdkLlmBackend(),
      model: 'claude-haiku-4-5-20251001',
      maxTurns: 3,
      storageStatePath: '/tmp/auth-success.json',
      logger: makeLogger() as unknown as AuthAgentInput['logger'],
      stealth: false,
    };

    const result = await runAuthAgentSdk(input);

    expect(result.ok).toBe(true);
    expect(result.storageStatePath).toBe('/tmp/auth-success.json');
    expect(result.detail).toContain('logged in via email field');
    // storageState() must have been called with the configured path.
    expect(context.storageState).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/tmp/auth-success.json', indexedDB: true }),
    );
    // sessionInfo derives from JWT/storage — fallback to credentials.username
    // when no JWT is present (mock context.storageState returns empty cookies).
    expect(result.sessionInfo?.username).toBe('admin');
  });

  it('closes the browser context and browser in finally even on failure', async () => {
    const page = makeMockPage();
    const context = makeMockContext(page);
    const browser = makeMockBrowser(context);

    vi.mocked(launchBrowser).mockResolvedValue(browser as never);

    const input: AuthAgentInput = {
      targetUrl: 'http://localhost:3000',
      credentials: { username: 'user', password: 'pw' },
      allowedHosts: [],
      backend: new SdkLlmBackend(),
      model: 'claude-haiku-4-5-20251001',
      storageStatePath: '/tmp/test-auth-state.json',
      logger: makeLogger() as unknown as AuthAgentInput['logger'],
      stealth: false,
    };

    await runAuthAgentSdk(input);

    expect(context.close).toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalled();
  });
});
