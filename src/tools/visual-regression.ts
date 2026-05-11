/**
 * Visual regression — captures and compares screenshots across runs.
 *
 * Baselines are stored in `<memory_path>/baselines/<route-hash>.png`.
 * On each run, a new screenshot is taken and compared byte-for-byte
 * against the baseline. If no baseline exists, the screenshot becomes
 * the new baseline.
 *
 * This is intentionally simple — byte-level comparison catches layout
 * shifts, missing elements, and broken styles without needing an image
 * processing library. Anti-aliasing differences will trigger false
 * positives, but the review pipeline filters those.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import type { Logger } from '../logging/logger.ts';

export interface VisualRegressionResult {
  route: string;
  baselinePath: string;
  currentPath: string;
  isNew: boolean;
  changed: boolean;
  diffPercentage: number;
}

function routeHash(route: string): string {
  return createHash('sha256').update(route).digest('hex').slice(0, 16);
}

export async function captureAndCompare(opts: {
  page: Page;
  route: string;
  baselineDir: string;
  currentDir: string;
  logger: Logger;
}): Promise<VisualRegressionResult> {
  const { page, route, baselineDir, currentDir, logger } = opts;
  const hash = routeHash(route);
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
    return {
      route,
      baselinePath,
      currentPath,
      isNew: true,
      changed: false,
      diffPercentage: 0,
    };
  }

  const baseline = await readFile(baselinePath);
  const diffPct = computeDiffPercentage(baseline, screenshot);

  logger.info('visual-regression.compared', {
    route,
    diffPercentage: diffPct.toFixed(2),
    changed: diffPct > 1,
  });

  return {
    route,
    baselinePath,
    currentPath,
    isNew: false,
    changed: diffPct > 1,
    diffPercentage: diffPct,
  };
}

function computeDiffPercentage(a: Buffer, b: Buffer): number {
  if (Buffer.compare(a, b) === 0) return 0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 0;
  const minLen = Math.min(a.length, b.length);
  let diffBytes = maxLen - minLen;
  for (let i = 0; i < minLen; i++) {
    if (a[i] !== b[i]) diffBytes++;
  }
  return (diffBytes / maxLen) * 100;
}

export async function runVisualRegression(opts: {
  page: Page;
  routes: string[];
  memoryPath: string;
  runDir: string;
  logger: Logger;
}): Promise<VisualRegressionResult[]> {
  const { page, routes, memoryPath, runDir, logger } = opts;
  const baselineDir = path.join(memoryPath, 'baselines');
  const currentDir = path.join(runDir, 'screenshots');
  const results: VisualRegressionResult[] = [];

  for (const route of routes) {
    try {
      await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      try {
        await page.waitForLoadState('networkidle', { timeout: 3_000 });
      } catch {
        await page.waitForTimeout(500);
      }
      const result = await captureAndCompare({
        page,
        route,
        baselineDir,
        currentDir,
        logger,
      });
      results.push(result);
    } catch (err) {
      logger.warn('visual-regression.route.failed', {
        route,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}
