/**
 * Tests for SelectorCache.
 *
 * Uses a tmp directory so disk I/O is real (not mocked) — validates the
 * atomic write path end-to-end. vi.useFakeTimers is used to avoid real
 * debounce delays in concurrency tests.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCacheKey, SelectorCache, type SelectorCacheFile } from './selector-cache.ts';

// ─── helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string;
const TARGET_URL = 'https://app.example.com';

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), 'selector-cache-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  vi.useRealTimers();
});

function overridePath(): string {
  return path.join(tmpDir, 'cache.json');
}

// ─── buildCacheKey ────────────────────────────────────────────────────────────

describe('buildCacheKey', () => {
  it('lowercases and trims the hint', () => {
    expect(buildCacheKey('/dashboard', '  Save  ', undefined)).toBe('/dashboard::save::any');
  });

  it('uses the role when provided', () => {
    expect(buildCacheKey('/form', 'submit', 'button')).toBe('/form::submit::button');
  });

  it('uses "any" when role is undefined', () => {
    expect(buildCacheKey('/page', 'click me', undefined)).toBe('/page::click me::any');
  });
});

// ─── SelectorCache.load ───────────────────────────────────────────────────────

describe('SelectorCache.load', () => {
  it('returns an empty cache for a nonexistent file', async () => {
    const cache = await SelectorCache.load(TARGET_URL, overridePath());
    expect(cache.size).toBe(0);
  });

  it('reads back a previously saved cache file', async () => {
    // Manually write a valid cache file.
    const file: SelectorCacheFile = {
      version: 1,
      targetUrl: TARGET_URL,
      entries: {
        '/page::login::button': {
          locator: 'role=button[name="Login"]',
          hits: 3,
          lastHitAt: '2026-01-01T00:00:00.000Z',
        },
      },
    };
    const { writeFile } = await import('node:fs/promises');
    await writeFile(overridePath(), JSON.stringify(file), 'utf8');

    const cache = await SelectorCache.load(TARGET_URL, overridePath());
    expect(cache.size).toBe(1);
    expect(cache.get('/page', 'login', 'button')).toBe('role=button[name="Login"]');
  });

  it('returns empty cache for a version-mismatch file', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      overridePath(),
      JSON.stringify({ version: 99, targetUrl: TARGET_URL, entries: {} }),
      'utf8',
    );
    const cache = await SelectorCache.load(TARGET_URL, overridePath());
    expect(cache.size).toBe(0);
  });
});

// ─── get / set ────────────────────────────────────────────────────────────────

describe('get / set', () => {
  it('returns null for a missing key', async () => {
    const cache = await SelectorCache.load(TARGET_URL, overridePath());
    expect(cache.get('/missing', 'something', undefined)).toBeNull();
  });

  it('set then get round-trips the locator', async () => {
    vi.useFakeTimers();
    const cache = await SelectorCache.load(TARGET_URL, overridePath());
    cache.set('/dashboard', 'Submit', 'button', 'role=button[name="Submit"]');
    const result = cache.get('/dashboard', 'Submit', 'button');
    expect(result).toBe('role=button[name="Submit"]');
  });

  it('get increments hits', async () => {
    vi.useFakeTimers();
    const cache = await SelectorCache.load(TARGET_URL, overridePath());
    cache.set('/page', 'Ok', undefined, 'text="Ok"');
    cache.get('/page', 'Ok', undefined);
    cache.get('/page', 'Ok', undefined);
    // Re-read via rawFile to check metadata.
    const entry = cache.rawFile.entries[buildCacheKey('/page', 'Ok', undefined)];
    expect(entry?.hits).toBe(2);
  });

  it('is case-insensitive and trims whitespace on get', async () => {
    vi.useFakeTimers();
    const cache = await SelectorCache.load(TARGET_URL, overridePath());
    cache.set('/page', 'submit', undefined, 'role=button[name="Submit"]');
    // Get with different case + surrounding whitespace.
    expect(cache.get('/page', '  SUBMIT  ', undefined)).toBe('role=button[name="Submit"]');
  });
});

// ─── save / load round-trip ───────────────────────────────────────────────────

describe('save / load round-trip', () => {
  it('set then save then load reads back the entry', async () => {
    vi.useFakeTimers();
    const fp = overridePath();
    const cache = await SelectorCache.load(TARGET_URL, fp);
    cache.set('/checkout', 'Place order', 'button', 'role=button[name="Place order"]', 'abc123');

    // close() forces a save regardless of debounce timer.
    await cache.close();

    const raw = await readFile(fp, 'utf8');
    const parsed: SelectorCacheFile = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.targetUrl).toBe(TARGET_URL);

    const entry = parsed.entries[buildCacheKey('/checkout', 'Place order', 'button')];
    expect(entry?.locator).toBe('role=button[name="Place order"]');
    expect(entry?.pageTextHash).toBe('abc123');

    // Also verify a fresh load sees it.
    const cache2 = await SelectorCache.load(TARGET_URL, fp);
    expect(cache2.get('/checkout', 'Place order', 'button')).toBe(
      'role=button[name="Place order"]',
    );
  });
});

// ─── invalidateRoute ──────────────────────────────────────────────────────────

describe('invalidateRoute', () => {
  it('removes only entries for the given pathname', async () => {
    vi.useFakeTimers();
    const cache = await SelectorCache.load(TARGET_URL, overridePath());
    cache.set('/dashboard', 'Save', 'button', 'role=button[name="Save"]');
    cache.set('/dashboard', 'Cancel', 'link', 'role=link[name="Cancel"]');
    cache.set('/other', 'Go', undefined, 'text="Go"');

    cache.invalidateRoute('/dashboard');

    expect(cache.get('/dashboard', 'Save', 'button')).toBeNull();
    expect(cache.get('/dashboard', 'Cancel', 'link')).toBeNull();
    expect(cache.get('/other', 'Go', undefined)).toBe('text="Go"');
    expect(cache.size).toBe(1);
  });

  it('is a no-op when no entries match', async () => {
    vi.useFakeTimers();
    const cache = await SelectorCache.load(TARGET_URL, overridePath());
    cache.set('/page', 'Ok', undefined, 'text="Ok"');
    cache.invalidateRoute('/nonexistent');
    expect(cache.size).toBe(1);
  });
});

// ─── concurrent sets (debounce coalescing) ────────────────────────────────────

describe('concurrent sets with fake timers', () => {
  it('multiple set calls within debounce window are all present after close()', async () => {
    // With fake timers the setTimeout in scheduleDebounced is fake, so we
    // instead validate coalescing by calling close() which forces a flush.
    // This tests the same invariant: all sets within the open() → close()
    // window appear in the written file.
    const fp = overridePath();
    const cache = await SelectorCache.load(TARGET_URL, fp);

    cache.set('/page', 'First', undefined, 'text="First"');
    cache.set('/page', 'Second', undefined, 'text="Second"');
    cache.set('/page', 'Third', undefined, 'text="Third"');

    // Force flush without relying on the timer.
    await cache.close();

    const raw = await readFile(fp, 'utf8');
    const parsed: SelectorCacheFile = JSON.parse(raw);
    expect(Object.keys(parsed.entries)).toHaveLength(3);
  });

  it('close() flushes even when called before debounce fires', async () => {
    vi.useFakeTimers();
    const fp = overridePath();
    const cache = await SelectorCache.load(TARGET_URL, fp);
    cache.set('/page', 'Flush', 'button', 'role=button[name="Flush"]');

    // Call close() immediately — debounce timer has not fired yet.
    // Use real async execution so that close() can await properly.
    vi.useRealTimers();
    await cache.close();

    const raw = await readFile(fp, 'utf8');
    const parsed: SelectorCacheFile = JSON.parse(raw);
    expect(parsed.entries[buildCacheKey('/page', 'Flush', 'button')]?.locator).toBe(
      'role=button[name="Flush"]',
    );
  });
});
