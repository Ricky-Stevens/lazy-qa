/**
 * Performance playbook — `perf_web_vitals`. Measures Core Web Vitals (LCP,
 * CLS, FCP, TTFB) on a page using `page.evaluate()`. Zero LLM cost — pure
 * browser measurement via the Navigation Timing and Performance Observer APIs.
 */

import { z } from 'zod';
import type { Playbook } from './framework.ts';
import { ok, type PlaybookOutcome, type PlaybookStep, suspicious } from './outcome.ts';

// Thresholds from Google "poor" ratings
const THRESHOLDS = {
  lcp: 2500, // ms - Largest Contentful Paint
  cls: 0.1, // score - Cumulative Layout Shift
  fcp: 1800, // ms - First Contentful Paint
  ttfb: 800, // ms - Time to First Byte
};

export const perfWebVitalsShape = {
  route: z.string(),
} satisfies z.ZodRawShape;

export interface PerfWebVitalsInput {
  route: string;
}

interface WebVitalsMetrics {
  ttfb: number | null;
  fcp: number | null;
  lcp: number | null;
  cls: number | null;
}

export const perfWebVitals: Playbook<PerfWebVitalsInput> = {
  name: 'perf_web_vitals',
  description:
    'Measures Core Web Vitals (LCP, CLS, FCP, TTFB) on the given route. ' +
    'Flags pages with poor performance scores based on Google thresholds. ' +
    'Zero LLM cost — pure browser measurement. Input: `route` (URL to measure).',
  categories: ['performance'],
  estimatedDurationMs: 8_000,
  inputShape: perfWebVitalsShape,
  async run(input, ctx): Promise<PlaybookOutcome> {
    const steps: PlaybookStep[] = [];
    const evidence: Record<string, unknown> = { route: input.route };

    // Navigate to the route and wait for the load event
    try {
      await ctx.page.goto(input.route, { waitUntil: 'load', timeout: 15_000 });
      steps.push({ label: 'navigated to route', ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      steps.push({
        label: 'navigation failed',
        ok: false,
        detail: message,
      });
      return {
        playbookName: perfWebVitals.name,
        status: 'failed',
        summary: `Failed to navigate to ${input.route}: ${message}`,
        evidence,
        signals: { networkAnomalies: [], consoleErrors: [] },
        steps,
        durationMs: 0,
      };
    }

    // Give the page a moment for LCP and CLS entries to settle
    await ctx.page.waitForTimeout(1_500);

    // Collect metrics via page.evaluate()
    const metrics = await ctx.page.evaluate((): WebVitalsMetrics => {
      const result: WebVitalsMetrics = {
        ttfb: null,
        fcp: null,
        lcp: null,
        cls: null,
      };

      // TTFB from Navigation Timing API
      const navEntries = performance.getEntriesByType(
        'navigation',
      ) as PerformanceNavigationTiming[];
      if (navEntries.length > 0) {
        result.ttfb = navEntries[0].responseStart - navEntries[0].requestStart;
      }

      // FCP from paint timing entries
      const paintEntries = performance.getEntriesByType('paint');
      for (const entry of paintEntries) {
        if (entry.name === 'first-contentful-paint') {
          result.fcp = entry.startTime;
        }
      }

      // LCP from PerformanceObserver — read existing entries
      // The PerformanceObserver buffered flag lets us read entries already recorded
      try {
        const lcpEntries: PerformanceEntry[] = [];
        const lcpObserver = new PerformanceObserver((list) => {
          lcpEntries.push(...list.getEntries());
        });
        lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true });
        lcpObserver.disconnect();
        if (lcpEntries.length > 0) {
          result.lcp = lcpEntries[lcpEntries.length - 1].startTime;
        }
      } catch {
        // PerformanceObserver may not support LCP in all browsers
      }

      // CLS from layout-shift entries
      try {
        let clsScore = 0;
        const clsObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            // layout-shift entries have a `value` property but it's not in the base type
            const shift = entry as PerformanceEntry & {
              hadRecentInput?: boolean;
              value?: number;
            };
            if (!shift.hadRecentInput && shift.value != null) {
              clsScore += shift.value;
            }
          }
        });
        clsObserver.observe({ type: 'layout-shift', buffered: true });
        clsObserver.disconnect();
        result.cls = clsScore;
      } catch {
        // PerformanceObserver may not support layout-shift in all browsers
      }

      return result;
    });

    evidence.metrics = metrics;
    evidence.thresholds = THRESHOLDS;

    // Evaluate each metric against thresholds
    const exceeded: string[] = [];

    if (metrics.ttfb != null) {
      const pass = metrics.ttfb <= THRESHOLDS.ttfb;
      steps.push({
        label: `TTFB: ${Math.round(metrics.ttfb)}ms (threshold: ${THRESHOLDS.ttfb}ms)`,
        ok: pass,
      });
      if (!pass) exceeded.push(`TTFB=${Math.round(metrics.ttfb)}ms`);
    } else {
      steps.push({ label: 'TTFB: not available', ok: true });
    }

    if (metrics.fcp != null) {
      const pass = metrics.fcp <= THRESHOLDS.fcp;
      steps.push({
        label: `FCP: ${Math.round(metrics.fcp)}ms (threshold: ${THRESHOLDS.fcp}ms)`,
        ok: pass,
      });
      if (!pass) exceeded.push(`FCP=${Math.round(metrics.fcp)}ms`);
    } else {
      steps.push({ label: 'FCP: not available', ok: true });
    }

    if (metrics.lcp != null) {
      const pass = metrics.lcp <= THRESHOLDS.lcp;
      steps.push({
        label: `LCP: ${Math.round(metrics.lcp)}ms (threshold: ${THRESHOLDS.lcp}ms)`,
        ok: pass,
      });
      if (!pass) exceeded.push(`LCP=${Math.round(metrics.lcp)}ms`);
    } else {
      steps.push({ label: 'LCP: not available', ok: true });
    }

    if (metrics.cls != null) {
      const pass = metrics.cls <= THRESHOLDS.cls;
      steps.push({
        label: `CLS: ${metrics.cls.toFixed(4)} (threshold: ${THRESHOLDS.cls})`,
        ok: pass,
      });
      if (!pass) exceeded.push(`CLS=${metrics.cls.toFixed(4)}`);
    } else {
      steps.push({ label: 'CLS: not available', ok: true });
    }

    if (exceeded.length > 0) {
      return suspicious(
        perfWebVitals.name,
        `${exceeded.length} metric(s) exceed "poor" threshold: ${exceeded.join(', ')}`,
        evidence,
        steps,
      );
    }

    return ok(
      perfWebVitals.name,
      `All measured Web Vitals within acceptable thresholds on ${input.route}`,
      evidence,
      steps,
    );
  },
};
