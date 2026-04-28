/**
 * Persistent per-target selector cache.
 *
 * Maps (URL pathname + hint + role) → resolved Playwright locator string so
 * that `find_and_click` can skip its multi-strategy probe on subsequent runs
 * against the same target.
 *
 * Storage: ~/.regress-harness/cache/selectors/<sha1(targetUrl).slice(0,16)>.json
 *
 * Atomic writes: content is written to a .tmp sibling then renamed. A
 * debounced 2-second timer gates routine saves; a final forced flush is
 * triggered on close().
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

// ─── Schema types ─────────────────────────────────────────────────────────────

export interface SelectorCacheFile {
  version: 1;
  targetUrl: string;
  entries: Record<string, SelectorCacheEntry>;
}

export interface SelectorCacheEntry {
  locator: string;
  hits: number;
  lastHitAt: string; // ISO
  pageTextHash?: string; // optional invalidation hint
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build the cache key string for a given (pathname, hint, role) triple.
 */
export function buildCacheKey(pathname: string, hint: string, role: string | undefined): string {
  return `${pathname}::${hint.toLowerCase().trim()}::${role ?? 'any'}`;
}

/**
 * Resolve the cache file path for a given target URL.
 *
 * @param targetUrl  The canonical target portal URL.
 * @param override   Optional override path (used in tests / config).
 */
export function resolveCachePath(targetUrl: string, override?: string): string {
  if (override) {
    return path.resolve(override);
  }
  const hash = createHash('sha1').update(targetUrl).digest('hex').slice(0, 16);
  return path.join(homedir(), '.regress-harness', 'cache', 'selectors', `${hash}.json`);
}

// ─── SelectorCache class ──────────────────────────────────────────────────────

export class SelectorCache {
  private file: SelectorCacheFile;
  private filepath: string;
  private dirty = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private savePromise: Promise<void> = Promise.resolve();

  private constructor(file: SelectorCacheFile, filepath: string) {
    this.file = file;
    this.filepath = filepath;
  }

  /**
   * Load the cache from disk. Returns an empty cache when the file doesn't
   * exist yet. `override` lets callers (tests, config) redirect the storage
   * path.
   */
  static async load(targetUrl: string, override?: string): Promise<SelectorCache> {
    const filepath = resolveCachePath(targetUrl, override);
    let file: SelectorCacheFile;
    try {
      // Synchronous read on purpose — this is called once at startup and
      // avoids the need to handle async errors from a cold path.
      const raw = readFileSync(filepath, 'utf8');
      const parsed = JSON.parse(raw) as SelectorCacheFile;
      // Basic version guard — treat unknown versions as empty.
      if (parsed.version !== 1) {
        file = { version: 1, targetUrl, entries: {} };
      } else {
        file = parsed;
      }
    } catch {
      // File missing or unreadable — start fresh.
      file = { version: 1, targetUrl, entries: {} };
    }
    return new SelectorCache(file, filepath);
  }

  /**
   * Atomically persist the cache. Writes to a .tmp sibling then renames so a
   * crash mid-write never produces a truncated JSON file.
   */
  async save(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    const tmp = `${this.filepath}.tmp`;
    const content = JSON.stringify(this.file, null, 2);
    // Ensure the parent directory exists.
    await mkdir(path.dirname(this.filepath), { recursive: true });
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, this.filepath);
  }

  /**
   * Schedule a debounced save (at most once every 2 seconds).
   * Consecutive sets within the window coalesce into a single write.
   */
  private scheduleDebounced(): void {
    if (this.debounceTimer !== null) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.savePromise = this.savePromise
        .then(() => this.save())
        .catch(() => {
          // Best-effort — a failed cache write must not crash the run.
        });
    }, 2_000);
  }

  /**
   * Force a final flush and cancel any pending timer. Call from the run's
   * finally block to ensure the last batch of entries is persisted.
   */
  async close(): Promise<void> {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    // Wait for any in-progress debounced save to finish first.
    await this.savePromise;
    // Then do a final forced save.
    this.dirty = true; // force even if dirty was cleared by the debounce save
    await this.save();
  }

  /**
   * Look up a cached locator. Records hit metadata if found and marks dirty.
   */
  get(pathname: string, hint: string, role: string | undefined): string | null {
    const key = buildCacheKey(pathname, hint, role);
    const entry = this.file.entries[key];
    if (!entry) return null;
    // Record the hit.
    entry.hits += 1;
    entry.lastHitAt = new Date().toISOString();
    this.dirty = true;
    this.scheduleDebounced();
    return entry.locator;
  }

  /**
   * Record a successful resolution. Marks dirty and schedules a debounced save.
   */
  set(
    pathname: string,
    hint: string,
    role: string | undefined,
    locator: string,
    pageTextHash?: string,
  ): void {
    const key = buildCacheKey(pathname, hint, role);
    const existing = this.file.entries[key];
    this.file.entries[key] = {
      locator,
      hits: existing ? existing.hits : 0,
      lastHitAt: existing ? existing.lastHitAt : new Date().toISOString(),
      ...(pageTextHash !== undefined ? { pageTextHash } : {}),
    };
    this.dirty = true;
    this.scheduleDebounced();
  }

  /**
   * Remove all entries for a given pathname (e.g. after a stale cache hit
   * causes a click failure, we drop everything for that route so the next
   * call falls through to the multi-strategy probe).
   */
  invalidateRoute(pathname: string): void {
    const prefix = `${pathname}::`;
    let changed = false;
    for (const key of Object.keys(this.file.entries)) {
      if (key.startsWith(prefix)) {
        delete this.file.entries[key];
        changed = true;
      }
    }
    if (changed) {
      this.dirty = true;
      this.scheduleDebounced();
    }
  }

  /** Expose entry count for testing. */
  get size(): number {
    return Object.keys(this.file.entries).length;
  }

  /** Expose the raw file content for testing. */
  get rawFile(): SelectorCacheFile {
    return this.file;
  }
}
