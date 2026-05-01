/**
 * Smoke tests for generateSitePlaybook.
 *
 * Uses a stub LlmBackend so no real API key or network is required.
 * Pattern mirrors src/findings/verify.test.ts (makeStubBackend / makeBackendResult).
 */
import { describe, expect, it, vi } from 'vitest';
import type { SiteMap } from '../crawler/types.ts';
import type { LlmBackend, LlmCallResult } from '../llm/backend.ts';
import { generateSitePlaybook } from './site-playbook.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBackendResult(jsonText: string): LlmCallResult {
  return {
    content: [{ type: 'text', text: jsonText, citations: [] }],
    stopReason: 'end_turn',
    usage: {
      inputTokens: 200,
      outputTokens: 80,
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

function makeMinimalSitemap(): SiteMap {
  return {
    rootUrl: 'http://localhost:3000',
    startedAt: new Date().toISOString(),
    routes: {
      '/': {
        url: 'http://localhost:3000/',
        route: '/',
        title: 'Home',
        status: 200,
        formIds: [],
        tableIds: [],
        modalIds: [],
        wizardIds: [],
        source: 'crawler' as const,
        discoveredAt: new Date().toISOString(),
        visited: false,
      },
    },
    pageModels: {
      '/': {
        url: 'http://localhost:3000/',
        route: '/',
        title: 'Home',
        primaryHeading: 'Welcome',
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
        textHash: 'abc',
        looksBroken: false,
        interactiveCount: 2,
        capturedAt: new Date().toISOString(),
      },
    },
  };
}

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as never;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('generateSitePlaybook', () => {
  it('returns a successful result when the backend returns valid JSON', async () => {
    const personas = [
      { name: 'power-user', description: 'Explores advanced features' },
      { name: 'completionist', description: 'Tries every link and form' },
    ];

    const payload = {
      siteShape: 'ecommerce',
      siteSummary: 'A shop selling juice. Users browse products and add them to a basket.',
      perPersona: {
        'power-user': 'Go to /#/search, search for "apple", click first result, add to basket.',
        completionist: 'Visit every route. Submit every form. Check /#/order-history.',
      },
    };

    const backend = makeStubBackend(makeBackendResult(JSON.stringify(payload)));

    const result = await generateSitePlaybook({
      rootUrl: 'http://localhost:3000',
      sitemap: makeMinimalSitemap(),
      personas,
      backend,
      model: 'claude-sonnet-4-6',
      logger: makeLogger(),
    });

    expect(result.ok).toBe(true);
    expect(result.siteShape).toBe('ecommerce');
    expect(result.siteSummary).toContain('juice');
    expect(result.perPersona['power-user']).toContain('basket');
    expect(result.perPersona.completionist).toContain('form');
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it('returns ok=false and a detail when the backend throws', async () => {
    const backend = makeStubBackend(new Error('rate limited'));

    const result = await generateSitePlaybook({
      rootUrl: 'http://localhost:3000',
      sitemap: makeMinimalSitemap(),
      personas: [{ name: 'power-user', description: 'Explores features' }],
      backend,
      model: 'claude-sonnet-4-6',
      logger: makeLogger(),
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('rate limited');
    expect(result.costUsd).toBe(0);
  });

  it('returns ok=false when there are no personas', async () => {
    const backend = makeStubBackend(makeBackendResult('{}'));

    const result = await generateSitePlaybook({
      rootUrl: 'http://localhost:3000',
      sitemap: makeMinimalSitemap(),
      personas: [],
      backend,
      model: 'claude-sonnet-4-6',
      logger: makeLogger(),
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('no personas');
    // Backend should never have been called for an empty persona list.
    expect((backend.call as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});
