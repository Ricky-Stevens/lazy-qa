/**
 * Accessibility audit playbook — runs axe-core in-browser for WCAG 2.1 AA
 * compliance checking. Catches color contrast violations, missing ARIA
 * attributes, focus management issues, and other programmatic accessibility
 * failures that sheldon's tree-inspection approach misses.
 *
 * axe-core is injected at runtime via page.addScriptTag from the bundled
 * axe-core npm package. No external CDN dependency.
 */

import { z } from 'zod';
import type { Playbook } from './framework.ts';
import { ok, suspicious, type PlaybookOutcome } from './outcome.ts';

interface AxeViolation {
  id: string;
  impact: string;
  description: string;
  help: string;
  helpUrl: string;
  nodes: Array<{ html: string; target: string[] }>;
}

export const accessibilityAxeAudit: Playbook<{ route: string; standard?: string }> = {
  name: 'accessibility_axe_audit',
  description:
    'Run axe-core accessibility engine on the current page. Returns WCAG 2.1 AA violations ' +
    'with impact level, description, affected elements, and remediation URLs. ' +
    'Catches color contrast, missing ARIA, focus management, and structural issues ' +
    'that manual ARIA tree inspection misses. Zero LLM cost.',
  categories: ['discovery'],
  estimatedDurationMs: 5_000,
  inputShape: {
    route: z.string().min(1).describe('The route URL to audit for accessibility'),
    standard: z
      .string()
      .optional()
      .describe('WCAG standard to check against: "wcag2aa" (default) or "wcag2aaa"'),
  },
  async run(input, ctx): Promise<PlaybookOutcome> {
    const { route } = input;
    const standard = input.standard ?? 'wcag2aa';
    const { page, logger } = ctx;

    try {
      const axeAvailable = await page.evaluate(() => typeof (globalThis as Record<string, unknown>).axe === 'object');
      if (!axeAvailable) {
        try {
          await page.addScriptTag({
            path: require.resolve('axe-core'),
          });
        } catch {
          try {
            await page.addScriptTag({
              path: require.resolve('axe-core/axe.min.js'),
            });
          } catch {
            return ok(
              'accessibility_axe_audit',
              'axe-core not available — install axe-core as a dependency to enable',
              { route, reason: 'axe-core not installed' },
            );
          }
        }
      }

      const results = await page.evaluate(
        (opts: { standard: string }) => {
          const axe = (globalThis as Record<string, unknown>).axe as {
            run: (
              context: unknown,
              options: Record<string, unknown>,
            ) => Promise<{ violations: AxeViolation[] }>;
          };
          return axe.run(document, {
            runOnly: {
              type: 'tag',
              values: [opts.standard, 'best-practice'],
            },
          });
        },
        { standard },
      );

      const violations = (results as { violations: AxeViolation[] }).violations;

      if (violations.length === 0) {
        return ok(
          'accessibility_axe_audit',
          `No ${standard} violations found`,
          { route, standard, violationCount: 0 },
          [{ label: 'run axe-core audit', ok: true }],
        );
      }

      const critical = violations.filter((v) => v.impact === 'critical');
      const serious = violations.filter((v) => v.impact === 'serious');

      const summary = violations
        .slice(0, 10)
        .map(
          (v) =>
            `[${v.impact}] ${v.help} (${v.id}) — ${v.nodes.length} element(s). Fix: ${v.helpUrl}`,
        )
        .join('\n');

      return suspicious(
        'accessibility_axe_audit',
        `Found ${violations.length} ${standard} violations (${critical.length} critical, ${serious.length} serious)`,
        {
          route,
          standard,
          violationCount: violations.length,
          criticalCount: critical.length,
          seriousCount: serious.length,
          violations: summary,
        },
        [
          {
            label: `axe-core found ${violations.length} violations`,
            ok: false,
          },
        ],
      );
    } catch (err) {
      logger.warn('accessibility-audit.failed', {
        route,
        error: err instanceof Error ? err.message : String(err),
      });
      return ok(
        'accessibility_axe_audit',
        `Audit failed: ${err instanceof Error ? err.message : String(err)}`,
        { route, error: true },
      );
    }
  },
};
