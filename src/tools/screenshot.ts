import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';

/**
 * Capture a screenshot for a finding and store it under
 * `<runDir>/findings/<findingId>.png`.
 *
 * Returns the path *relative to runDir* (e.g. `findings/<id>.png`) so it
 * can be embedded directly in the run's review.md via a relative `<img>`.
 */
export async function captureScreenshot(
  page: Page,
  runDir: string,
  findingId: string,
): Promise<string> {
  const dir = path.join(runDir, 'findings');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${findingId}.png`);
  await page.screenshot({ path: file, fullPage: false });
  return path.relative(runDir, file);
}
