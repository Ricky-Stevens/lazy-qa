/**
 * Tests for accessibility-audit.ts — outcome construction, axe-core injection
 * flow, violation counting, and error handling.
 *
 * The playbook requires a Playwright Page and axe-core runtime injection, so
 * we test the outcome construction patterns and metadata statically, and mock
 * the Page object for integration paths.
 */

import { describe, expect, it, vi } from 'vitest';
import type { PlaybookContext } from './framework.ts';
import type { PlaybookOutcome } from './outcome.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAxeViolation(overrides: Partial<{
  id: string;
  impact: string;
  description: string;
  help: string;
  helpUrl: string;
  nodes: Array<{ html: string; target: string[] }>;
}> = {}) {
  return {
    id: overrides.id ?? 'color-contrast',
    impact: overrides.impact ?? 'serious',
    description: overrides.description ?? 'Elements must have sufficient color contrast',
    help: overrides.help ?? 'Elements must meet minimum color contrast ratio thresholds',
    helpUrl: overrides.helpUrl ?? 'https://dequeuniversity.com/rules/axe/4.7/color-contrast',
    nodes: overrides.nodes ?? [{ html: '<span>text</span>', target: ['span'] }],
  };
}

function makeMockPage(opts: {
  axeAvailable?: boolean;
  violations?: ReturnType<typeof makeAxeViolation>[];
  addScriptTagFails?: boolean;
  evaluateThrows?: Error | null;
}) {
  const { axeAvailable = true, violations = [], addScriptTagFails = false, evaluateThrows = null } = opts;

  let evaluateCallCount = 0;

  return {
    evaluate: vi.fn().mockImplementation((fn: unknown, args?: unknown) => {
      evaluateCallCount++;
      if (evaluateThrows) throw evaluateThrows;
      // First call checks if axe is available
      if (evaluateCallCount === 1) return axeAvailable;
      // Second call runs axe
      return { violations };
    }),
    addScriptTag: vi.fn().mockImplementation(() => {
      if (addScriptTagFails) throw new Error('Cannot find axe-core');
      return Promise.resolve();
    }),
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

describe('accessibilityAxeAudit', () => {
  describe('metadata', () => {
    it('has correct name', async () => {
      const { accessibilityAxeAudit } = await import('./accessibility-audit.ts');
      expect(accessibilityAxeAudit.name).toBe('accessibility_axe_audit');
    });

    it('is categorized as discovery', async () => {
      const { accessibilityAxeAudit } = await import('./accessibility-audit.ts');
      expect(accessibilityAxeAudit.categories).toContain('discovery');
    });

    it('has estimatedDurationMs set', async () => {
      const { accessibilityAxeAudit } = await import('./accessibility-audit.ts');
      expect(accessibilityAxeAudit.estimatedDurationMs).toBeGreaterThan(0);
    });

    it('requires route in inputShape', async () => {
      const { accessibilityAxeAudit } = await import('./accessibility-audit.ts');
      expect(accessibilityAxeAudit.inputShape).toHaveProperty('route');
    });

    it('has optional standard in inputShape', async () => {
      const { accessibilityAxeAudit } = await import('./accessibility-audit.ts');
      expect(accessibilityAxeAudit.inputShape).toHaveProperty('standard');
    });
  });

  describe('run — no violations', () => {
    it('returns ok outcome when no violations found', async () => {
      const { accessibilityAxeAudit } = await import('./accessibility-audit.ts');
      const page = makeMockPage({ axeAvailable: true, violations: [] });
      const ctx = makeMockContext(page);

      const result = await accessibilityAxeAudit.run(
        { route: '/home' },
        ctx,
      );

      expect(result.status).toBe('ok');
      expect(result.playbookName).toBe('accessibility_axe_audit');
      expect(result.summary).toContain('No');
      expect(result.summary).toContain('violations');
      expect(result.evidence).toHaveProperty('violationCount', 0);
    });

    it('uses wcag2aa as default standard', async () => {
      const { accessibilityAxeAudit } = await import('./accessibility-audit.ts');
      const page = makeMockPage({ axeAvailable: true, violations: [] });
      const ctx = makeMockContext(page);

      const result = await accessibilityAxeAudit.run(
        { route: '/home' },
        ctx,
      );

      expect(result.evidence).toHaveProperty('standard', 'wcag2aa');
    });

    it('uses custom standard when provided', async () => {
      const { accessibilityAxeAudit } = await import('./accessibility-audit.ts');
      const page = makeMockPage({ axeAvailable: true, violations: [] });
      const ctx = makeMockContext(page);

      const result = await accessibilityAxeAudit.run(
        { route: '/home', standard: 'wcag2aaa' },
        ctx,
      );

      expect(result.evidence).toHaveProperty('standard', 'wcag2aaa');
    });
  });

  describe('run — with violations', () => {
    it('returns suspicious outcome when violations found', async () => {
      const { accessibilityAxeAudit } = await import('./accessibility-audit.ts');
      const violations = [
        makeAxeViolation({ id: 'color-contrast', impact: 'serious' }),
        makeAxeViolation({ id: 'aria-label', impact: 'critical' }),
      ];
      const page = makeMockPage({ axeAvailable: true, violations });
      const ctx = makeMockContext(page);

      const result = await accessibilityAxeAudit.run(
        { route: '/home' },
        ctx,
      );

      expect(result.status).toBe('suspicious');
      expect(result.evidence).toHaveProperty('violationCount', 2);
      expect(result.evidence).toHaveProperty('criticalCount', 1);
      expect(result.evidence).toHaveProperty('seriousCount', 1);
    });

    it('includes violation summary in evidence', async () => {
      const { accessibilityAxeAudit } = await import('./accessibility-audit.ts');
      const violations = [
        makeAxeViolation({
          id: 'image-alt',
          impact: 'critical',
          help: 'Images must have alternate text',
          helpUrl: 'https://example.com/image-alt',
          nodes: [
            { html: '<img src="photo.jpg">', target: ['img'] },
            { html: '<img src="logo.png">', target: ['img.logo'] },
          ],
        }),
      ];
      const page = makeMockPage({ axeAvailable: true, violations });
      const ctx = makeMockContext(page);

      const result = await accessibilityAxeAudit.run(
        { route: '/home' },
        ctx,
      );

      expect(result.evidence.violations).toContain('image-alt');
      expect(result.evidence.violations).toContain('2 element(s)');
      expect(result.evidence.violations).toContain('https://example.com/image-alt');
    });

    it('counts impact levels correctly', async () => {
      const { accessibilityAxeAudit } = await import('./accessibility-audit.ts');
      const violations = [
        makeAxeViolation({ impact: 'critical' }),
        makeAxeViolation({ impact: 'critical' }),
        makeAxeViolation({ impact: 'serious' }),
        makeAxeViolation({ impact: 'moderate' }),
        makeAxeViolation({ impact: 'minor' }),
      ];
      const page = makeMockPage({ axeAvailable: true, violations });
      const ctx = makeMockContext(page);

      const result = await accessibilityAxeAudit.run(
        { route: '/page' },
        ctx,
      );

      expect(result.evidence.criticalCount).toBe(2);
      expect(result.evidence.seriousCount).toBe(1);
      expect(result.evidence.violationCount).toBe(5);
    });

    it('truncates violation summary to 10 items', async () => {
      const { accessibilityAxeAudit } = await import('./accessibility-audit.ts');
      const violations = Array.from({ length: 15 }, (_, i) =>
        makeAxeViolation({ id: `rule-${i}`, impact: 'minor' }),
      );
      const page = makeMockPage({ axeAvailable: true, violations });
      const ctx = makeMockContext(page);

      const result = await accessibilityAxeAudit.run(
        { route: '/page' },
        ctx,
      );

      // Should contain rule-0 through rule-9 but not rule-10+
      const summaryLines = (result.evidence.violations as string).split('\n');
      expect(summaryLines).toHaveLength(10);
      expect(result.evidence.violationCount).toBe(15);
    });

    it('includes step trace', async () => {
      const { accessibilityAxeAudit } = await import('./accessibility-audit.ts');
      const violations = [makeAxeViolation()];
      const page = makeMockPage({ axeAvailable: true, violations });
      const ctx = makeMockContext(page);

      const result = await accessibilityAxeAudit.run(
        { route: '/page' },
        ctx,
      );

      expect(result.steps).toHaveLength(1);
      expect(result.steps[0]!.ok).toBe(false);
      expect(result.steps[0]!.label).toContain('1 violation');
    });
  });

  describe('run — axe injection', () => {
    it('returns ok with message when axe-core package is not installed', async () => {
      // In this test environment axe-core is not installed, so
      // require.resolve('axe-core') throws before addScriptTag is reached.
      // The playbook catches both attempts and returns a graceful ok.
      const { accessibilityAxeAudit } = await import('./accessibility-audit.ts');
      const page = makeMockPage({ axeAvailable: false, violations: [] });
      const ctx = makeMockContext(page);

      const result = await accessibilityAxeAudit.run({ route: '/home' }, ctx);

      expect(result.status).toBe('ok');
      expect(result.summary).toContain('axe-core not available');
      expect(result.evidence).toHaveProperty('reason', 'axe-core not installed');
    });

    it('returns ok with install message when addScriptTag also fails', async () => {
      const { accessibilityAxeAudit } = await import('./accessibility-audit.ts');
      const page = makeMockPage({ axeAvailable: false, addScriptTagFails: true });
      const ctx = makeMockContext(page);

      const result = await accessibilityAxeAudit.run(
        { route: '/home' },
        ctx,
      );

      expect(result.status).toBe('ok');
      expect(result.summary).toContain('axe-core not available');
      expect(result.evidence).toHaveProperty('reason', 'axe-core not installed');
    });
  });

  describe('run — error handling', () => {
    it('returns ok outcome with error message on evaluation failure', async () => {
      const { accessibilityAxeAudit } = await import('./accessibility-audit.ts');
      const page = makeMockPage({
        axeAvailable: true,
        evaluateThrows: new Error('Page crashed'),
      });
      const ctx = makeMockContext(page);

      const result = await accessibilityAxeAudit.run(
        { route: '/broken' },
        ctx,
      );

      expect(result.status).toBe('ok');
      expect(result.summary).toContain('Audit failed');
      expect(result.summary).toContain('Page crashed');
      expect(result.evidence).toHaveProperty('error', true);
    });

    it('logs warning on audit failure', async () => {
      const { accessibilityAxeAudit } = await import('./accessibility-audit.ts');
      const page = makeMockPage({
        axeAvailable: true,
        evaluateThrows: new Error('Timeout'),
      });
      const ctx = makeMockContext(page);

      await accessibilityAxeAudit.run({ route: '/broken' }, ctx);

      expect(ctx.logger.warn).toHaveBeenCalledWith('accessibility-audit.failed', {
        route: '/broken',
        error: 'Timeout',
      });
    });
  });

  describe('outcome construction', () => {
    it('ok outcome has correct structure', async () => {
      const { accessibilityAxeAudit } = await import('./accessibility-audit.ts');
      const page = makeMockPage({ axeAvailable: true, violations: [] });
      const ctx = makeMockContext(page);

      const result = await accessibilityAxeAudit.run(
        { route: '/home' },
        ctx,
      );

      // Verify PlaybookOutcome shape
      expect(result).toHaveProperty('playbookName');
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('evidence');
      expect(result).toHaveProperty('signals');
      expect(result).toHaveProperty('steps');
      expect(result).toHaveProperty('durationMs');
    });

    it('suspicious outcome includes route in evidence', async () => {
      const { accessibilityAxeAudit } = await import('./accessibility-audit.ts');
      const violations = [makeAxeViolation()];
      const page = makeMockPage({ axeAvailable: true, violations });
      const ctx = makeMockContext(page);

      const result = await accessibilityAxeAudit.run(
        { route: '/dashboard' },
        ctx,
      );

      expect(result.evidence).toHaveProperty('route', '/dashboard');
    });

    it('summary includes violation counts for suspicious outcome', async () => {
      const { accessibilityAxeAudit } = await import('./accessibility-audit.ts');
      const violations = [
        makeAxeViolation({ impact: 'critical' }),
        makeAxeViolation({ impact: 'serious' }),
        makeAxeViolation({ impact: 'minor' }),
      ];
      const page = makeMockPage({ axeAvailable: true, violations });
      const ctx = makeMockContext(page);

      const result = await accessibilityAxeAudit.run(
        { route: '/page' },
        ctx,
      );

      expect(result.summary).toContain('3');
      expect(result.summary).toContain('1 critical');
      expect(result.summary).toContain('1 serious');
    });
  });
});
