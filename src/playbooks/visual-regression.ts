/**
 * Visual regression playbook — captures a viewport screenshot and compares
 * it against a stored baseline. Reports findings when visual differences
 * exceed a threshold (>1% byte difference).
 *
 * Baselines are stored in the per-target memory directory so they persist
 * across runs. New routes get a baseline created on first visit.
 *
 * Agent usage: call `visual_regression_check` with the current route after
 * the page has fully loaded. The playbook handles screenshot capture,
 * baseline lookup, comparison, and finding generation.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Playbook } from './framework.ts';
import { ok, suspicious, type PlaybookOutcome } from './outcome.ts';

function routeHash(route: string): string {
  return createHash('sha256').update(route).digest('hex').slice(0, 16);
}

function computeDiffPercentage(a: Buffer, b: Buffer): number {
  if (Buffer.compare(a, b) === 0) return 0;
  // Compare byte-by-byte up to the shorter length; treat any extra bytes in
  // the longer buffer as diffs. Without this, two PNGs of the same visual
  // content that compress to different lengths would return 100% diff — PNG
  // compression is non-deterministic, so length differences are common even
  // for identical screenshots.
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 0;
  const minLen = Math.min(a.length, b.length);
  let diffBytes = maxLen - minLen; // extra bytes in longer buffer count as diffs
  for (let i = 0; i < minLen; i++) {
    if (a[i] !== b[i]) diffBytes++;
  }
  return (diffBytes / maxLen) * 100;
}

export const visualRegressionCheck: Playbook<{ route: string }> = {
  name: 'visual_regression_check',
  description:
    'Capture a viewport screenshot and compare against the stored baseline. ' +
    'Call on each route after the page has fully loaded. Reports suspicious ' +
    'when visual differences exceed threshold (>1%). New routes get a baseline ' +
    'created automatically.',
  categories: ['discovery'],
  estimatedDurationMs: 3_000,
  inputShape: {
    route: z.string().min(1).describe('The route URL to screenshot and compare'),
  },
  async run(input, ctx): Promise<PlaybookOutcome> {
    const { route } = input;
    const { page, runDir, logger } = ctx;

    const hash = routeHash(route);
    const baselineDir = path.join(runDir, '..', '..', 'baselines');
    const currentDir = path.join(runDir, 'screenshots');
    const baselinePath = path.join(baselineDir, `${hash}.png`);
    const currentPath = path.join(currentDir, `${hash}.png`);

    await mkdir(baselineDir, { recursive: true });
    await mkdir(currentDir, { recursive: true });

    const screenshot = await page.screenshot({
      fullPage: false,
      type: 'png',
    });

    await writeFile(currentPath, screenshot);

    if (!existsSync(baselinePath)) {
      await writeFile(baselinePath, screenshot);
      logger.info('visual-regression.new-baseline', { route, path: baselinePath });
      return ok(
        'visual_regression_check',
        'New baseline created (first visit)',
        { route },
        [
          { label: 'capture screenshot', ok: true },
          { label: 'create baseline (first visit)', ok: true },
        ],
      );
    }

    const baseline = await readFile(baselinePath);
    const diffPct = computeDiffPercentage(baseline, screenshot);

    if (diffPct <= 1) {
      return ok(
        'visual_regression_check',
        `Visual match (${diffPct.toFixed(2)}% diff — within threshold)`,
        { route, diffPercentage: diffPct },
        [
          { label: 'capture screenshot', ok: true },
          { label: `compare (${diffPct.toFixed(2)}% diff — within threshold)`, ok: true },
        ],
      );
    }

    return suspicious(
      'visual_regression_check',
      `Visual regression detected (${diffPct.toFixed(1)}% diff — exceeds 1% threshold)`,
      { route, diffPercentage: diffPct, baselinePath, currentPath },
      [
        { label: 'capture screenshot', ok: true },
        {
          label: `compare (${diffPct.toFixed(1)}% diff — exceeds 1% threshold)`,
          ok: false,
        },
      ],
    );
  },
};
