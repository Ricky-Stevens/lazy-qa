/**
 * Tests for performance.ts — perfWebVitals playbook metadata,
 * threshold evaluation logic, and outcome construction with mocked pages.
 */

import { describe, expect, it, vi } from 'vitest';
import type { PlaybookContext } from './framework.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockPage(opts: {
  gotoThrows?: Error | null;
  metrics?: {
    ttfb: number | null;
    fcp: number | null;
    lcp: number | null;
    cls: number | null;
  };
}) {
  const { gotoThrows = null, metrics = { ttfb: 100, fcp: 500, lcp: 1000, cls: 0.01 } } = opts;
  return {
    goto: vi.fn().mockImplementation(() => {
      if (gotoThrows) throw gotoThrows;
      return Promise.resolve();
    }),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(metrics),
  };
}

function makeMockContext(page: ReturnType<typeof makeMockPage>): PlaybookContext {
  return {
    page: page as unknown as PlaybookContext['page'],
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

describe('perfWebVitals', () => {
  describe('metadata', () => {
    it('has correct name', async () => {
      const { perfWebVitals } = await import('./performance.ts');
      expect(perfWebVitals.name).toBe('perf_web_vitals');
    });

    it('is categorized as performance', async () => {
      const { perfWebVitals } = await import('./performance.ts');
      expect(perfWebVitals.categories).toContain('performance');
    });

    it('has estimatedDurationMs set', async () => {
      const { perfWebVitals } = await import('./performance.ts');
      expect(perfWebVitals.estimatedDurationMs).toBeGreaterThan(0);
    });

    it('requires route in inputShape', async () => {
      const { perfWebVitals } = await import('./performance.ts');
      expect(perfWebVitals.inputShape).toHaveProperty('route');
    });
  });

  describe('run — navigation failure', () => {
    it('returns failed outcome when goto throws', async () => {
      const { perfWebVitals } = await import('./performance.ts');
      const page = makeMockPage({ gotoThrows: new Error('net::ERR_CONNECTION_REFUSED') });
      const ctx = makeMockContext(page);

      const result = await perfWebVitals.run({ route: 'http://localhost:9999' }, ctx);

      expect(result.status).toBe('failed');
      expect(result.summary).toContain('Failed to navigate');
      expect(result.summary).toContain('net::ERR_CONNECTION_REFUSED');
      expect(result.steps.some((s) => !s.ok && s.label.includes('navigation failed'))).toBe(true);
    });
  });

  describe('run — all metrics within thresholds', () => {
    it('returns ok outcome when all metrics pass', async () => {
      const { perfWebVitals } = await import('./performance.ts');
      const page = makeMockPage({
        metrics: { ttfb: 100, fcp: 500, lcp: 1000, cls: 0.05 },
      });
      const ctx = makeMockContext(page);

      const result = await perfWebVitals.run({ route: 'http://localhost:3000' }, ctx);

      expect(result.status).toBe('ok');
      expect(result.summary).toContain('acceptable thresholds');
    });

    it('includes metrics in evidence', async () => {
      const { perfWebVitals } = await import('./performance.ts');
      const metrics = { ttfb: 200, fcp: 800, lcp: 1500, cls: 0.02 };
      const page = makeMockPage({ metrics });
      const ctx = makeMockContext(page);

      const result = await perfWebVitals.run({ route: 'http://localhost:3000' }, ctx);

      expect(result.evidence).toHaveProperty('metrics', metrics);
      expect(result.evidence).toHaveProperty('thresholds');
    });
  });

  describe('run — metrics exceeding thresholds', () => {
    it('returns suspicious when TTFB exceeds 800ms', async () => {
      const { perfWebVitals } = await import('./performance.ts');
      const page = makeMockPage({
        metrics: { ttfb: 1500, fcp: 500, lcp: 1000, cls: 0.01 },
      });
      const ctx = makeMockContext(page);

      const result = await perfWebVitals.run({ route: 'http://localhost:3000' }, ctx);

      expect(result.status).toBe('suspicious');
      expect(result.summary).toContain('TTFB=1500ms');
    });

    it('returns suspicious when FCP exceeds 1800ms', async () => {
      const { perfWebVitals } = await import('./performance.ts');
      const page = makeMockPage({
        metrics: { ttfb: 100, fcp: 2500, lcp: 1000, cls: 0.01 },
      });
      const ctx = makeMockContext(page);

      const result = await perfWebVitals.run({ route: 'http://localhost:3000' }, ctx);

      expect(result.status).toBe('suspicious');
      expect(result.summary).toContain('FCP=2500ms');
    });

    it('returns suspicious when LCP exceeds 2500ms', async () => {
      const { perfWebVitals } = await import('./performance.ts');
      const page = makeMockPage({
        metrics: { ttfb: 100, fcp: 500, lcp: 5000, cls: 0.01 },
      });
      const ctx = makeMockContext(page);

      const result = await perfWebVitals.run({ route: 'http://localhost:3000' }, ctx);

      expect(result.status).toBe('suspicious');
      expect(result.summary).toContain('LCP=5000ms');
    });

    it('returns suspicious when CLS exceeds 0.1', async () => {
      const { perfWebVitals } = await import('./performance.ts');
      const page = makeMockPage({
        metrics: { ttfb: 100, fcp: 500, lcp: 1000, cls: 0.5 },
      });
      const ctx = makeMockContext(page);

      const result = await perfWebVitals.run({ route: 'http://localhost:3000' }, ctx);

      expect(result.status).toBe('suspicious');
      expect(result.summary).toContain('CLS=0.5000');
    });

    it('reports all exceeded metrics in summary', async () => {
      const { perfWebVitals } = await import('./performance.ts');
      const page = makeMockPage({
        metrics: { ttfb: 1000, fcp: 2000, lcp: 3000, cls: 0.2 },
      });
      const ctx = makeMockContext(page);

      const result = await perfWebVitals.run({ route: 'http://localhost:3000' }, ctx);

      expect(result.status).toBe('suspicious');
      expect(result.summary).toContain('4 metric(s)');
      expect(result.summary).toContain('TTFB=');
      expect(result.summary).toContain('FCP=');
      expect(result.summary).toContain('LCP=');
      expect(result.summary).toContain('CLS=');
    });
  });

  describe('run — null metrics', () => {
    it('treats null metrics as ok (not available)', async () => {
      const { perfWebVitals } = await import('./performance.ts');
      const page = makeMockPage({
        metrics: { ttfb: null, fcp: null, lcp: null, cls: null },
      });
      const ctx = makeMockContext(page);

      const result = await perfWebVitals.run({ route: 'http://localhost:3000' }, ctx);

      expect(result.status).toBe('ok');
      expect(result.steps.some((s) => s.label.includes('not available'))).toBe(true);
    });

    it('evaluates only available metrics', async () => {
      const { perfWebVitals } = await import('./performance.ts');
      const page = makeMockPage({
        metrics: { ttfb: null, fcp: null, lcp: 5000, cls: null },
      });
      const ctx = makeMockContext(page);

      const result = await perfWebVitals.run({ route: 'http://localhost:3000' }, ctx);

      expect(result.status).toBe('suspicious');
      expect(result.summary).toContain('1 metric(s)');
      expect(result.summary).toContain('LCP=5000ms');
    });
  });

  describe('run — threshold boundaries', () => {
    it('TTFB at exactly 800ms passes', async () => {
      const { perfWebVitals } = await import('./performance.ts');
      const page = makeMockPage({
        metrics: { ttfb: 800, fcp: 500, lcp: 1000, cls: 0.01 },
      });
      const ctx = makeMockContext(page);

      const result = await perfWebVitals.run({ route: 'http://localhost:3000' }, ctx);
      expect(result.status).toBe('ok');
    });

    it('CLS at exactly 0.1 passes', async () => {
      const { perfWebVitals } = await import('./performance.ts');
      const page = makeMockPage({
        metrics: { ttfb: 100, fcp: 500, lcp: 1000, cls: 0.1 },
      });
      const ctx = makeMockContext(page);

      const result = await perfWebVitals.run({ route: 'http://localhost:3000' }, ctx);
      expect(result.status).toBe('ok');
    });

    it('TTFB at 801ms fails', async () => {
      const { perfWebVitals } = await import('./performance.ts');
      const page = makeMockPage({
        metrics: { ttfb: 801, fcp: 500, lcp: 1000, cls: 0.01 },
      });
      const ctx = makeMockContext(page);

      const result = await perfWebVitals.run({ route: 'http://localhost:3000' }, ctx);
      expect(result.status).toBe('suspicious');
    });
  });

  describe('steps trace', () => {
    it('includes navigation step', async () => {
      const { perfWebVitals } = await import('./performance.ts');
      const page = makeMockPage({
        metrics: { ttfb: 100, fcp: 500, lcp: 1000, cls: 0.01 },
      });
      const ctx = makeMockContext(page);

      const result = await perfWebVitals.run({ route: 'http://localhost:3000' }, ctx);

      const navStep = result.steps.find((s) => s.label === 'navigated to route');
      expect(navStep).toBeDefined();
      expect(navStep!.ok).toBe(true);
    });

    it('includes per-metric steps', async () => {
      const { perfWebVitals } = await import('./performance.ts');
      const page = makeMockPage({
        metrics: { ttfb: 100, fcp: 500, lcp: 1000, cls: 0.01 },
      });
      const ctx = makeMockContext(page);

      const result = await perfWebVitals.run({ route: 'http://localhost:3000' }, ctx);

      expect(result.steps.some((s) => s.label.includes('TTFB'))).toBe(true);
      expect(result.steps.some((s) => s.label.includes('FCP'))).toBe(true);
      expect(result.steps.some((s) => s.label.includes('LCP'))).toBe(true);
      expect(result.steps.some((s) => s.label.includes('CLS'))).toBe(true);
    });
  });
});
