/**
 * Tests for tools/visual-regression.ts — captureAndCompare and
 * runVisualRegression functions. Tests the comparison logic and
 * filesystem operations with temp directories.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../logging/logger.ts';

// ---------------------------------------------------------------------------
// Helpers — reimplemented private functions for verification
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

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;
}

function makeMockPage(screenshot: Buffer) {
  return {
    screenshot: vi.fn().mockResolvedValue(screenshot),
    goto: vi.fn().mockResolvedValue(undefined),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Pure logic tests (routeHash, computeDiffPercentage)
// ---------------------------------------------------------------------------

describe('routeHash (tools)', () => {
  it('produces a 16-char hex string', () => {
    const hash = routeHash('/home');
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic', () => {
    expect(routeHash('/admin')).toBe(routeHash('/admin'));
  });
});

describe('computeDiffPercentage (tools)', () => {
  it('returns 0 for identical buffers', () => {
    const buf = Buffer.from([1, 2, 3]);
    expect(computeDiffPercentage(buf, Buffer.from(buf))).toBe(0);
  });

  it('returns 100 for different-length buffers', () => {
    expect(computeDiffPercentage(Buffer.from([1]), Buffer.from([1, 2]))).toBe(100);
  });

  it('returns correct diff percentage', () => {
    const a = Buffer.alloc(10, 0);
    const b = Buffer.alloc(10, 0);
    b[0] = 1;
    b[1] = 1;
    expect(computeDiffPercentage(a, b)).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// captureAndCompare integration tests
// ---------------------------------------------------------------------------

describe('captureAndCompare', () => {
  const tmpDir = path.join(process.cwd(), '.tmp-vr-test');
  const baselineDir = path.join(tmpDir, 'baselines');
  const currentDir = path.join(tmpDir, 'screenshots');

  beforeEach(() => {
    mkdirSync(baselineDir, { recursive: true });
    mkdirSync(currentDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates baseline on first visit', async () => {
    const { captureAndCompare } = await import('./visual-regression.ts');
    const screenshot = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const page = makeMockPage(screenshot);
    const logger = makeLogger();

    const result = await captureAndCompare({
      page: page as any,
      route: '/new-route',
      baselineDir,
      currentDir,
      logger,
    });

    expect(result.isNew).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.diffPercentage).toBe(0);
    expect(existsSync(result.baselinePath)).toBe(true);
    expect(existsSync(result.currentPath)).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      'visual-regression.new-baseline',
      expect.objectContaining({ route: '/new-route' }),
    );
  });

  it('detects no change when screenshot matches baseline', async () => {
    const { captureAndCompare } = await import('./visual-regression.ts');
    const screenshot = Buffer.alloc(100, 42);
    const page = makeMockPage(screenshot);
    const logger = makeLogger();

    // Pre-create baseline
    const hash = routeHash('/stable');
    writeFileSync(path.join(baselineDir, `${hash}.png`), screenshot);

    const result = await captureAndCompare({
      page: page as any,
      route: '/stable',
      baselineDir,
      currentDir,
      logger,
    });

    expect(result.isNew).toBe(false);
    expect(result.changed).toBe(false);
    expect(result.diffPercentage).toBe(0);
  });

  it('detects change when screenshot differs from baseline', async () => {
    const { captureAndCompare } = await import('./visual-regression.ts');
    const baseline = Buffer.alloc(100, 0);
    const current = Buffer.alloc(100, 0);
    for (let i = 0; i < 10; i++) current[i] = 255; // 10% diff

    const page = makeMockPage(current);
    const logger = makeLogger();

    // Pre-create baseline
    const hash = routeHash('/changed');
    writeFileSync(path.join(baselineDir, `${hash}.png`), baseline);

    const result = await captureAndCompare({
      page: page as any,
      route: '/changed',
      baselineDir,
      currentDir,
      logger,
    });

    expect(result.isNew).toBe(false);
    expect(result.changed).toBe(true);
    expect(result.diffPercentage).toBe(10);
  });

  it('threshold: 1% diff is not flagged as changed', async () => {
    const { captureAndCompare } = await import('./visual-regression.ts');
    const baseline = Buffer.alloc(200, 0);
    const current = Buffer.alloc(200, 0);
    current[0] = 1;
    current[1] = 1; // 2/200 = 1%

    const page = makeMockPage(current);
    const logger = makeLogger();

    const hash = routeHash('/borderline');
    writeFileSync(path.join(baselineDir, `${hash}.png`), baseline);

    const result = await captureAndCompare({
      page: page as any,
      route: '/borderline',
      baselineDir,
      currentDir,
      logger,
    });

    expect(result.changed).toBe(false);
    expect(result.diffPercentage).toBe(1);
  });

  it('threshold: 1.5% diff is flagged as changed', async () => {
    const { captureAndCompare } = await import('./visual-regression.ts');
    const baseline = Buffer.alloc(200, 0);
    const current = Buffer.alloc(200, 0);
    current[0] = 1;
    current[1] = 1;
    current[2] = 1; // 3/200 = 1.5%

    const page = makeMockPage(current);
    const logger = makeLogger();

    const hash = routeHash('/over-threshold');
    writeFileSync(path.join(baselineDir, `${hash}.png`), baseline);

    const result = await captureAndCompare({
      page: page as any,
      route: '/over-threshold',
      baselineDir,
      currentDir,
      logger,
    });

    expect(result.changed).toBe(true);
    expect(result.diffPercentage).toBe(1.5);
  });

  it('returns correct route in result', async () => {
    const { captureAndCompare } = await import('./visual-regression.ts');
    const page = makeMockPage(Buffer.from([1, 2, 3]));
    const logger = makeLogger();

    const result = await captureAndCompare({
      page: page as any,
      route: '/my-route',
      baselineDir,
      currentDir,
      logger,
    });

    expect(result.route).toBe('/my-route');
  });
});

// ---------------------------------------------------------------------------
// runVisualRegression integration tests
// ---------------------------------------------------------------------------

describe('runVisualRegression', () => {
  const tmpDir = path.join(process.cwd(), '.tmp-vr-run-test');
  const memoryPath = path.join(tmpDir, 'memory');
  const runDir = path.join(tmpDir, 'run');

  beforeEach(() => {
    mkdirSync(memoryPath, { recursive: true });
    mkdirSync(runDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('processes multiple routes', async () => {
    const { runVisualRegression } = await import('./visual-regression.ts');
    const screenshot = Buffer.from([1, 2, 3, 4, 5]);
    const page = makeMockPage(screenshot);
    const logger = makeLogger();

    const results = await runVisualRegression({
      page: page as any,
      routes: ['/route-a', '/route-b', '/route-c'],
      memoryPath,
      runDir,
      logger,
    });

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.isNew)).toBe(true);
    expect(page.goto).toHaveBeenCalledTimes(3);
  });

  it('handles route navigation failure gracefully', async () => {
    const { runVisualRegression } = await import('./visual-regression.ts');
    const page = makeMockPage(Buffer.from([1]));
    page.goto.mockRejectedValueOnce(new Error('timeout'));
    const logger = makeLogger();

    const results = await runVisualRegression({
      page: page as any,
      routes: ['/fail-route', '/ok-route'],
      memoryPath,
      runDir,
      logger,
    });

    // First route fails, second succeeds
    expect(results).toHaveLength(1);
    expect(results[0]!.route).toBe('/ok-route');
    expect(logger.warn).toHaveBeenCalledWith(
      'visual-regression.route.failed',
      expect.objectContaining({ route: '/fail-route' }),
    );
  });

  it('returns empty array for no routes', async () => {
    const { runVisualRegression } = await import('./visual-regression.ts');
    const page = makeMockPage(Buffer.from([1]));
    const logger = makeLogger();

    const results = await runVisualRegression({
      page: page as any,
      routes: [],
      memoryPath,
      runDir,
      logger,
    });

    expect(results).toEqual([]);
  });
});
