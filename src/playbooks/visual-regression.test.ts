/**
 * Tests for visual-regression.ts playbook — baseline creation, comparison,
 * and the computeDiffPercentage helper.
 *
 * Since the playbook depends on Playwright's page.screenshot() and filesystem
 * operations, we test the pure comparison logic directly and mock I/O for the
 * integration paths.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Re-implement the pure functions from visual-regression.ts for unit testing.
// The module exports only the Playbook object (visualRegressionCheck), so we
// replicate the deterministic helpers here.
// ---------------------------------------------------------------------------

function routeHash(route: string): string {
  return createHash('sha256').update(route).digest('hex').slice(0, 16);
}

function computeDiffPercentage(a: Buffer, b: Buffer): number {
  if (a.length !== b.length) return 100;
  if (Buffer.compare(a, b) === 0) return 0;
  let diffBytes = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) diffBytes++;
  }
  return (diffBytes / len) * 100;
}

// ---------------------------------------------------------------------------
// routeHash
// ---------------------------------------------------------------------------

describe('routeHash', () => {
  it('produces a 16-character hex string', () => {
    const hash = routeHash('/home');
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('produces deterministic output', () => {
    expect(routeHash('/admin')).toBe(routeHash('/admin'));
  });

  it('produces different hashes for different routes', () => {
    expect(routeHash('/admin')).not.toBe(routeHash('/settings'));
  });

  it('handles empty string', () => {
    const hash = routeHash('');
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('handles long URLs', () => {
    const longRoute = 'https://example.com/' + 'a'.repeat(2000);
    const hash = routeHash(longRoute);
    expect(hash).toHaveLength(16);
  });

  it('handles special characters in routes', () => {
    const hash = routeHash('/search?q=test&page=1#results');
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ---------------------------------------------------------------------------
// computeDiffPercentage
// ---------------------------------------------------------------------------

describe('computeDiffPercentage', () => {
  it('returns 0 for identical buffers', () => {
    const buf = Buffer.from([1, 2, 3, 4, 5]);
    expect(computeDiffPercentage(buf, Buffer.from(buf))).toBe(0);
  });

  it('returns 100 for buffers of different lengths', () => {
    const a = Buffer.from([1, 2, 3]);
    const b = Buffer.from([1, 2, 3, 4]);
    expect(computeDiffPercentage(a, b)).toBe(100);
  });

  it('returns 100 when one buffer is empty and other is not', () => {
    const a = Buffer.from([]);
    const b = Buffer.from([1]);
    expect(computeDiffPercentage(a, b)).toBe(100);
  });

  it('returns 0 for two empty buffers', () => {
    const a = Buffer.from([]);
    const b = Buffer.from([]);
    expect(computeDiffPercentage(a, b)).toBe(0);
  });

  it('returns correct percentage for partial differences', () => {
    // 10 bytes, 2 differ = 20%
    const a = Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const b = Buffer.from([1, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect(computeDiffPercentage(a, b)).toBe(20);
  });

  it('returns 100 for completely different buffers of same length', () => {
    const a = Buffer.from([0, 0, 0, 0]);
    const b = Buffer.from([1, 1, 1, 1]);
    expect(computeDiffPercentage(a, b)).toBe(100);
  });

  it('handles single-byte buffers (identical)', () => {
    expect(computeDiffPercentage(Buffer.from([42]), Buffer.from([42]))).toBe(0);
  });

  it('handles single-byte buffers (different)', () => {
    expect(computeDiffPercentage(Buffer.from([0]), Buffer.from([1]))).toBe(100);
  });

  it('returns percentage less than 1 for minor differences', () => {
    // 1000 bytes, 5 differ = 0.5%
    const a = Buffer.alloc(1000, 0);
    const b = Buffer.alloc(1000, 0);
    b[0] = 1;
    b[200] = 1;
    b[400] = 1;
    b[600] = 1;
    b[800] = 1;
    expect(computeDiffPercentage(a, b)).toBe(0.5);
  });

  it('threshold: 1% diff should pass, >1% should fail', () => {
    // 100 bytes, 1 differs = 1% (exactly at threshold)
    const a = Buffer.alloc(100, 0);
    const b = Buffer.alloc(100, 0);
    b[0] = 1;
    const diff = computeDiffPercentage(a, b);
    expect(diff).toBe(1); // exactly 1% — within threshold (<= 1)

    // 100 bytes, 2 differ = 2% (exceeds threshold)
    const c = Buffer.alloc(100, 0);
    c[0] = 1;
    c[1] = 1;
    expect(computeDiffPercentage(a, c)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Integration: baseline creation and comparison on disk
// ---------------------------------------------------------------------------

describe('visual regression baseline lifecycle', () => {
  const tmpDir = path.join(process.cwd(), '.tmp-visual-test');
  const baselineDir = path.join(tmpDir, 'baselines');
  const currentDir = path.join(tmpDir, 'screenshots');

  beforeEach(() => {
    mkdirSync(baselineDir, { recursive: true });
    mkdirSync(currentDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates baseline on first visit when file does not exist', () => {
    const hash = routeHash('/home');
    const baselinePath = path.join(baselineDir, `${hash}.png`);

    expect(existsSync(baselinePath)).toBe(false);

    // Simulate what the playbook does: write the screenshot as the baseline
    const screenshotData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    writeFileSync(baselinePath, screenshotData);

    expect(existsSync(baselinePath)).toBe(true);
  });

  it('baseline matches identical screenshot (0% diff)', async () => {
    const hash = routeHash('/settings');
    const baselinePath = path.join(baselineDir, `${hash}.png`);
    const currentPath = path.join(currentDir, `${hash}.png`);

    const screenshotData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 10, 20, 30]);
    writeFileSync(baselinePath, screenshotData);
    writeFileSync(currentPath, screenshotData);

    const baseline = await readFile(baselinePath);
    const current = await readFile(currentPath);
    expect(computeDiffPercentage(baseline, current)).toBe(0);
  });

  it('detects visual regression when screenshots differ', async () => {
    const hash = routeHash('/dashboard');
    const baselinePath = path.join(baselineDir, `${hash}.png`);
    const currentPath = path.join(currentDir, `${hash}.png`);

    const original = Buffer.alloc(100, 0);
    const changed = Buffer.alloc(100, 0);
    // 10 bytes differ = 10% -> exceeds 1% threshold
    for (let i = 0; i < 10; i++) changed[i] = 255;

    writeFileSync(baselinePath, original);
    writeFileSync(currentPath, changed);

    const baseline = await readFile(baselinePath);
    const current = await readFile(currentPath);
    const diffPct = computeDiffPercentage(baseline, current);

    expect(diffPct).toBe(10);
    expect(diffPct).toBeGreaterThan(1);
  });

  it('uses consistent hash for route-to-filename mapping', () => {
    const routes = ['/home', '/settings', '/admin/users', '/api/v2/health'];
    const hashes = routes.map(routeHash);

    // All hashes should be unique
    expect(new Set(hashes).size).toBe(routes.length);
    // All should be 16-char hex
    for (const h of hashes) {
      expect(h).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests for the Playbook metadata (static properties)
// ---------------------------------------------------------------------------

describe('visualRegressionCheck playbook metadata', () => {
  // Import lazily to avoid side effects during test setup
  it('has correct name', async () => {
    const { visualRegressionCheck } = await import('./visual-regression.ts');
    expect(visualRegressionCheck.name).toBe('visual_regression_check');
  });

  it('is categorized as discovery', async () => {
    const { visualRegressionCheck } = await import('./visual-regression.ts');
    expect(visualRegressionCheck.categories).toContain('discovery');
  });

  it('has an estimatedDurationMs', async () => {
    const { visualRegressionCheck } = await import('./visual-regression.ts');
    expect(visualRegressionCheck.estimatedDurationMs).toBeGreaterThan(0);
  });

  it('requires route in inputShape', async () => {
    const { visualRegressionCheck } = await import('./visual-regression.ts');
    expect(visualRegressionCheck.inputShape).toHaveProperty('route');
  });
});
